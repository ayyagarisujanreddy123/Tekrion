import {
  createServer,
  request as httpRequest,
  type ClientRequest,
  type IncomingHttpHeaders,
  type Server,
} from "node:http";
import { connect, type AddressInfo } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ChunkManifestSchema,
  openBlackBoxStorage,
  type BlackBoxStorage,
} from "@blackbox/storage";
import { afterEach, describe, expect, it } from "vitest";

import {
  DurableNormalizationRunner,
  RecorderProxy,
  exportBbxArchive,
  sessionScopedProxyBaseUrl,
} from "../src/index.js";

interface HttpResult {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: Buffer;
  readonly chunks: readonly Buffer[];
}

interface UpstreamObservation {
  readonly path: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: Buffer;
}

const roots: string[] = [];
const storages: BlackBoxStorage[] = [];
const proxies: RecorderProxy[] = [];
const upstreams: Server[] = [];

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function makeUpstream(): Promise<{
  readonly origin: string;
  readonly observations: UpstreamObservation[];
  readonly server: Server;
}> {
  const observations: UpstreamObservation[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      const body = Buffer.concat(chunks);
      observations.push({
        path: request.url ?? "/",
        headers: request.headers,
        body,
      });

      if (
        request.url === "/v1/responses" &&
        body.includes(Buffer.from('"model":"normalize-fixture"'))
      ) {
        const output = Buffer.from(
          JSON.stringify({
            id: "resp_normalized",
            status: "completed",
            output: [
              {
                type: "message",
                id: "msg_normalized",
                content: [{ type: "output_text", text: "normalized" }],
              },
            ],
            usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
          }),
        );
        response.writeHead(200, {
          "content-type": "application/json",
          "content-length": output.length,
        });
        response.end(output);
        return;
      }

      if (request.url === "/sse") {
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "x-upstream": "sse",
        });
        const frames = [
          'event: response.created\ndata: {"type":"response.created"}\n\n',
          'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hello"}\n\n',
          'event: response.completed\ndata: {"type":"response.completed"}\n\n',
        ];
        let index = 0;
        const writeNext = () => {
          const frame = frames[index];
          if (frame === undefined) {
            response.end();
            return;
          }
          response.write(frame);
          index += 1;
          setImmediate(writeNext);
        };
        writeNext();
        return;
      }

      if (request.url === "/disconnect") {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write("data: partial\n\n");
        setTimeout(() => response.socket?.destroy(), 10);
        return;
      }

      if (request.url === "/slow") {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write("data: first\n\n");
        const interval = setInterval(() => {
          response.write("data: more\n\n");
        }, 10);
        response.on("close", () => clearInterval(interval));
        return;
      }

      if (request.url === "/never") {
        return;
      }

      const output = Buffer.concat([Buffer.from("upstream:"), body]);
      response.writeHead(201, "Recorded", {
        "content-type": "application/octet-stream",
        "content-length": output.length,
        "x-upstream": "fixture",
        "set-cookie": ["one=1; HttpOnly", "two=2; Secure"],
      });
      response.end(output);
    });
  });
  const origin = await listen(server);
  upstreams.push(server);
  return { origin, observations, server };
}

async function makeStorage(): Promise<{
  storage: BlackBoxStorage;
  root: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "blackbox-proxy-test-"));
  roots.push(root);
  const storage = await openBlackBoxStorage({
    databasePath: join(root, "blackbox.sqlite"),
    dataDirectory: join(root, "data"),
  });
  storages.push(storage);
  return { storage, root };
}

async function makeProxy(
  upstream: string,
  storage: BlackBoxStorage,
  overrides: Partial<ConstructorParameters<typeof RecorderProxy>[0]> = {},
): Promise<RecorderProxy> {
  const proxy = new RecorderProxy({
    storage,
    upstream,
    listenHost: "127.0.0.1",
    listenPort: 0,
    ...overrides,
  });
  await proxy.start();
  proxies.push(proxy);
  return proxy;
}

async function requestBytes(
  origin: string,
  path: string,
  body: Buffer,
  headers: Record<string, string> = {},
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const destination = new URL(origin);
    const request = httpRequest(
      {
        protocol: destination.protocol,
        hostname: destination.hostname,
        port: destination.port,
        path,
        method: "POST",
        headers: {
          "content-length": body.length,
          ...headers,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks),
            chunks,
          });
        });
        response.on("aborted", () => reject(new Error("response aborted")));
        response.on("error", reject);
      },
    );
    request.on("error", reject);
    const midpoint = Math.floor(body.length / 2);
    request.write(body.subarray(0, midpoint));
    request.end(body.subarray(midpoint));
  });
}

function startHangingRequest(
  origin: string,
  path: string,
  body: Buffer,
  headers: Record<string, string> = {},
): ClientRequest {
  const destination = new URL(origin);
  const request = httpRequest({
    protocol: destination.protocol,
    hostname: destination.hostname,
    port: destination.port,
    path,
    method: "POST",
    headers: {
      "content-length": body.length,
      ...headers,
    },
  });
  request.on("response", (response) => response.resume());
  request.on("error", () => undefined);
  request.end(body);
  return request;
}

function latestRawExchange(storage: BlackBoxStorage) {
  const row = storage.unsafeDatabase
    .prepare(
      "SELECT id FROM raw_exchanges ORDER BY created_at DESC, id DESC LIMIT 1",
    )
    .get() as { id: string } | undefined;
  if (row === undefined) {
    throw new Error("Expected a raw exchange.");
  }
  return storage.rawExchanges.getRequired(row.id);
}

function createCodexSession(
  storage: BlackBoxStorage,
  id: string,
  upstreamOrigin: string,
): void {
  storage.sessions.create({
    schemaVersion: 1,
    id,
    startedAt: new Date().toISOString(),
    status: "active",
    captureLevel: "wrapped-process",
    agentName: "codex",
    models: [],
    upstreamOrigin,
    upstreamRoute: "codex-auth",
    tags: [],
    counts: {
      events: 0,
      errors: 0,
      inputTokens: null,
      outputTokens: null,
    },
    metadata: {
      internalAnalysis: false,
      sessionization: { source: "explicit-wrapper" },
    },
  });
}

async function eventually(
  predicate: () => boolean,
  timeoutMilliseconds = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Condition was not satisfied before timeout.");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

afterEach(async () => {
  for (const proxy of proxies.splice(0)) {
    await proxy.close();
  }
  for (const server of upstreams.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const storage of storages.splice(0)) {
    storage.close();
  }
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("byte-faithful recorder proxy", () => {
  it("forwards JSON bytes and credentials while storing only safe evidence", async () => {
    const upstream = await makeUpstream();
    const { storage } = await makeStorage();
    const proxy = await makeProxy(upstream.origin, storage);
    const body = Buffer.from('{"model":"fixture","input":"hello"}');
    const secret = "Bearer sk-fixture-never-persist";
    const anthropicSecret = "sk-ant-fixture-never-persist";
    const cookie = "session=fixture-never-persist";
    const result = await requestBytes(
      proxy.address()?.origin as string,
      "/v1/responses",
      body,
      {
        authorization: secret,
        "x-api-key": anthropicSecret,
        cookie,
        "x-blackbox-session": "session-explicit",
        "content-type": "application/json",
      },
    );
    await proxy.flush();

    expect(result.status).toBe(201);
    expect(result.body).toEqual(
      Buffer.concat([Buffer.from("upstream:"), body]),
    );
    expect(result.headers["x-upstream"]).toBe("fixture");
    expect(result.headers["set-cookie"]).toEqual([
      "one=1; HttpOnly",
      "two=2; Secure",
    ]);
    expect(upstream.observations[0]?.headers.authorization).toBe(secret);
    expect(upstream.observations[0]?.headers["x-api-key"]).toBe(
      anthropicSecret,
    );
    expect(upstream.observations[0]?.headers.cookie).toBe(cookie);
    expect(
      upstream.observations[0]?.headers["x-blackbox-session"],
    ).toBeUndefined();

    const raw = latestRawExchange(storage);
    expect(raw.sessionId).toBe("session-explicit");
    expect(raw.outcome).toBe("completed");
    expect(raw.firstByteAt).toBeDefined();
    expect(raw.endedAt).toBeDefined();
    expect(Date.parse(raw.firstByteAt as string)).toBeGreaterThanOrEqual(
      Date.parse(raw.startedAt),
    );
    expect(Date.parse(raw.endedAt as string)).toBeGreaterThanOrEqual(
      Date.parse(raw.firstByteAt as string),
    );
    expect(raw.requestHeaders.authorization).toBeUndefined();
    expect(raw.requestHeaders["x-api-key"]).toBeUndefined();
    expect(raw.requestHeaders.cookie).toBeUndefined();
    expect(raw.responseHeaders?.["set-cookie"]).toBeUndefined();
    expect(await storage.blobs.get(raw.requestBodyRef?.id as string)).toEqual(
      body,
    );
    expect(await storage.blobs.get(raw.responseBodyRef?.id as string)).toEqual(
      result.body,
    );
    storage.checkpoint("TRUNCATE");
    const databaseBytes = await readFile(storage.databasePath);
    expect(databaseBytes.includes(Buffer.from(secret))).toBe(false);
    expect(databaseBytes.includes(Buffer.from(anthropicSecret))).toBe(false);
    expect(databaseBytes.includes(Buffer.from(cookie))).toBe(false);
    const blobIds = storage.unsafeDatabase
      .prepare("SELECT id FROM blobs ORDER BY id")
      .all() as { id: string }[];
    for (const { id } of blobIds) {
      const blob = Buffer.from(await storage.blobs.get(id));
      expect(blob.includes(Buffer.from(secret))).toBe(false);
      expect(blob.includes(Buffer.from(cookie))).toBe(false);
    }
  });

  it("normalizes finalized exchanges durably and idempotently", async () => {
    const upstream = await makeUpstream();
    const { storage } = await makeStorage();
    const proxy = await makeProxy(upstream.origin, storage);
    const body = Buffer.from(
      JSON.stringify({ model: "normalize-fixture", input: "hello" }),
    );
    const result = await requestBytes(
      proxy.address()?.origin as string,
      "/v1/responses",
      body,
      {
        "content-type": "application/json",
        "x-blackbox-session": "session-normalization",
      },
    );
    await proxy.flush();

    expect(result.status).toBe(200);
    const raw = latestRawExchange(storage);
    const events = storage.events.list("session-normalization").events;
    expect(raw.parseStatus).toBe("parsed");
    expect(events.map((event) => event.type)).toEqual([
      "model.request",
      "message.assistant",
      "model.usage",
      "model.response.completed",
    ]);
    expect(events.map((event) => event.sequence)).toEqual([2, 3, 4, 5]);
    expect(events[1]?.summary).toEqual({
      messageId: "msg_normalized",
      text: "normalized",
    });
    expect(
      storage.sessions.getRequired("session-normalization").counts,
    ).toEqual({
      events: 4,
      errors: 0,
      inputTokens: null,
      outputTokens: null,
    });
    expect(
      storage.sessions.getRequired("session-normalization").metadata,
    ).toMatchObject({
      internalAnalysis: false,
      sessionization: { source: "explicit", heuristic: false },
      captureConfiguration: {
        maxRequestBodyBytes: proxy.configuration.maxRequestBodyBytes,
        maxResponseBodyBytes: proxy.configuration.maxResponseBodyBytes,
        transports: ["http-json", "http-sse"],
      },
      normalizerVersions: {
        "openai.responses": "1.2.0",
        "openai.chat-completions": "1.1.0",
        "unknown-openai-compatible": "1.0.0",
      },
    });

    const rerun = await new DurableNormalizationRunner(
      storage,
    ).normalizeExchange(raw.id);
    expect(rerun.inserted).toBe(false);
    expect(storage.events.count("session-normalization")).toBe(4);
  });

  it("continues a known response ancestry session and strips grouping signals", async () => {
    const upstream = await makeUpstream();
    const { storage } = await makeStorage();
    let proxy = await makeProxy(upstream.origin, storage);
    const body = Buffer.from(
      JSON.stringify({ model: "normalize-fixture", input: "hello" }),
    );

    await requestBytes(
      proxy.address()?.origin as string,
      "/v1/responses",
      body,
      {
        "content-type": "application/json",
        "x-blackbox-session": "session-ancestry",
      },
    );
    await proxy.flush();
    await proxy.close();
    proxies.splice(proxies.indexOf(proxy), 1);
    proxy = await makeProxy(upstream.origin, storage);
    await requestBytes(
      proxy.address()?.origin as string,
      "/v1/responses",
      Buffer.from(
        JSON.stringify({
          model: "normalize-fixture",
          previous_response_id: "resp_normalized",
          input: "continue",
        }),
      ),
      {
        "content-type": "application/json",
        "x-blackbox-response-ancestor": "resp_normalized",
        "x-blackbox-client-id": "different-client",
      },
    );
    await proxy.flush();

    const rows = storage.unsafeDatabase
      .prepare("SELECT id FROM raw_exchanges ORDER BY sequence, id")
      .all() as { id: string }[];
    const exchanges = rows.map(({ id }) =>
      storage.rawExchanges.getRequired(id),
    );
    expect(exchanges).toHaveLength(2);
    expect(exchanges.map((exchange) => exchange.sessionId)).toEqual([
      "session-ancestry",
      "session-ancestry",
    ]);
    expect(
      exchanges[1]?.requestHeaders["x-blackbox-response-ancestor"],
    ).toBeUndefined();
    expect(
      upstream.observations[1]?.headers["x-blackbox-response-ancestor"],
    ).toBeUndefined();
    expect(
      upstream.observations[1]?.headers["x-blackbox-client-id"],
    ).toBeUndefined();
    expect(
      storage.events
        .list("session-ancestry", { type: "model.request" })
        .events.at(-1)?.summary,
    ).toEqual({
      previousResponseId: "resp_normalized",
      contextCompleteness: "complete-client-chain",
    });
  });

  it("keeps internal analysis traffic out of the investigated session", async () => {
    const upstream = await makeUpstream();
    const { storage } = await makeStorage();
    const proxy = await makeProxy(upstream.origin, storage);

    await requestBytes(
      proxy.address()?.origin as string,
      "/v1/future-operation",
      Buffer.from("investigated"),
      { "x-blackbox-session": "session-investigated" },
    );
    await requestBytes(
      proxy.address()?.origin as string,
      "/v1/future-operation",
      Buffer.from("analysis"),
      {
        "x-blackbox-session": "session-investigated",
        "x-blackbox-analysis-session": "analysis-run-1",
        "x-blackbox-analysis-target": "session-investigated",
      },
    );
    await proxy.flush();

    const sessions = storage.sessions.list();
    const analysis = sessions.find(
      (session) => session.metadata.internalAnalysis === true,
    );
    expect(analysis).toBeDefined();
    expect(analysis?.id).not.toBe("session-investigated");
    expect(analysis).toMatchObject({
      captureLevel: "api",
      tags: ["internal-analysis"],
      metadata: {
        internalAnalysis: true,
        analysisTargetSessionId: "session-investigated",
        sessionization: { source: "analysis" },
      },
    });
    expect(storage.events.count("session-investigated")).toBe(1);
    expect(storage.events.count(analysis?.id as string)).toBe(1);
    const analysisRawRow = storage.unsafeDatabase
      .prepare("SELECT id FROM raw_exchanges WHERE session_id = ?")
      .get(analysis?.id) as { id: string };
    const analysisRaw = storage.rawExchanges.getRequired(analysisRawRow.id);
    expect(
      analysisRaw.requestHeaders["x-blackbox-analysis-session"],
    ).toBeUndefined();
    expect(
      upstream.observations[1]?.headers["x-blackbox-analysis-session"],
    ).toBeUndefined();
    expect(
      upstream.observations[1]?.headers["x-blackbox-session"],
    ).toBeUndefined();
  });

  it("fails open and reports normalization infrastructure failures", async () => {
    const upstream = await makeUpstream();
    const { storage } = await makeStorage();
    const proxy = await makeProxy(upstream.origin, storage, {
      normalizationRunner: {
        async normalizeExchange() {
          throw new Error("normalization fixture failure");
        },
      },
    });
    const body = Buffer.from("still-forwarded-after-normalizer-failure");
    const result = await requestBytes(
      proxy.address()?.origin as string,
      "/v1/future-operation",
      body,
    );
    await proxy.flush();

    expect(result.body).toEqual(
      Buffer.concat([Buffer.from("upstream:"), body]),
    );
    expect(latestRawExchange(storage).parseStatus).toBe("pending");
    expect(proxy.health()).toMatchObject({
      status: "degraded",
      captureFailures: 0,
      normalizationFailures: 1,
      lastError: "normalization fixture failure",
    });
  });

  it("preserves SSE bytes, frame order, and response chunk provenance", async () => {
    const upstream = await makeUpstream();
    const direct = await requestBytes(upstream.origin, "/sse", Buffer.alloc(0));
    const { storage } = await makeStorage();
    const proxy = await makeProxy(upstream.origin, storage);
    const recorded = await requestBytes(
      proxy.address()?.origin as string,
      "/sse",
      Buffer.alloc(0),
    );
    await proxy.flush();

    expect(recorded.status).toBe(direct.status);
    expect(recorded.body).toEqual(direct.body);
    expect(
      recorded.body.toString("utf8").split("\n\n").filter(Boolean),
    ).toEqual(direct.body.toString("utf8").split("\n\n").filter(Boolean));
    const raw = latestRawExchange(storage);
    expect(await storage.blobs.get(raw.responseBodyRef?.id as string)).toEqual(
      direct.body,
    );
    const manifest = ChunkManifestSchema.parse(
      JSON.parse(
        Buffer.from(
          await storage.blobs.get(raw.streamManifestRef?.id as string),
        ).toString("utf8"),
      ),
    );
    expect(manifest.completed).toBe(true);
    expect(
      manifest.entries.filter((entry) => entry.direction === "response"),
    ).toHaveLength(3);
  });

  it("bounds chunk provenance without changing SSE bytes", async () => {
    const upstream = await makeUpstream();
    const direct = await requestBytes(upstream.origin, "/sse", Buffer.alloc(0));
    const { storage } = await makeStorage();
    const proxy = await makeProxy(upstream.origin, storage, {
      maxChunkManifestEntries: 1,
    });
    const recorded = await requestBytes(
      proxy.address()?.origin as string,
      "/sse",
      Buffer.alloc(0),
    );
    await proxy.flush();

    expect(recorded.body).toEqual(direct.body);
    const raw = latestRawExchange(storage);
    const manifest = ChunkManifestSchema.parse(
      JSON.parse(
        Buffer.from(
          await storage.blobs.get(raw.streamManifestRef?.id as string),
        ).toString("utf8"),
      ),
    );
    expect(raw.outcome).toBe("capture-incomplete");
    expect(manifest.truncated).toBe(true);
    expect(manifest.entries).toHaveLength(1);
    expect(manifest.droppedEntryCount).toBeGreaterThan(0);
    expect(proxy.health()).toMatchObject({
      status: "degraded",
      droppedManifestEntries: manifest.droppedEntryCount,
    });
  });

  it("forwards unknown v1 routes transparently", async () => {
    const upstream = await makeUpstream();
    const { storage } = await makeStorage();
    const proxy = await makeProxy(upstream.origin, storage);
    const body = Buffer.from("opaque-body");
    const result = await requestBytes(
      proxy.address()?.origin as string,
      "/v1/future-operation?mode=opaque",
      body,
    );
    await proxy.flush();

    expect(result.body).toEqual(
      Buffer.concat([Buffer.from("upstream:"), body]),
    );
    const raw = latestRawExchange(storage);
    expect(raw.protocol).toBe("unknown-openai-compatible");
    expect(raw.path).toBe("/v1/future-operation");
    expect(raw.query).toEqual({ mode: ["opaque"] });
  });

  it("keeps absolute-form request targets on the configured upstream", async () => {
    const upstream = await makeUpstream();
    const unintended = await makeUpstream();
    const { storage } = await makeStorage();
    const proxy = await makeProxy(upstream.origin, storage);
    const body = Buffer.from("absolute-target");

    const result = await requestBytes(
      proxy.address()?.origin as string,
      `${unintended.origin}/v1/future-operation?mode=absolute`,
      body,
    );
    await proxy.flush();

    expect(result.status).toBe(201);
    expect(upstream.observations.at(-1)?.path).toBe(
      "/v1/future-operation?mode=absolute",
    );
    expect(unintended.observations).toHaveLength(0);
  });

  it("records prototype-shaped query names without property injection", async () => {
    const upstream = await makeUpstream();
    const { storage } = await makeStorage();
    const proxy = await makeProxy(upstream.origin, storage);

    const result = await requestBytes(
      proxy.address()?.origin as string,
      "/v1/future-operation?__proto__=one&__proto__=two&constructor=three",
      Buffer.from("query-keys"),
    );
    await proxy.flush();

    expect(result.status).toBe(201);
    const query = latestRawExchange(storage).query;
    expect(Object.hasOwn(query, "__proto__")).toBe(true);
    expect(query["__proto__"]).toEqual(["one", "two"]);
    expect(Object.hasOwn(query, "constructor")).toBe(true);
    expect(query["constructor"]).toEqual(["three"]);
  });

  it("rewrites a session-scoped wrapper route before forwarding", async () => {
    const upstream = await makeUpstream();
    const { storage } = await makeStorage();
    const proxy = await makeProxy(upstream.origin, storage);
    const base = new URL(
      sessionScopedProxyBaseUrl(
        proxy.address()?.origin as string,
        "session-wrapper-route",
      ),
    );
    const body = Buffer.from("wrapper-route");

    const result = await requestBytes(
      base.origin,
      `${base.pathname}/future-operation?mode=wrapper`,
      body,
    );
    await proxy.flush();

    expect(result.body).toEqual(
      Buffer.concat([Buffer.from("upstream:"), body]),
    );
    expect(upstream.observations.at(-1)?.path).toBe(
      "/v1/future-operation?mode=wrapper",
    );
    const raw = latestRawExchange(storage);
    expect(raw).toMatchObject({
      sessionId: "session-wrapper-route",
      path: "/v1/future-operation",
      query: { mode: ["wrapper"] },
    });
  });

  it("routes Codex account and API-key sessions without persisting identity headers", async () => {
    const apiUpstream = await makeUpstream();
    const chatGptUpstream = await makeUpstream();
    const { storage } = await makeStorage();
    const proxy = await makeProxy(apiUpstream.origin, storage, {
      codexApiUpstreamOrigin: apiUpstream.origin,
      codexChatGptUpstreamOrigin: chatGptUpstream.origin,
    });
    const proxyOrigin = proxy.address()?.origin as string;

    createCodexSession(storage, "session-codex-account", apiUpstream.origin);
    const accountBase = new URL(
      sessionScopedProxyBaseUrl(proxyOrigin, "session-codex-account"),
    );
    await requestBytes(
      accountBase.origin,
      `${accountBase.pathname}/responses?mode=account`,
      Buffer.from('{"model":"fixture","input":"account"}'),
      {
        authorization: "Bearer account-token-never-persist",
        "chatgpt-account-id": "account-id-never-persist",
        "content-type": "application/json",
      },
    );

    createCodexSession(storage, "session-codex-api-key", apiUpstream.origin);
    const apiBase = new URL(
      sessionScopedProxyBaseUrl(proxyOrigin, "session-codex-api-key"),
    );
    await requestBytes(
      apiBase.origin,
      `${apiBase.pathname}/responses?mode=api-key`,
      Buffer.from('{"model":"fixture","input":"api"}'),
      {
        authorization: "Bearer sk-api-never-persist",
        "content-type": "application/json",
      },
    );
    await proxy.flush();

    expect(chatGptUpstream.observations).toHaveLength(1);
    expect(chatGptUpstream.observations[0]?.path).toBe(
      "/backend-api/codex/responses?mode=account",
    );
    expect(chatGptUpstream.observations[0]?.headers["chatgpt-account-id"]).toBe(
      "account-id-never-persist",
    );
    expect(apiUpstream.observations).toHaveLength(1);
    expect(apiUpstream.observations[0]?.path).toBe(
      "/v1/responses?mode=api-key",
    );

    expect(storage.sessions.getRequired("session-codex-account")).toMatchObject(
      {
        upstreamOrigin: chatGptUpstream.origin,
        upstreamRoute: "codex-auth",
        metadata: { providerAuthentication: "chatgpt-account" },
      },
    );
    expect(storage.sessions.getRequired("session-codex-api-key")).toMatchObject(
      {
        upstreamOrigin: apiUpstream.origin,
        upstreamRoute: "codex-auth",
        metadata: { providerAuthentication: "api-key" },
      },
    );
    const recorded = storage.unsafeDatabase
      .prepare(
        "SELECT id FROM raw_exchanges WHERE session_id = ? ORDER BY sequence DESC LIMIT 1",
      )
      .get("session-codex-account") as { id: string };
    const raw = storage.rawExchanges.getRequired(recorded.id);
    expect(raw.requestHeaders.authorization).toBeUndefined();
    expect(raw.requestHeaders["chatgpt-account-id"]).toBeUndefined();
    storage.checkpoint("TRUNCATE");
    const databaseBytes = await readFile(storage.databasePath);
    expect(
      databaseBytes.includes(Buffer.from("account-id-never-persist")),
    ).toBe(false);
  });

  it("rejects unsupported WebSocket upgrades explicitly", async () => {
    const upstream = await makeUpstream();
    const { storage } = await makeStorage();
    const proxy = await makeProxy(upstream.origin, storage);
    const address = proxy.address();
    if (address === undefined) {
      throw new Error("Expected proxy address.");
    }

    const response = await new Promise<string>((resolve, reject) => {
      const socket = connect(address.port, address.host);
      const chunks: Buffer[] = [];
      socket.on("connect", () => {
        socket.write(
          "GET /v1/responses HTTP/1.1\r\n" +
            `Host: ${address.host}:${address.port}\r\n` +
            "Connection: Upgrade\r\n" +
            "Upgrade: websocket\r\n\r\n",
        );
      });
      socket.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      socket.on("end", () => resolve(Buffer.concat(chunks).toString("ascii")));
      socket.on("error", reject);
    });

    expect(response).toMatch(/^HTTP\/1\.1 426 Upgrade Required\r\n/u);
    expect(upstream.observations).toHaveLength(0);
  });

  it("bounds capture memory without truncating forwarded traffic", async () => {
    const upstream = await makeUpstream();
    const { storage } = await makeStorage();
    const proxy = await makeProxy(upstream.origin, storage, {
      captureQueueMaxBytes: 64,
      maxRequestBodyBytes: 32,
      maxResponseBodyBytes: 32,
    });
    const body = Buffer.alloc(256, 5);
    const result = await requestBytes(
      proxy.address()?.origin as string,
      "/large",
      body,
    );
    await proxy.flush();

    expect(result.body).toEqual(
      Buffer.concat([Buffer.from("upstream:"), body]),
    );
    const raw = latestRawExchange(storage);
    expect(raw.outcome).toBe("capture-incomplete");
    expect(raw.capture.droppedRequestBytes).toBe(224);
    expect(raw.capture.droppedResponseBytes).toBe(result.body.length - 32);
    expect(raw.requestBodyRef?.byteLength).toBe(32);
    expect(raw.responseBodyRef?.byteLength).toBe(32);
    expect(proxy.health()).toMatchObject({
      status: "degraded",
      droppedCaptureBytes: 224 + result.body.length - 32,
    });
  });

  it("fails open for recorder database errors", async () => {
    const upstream = await makeUpstream();
    const { storage } = await makeStorage();
    const proxy = await makeProxy(upstream.origin, storage);
    storage.close();
    storages.splice(storages.indexOf(storage), 1);
    const body = Buffer.from("still-forwarded");

    const result = await requestBytes(
      proxy.address()?.origin as string,
      "/open",
      body,
    );
    await proxy.flush();

    expect(result.body).toEqual(
      Buffer.concat([Buffer.from("upstream:"), body]),
    );
    expect(proxy.health().status).toBe("degraded");
    expect(proxy.health().captureFailures).toBeGreaterThan(0);
  });
});

describe("transport failure evidence", () => {
  it("settles and exports an in-flight terminal session during shutdown", async () => {
    const upstream = await makeUpstream();
    const { storage } = await makeStorage();
    const proxy = await makeProxy(upstream.origin, storage);
    const request = startHangingRequest(
      proxy.address()?.origin as string,
      "/never",
      Buffer.from('{"model":"fixture","input":"shutdown"}'),
      {
        "content-type": "application/json",
        "x-blackbox-session": "session-shutdown-settlement",
      },
    );
    await eventually(() => proxy.health().activeRequests === 1);
    const session = storage.sessions.getRequired("session-shutdown-settlement");
    storage.sessions.replace({
      ...session,
      status: "completed",
      endedAt: new Date().toISOString(),
    });

    await proxy.close(25);
    await eventually(() => request.destroyed);

    const raw = latestRawExchange(storage);
    expect(raw).toMatchObject({
      sessionId: "session-shutdown-settlement",
      outcome: "client-disconnected",
      capture: { responseComplete: false },
    });
    expect(raw.parseStatus).not.toBe("pending");
    expect(raw.endedAt).toBeDefined();
    expect(storage.rawExchanges.getJournalState(raw.id)).toBe("complete");
    expect(proxy.health()).toMatchObject({
      activeRequests: 0,
      requestsStarted: 1,
      requestsCompleted: 1,
      clientDisconnects: 1,
    });
    await expect(
      exportBbxArchive(storage, {
        sessionId: "session-shutdown-settlement",
        profile: "share",
      }),
    ).resolves.toMatchObject({
      archive: {
        manifest: {
          sourceSessionId: "session-shutdown-settlement",
          profile: "share",
        },
      },
    });
  });

  it("records upstream connection failures separately", async () => {
    const upstream = await makeUpstream();
    const { storage } = await makeStorage();
    const proxy = await makeProxy(upstream.origin, storage);
    await new Promise<void>((resolve) =>
      upstream.server.close(() => resolve()),
    );
    upstreams.splice(upstreams.indexOf(upstream.server), 1);

    const result = await requestBytes(
      proxy.address()?.origin as string,
      "/offline",
      Buffer.alloc(0),
    );
    await proxy.flush();

    expect(result.status).toBe(502);
    expect(latestRawExchange(storage).outcome).toBe("upstream-error");
    expect(proxy.health().upstreamFailures).toBe(1);
  });

  it("records an explicitly configured upstream timeout", async () => {
    const upstream = await makeUpstream();
    const { storage } = await makeStorage();
    const proxy = await makeProxy(upstream.origin, storage, {
      upstreamTimeoutMs: 25,
    });

    const result = await requestBytes(
      proxy.address()?.origin as string,
      "/never",
      Buffer.alloc(0),
    );
    await proxy.flush();

    expect(result.status).toBe(502);
    const raw = latestRawExchange(storage);
    expect(raw.outcome).toBe("timeout");
    expect(raw.firstByteAt).toBeUndefined();
    expect(raw.endedAt).toBeDefined();
    expect(proxy.health().upstreamFailures).toBe(1);
  });

  it("records a mid-stream upstream disconnect with partial evidence", async () => {
    const upstream = await makeUpstream();
    const { storage } = await makeStorage();
    const proxy = await makeProxy(upstream.origin, storage);

    await expect(
      requestBytes(
        proxy.address()?.origin as string,
        "/disconnect",
        Buffer.alloc(0),
      ),
    ).rejects.toThrow();
    await eventually(() => proxy.health().upstreamFailures === 1);
    await proxy.flush();

    const raw = latestRawExchange(storage);
    expect(raw.outcome).toBe("upstream-disconnected");
    expect(raw.capture.responseComplete).toBe(false);
  });

  it("distinguishes a client cancellation from an upstream disconnect", async () => {
    const upstream = await makeUpstream();
    const { storage } = await makeStorage();
    const proxy = await makeProxy(upstream.origin, storage);

    await new Promise<void>((resolve, reject) => {
      const request = httpRequest(
        new URL("/slow", proxy.address()?.origin),
        { method: "POST", headers: { "content-length": 0 } },
        (response) => {
          response.once("data", () => {
            response.destroy();
            request.destroy();
            resolve();
          });
        },
      );
      request.on("error", (error) => {
        if ((error as NodeJS.ErrnoException).code !== "ECONNRESET") {
          reject(error);
        }
      });
      request.end();
    });
    await eventually(() => proxy.health().clientDisconnects === 1);
    await proxy.flush();

    expect(latestRawExchange(storage).outcome).toBe("client-disconnected");
    expect(proxy.health().clientDisconnects).toBe(1);
  });
});
