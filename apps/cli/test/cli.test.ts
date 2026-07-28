import { createServer, type Server } from "node:http";
import { EventEmitter } from "node:events";
import {
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BlackBoxDaemon,
  readControlToken,
  resolveDaemonPaths,
  type DaemonPaths,
} from "@blackbox/daemon";
import { openBlackBoxStorage } from "@blackbox/storage";
import { afterEach, describe, expect, it } from "vitest";

import {
  UnsafeControlOriginError,
  createViewerUrl,
  nodeRuntimeCheck,
  parseCliArguments,
  requestDaemonStatus,
  resolveStartConfiguration,
  runCli,
  runDoctor,
  type CliOutput,
  type CliRuntime,
  type ResolvedStartConfiguration,
  type SignalEventSource,
} from "../src/index.js";

class CapturedOutput implements CliOutput {
  value = "";

  write(value: string | Uint8Array): void {
    this.value +=
      typeof value === "string" ? value : Buffer.from(value).toString("utf8");
  }

  clear(): void {
    this.value = "";
  }
}

const roots: string[] = [];
const daemons: BlackBoxDaemon[] = [];
const servers: Server[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "blackbox-cli-test-"));
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

async function upstream(): Promise<string> {
  return listen(
    createServer((request, response) => {
      request.resume();
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"upstream":true}');
    }),
  );
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

function runtime(
  stdout: CapturedOutput,
  stderr: CapturedOutput,
  launchDaemon?: (configuration: ResolvedStartConfiguration) => Promise<number>,
): Partial<CliRuntime> {
  return {
    stdout,
    stderr,
    environment: {},
    ...(launchDaemon === undefined ? {} : { launchDaemon }),
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

describe("CLI initialization and configuration", () => {
  it("reports the candidate version without starting the recorder", async () => {
    const stdout = new CapturedOutput();
    const stderr = new CapturedOutput();

    expect(await runCli(["--version"], runtime(stdout, stderr))).toBe(0);
    expect(stdout.value).toBe("0.1.0\n");
    expect(stderr.value).toBe("");

    stdout.clear();
    expect(await runCli(["-v"], runtime(stdout, stderr))).toBe(0);
    expect(stdout.value).toBe("0.1.0\n");
    expect(stderr.value).toBe("");
  });

  it("initializes private storage idempotently without printing the token", async () => {
    const root = await temporaryRoot();
    const stdout = new CapturedOutput();
    const stderr = new CapturedOutput();
    const paths = resolveDaemonPaths(root);

    expect(
      await runCli(["init", "--home", root], runtime(stdout, stderr)),
    ).toBe(0);
    const token = await readControlToken(paths.tokenPath);
    expect(
      await runCli(["init", "--home", root], runtime(stdout, stderr)),
    ).toBe(0);

    expect(stdout.value).not.toContain(token);
    expect(stderr.value).toBe("");
    expect((await stat(paths.homeDirectory)).mode & 0o777).toBe(0o700);
    expect((await stat(paths.tokenPath)).mode & 0o777).toBe(0o600);
    expect((await stat(paths.databasePath)).mode & 0o777).toBe(0o600);
  });

  it("uses BLACKBOX_UPSTREAM_URL but never reuses OPENAI_BASE_URL", () => {
    const parsed = parseCliArguments(["start", "--proxy-port", "0"]);
    const ignored = resolveStartConfiguration(parsed.flags, {
      OPENAI_BASE_URL: "http://127.0.0.1:9",
    });
    const selected = resolveStartConfiguration(parsed.flags, {
      BLACKBOX_UPSTREAM_URL: "http://127.0.0.1:8080",
      OPENAI_BASE_URL: "http://127.0.0.1:9",
    });

    expect(ignored.proxy.upstream.origin).toBe("https://api.openai.com");
    expect(selected.proxy.upstream.origin).toBe("http://127.0.0.1:8080");
  });

  it("returns a usage error for unknown flags", async () => {
    const stdout = new CapturedOutput();
    const stderr = new CapturedOutput();

    expect(await runCli(["start", "--mystery"], runtime(stdout, stderr))).toBe(
      2,
    );
    expect(stderr.value).toContain("Unknown flag --mystery");
    expect(stderr.value).toContain("blackbox --help");
  });

  it("makes quota and dry-run retention controls visible in help", async () => {
    const stdout = new CapturedOutput();
    const stderr = new CapturedOutput();

    expect(await runCli(["--help"], runtime(stdout, stderr))).toBe(0);
    expect(stderr.value).toBe("");
    expect(stdout.value).toContain("--max-stored-bytes N");
    expect(stdout.value).toContain("blackbox delete <session-id> [--yes]");
    expect(stdout.value).toContain("blackbox prune [--older-than-days N]");
    expect(stdout.value).toContain("Apply a displayed delete/prune plan");
  });
});

describe("CLI daemon lifecycle", () => {
  it("starts idempotently, reports status, and stops through authenticated control", async () => {
    const root = await temporaryRoot();
    const upstreamOrigin = await upstream();
    const stdout = new CapturedOutput();
    const stderr = new CapturedOutput();
    let launches = 0;
    const launch = async (configuration: ResolvedStartConfiguration) => {
      launches += 1;
      const daemon = new BlackBoxDaemon({
        homeDirectory: configuration.paths.homeDirectory,
        proxy: {
          ...configuration.proxy,
          upstream: configuration.proxy.upstream,
        },
        control: {
          listenHost: configuration.controlHost,
          listenPort: configuration.controlPort,
        },
        shutdownGraceMilliseconds: 100,
      });
      daemons.push(daemon);
      await daemon.start();
      return process.pid;
    };
    const cliRuntime = runtime(stdout, stderr, launch);
    const startArguments = [
      "start",
      "--home",
      root,
      "--upstream",
      upstreamOrigin,
      "--proxy-port",
      "0",
      "--control-port",
      "0",
    ];

    expect(await runCli(startArguments, cliRuntime)).toBe(0);
    expect(await runCli(startArguments, cliRuntime)).toBe(0);
    expect(launches).toBe(1);
    expect(stdout.value).toContain("OPENAI_BASE_URL=http://127.0.0.1:");
    const token = await readControlToken(resolveDaemonPaths(root).tokenPath);
    expect(stdout.value).not.toContain(token);

    stdout.clear();
    expect(await runCli(["status", "--home", root, "--json"], cliRuntime)).toBe(
      0,
    );
    expect(JSON.parse(stdout.value)).toMatchObject({
      state: "ready",
      proxy: { status: "healthy" },
    });
    expect(stdout.value).not.toContain(token);

    stdout.clear();
    expect(await runCli(["stop", "--home", root], cliRuntime)).toBe(0);
    expect(stdout.value).toContain("daemon stopped");
    stdout.clear();
    expect(await runCli(["status", "--home", root, "--json"], cliRuntime)).toBe(
      1,
    );
    expect(JSON.parse(stdout.value)).toEqual({ state: "stopped" });
    expect(stderr.value).toBe("");
  });

  it("recovers a corrupt lock during an idempotent stop", async () => {
    const root = await temporaryRoot();
    const paths = resolveDaemonPaths(root);
    const stdout = new CapturedOutput();
    const stderr = new CapturedOutput();
    await writeFile(paths.lockPath, "{corrupt", { mode: 0o600 });

    expect(
      await runCli(["stop", "--home", root], runtime(stdout, stderr)),
    ).toBe(0);
    expect(stdout.value).toContain("removed corrupt lock");
    await expect(readFile(paths.lockPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("will not send a token to a non-loopback lock endpoint", async () => {
    const root = await temporaryRoot();
    const paths: DaemonPaths = resolveDaemonPaths(root);

    await expect(
      requestDaemonStatus(
        {
          schemaVersion: 1,
          instanceId: "daemon-hostile-lock",
          pid: process.pid,
          startedAt: "2026-07-16T12:00:00.000Z",
          updatedAt: "2026-07-16T12:00:00.000Z",
          state: "ready",
          proxyOrigin: "http://127.0.0.1:4141",
          controlOrigin: "https://attacker.example",
        },
        paths,
      ),
    ).rejects.toBeInstanceOf(UnsafeControlOriginError);
  });

  it("runs a child in one proxy/process session and returns its exit code", async () => {
    const root = await temporaryRoot();
    const workspace = await temporaryRoot();
    const upstreamOrigin = await upstream();
    const stdout = new CapturedOutput();
    const stderr = new CapturedOutput();
    const launch = async (configuration: ResolvedStartConfiguration) => {
      const daemon = new BlackBoxDaemon({
        homeDirectory: configuration.paths.homeDirectory,
        proxy: {
          ...configuration.proxy,
          upstream: configuration.proxy.upstream,
        },
        control: {
          listenHost: configuration.controlHost,
          listenPort: configuration.controlPort,
        },
        shutdownGraceMilliseconds: 100,
      });
      daemons.push(daemon);
      await daemon.start();
      return process.pid;
    };
    const script = `
      (async () => {
        const response = await fetch(process.env.OPENAI_BASE_URL + "/responses", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "fixture", input: "wrapped" })
        });
        const body = await response.text();
        await new Promise((resolve) => setTimeout(resolve, 50));
        require("node:fs").writeFileSync("agent-output.txt", "created by child\\n");
        await new Promise((resolve) => setTimeout(resolve, 100));
        process.stdout.write(JSON.stringify({
          base: process.env.OPENAI_BASE_URL,
          session: process.env.BLACKBOX_SESSION_ID,
          status: response.status,
          body
        }));
        process.stderr.write("child-stderr\\n");
        process.exitCode = 7;
      })().catch((error) => {
        process.stderr.write(String(error));
        process.exitCode = 99;
      });
    `;

    const exitCode = await runCli(
      [
        "run",
        "--home",
        root,
        "--upstream",
        upstreamOrigin,
        "--proxy-port",
        "0",
        "--control-port",
        "0",
        "--cwd",
        workspace,
        "--",
        process.execPath,
        "-e",
        script,
      ],
      runtime(stdout, stderr, launch),
    );

    expect(exitCode).toBe(7);
    const childOutput = JSON.parse(stdout.value) as {
      base: string;
      session: string;
      status: number;
      body: string;
    };
    expect(childOutput).toMatchObject({
      status: 200,
      body: '{"upstream":true}',
    });
    expect(childOutput.base).toContain("/.blackbox/session/");
    expect(childOutput.base).toMatch(/\/v1$/u);
    expect(stderr.value).toBe("child-stderr\n");

    const paths = resolveDaemonPaths(root);
    const storage = await openBlackBoxStorage({
      databasePath: paths.databasePath,
      dataDirectory: paths.dataDirectory,
      recoverIncompleteExchanges: false,
    });
    try {
      await eventually(() => {
        const session = storage.sessions.get(childOutput.session);
        return (
          session?.status === "completed" &&
          storage.events
            .list(childOutput.session)
            .events.some((event) => event.type === "model.response.completed")
        );
      });
      const session = storage.sessions.getRequired(childOutput.session);
      const events = storage.events.list(childOutput.session).events;
      expect(session).toMatchObject({
        captureLevel: "wrapped-process",
        status: "completed",
        command: { executable: process.execPath, cwd: workspace },
        repoRoot: await realpath(workspace),
      });
      expect(events.map((event) => event.type)).toEqual(
        expect.arrayContaining([
          "session.started",
          "process.started",
          "process.stdout",
          "process.stderr",
          "process.exited",
          "session.ended",
          "model.response.completed",
          "workspace.snapshot",
          "file.create",
        ]),
      );
      expect(
        events.some(
          (event) =>
            event.type === "file.create" &&
            event.summary.timingPrecision === "approximate-watcher",
        ),
      ).toBe(true);
      const fileEvent = events.find(
        (event) =>
          event.type === "file.create" &&
          event.summary.timingPrecision === "exact-final-diff",
      );
      expect(fileEvent).toMatchObject({
        source: "filesystem",
        summary: {
          path: "agent-output.txt",
          operation: "create",
          payloadKind: "file-delta",
        },
      });
      expect(
        storage.fileChanges.getByEvent(fileEvent?.id as string),
      ).toMatchObject({
        path: "agent-output.txt",
        operation: "create",
        patchBlobId: fileEvent?.payloadRef?.id,
      });
      const rawRow = storage.unsafeDatabase
        .prepare("SELECT id FROM raw_exchanges WHERE session_id = ?")
        .get(childOutput.session) as { id: string };
      expect(storage.rawExchanges.getRequired(rawRow.id).path).toBe(
        "/v1/responses",
      );
    } finally {
      storage.close();
    }
  }, 15_000);

  it("routes a Claude session to its own upstream through an existing daemon", async () => {
    const root = await temporaryRoot();
    const workspace = await temporaryRoot();
    let openAiRequests = 0;
    let anthropicPath: string | undefined;
    let forwardedAuthorization: string | undefined;
    const openAiUpstream = await listen(
      createServer((request, response) => {
        openAiRequests += 1;
        request.resume();
        response.writeHead(500);
        response.end();
      }),
    );
    const anthropicUpstream = await listen(
      createServer((request, response) => {
        anthropicPath = request.url;
        forwardedAuthorization =
          typeof request.headers.authorization === "string"
            ? request.headers.authorization
            : undefined;
        request.resume();
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            id: "msg_cli_claude",
            type: "message",
            role: "assistant",
            model: "claude-sonnet-4-6",
            content: [{ type: "text", text: "Captured through Claude." }],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 8, output_tokens: 4 },
          }),
        );
      }),
    );
    const stdout = new CapturedOutput();
    const stderr = new CapturedOutput();
    const launch = async (configuration: ResolvedStartConfiguration) => {
      const daemon = new BlackBoxDaemon({
        homeDirectory: configuration.paths.homeDirectory,
        proxy: configuration.proxy,
        control: {
          listenHost: configuration.controlHost,
          listenPort: configuration.controlPort,
        },
        shutdownGraceMilliseconds: 100,
      });
      daemons.push(daemon);
      await daemon.start();
      return process.pid;
    };
    const cliRuntime = runtime(stdout, stderr, launch);

    expect(
      await runCli(
        [
          "start",
          "--home",
          root,
          "--upstream",
          openAiUpstream,
          "--proxy-port",
          "0",
          "--control-port",
          "0",
        ],
        cliRuntime,
      ),
    ).toBe(0);
    stdout.clear();
    const script = `
      (async () => {
        const response = await fetch(process.env.ANTHROPIC_BASE_URL + "/v1/messages", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "anthropic-version": "2023-06-01",
            "authorization": "Bearer claude-oauth-never-persist"
          },
          body: JSON.stringify({
            model: "claude-sonnet-4-6",
            max_tokens: 64,
            messages: [{ role: "user", content: "Hello" }]
          })
        });
        process.stdout.write(JSON.stringify({
          base: process.env.ANTHROPIC_BASE_URL,
          session: process.env.BLACKBOX_SESSION_ID,
          agent: process.env.BLACKBOX_AGENT,
          status: response.status,
          body: await response.json()
        }));
      })().catch((error) => {
        process.stderr.write(String(error));
        process.exitCode = 99;
      });
    `;

    expect(
      await runCli(
        [
          "run",
          "--home",
          root,
          "--agent",
          "claude",
          "--upstream",
          anthropicUpstream,
          "--proxy-port",
          "0",
          "--control-port",
          "0",
          "--cwd",
          workspace,
          "--",
          process.execPath,
          "-e",
          script,
        ],
        cliRuntime,
      ),
    ).toBe(0);

    const childOutput = JSON.parse(stdout.value) as {
      base: string;
      session: string;
      agent: string;
      status: number;
    };
    expect(childOutput).toMatchObject({
      agent: "claude",
      status: 200,
    });
    expect(childOutput.base).toContain("/.blackbox/session/");
    expect(childOutput.base).not.toMatch(/\/v1$/u);
    expect(openAiRequests).toBe(0);
    expect(anthropicPath).toBe("/v1/messages");
    expect(forwardedAuthorization).toBe("Bearer claude-oauth-never-persist");
    expect(stderr.value).toBe("");

    const paths = resolveDaemonPaths(root);
    const storage = await openBlackBoxStorage({
      databasePath: paths.databasePath,
      dataDirectory: paths.dataDirectory,
      recoverIncompleteExchanges: false,
    });
    try {
      await eventually(() =>
        storage.events
          .list(childOutput.session)
          .events.some((event) => event.type === "model.response.completed"),
      );
      expect(storage.sessions.getRequired(childOutput.session)).toMatchObject({
        agentName: "claude",
        upstreamOrigin: anthropicUpstream,
      });
      const rawRow = storage.unsafeDatabase
        .prepare("SELECT id FROM raw_exchanges WHERE session_id = ?")
        .get(childOutput.session) as { id: string };
      const raw = storage.rawExchanges.getRequired(rawRow.id);
      expect(raw.protocol).toBe("anthropic.messages");
      expect(raw.requestHeaders.authorization).toBeUndefined();
      expect(
        storage.events
          .list(childOutput.session)
          .events.map((event) => event.type),
      ).toEqual(
        expect.arrayContaining([
          "model.request",
          "message.assistant",
          "model.usage",
          "model.response.completed",
        ]),
      );
    } finally {
      storage.close();
    }
  }, 15_000);

  it("forwards Ctrl-C and preserves the child's final filesystem effect", async () => {
    const root = await temporaryRoot();
    const workspace = await temporaryRoot();
    const stdout = new CapturedOutput();
    const stderr = new CapturedOutput();
    const signalSource = new EventEmitter();
    const launch = async (configuration: ResolvedStartConfiguration) => {
      const daemon = new BlackBoxDaemon({
        homeDirectory: configuration.paths.homeDirectory,
        proxy: configuration.proxy,
        control: {
          listenHost: configuration.controlHost,
          listenPort: configuration.controlPort,
        },
        shutdownGraceMilliseconds: 100,
      });
      daemons.push(daemon);
      await daemon.start();
      return process.pid;
    };
    const script = `
      const fs = require("node:fs");
      process.on("SIGINT", () => {
        fs.writeFileSync("signal-result.txt", "signal forwarded\\n");
        process.exit(42);
      });
      process.stdout.write("ready\\n");
      setInterval(() => undefined, 1000);
    `;

    const running = runCli(
      [
        "run",
        "--home",
        root,
        "--proxy-port",
        "0",
        "--control-port",
        "0",
        "--cwd",
        workspace,
        "--watcher-debounce-ms",
        "10",
        "--cleanup-timeout-ms",
        "2000",
        "--",
        process.execPath,
        "-e",
        script,
      ],
      {
        ...runtime(stdout, stderr, launch),
        signalSource: signalSource as SignalEventSource,
      },
    );
    await eventually(() => stdout.value.includes("ready\n"), 10_000);
    signalSource.emit("SIGINT");

    expect(await running).toBe(42);
    expect(stderr.value).toBe("");
    expect(signalSource.listenerCount("SIGINT")).toBe(0);
    expect(signalSource.listenerCount("SIGTERM")).toBe(0);

    const paths = resolveDaemonPaths(root);
    const storage = await openBlackBoxStorage({
      databasePath: paths.databasePath,
      dataDirectory: paths.dataDirectory,
      recoverIncompleteExchanges: false,
    });
    try {
      const session = storage.sessions.list(1)[0];
      expect(session).toMatchObject({
        status: "completed",
        repoRoot: await realpath(workspace),
      });
      const events = storage.events.list(session?.id as string).events;
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "process.exited",
            summary: expect.objectContaining({ exitCode: 42 }),
          }),
          expect.objectContaining({
            type: "file.create",
            summary: expect.objectContaining({
              path: "signal-result.txt",
              timingPrecision: "exact-final-diff",
            }),
          }),
          expect.objectContaining({ type: "workspace.snapshot" }),
        ]),
      );
    } finally {
      storage.close();
    }
  }, 15_000);
});

describe("CLI cockpit opening", () => {
  it("starts the daemon and opens a selected session through a fragment credential", async () => {
    const root = await temporaryRoot();
    const stdout = new CapturedOutput();
    const stderr = new CapturedOutput();
    const paths = resolveDaemonPaths(root);
    const opened: URL[] = [];
    let launches = 0;
    const launch = async (configuration: ResolvedStartConfiguration) => {
      launches += 1;
      const daemon = new BlackBoxDaemon({
        homeDirectory: configuration.paths.homeDirectory,
        proxy: configuration.proxy,
        control: {
          listenHost: configuration.controlHost,
          listenPort: configuration.controlPort,
        },
        shutdownGraceMilliseconds: 100,
      });
      daemons.push(daemon);
      await daemon.start();
      return process.pid;
    };
    const cliRuntime: Partial<CliRuntime> = {
      ...runtime(stdout, stderr, launch),
      openBrowser: (url) => {
        opened.push(new URL(url));
        return Promise.resolve();
      },
    };

    expect(await runCli(["init", "--home", root], cliRuntime)).toBe(0);
    const storage = await openBlackBoxStorage({
      databasePath: paths.databasePath,
      dataDirectory: paths.dataDirectory,
      recoverIncompleteExchanges: false,
    });
    try {
      storage.sessions.create({
        schemaVersion: 1,
        id: "session-cockpit",
        startedAt: "2026-07-16T12:00:00.000Z",
        status: "active",
        captureLevel: "api",
        models: [],
        tags: [],
        counts: {
          events: 0,
          errors: 0,
          inputTokens: null,
          outputTokens: null,
        },
        metadata: {},
      });
    } finally {
      storage.close();
    }

    stdout.clear();
    expect(
      await runCli(["open", "missing-session", "--home", root], cliRuntime),
    ).toBe(1);
    expect(launches).toBe(0);
    expect(opened).toHaveLength(0);
    expect(stderr.value).toContain("Session missing-session does not exist");

    stdout.clear();
    stderr.clear();
    expect(
      await runCli(
        [
          "open",
          "session-cockpit",
          "--home",
          root,
          "--proxy-port",
          "0",
          "--control-port",
          "0",
        ],
        cliRuntime,
      ),
    ).toBe(0);
    expect(launches).toBe(1);

    const token = await readControlToken(paths.tokenPath);
    const url = opened[0];
    expect(url?.origin).toBe(daemons[0]?.status().controlOrigin);
    expect(url?.pathname).toBe("/");
    expect(url?.search).toBe("");
    expect(new URLSearchParams(url?.hash.slice(1))).toEqual(
      new URLSearchParams({ token, session: "session-cockpit" }),
    );
    expect(stdout.value).toBe(
      "Opened Black Box cockpit for session session-cockpit.\n",
    );
    expect(stdout.value).not.toContain(token);
    expect(stderr.value).toBe("");
  });

  it("refuses to place a control token in a non-loopback viewer URL", () => {
    expect(() =>
      createViewerUrl("https://attacker.example", "a".repeat(43)),
    ).toThrow("Refusing to open a non-loopback Black Box control origin");
  });
});

describe("CLI canonical inspection", () => {
  it("lists user sessions and emits canonical event JSON", async () => {
    const root = await temporaryRoot();
    const stdout = new CapturedOutput();
    const stderr = new CapturedOutput();
    const cliRuntime = runtime(stdout, stderr);
    const paths = resolveDaemonPaths(root);
    const startedAt = "2026-07-16T12:00:00.000Z";

    expect(await runCli(["init", "--home", root], cliRuntime)).toBe(0);
    const storage = await openBlackBoxStorage({
      databasePath: paths.databasePath,
      dataDirectory: paths.dataDirectory,
      recoverIncompleteExchanges: false,
    });
    try {
      for (const [id, internalAnalysis] of [
        ["session-visible", false],
        ["session-internal", true],
      ] as const) {
        storage.sessions.create({
          schemaVersion: 1,
          id,
          startedAt,
          status: "active",
          captureLevel: "api",
          models: [],
          tags: internalAnalysis ? ["internal-analysis"] : [],
          counts: {
            events: 0,
            errors: 0,
            inputTokens: null,
            outputTokens: null,
          },
          metadata: { internalAnalysis },
        });
      }
      storage.events.insert({
        schemaVersion: 1,
        id: "event-visible-1",
        sessionId: "session-visible",
        sequence: 1,
        occurredAt: startedAt,
        observedAt: startedAt,
        source: "proxy",
        type: "message.assistant",
        evidence: "observed",
        summary: { text: "inspectable" },
        redaction: { applied: false, ruleIds: [] },
      });
      storage.events.insert({
        schemaVersion: 1,
        id: "event-visible-2",
        sessionId: "session-visible",
        sequence: 2,
        occurredAt: startedAt,
        observedAt: startedAt,
        source: "proxy",
        type: "tool.call",
        evidence: "observed",
        summary: { name: "inspect" },
        redaction: { applied: false, ruleIds: [] },
      });
    } finally {
      storage.close();
    }

    stdout.clear();
    expect(
      await runCli(["sessions", "--home", root, "--json"], cliRuntime),
    ).toBe(0);
    expect(
      (JSON.parse(stdout.value) as { id: string }[]).map(
        (session) => session.id,
      ),
    ).toEqual(["session-visible"]);

    stdout.clear();
    expect(
      await runCli(
        ["sessions", "--home", root, "--include-internal", "--json"],
        cliRuntime,
      ),
    ).toBe(0);
    expect(JSON.parse(stdout.value)).toHaveLength(2);

    stdout.clear();
    expect(
      await runCli(
        ["inspect", "session-visible", "--home", root, "--json"],
        cliRuntime,
      ),
    ).toBe(0);
    const inspection = JSON.parse(stdout.value) as {
      session: { id: string };
      events: { id: string; type: string; summary: unknown }[];
    };
    expect(inspection.session.id).toBe("session-visible");
    expect(inspection.events).toEqual([
      expect.objectContaining({
        id: "event-visible-1",
        type: "message.assistant",
        summary: { text: "inspectable" },
      }),
      expect.objectContaining({ id: "event-visible-2", type: "tool.call" }),
    ]);

    stdout.clear();
    expect(
      await runCli(
        [
          "inspect",
          "session-visible",
          "--home",
          root,
          "--limit",
          "1",
          "--json",
        ],
        cliRuntime,
      ),
    ).toBe(0);
    const firstPage = JSON.parse(stdout.value) as {
      events: { id: string }[];
      nextCursor: string;
    };
    stdout.clear();
    expect(
      await runCli(
        [
          "inspect",
          "session-visible",
          "--home",
          root,
          "--limit",
          "1",
          "--cursor",
          firstPage.nextCursor,
          "--json",
        ],
        cliRuntime,
      ),
    ).toBe(0);
    expect(firstPage.events.map((event) => event.id)).toEqual([
      "event-visible-1",
    ]);
    expect(
      (JSON.parse(stdout.value) as { events: { id: string }[] }).events.map(
        (event) => event.id,
      ),
    ).toEqual(["event-visible-2"]);
    expect(stderr.value).toBe("");
  });

  it("validates inspect positional arguments", async () => {
    const stdout = new CapturedOutput();
    const stderr = new CapturedOutput();

    expect(await runCli(["inspect"], runtime(stdout, stderr))).toBe(2);
    expect(stderr.value).toContain("requires exactly one session ID");
  });

  it("emits incident reports offline and treats --ai as explicit scoped consent", async () => {
    const root = await temporaryRoot();
    const stdout = new CapturedOutput();
    const stderr = new CapturedOutput();
    const cliRuntime = runtime(stdout, stderr);
    const paths = resolveDaemonPaths(root);
    const startedAt = "2026-07-18T12:00:00.000Z";

    expect(await runCli(["init", "--home", root], cliRuntime)).toBe(0);
    const storage = await openBlackBoxStorage({
      databasePath: paths.databasePath,
      dataDirectory: paths.dataDirectory,
      recoverIncompleteExchanges: false,
    });
    try {
      storage.sessions.create({
        schemaVersion: 1,
        id: "session-report-cli",
        startedAt,
        status: "completed",
        captureLevel: "wrapped-process",
        models: [],
        tags: [],
        counts: {
          events: 1,
          errors: 0,
          inputTokens: null,
          outputTokens: null,
        },
        metadata: {},
      });
      storage.events.insert({
        schemaVersion: 1,
        id: "event-report-delete",
        sessionId: "session-report-cli",
        sequence: 1,
        occurredAt: startedAt,
        observedAt: startedAt,
        source: "filesystem",
        type: "file.delete",
        evidence: "observed",
        summary: {
          path: "test/example.test.ts",
          operation: "delete",
          timingPrecision: "exact-final-diff",
          sensitivity: "normal",
        },
        redaction: { applied: false, ruleIds: [] },
      });
    } finally {
      storage.close();
    }

    stdout.clear();
    expect(
      await runCli(
        [
          "report",
          "session-report-cli",
          "--target-event",
          "event-report-delete",
          "--home",
          root,
          "--json",
        ],
        cliRuntime,
      ),
    ).toBe(0);
    const deterministic = JSON.parse(stdout.value) as {
      requestedMode: string;
      report: {
        targetEventId: string;
        analysis: { mode: string; externalEvidenceSent: boolean };
      };
    };
    expect(deterministic).toMatchObject({
      requestedMode: "deterministic",
      report: {
        targetEventId: "event-report-delete",
        analysis: { mode: "deterministic", externalEvidenceSent: false },
      },
    });
    expect(stderr.value).toBe("");

    stdout.clear();
    expect(
      await runCli(
        ["report", "session-report-cli", "--home", root],
        cliRuntime,
      ),
    ).toBe(0);
    expect(stdout.value).toContain("# Black Box Incident Report");
    expect(stdout.value).toContain("blackbox://event/event-report-delete");

    stdout.clear();
    stderr.clear();
    expect(
      await runCli(
        ["report", "session-report-cli", "--home", root, "--ai", "--json"],
        {
          ...cliRuntime,
          environment: {
            OPENAI_API_KEY: "must-not-be-used-for-analysis",
            OPENAI_MODEL: "must-not-be-used-for-analysis",
          },
        },
      ),
    ).toBe(0);
    const fallback = JSON.parse(stdout.value) as {
      requestedMode: string;
      report: { analysis: { externalEvidenceSent: boolean } };
      aiAttempt: { status: string };
    };
    expect(fallback).toMatchObject({
      requestedMode: "ai",
      report: { analysis: { externalEvidenceSent: false } },
      aiAttempt: { status: "failed" },
    });
    expect(stderr.value).toContain("AI preflight:");
    expect(stderr.value).toContain("provider=not-configured");
    expect(stderr.value).toContain("deterministic report preserved");
    expect(stderr.value).not.toContain("must-not-be-used-for-analysis");

    stdout.clear();
    stderr.clear();
    expect(
      await runCli(
        ["report", "session-report-cli", "--home", root, "--ai", "--json"],
        {
          ...cliRuntime,
          environment: {
            BLACKBOX_ANALYSIS_API_KEY: "dedicated-analysis-key",
            BLACKBOX_ANALYSIS_MODEL: "fixture-model",
            BLACKBOX_ANALYSIS_BASE_URL:
              "https://user:password@analysis.example/v1/",
          },
        },
      ),
    ).toBe(0);
    expect(JSON.parse(stdout.value)).toMatchObject({
      report: { analysis: { externalEvidenceSent: false } },
      aiAttempt: { status: "failed", externalEvidenceSent: false },
    });
    expect(stderr.value).toContain("AI configuration is invalid");
    expect(stderr.value).toContain("deterministic report preserved");
    expect(stderr.value).not.toContain("dedicated-analysis-key");
  });

  it("validates report positional arguments and flags", async () => {
    const stdout = new CapturedOutput();
    const stderr = new CapturedOutput();

    expect(await runCli(["report"], runtime(stdout, stderr))).toBe(2);
    expect(stderr.value).toContain("requires exactly one session ID");
    expect(
      parseCliArguments([
        "report",
        "session-id",
        "--target-event",
        "event-id",
        "--ai",
        "--json",
      ]),
    ).toMatchObject({
      command: "report",
      positionals: ["session-id"],
      help: false,
    });
  });

  it("exports, imports, previews deletion, and prunes through explicit CLI controls", async () => {
    const sourceRoot = await temporaryRoot();
    const destinationRoot = await temporaryRoot();
    const outputRoot = await temporaryRoot();
    const archivePath = join(outputRoot, "fixture.bbx");
    const stdout = new CapturedOutput();
    const stderr = new CapturedOutput();
    const cliRuntime: Partial<CliRuntime> = {
      ...runtime(stdout, stderr),
      now: () => new Date("2026-07-20T12:00:00.000Z"),
    };
    expect(await runCli(["init", "--home", sourceRoot], cliRuntime)).toBe(0);
    expect(await runCli(["init", "--home", destinationRoot], cliRuntime)).toBe(
      0,
    );
    const sourcePaths = resolveDaemonPaths(sourceRoot);
    const source = await openBlackBoxStorage({
      databasePath: sourcePaths.databasePath,
      dataDirectory: sourcePaths.dataDirectory,
      recoverIncompleteExchanges: false,
    });
    try {
      source.sessions.create({
        schemaVersion: 1,
        id: "session-archive-cli",
        startedAt: "2026-07-01T12:00:00.000Z",
        status: "active",
        captureLevel: "wrapped-process",
        command: {
          executable: "fixture-agent",
          arguments: ["--token=sk-proj-clisecretfixture123"],
          cwd: "/private/cli-fixture",
        },
        repoRoot: "/private/cli-fixture",
        models: [],
        tags: [],
        counts: {
          events: 0,
          errors: 0,
          inputTokens: null,
          outputTokens: null,
        },
        metadata: {},
      });
      source.events.insert({
        schemaVersion: 1,
        id: "event-archive-cli",
        sessionId: "session-archive-cli",
        sequence: 1,
        occurredAt: "2026-07-01T12:00:01.000Z",
        observedAt: "2026-07-01T12:00:01.000Z",
        source: "filesystem",
        type: "file.delete",
        evidence: "observed",
        summary: {
          path: "test/archive.test.ts",
          operation: "delete",
          timingPrecision: "exact-final-diff",
        },
        redaction: { applied: false, ruleIds: [] },
      });
      const current = source.sessions.getRequired("session-archive-cli");
      source.sessions.replace({
        ...current,
        endedAt: "2026-07-01T12:00:02.000Z",
        status: "completed",
      });
    } finally {
      source.close();
    }

    stdout.clear();
    expect(
      await runCli(
        [
          "export",
          "session-archive-cli",
          "--home",
          sourceRoot,
          "--output",
          archivePath,
          "--json",
        ],
        cliRuntime,
      ),
    ).toBe(0);
    expect(JSON.parse(stdout.value)).toMatchObject({
      sessionId: "session-archive-cli",
      profile: "share",
      path: archivePath,
    });
    expect((await stat(archivePath)).mode & 0o777).toBe(0o600);
    expect(
      await runCli(
        [
          "export",
          "session-archive-cli",
          "--home",
          sourceRoot,
          "--output",
          archivePath,
        ],
        cliRuntime,
      ),
    ).toBe(1);
    expect(stderr.value).toContain("Refusing to overwrite");

    stdout.clear();
    stderr.clear();
    expect(
      await runCli(
        ["import", archivePath, "--home", destinationRoot, "--json"],
        cliRuntime,
      ),
    ).toBe(0);
    expect(JSON.parse(stdout.value)).toMatchObject({
      sessionId: "session-archive-cli",
      profile: "share",
      readOnly: true,
    });

    stdout.clear();
    expect(
      await runCli(
        ["delete", "session-archive-cli", "--home", destinationRoot, "--json"],
        cliRuntime,
      ),
    ).toBe(0);
    expect(JSON.parse(stdout.value)).toMatchObject({ applied: false });
    let destination = await openBlackBoxStorage({
      databasePath: resolveDaemonPaths(destinationRoot).databasePath,
      dataDirectory: resolveDaemonPaths(destinationRoot).dataDirectory,
      recoverIncompleteExchanges: false,
    });
    expect(destination.sessions.get("session-archive-cli")).toBeDefined();
    destination.close();

    stdout.clear();
    expect(
      await runCli(
        [
          "delete",
          "session-archive-cli",
          "--home",
          destinationRoot,
          "--yes",
          "--json",
        ],
        cliRuntime,
      ),
    ).toBe(0);
    destination = await openBlackBoxStorage({
      databasePath: resolveDaemonPaths(destinationRoot).databasePath,
      dataDirectory: resolveDaemonPaths(destinationRoot).dataDirectory,
      recoverIncompleteExchanges: false,
    });
    expect(destination.sessions.get("session-archive-cli")).toBeUndefined();
    destination.close();

    stdout.clear();
    expect(
      await runCli(
        ["prune", "--home", sourceRoot, "--older-than-days", "1", "--json"],
        cliRuntime,
      ),
    ).toBe(0);
    expect(JSON.parse(stdout.value)).toMatchObject({
      applied: false,
      plan: { sessions: [{ sessionId: "session-archive-cli" }] },
    });
    stdout.clear();
    expect(
      await runCli(
        [
          "prune",
          "--home",
          sourceRoot,
          "--older-than-days",
          "1",
          "--yes",
          "--json",
        ],
        cliRuntime,
      ),
    ).toBe(0);
    expect(JSON.parse(stdout.value)).toMatchObject({ applied: true });
  });

  it("parses archive and retention commands without broadening their flags", () => {
    expect(
      parseCliArguments([
        "export",
        "session-id",
        "--output",
        "fixture.bbx",
        "--profile",
        "forensic",
        "--force",
      ]),
    ).toMatchObject({ command: "export", positionals: ["session-id"] });
    expect(parseCliArguments(["import", "fixture.bbx"])).toMatchObject({
      command: "import",
      positionals: ["fixture.bbx"],
    });
    expect(parseCliArguments(["delete", "session-id", "--yes"])).toMatchObject({
      command: "delete",
      positionals: ["session-id"],
    });
    expect(
      parseCliArguments(["prune", "--max-bytes", "1024", "--yes"]),
    ).toMatchObject({ command: "prune", positionals: [] });
    expect(() =>
      parseCliArguments(["import", "fixture.bbx", "--force"]),
    ).toThrow("not valid for import");
  });
});

describe("CLI doctor", () => {
  it("reports the minimum runtime required by the storage codec", () => {
    expect(nodeRuntimeCheck("22.14.0")).toMatchObject({
      id: "node-runtime",
      status: "fail",
    });
    expect(nodeRuntimeCheck("22.15.0")).toMatchObject({
      id: "node-runtime",
      status: "pass",
    });
    expect(nodeRuntimeCheck("24.0.0")).toMatchObject({
      id: "node-runtime",
      status: "pass",
    });
    expect(nodeRuntimeCheck("invalid")).toMatchObject({
      id: "node-runtime",
      status: "fail",
    });
  });

  it("reports port conflicts, reachability, storage, limits, and WebSocket support", async () => {
    const root = await temporaryRoot();
    const upstreamOrigin = await upstream();
    const occupiedOrigin = await listen(createServer());
    const occupiedPort = new URL(occupiedOrigin).port;
    const stdout = new CapturedOutput();
    const stderr = new CapturedOutput();
    const cliRuntime = runtime(stdout, stderr);

    expect(await runCli(["init", "--home", root], cliRuntime)).toBe(0);
    stdout.clear();
    expect(
      await runCli(
        [
          "doctor",
          "--home",
          root,
          "--upstream",
          upstreamOrigin,
          "--proxy-port",
          occupiedPort,
          "--control-port",
          "0",
          "--json",
        ],
        cliRuntime,
      ),
    ).toBe(1);
    const conflicted = JSON.parse(stdout.value) as {
      checks: { id: string; status: string }[];
    };
    expect(conflicted.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "node-runtime", status: "pass" }),
        expect.objectContaining({ id: "storage", status: "pass" }),
        expect.objectContaining({ id: "database", status: "pass" }),
        expect.objectContaining({ id: "upstream", status: "pass" }),
        expect.objectContaining({ id: "proxy-port", status: "fail" }),
        expect.objectContaining({ id: "capture-limits", status: "pass" }),
        expect.objectContaining({
          id: "websocket-transport",
          status: "warn",
        }),
      ]),
    );

    const occupied = servers.pop();
    await new Promise<void>((resolve) => occupied?.close(() => resolve()));
    stdout.clear();
    expect(
      await runCli(
        [
          "doctor",
          "--home",
          root,
          "--upstream",
          upstreamOrigin,
          "--proxy-port",
          occupiedPort,
          "--control-port",
          "0",
          "--json",
        ],
        cliRuntime,
      ),
    ).toBe(0);
    expect(
      (JSON.parse(stdout.value) as { checks: { id: string; status: string }[] })
        .checks,
    ).toContainEqual(
      expect.objectContaining({ id: "websocket-transport", status: "warn" }),
    );

    const windowsReport = await runDoctor(
      resolveStartConfiguration(
        parseCliArguments([
          "doctor",
          "--home",
          root,
          "--upstream",
          upstreamOrigin,
          "--proxy-port",
          "0",
          "--control-port",
          "0",
        ]).flags,
        {},
      ),
      false,
      "win32",
    );
    expect(windowsReport.ok).toBe(true);
    expect(windowsReport.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "storage", status: "warn" }),
        expect.objectContaining({ id: "control-token", status: "warn" }),
      ]),
    );

    stdout.clear();
    expect(
      await runCli(
        [
          "doctor",
          "--home",
          root,
          "--upstream",
          upstreamOrigin,
          "--proxy-port",
          occupiedPort,
          "--control-port",
          "0",
          "--websocket",
          "--json",
        ],
        cliRuntime,
      ),
    ).toBe(1);
    const websocket = JSON.parse(stdout.value) as {
      checks: { id: string; status: string }[];
    };
    expect(websocket.checks).toContainEqual(
      expect.objectContaining({ id: "websocket-transport", status: "fail" }),
    );
    expect(stderr.value).toBe("");
  });

  it("fails when the evidence database is corrupt", async () => {
    const root = await temporaryRoot();
    const upstreamOrigin = await upstream();
    const stdout = new CapturedOutput();
    const stderr = new CapturedOutput();
    const cliRuntime = runtime(stdout, stderr);

    expect(await runCli(["init", "--home", root], cliRuntime)).toBe(0);
    await writeFile(resolveDaemonPaths(root).databasePath, "not sqlite", {
      mode: 0o600,
    });
    stdout.clear();

    expect(
      await runCli(
        [
          "doctor",
          "--home",
          root,
          "--upstream",
          upstreamOrigin,
          "--proxy-port",
          "0",
          "--control-port",
          "0",
          "--json",
        ],
        cliRuntime,
      ),
    ).toBe(1);
    const report = JSON.parse(stdout.value) as {
      checks: { id: string; status: string }[];
    };
    expect(report.checks).toContainEqual(
      expect.objectContaining({ id: "database", status: "fail" }),
    );
    expect(stderr.value).toBe("");
  });
});
