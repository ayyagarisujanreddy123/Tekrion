import { createServer, request as httpRequest, type Server } from "node:http";
import { connect } from "node:net";
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import {
  BlackBoxDaemon,
  ControlServer,
  CorruptDaemonLockError,
  DaemonAlreadyRunningError,
  DaemonLock,
  UnsafeControlBindError,
  ViewerAssets,
  ensureControlToken,
  readControlToken,
  readDaemonLockRecord,
  resolveDaemonPaths,
  type DaemonStatus,
} from "../src/index.js";

interface ControlResult {
  readonly status: number;
  readonly body: string;
  readonly headers: Record<string, string | string[] | undefined>;
}

const roots: string[] = [];
const daemons: BlackBoxDaemon[] = [];
const servers: Server[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "blackbox-lifecycle-test-"));
  roots.push(root);
  return root;
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  servers.push(server);
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function makeUpstream(): Promise<string> {
  return listen(
    createServer((request, response) => {
      request.resume();
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"ok":true}');
    }),
  );
}

async function controlRequest(
  origin: string,
  path: string,
  options: {
    readonly method?: string;
    readonly token?: string;
    readonly origin?: string;
    readonly host?: string;
  } = {},
): Promise<ControlResult> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      new URL(path, origin),
      {
        method: options.method ?? "GET",
        headers: {
          ...(options.token === undefined
            ? {}
            : { authorization: `Bearer ${options.token}` }),
          ...(options.origin === undefined ? {} : { origin: options.origin }),
          ...(options.host === undefined ? {} : { host: options.host }),
          "content-length": 0,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
            headers: response.headers,
          });
        });
      },
    );
    request.on("error", reject);
    request.end();
  });
}

async function eventually(
  predicate: () => boolean | Promise<boolean>,
  timeoutMilliseconds = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (!(await predicate())) {
    if (Date.now() >= deadline) {
      throw new Error("Condition was not satisfied before timeout.");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function fixtureStatus(): DaemonStatus {
  return {
    schemaVersion: 1,
    instanceId: "daemon-control-fixture",
    pid: process.pid,
    state: "ready",
    startedAt: "2026-07-16T12:00:00.000Z",
    proxyOrigin: "http://127.0.0.1:4141",
    controlOrigin: "http://127.0.0.1:4142",
    upstreamOrigin: "https://api.openai.com",
    proxy: {
      status: "healthy",
      activeRequests: 0,
      requestsStarted: 0,
      requestsCompleted: 0,
      captureFailures: 0,
      normalizationFailures: 0,
      droppedCaptureBytes: 0,
      droppedManifestEntries: 0,
      clientDisconnects: 0,
      upstreamFailures: 0,
    },
    storage: {
      schemaVersion: 1,
      readOnly: false,
      recoveredIncompleteExchanges: 0,
      removedTemporaryBlobs: 0,
    },
  };
}

afterEach(async () => {
  for (const daemon of daemons.splice(0)) {
    await daemon.stop().catch(() => undefined);
  }
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("private install credentials", () => {
  it("creates one random token with private directory and file modes", async () => {
    const root = await temporaryRoot();
    const paths = resolveDaemonPaths(root);

    const first = await ensureControlToken(
      paths.homeDirectory,
      paths.tokenPath,
    );
    const second = await ensureControlToken(
      paths.homeDirectory,
      paths.tokenPath,
    );

    expect(first).toMatch(/^[A-Za-z\d_-]{43}$/u);
    expect(second).toBe(first);
    expect(await readControlToken(paths.tokenPath)).toBe(first);
    expect((await stat(paths.homeDirectory)).mode & 0o777).toBe(0o700);
    expect((await stat(paths.tokenPath)).mode & 0o777).toBe(0o600);
  });

  it("rejects malformed existing token material", async () => {
    const root = await temporaryRoot();
    const paths = resolveDaemonPaths(root);
    await writeFile(paths.tokenPath, "predictable-token\n", { mode: 0o644 });

    await expect(readControlToken(paths.tokenPath)).rejects.toThrow(
      "Control token is invalid",
    );
    expect((await stat(paths.tokenPath)).mode & 0o777).toBe(0o600);
  });

  it("refuses a symlinked control-token target", async () => {
    const root = await temporaryRoot();
    const paths = resolveDaemonPaths(root);
    const targetPath = join(root, "target.token");
    await writeFile(targetPath, "A".repeat(43), { mode: 0o600 });
    await symlink(targetPath, paths.tokenPath);

    await expect(readControlToken(paths.tokenPath)).rejects.toThrow(
      "Sensitive path is not a regular file",
    );
  });
});

describe("daemon lock ownership and recovery", () => {
  it("rejects a live owner and keeps the lock private", async () => {
    const root = await temporaryRoot();
    const path = resolveDaemonPaths(root).lockPath;
    const first = await DaemonLock.acquire({
      path,
      instanceId: "daemon-first",
      pid: 101,
      processAlive: () => true,
    });

    await expect(
      DaemonLock.acquire({
        path,
        instanceId: "daemon-second",
        pid: 202,
        processAlive: () => true,
      }),
    ).rejects.toBeInstanceOf(DaemonAlreadyRunningError);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await first.release()).toBe(true);
    expect(await readDaemonLockRecord(path)).toBeUndefined();
  });

  it("recovers a dead owner without letting the old owner remove the replacement", async () => {
    const root = await temporaryRoot();
    const path = resolveDaemonPaths(root).lockPath;
    const first = await DaemonLock.acquire({
      path,
      instanceId: "daemon-dead",
      pid: 101,
    });
    const second = await DaemonLock.acquire({
      path,
      instanceId: "daemon-replacement",
      pid: 202,
      processAlive: (pid) => pid === 202,
    });

    expect(second.recovery).toMatchObject({
      reason: "dead-process",
      previous: { instanceId: "daemon-dead", pid: 101 },
    });
    expect(await first.release()).toBe(false);
    expect((await readDaemonLockRecord(path))?.instanceId).toBe(
      "daemon-replacement",
    );
    expect(await second.release()).toBe(true);
  });

  it("recovers a corrupt lock and exposes corruption to direct readers", async () => {
    const root = await temporaryRoot();
    const path = resolveDaemonPaths(root).lockPath;
    await writeFile(path, "{not-json", { mode: 0o600 });

    await expect(readDaemonLockRecord(path)).rejects.toBeInstanceOf(
      CorruptDaemonLockError,
    );
    const lock = await DaemonLock.acquire({
      path,
      instanceId: "daemon-after-corruption",
    });
    expect(lock.recovery).toEqual({ reason: "corrupt" });
    await lock.release();
  });

  it("allows only one winner across concurrent stale-lock recovery", async () => {
    const root = await temporaryRoot();
    const path = resolveDaemonPaths(root).lockPath;
    const stale = await DaemonLock.acquire({
      path,
      instanceId: "daemon-stale-contender",
      pid: 101,
    });
    const claims = await Promise.allSettled(
      Array.from({ length: 8 }, (_, index) =>
        DaemonLock.acquire({
          path,
          instanceId: `daemon-contender-${index}`,
          processAlive: (pid) => pid !== 101,
        }),
      ),
    );
    const winners = claims.filter(
      (claim): claim is PromiseFulfilledResult<DaemonLock> =>
        claim.status === "fulfilled",
    );

    expect(winners).toHaveLength(1);
    expect(claims.filter((claim) => claim.status === "rejected")).toHaveLength(
      7,
    );
    expect(await stale.release()).toBe(false);
    await winners[0]?.value.release();
  });
});

describe("authenticated loopback control API", () => {
  it("requires bearer auth, a loopback Host, and a trusted browser Origin", async () => {
    const token = "a".repeat(43);
    let shutdowns = 0;
    const settledSessions: string[] = [];
    const control = new ControlServer({
      token,
      listenPort: 0,
      status: fixtureStatus,
      shutdown: () => {
        shutdowns += 1;
      },
      settleSession: (sessionId) => {
        settledSessions.push(sessionId);
        return ["exchange-settled"];
      },
    });
    const address = await control.start();

    expect(
      (await controlRequest(address.origin, "/v1/control/status")).status,
    ).toBe(401);
    expect(
      (
        await controlRequest(address.origin, "/v1/control/status", {
          token,
          origin: "https://attacker.example",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await controlRequest(address.origin, "/v1/control/status", {
          token,
          host: "attacker.example",
        })
      ).status,
    ).toBe(403);

    const status = await controlRequest(address.origin, "/v1/control/status", {
      token,
      origin: address.origin,
    });
    expect(status.status).toBe(200);
    expect(JSON.parse(status.body)).toMatchObject({
      instanceId: "daemon-control-fixture",
      state: "ready",
    });
    expect(status.body).not.toContain(token);
    expect(status.headers["cache-control"]).toBe("no-store");

    expect(
      (
        await controlRequest(
          address.origin,
          "/v1/control/sessions/session-run-fixture/settle",
          { method: "POST" },
        )
      ).status,
    ).toBe(401);
    const wrongSettlementMethod = await controlRequest(
      address.origin,
      "/v1/control/sessions/session-run-fixture/settle",
      { token },
    );
    expect(wrongSettlementMethod.status).toBe(405);
    expect(wrongSettlementMethod.headers.allow).toBe("POST");
    expect(settledSessions).toEqual([]);

    const settlement = await controlRequest(
      address.origin,
      "/v1/control/sessions/session-run-fixture/settle",
      { method: "POST", token },
    );
    expect(settlement.status).toBe(200);
    expect(JSON.parse(settlement.body)).toEqual({
      sessionId: "session-run-fixture",
      settledExchangeIds: ["exchange-settled"],
    });
    expect(settledSessions).toEqual(["session-run-fixture"]);

    expect(
      (
        await controlRequest(address.origin, "/v1/control/shutdown", {
          method: "POST",
          token,
        })
      ).status,
    ).toBe(202);
    await eventually(() => shutdowns === 1);
    await control.close();
  });

  it("refuses to expose the control plane beyond loopback", () => {
    expect(
      () =>
        new ControlServer({
          token: "a".repeat(43),
          listenHost: "0.0.0.0",
          status: fixtureStatus,
          shutdown: () => undefined,
        }),
    ).toThrow(UnsafeControlBindError);
  });

  it("serves only the packaged viewer shell without weakening API authentication", async () => {
    const directory = await temporaryRoot();
    await mkdir(join(directory, "assets"));
    await writeFile(
      join(directory, "index.html"),
      '<!doctype html><div id="root"></div>',
    );
    await writeFile(join(directory, "assets", "viewer.js"), "export {};\n");
    await writeFile(
      join(directory, "assets", "viewer.css"),
      "body { color: white; }\n",
    );
    const token = "v".repeat(43);
    const control = new ControlServer({
      token,
      listenPort: 0,
      status: fixtureStatus,
      shutdown: () => undefined,
      viewerAssets: await ViewerAssets.load(directory),
    });
    const address = await control.start();

    const index = await controlRequest(address.origin, "/");
    expect(index).toMatchObject({
      status: 200,
      body: '<!doctype html><div id="root"></div>',
      headers: {
        "cache-control": "no-store",
        "content-type": "text/html; charset=utf-8",
        "x-content-type-options": "nosniff",
        "x-frame-options": "DENY",
      },
    });
    expect(index.headers["content-security-policy"]).toContain(
      "default-src 'none'",
    );
    expect(index.headers["content-security-policy"]).toContain(
      "connect-src 'self'",
    );

    const script = await controlRequest(address.origin, "/assets/viewer.js", {
      origin: address.origin,
    });
    expect(script).toMatchObject({
      status: 200,
      body: "export {};\n",
      headers: {
        "cache-control": "public, max-age=31536000, immutable",
        "content-type": "text/javascript; charset=utf-8",
      },
    });
    expect(
      (
        await controlRequest(address.origin, "/assets/missing.js", {
          token,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await controlRequest(address.origin, "/", {
          origin: "https://attacker.example",
        })
      ).status,
    ).toBe(403);
    expect(
      (await controlRequest(address.origin, "/", { method: "POST" })).headers
        .allow,
    ).toBe("GET, HEAD");
    expect(
      (await controlRequest(address.origin, "/v1/control/status")).status,
    ).toBe(401);
    expect(
      (
        await controlRequest(address.origin, "/v1/control/status", {
          token,
        })
      ).status,
    ).toBe(200);

    await control.close();
  });
});

describe("daemon lifecycle integration", () => {
  it("publishes ready state without exposing its token and stops through control", async () => {
    const root = await temporaryRoot();
    const upstream = await makeUpstream();
    const daemon = new BlackBoxDaemon({
      homeDirectory: root,
      proxy: { listenPort: 0, upstream },
      control: { listenPort: 0 },
      shutdownGraceMilliseconds: 100,
    });
    daemons.push(daemon);
    const status = await daemon.start();
    const token = await readControlToken(daemon.paths.tokenPath);
    const lockText = JSON.stringify(
      await readDaemonLockRecord(daemon.paths.lockPath),
    );

    expect(status).toMatchObject({
      state: "ready",
      upstreamOrigin: upstream,
      proxy: { status: "healthy" },
      storage: { readOnly: false },
    });
    expect(lockText).not.toContain(token);
    expect(await readDaemonLockRecord(daemon.paths.lockPath)).toMatchObject({
      state: "ready",
      proxyOrigin: status.proxyOrigin,
      controlOrigin: status.controlOrigin,
    });
    const remoteStatus = await controlRequest(
      status.controlOrigin,
      "/v1/control/status",
      { token },
    );
    expect(JSON.parse(remoteStatus.body)).toEqual(status);
    expect(remoteStatus.body).not.toContain(token);
    const health = await controlRequest(status.controlOrigin, "/v1/health", {
      token,
    });
    expect(health.status).toBe(200);
    expect(JSON.parse(health.body)).toEqual(status);

    const shutdown = await controlRequest(
      status.controlOrigin,
      "/v1/control/shutdown",
      { method: "POST", token },
    );
    expect(shutdown.status).toBe(202);
    await eventually(() => daemon.lifecycleState === "stopped");
    expect(await readDaemonLockRecord(daemon.paths.lockPath)).toBeUndefined();
  });

  it("rejects a second daemon and permits a clean restart after release", async () => {
    const root = await temporaryRoot();
    const upstream = await makeUpstream();
    const first = new BlackBoxDaemon({
      homeDirectory: root,
      proxy: { listenPort: 0, upstream },
      control: { listenPort: 0 },
    });
    const second = new BlackBoxDaemon({
      homeDirectory: root,
      proxy: { listenPort: 0, upstream },
      control: { listenPort: 0 },
    });
    daemons.push(first, second);
    await first.start();

    await expect(second.start()).rejects.toBeInstanceOf(
      DaemonAlreadyRunningError,
    );
    await first.stop();

    const restarted = new BlackBoxDaemon({
      homeDirectory: root,
      proxy: { listenPort: 0, upstream },
      control: { listenPort: 0 },
    });
    daemons.push(restarted);
    expect((await restarted.start()).state).toBe("ready");
  });

  it("forces lingering proxy connections closed within the shutdown grace", async () => {
    const root = await temporaryRoot();
    const upstream = await makeUpstream();
    const daemon = new BlackBoxDaemon({
      homeDirectory: root,
      proxy: { listenPort: 0, upstream },
      control: { listenPort: 0 },
      shutdownGraceMilliseconds: 25,
    });
    daemons.push(daemon);
    const status = await daemon.start();
    const proxyAddress = new URL(status.proxyOrigin);
    const socket = connect(Number(proxyAddress.port), proxyAddress.hostname);
    socket.on("error", () => undefined);
    await new Promise<void>((resolve) => socket.once("connect", resolve));

    const started = Date.now();
    await daemon.stop();
    expect(Date.now() - started).toBeLessThan(500);
    expect(socket.destroyed).toBe(true);
  });

  it("serializes an early stop request behind startup", async () => {
    const root = await temporaryRoot();
    const upstream = await makeUpstream();
    const daemon = new BlackBoxDaemon({
      homeDirectory: root,
      proxy: { listenPort: 0, upstream },
      control: { listenPort: 0 },
      shutdownGraceMilliseconds: 100,
    });
    daemons.push(daemon);

    const starting = daemon.start();
    const stopping = daemon.stop();
    await starting;
    await stopping;

    expect(daemon.lifecycleState).toBe("stopped");
    expect(await readDaemonLockRecord(daemon.paths.lockPath)).toBeUndefined();
  });
});
