import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { cpus, platform, release, tmpdir } from "node:os";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

import { TekrionDaemon } from "../apps/daemon/dist/index.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const viewerDirectory = join(
  repositoryRoot,
  "apps",
  "viewer",
  "dist",
  "public",
);
const sampleCount = 100;
const warmupCount = 10;
const requestBody = JSON.stringify({
  model: "tekrion-benchmark",
  input: "ping",
  stream: false,
});
const responseBody = JSON.stringify({
  id: "resp_tekrion_benchmark",
  object: "response",
  created_at: 0,
  status: "completed",
  model: "tekrion-benchmark",
  output: [],
  usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
});

function round(value) {
  return Number(value.toFixed(3));
}

function percentile(values, quantile) {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.ceil(sorted.length * quantile) - 1,
  );
  return sorted[index];
}

function summarize(values) {
  return {
    p50Milliseconds: round(percentile(values, 0.5)),
    p95Milliseconds: round(percentile(values, 0.95)),
  };
}

async function listen(server) {
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolvePromise();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Benchmark upstream did not publish a TCP address.");
  }
  return `http://127.0.0.1:${address.port}`;
}

async function close(server) {
  await new Promise((resolvePromise, reject) => {
    server.close((error) => {
      if (error === undefined) {
        resolvePromise();
      } else {
        reject(error);
      }
    });
    server.closeAllConnections();
  });
}

async function timedRequest(url, options) {
  const started = performance.now();
  const response = await fetch(url, options);
  const headersReceived = performance.now();
  await response.arrayBuffer();
  const completed = performance.now();
  if (!response.ok) {
    throw new Error(`${url} returned HTTP ${response.status}.`);
  }
  return {
    timeToFirstByte: headersReceived - started,
    total: completed - started,
  };
}

async function productionAssets(directory) {
  const paths = [];
  async function visit(current) {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries.sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile() && !entry.name.endsWith(".map")) {
        paths.push(path);
      }
    }
  }
  await visit(directory);
  const payloads = await Promise.all(paths.map((path) => readFile(path)));
  return {
    files: paths.map((path) => relative(directory, path)),
    rawBytes: payloads.reduce(
      (total, payload) => total + payload.byteLength,
      0,
    ),
    gzipBytes: payloads.reduce(
      (total, payload) => total + gzipSync(payload).byteLength,
      0,
    ),
  };
}

const temporaryRoot = await mkdtemp(join(tmpdir(), "tekrion-benchmark-"));
await mkdir(temporaryRoot, { recursive: true, mode: 0o700 });
const upstream = createServer((request, response) => {
  request.resume();
  response.writeHead(200, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(responseBody),
  });
  response.end(responseBody);
});
let daemon;

try {
  const upstreamOrigin = await listen(upstream);
  daemon = new TekrionDaemon({
    homeDirectory: temporaryRoot,
    proxy: { listenPort: 0, upstream: upstreamOrigin },
    control: { listenPort: 0 },
    viewerDirectory,
  });
  const status = await daemon.start();
  const directUrl = `${upstreamOrigin}/v1/responses`;
  const proxyUrl = `${status.proxyOrigin}/v1/responses`;
  const requestOptions = {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: requestBody,
  };

  for (let index = 0; index < warmupCount; index += 1) {
    await timedRequest(directUrl, requestOptions);
    await timedRequest(proxyUrl, requestOptions);
    await timedRequest(status.controlOrigin, undefined);
  }

  const direct = [];
  const proxied = [];
  const cockpit = [];
  for (let index = 0; index < sampleCount; index += 1) {
    if (index % 2 === 0) {
      direct.push(await timedRequest(directUrl, requestOptions));
      proxied.push(await timedRequest(proxyUrl, requestOptions));
    } else {
      proxied.push(await timedRequest(proxyUrl, requestOptions));
      direct.push(await timedRequest(directUrl, requestOptions));
    }
    cockpit.push(await timedRequest(status.controlOrigin, undefined));
  }

  const directTtfb = summarize(direct.map((sample) => sample.timeToFirstByte));
  const proxyTtfb = summarize(proxied.map((sample) => sample.timeToFirstByte));
  const directTotal = summarize(direct.map((sample) => sample.total));
  const proxyTotal = summarize(proxied.map((sample) => sample.total));
  const assets = await productionAssets(viewerDirectory);
  const result = {
    schemaVersion: 1,
    measuredAt: new Date().toISOString(),
    command: "npm run benchmark",
    environment: {
      platform: platform(),
      release: release(),
      architecture: process.arch,
      processor: cpus()[0]?.model ?? "unknown",
      node: process.version,
    },
    fixtureSha256: createHash("sha256")
      .update(requestBody)
      .update("\n")
      .update(responseBody)
      .digest("hex"),
    warmupCount,
    sampleCount,
    proxy: {
      direct: { timeToFirstByte: directTtfb, total: directTotal },
      recorded: { timeToFirstByte: proxyTtfb, total: proxyTotal },
      p95TimeToFirstByteOverheadMilliseconds: round(
        proxyTtfb.p95Milliseconds - directTtfb.p95Milliseconds,
      ),
      p95TotalOverheadMilliseconds: round(
        proxyTotal.p95Milliseconds - directTotal.p95Milliseconds,
      ),
    },
    cockpit: {
      initialDocument: {
        timeToFirstByte: summarize(
          cockpit.map((sample) => sample.timeToFirstByte),
        ),
        total: summarize(cockpit.map((sample) => sample.total)),
      },
      productionAssets: {
        count: assets.files.length,
        rawBytes: assets.rawBytes,
        gzipBytes: assets.gzipBytes,
        files: assets.files,
      },
    },
    limitations: [
      "Loopback smoke test with a small non-streaming response; it is not an Internet or load benchmark.",
      "Cockpit timing covers initial HTML delivery, not browser rendering or interaction latency.",
      "Results are machine-specific and should be reproduced before making release claims.",
    ],
  };
  process.stdout.write(`${JSON.stringify(result, undefined, 2)}\n`);
} finally {
  await daemon?.stop();
  if (upstream.listening) {
    await close(upstream);
  }
  await rm(temporaryRoot, { recursive: true, force: true });
}
