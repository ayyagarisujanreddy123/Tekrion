import { execFile } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
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
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { openTekrionStorage } from "@tekrion/storage";
import { expect, it } from "vitest";

const execute = promisify(execFile);
const cliPath = fileURLToPath(
  new URL("../../apps/cli/dist/bin.js", import.meta.url),
);
const offlineDemoPath = fileURLToPath(
  new URL("../../demo/scripts/run-offline.mjs", import.meta.url),
);
const resetDemoPath = fileURLToPath(
  new URL("../../demo/scripts/reset.mjs", import.meta.url),
);

interface HttpResult {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: Buffer;
}

async function runCli(
  arguments_: readonly string[],
): Promise<{ stdout: string; stderr: string }> {
  const result = await execute(process.execPath, [cliPath, ...arguments_], {
    encoding: "utf8",
    env: {
      ...process.env,
      OPENAI_API_KEY: "sk-environment-must-not-reach-daemon",
    },
    maxBuffer: 1024 * 1024,
  });
  return { stdout: result.stdout, stderr: result.stderr };
}

async function requestBytes(
  origin: string,
  body: Buffer,
  secret: string,
  cookie: string,
  apiKey: string,
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      new URL("/v1/responses", origin),
      {
        method: "POST",
        headers: {
          authorization: secret,
          cookie,
          "x-api-key": apiKey,
          "content-type": "application/json",
          "content-length": body.length,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
        response.on("error", reject);
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks),
          });
        });
      },
    );
    request.on("error", reject);
    request.end(body);
  });
}

async function eventuallyStopped(pid: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error: unknown) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ESRCH"
      ) {
        return;
      }
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Detached daemon PID ${pid} did not exit.`);
}

it("runs the packaged CLI and detached recorder end to end", async () => {
  const root = await mkdtemp(join(tmpdir(), "tekrion-packaged-e2e-"));
  const workspace = await mkdtemp(
    join(tmpdir(), "tekrion-packaged-workspace-e2e-"),
  );
  await writeFile(join(workspace, "delete-me.txt"), "tracked deletion\n");
  await execute("git", ["-C", workspace, "init", "--quiet"]);
  await execute("git", [
    "-C",
    workspace,
    "config",
    "user.email",
    "tekrion@example.test",
  ]);
  await execute("git", ["-C", workspace, "config", "user.name", "Tekrion E2E"]);
  await execute("git", ["-C", workspace, "add", "."]);
  await execute("git", [
    "-C",
    workspace,
    "commit",
    "--quiet",
    "-m",
    "packaged baseline",
  ]);
  const observations: {
    headers: Record<string, string | string[] | undefined>;
    body: Buffer;
  }[] = [];
  const upstream = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      const body = Buffer.concat(chunks);
      observations.push({ headers: request.headers, body });
      const output = Buffer.from(
        JSON.stringify({
          id: "resp_packaged_e2e",
          status: "completed",
          output: [
            {
              type: "message",
              id: "msg_packaged_e2e",
              content: [{ type: "output_text", text: "packaged" }],
            },
          ],
          usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
        }),
      );
      response.writeHead(200, {
        "content-type": "application/json",
        "content-length": output.length,
        "set-cookie": "provider=e2e; HttpOnly",
        "x-e2e-upstream": "packaged",
      });
      setImmediate(() => response.end(output));
    });
  });
  await new Promise<void>((resolve, reject) => {
    upstream.once("error", reject);
    upstream.listen(0, "127.0.0.1", () => resolve());
  });
  const upstreamAddress = upstream.address() as AddressInfo;
  const upstreamOrigin = `http://127.0.0.1:${upstreamAddress.port}`;
  let startAttempted = false;

  try {
    const initialized = await runCli(["init", "--home", root]);
    expect(initialized.stderr).toBe("");
    const token = (await readFile(join(root, "control.token"), "utf8")).trim();
    expect(initialized.stdout).not.toContain(token);

    startAttempted = true;
    const started = await runCli([
      "start",
      "--home",
      root,
      "--upstream",
      upstreamOrigin,
      "--proxy-port",
      "0",
      "--control-port",
      "0",
    ]);
    expect(started.stderr).toBe("");
    expect(started.stdout).not.toContain(token);

    const statusResult = await runCli(["status", "--home", root, "--json"]);
    const status = JSON.parse(statusResult.stdout) as {
      pid: number;
      state: string;
      proxyOrigin: string;
      controlOrigin: string;
      proxy: { requestsCompleted: number };
    };
    expect(status).toMatchObject({
      state: "ready",
      proxy: { requestsCompleted: 0 },
    });

    const viewerResponse = await fetch(status.controlOrigin);
    const viewerHtml = await viewerResponse.text();
    expect(viewerResponse.status).toBe(200);
    expect(viewerResponse.headers.get("content-type")).toBe(
      "text/html; charset=utf-8",
    );
    expect(viewerResponse.headers.get("content-security-policy")).toContain(
      "default-src 'none'",
    );
    expect(viewerHtml).toContain("Tekrion Cockpit");
    expect(viewerHtml).not.toContain(token);
    const viewerScriptPath = /<script[^>]+src="([^"]+\.js)"/u.exec(
      viewerHtml,
    )?.[1];
    expect(viewerScriptPath).toBeDefined();
    const viewerScript = await fetch(
      new URL(viewerScriptPath as string, status.controlOrigin),
    );
    expect(viewerScript.status).toBe(200);
    expect(viewerScript.headers.get("content-type")).toBe(
      "text/javascript; charset=utf-8",
    );
    expect((await viewerScript.arrayBuffer()).byteLength).toBeGreaterThan(
      100_000,
    );

    const unauthenticatedSessions = await fetch(
      new URL("/v1/sessions?limit=1", status.controlOrigin),
    );
    expect(unauthenticatedSessions.status).toBe(401);
    const authenticatedSessions = await fetch(
      new URL("/v1/sessions?limit=1", status.controlOrigin),
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(authenticatedSessions.status).toBe(200);
    expect(await authenticatedSessions.json()).toMatchObject({
      schemaVersion: 1,
      sessions: [],
    });

    const body = Buffer.from('{"input":"packaged-e2e"}', "utf8");
    const secret = "Bearer sk-packaged-e2e-never-persist";
    const cookie = "session=packaged-e2e-never-persist";
    const apiKey = "sk-ant-packaged-e2e-never-persist";
    const direct = await requestBytes(
      upstreamOrigin,
      body,
      secret,
      cookie,
      apiKey,
    );
    const recorded = await requestBytes(
      status.proxyOrigin,
      body,
      secret,
      cookie,
      apiKey,
    );
    expect(recorded.status).toBe(direct.status);
    expect(recorded.body).toEqual(direct.body);
    expect(recorded.headers["x-e2e-upstream"]).toBe("packaged");
    expect(recorded.headers["set-cookie"]).toEqual(["provider=e2e; HttpOnly"]);
    expect(observations.at(-1)?.headers.authorization).toBe(secret);
    expect(observations.at(-1)?.headers.cookie).toBe(cookie);
    expect(observations.at(-1)?.headers["x-api-key"]).toBe(apiKey);

    const doctor = await runCli([
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
    ]);
    const doctorReport = JSON.parse(doctor.stdout) as {
      ok: boolean;
      checks: { id: string; status: string }[];
    };
    expect(doctorReport.ok).toBe(true);
    expect(doctorReport.checks).toContainEqual(
      expect.objectContaining({ id: "websocket-transport", status: "warn" }),
    );

    const afterRequest = JSON.parse(
      (await runCli(["status", "--home", root, "--json"])).stdout,
    ) as { proxy: { requestsCompleted: number } };
    expect(afterRequest.proxy.requestsCompleted).toBe(1);

    type Inspection = {
      session: { id: string };
      events: { type: string }[];
    };
    let inspection: Inspection | undefined;
    const inspectionDeadline = Date.now() + 2_000;
    while (Date.now() < inspectionDeadline && inspection === undefined) {
      const sessions = JSON.parse(
        (await runCli(["sessions", "--home", root, "--json"])).stdout,
      ) as { id: string }[];
      const session = sessions[0];
      if (session !== undefined) {
        const candidate = JSON.parse(
          (await runCli(["inspect", session.id, "--home", root, "--json"]))
            .stdout,
        ) as Inspection;
        if ((candidate?.events.length ?? 0) > 0) {
          inspection = candidate;
          break;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(inspection?.events.map((event) => event.type)).toEqual([
      "model.request",
      "message.assistant",
      "model.usage",
      "model.response.completed",
    ]);

    const wrappedScript = `
      (async () => {
        const fs = require("node:fs");
        const response = await fetch(process.env.OPENAI_BASE_URL + "/responses", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ input: "packaged wrapped request" })
        });
        await response.arrayBuffer();
        fs.unlinkSync("delete-me.txt");
        fs.writeFileSync("created.txt", "packaged creation\\n");
        process.stdout.write(JSON.stringify({
          sessionId: process.env.TEKRION_SESSION_ID,
          proxyOrigin: process.env.TEKRION_PROXY_ORIGIN
        }));
      })().catch((error) => {
        process.stderr.write(String(error));
        process.exitCode = 1;
      });
    `;
    const wrappedResult = await runCli([
      "run",
      "--home",
      root,
      "--cwd",
      workspace,
      "--watcher-debounce-ms",
      "10",
      "--cleanup-timeout-ms",
      "5000",
      "--",
      process.execPath,
      "-e",
      wrappedScript,
    ]);
    expect(wrappedResult.stderr).toBe("");
    const wrappedOutput = JSON.parse(wrappedResult.stdout) as {
      sessionId: string;
      proxyOrigin: string;
    };
    expect(wrappedOutput.proxyOrigin).toBe(status.proxyOrigin);

    let wrappedInspection: Inspection | undefined;
    let lastWrappedEventTypes: string[] = [];
    const wrappedDeadline = Date.now() + 2_000;
    while (Date.now() < wrappedDeadline) {
      const candidate = JSON.parse(
        (
          await runCli([
            "inspect",
            wrappedOutput.sessionId,
            "--home",
            root,
            "--json",
          ])
        ).stdout,
      ) as Inspection;
      const types = candidate.events.map((event) => event.type);
      lastWrappedEventTypes = types;
      if (
        types.includes("model.response.completed") &&
        types.includes("file.delete") &&
        types.includes("process.exited")
      ) {
        wrappedInspection = candidate;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(
      wrappedInspection,
      `wrapped session did not finalize; last event types: ${lastWrappedEventTypes.join(", ")}`,
    ).toBeDefined();

    const packagedReportCommand = await runCli([
      "report",
      wrappedOutput.sessionId,
      "--home",
      root,
      "--json",
    ]);
    expect(packagedReportCommand.stderr).toBe("");
    const packagedReport = JSON.parse(packagedReportCommand.stdout) as {
      requestedMode: string;
      report: {
        targetEventId?: string;
        analysis: { mode: string; externalEvidenceSent: boolean };
      };
      aiAttempt: { status: string };
      markdown: string;
    };
    expect(packagedReport).toMatchObject({
      requestedMode: "deterministic",
      report: {
        analysis: { mode: "deterministic", externalEvidenceSent: false },
      },
      aiAttempt: { status: "not-requested" },
    });
    expect(packagedReport.report.targetEventId).toBeDefined();
    expect(packagedReport.markdown).toContain("# Tekrion Incident Report");

    const stopped = await runCli(["stop", "--home", root]);
    expect(stopped.stderr).toBe("");
    expect(stopped.stdout).toContain("daemon stopped");
    await eventuallyStopped(status.pid);
    await expect(stat(join(root, "daemon.lock"))).rejects.toMatchObject({
      code: "ENOENT",
    });

    const storage = await openTekrionStorage({
      databasePath: join(root, "tekrion.sqlite"),
      dataDirectory: join(root, "data"),
      recoverIncompleteExchanges: false,
    });
    try {
      const wrappedSession = storage.sessions.getRequired(
        wrappedOutput.sessionId,
      );
      expect(wrappedSession).toMatchObject({
        status: "completed",
        captureLevel: "wrapped-process",
        repoRoot: await realpath(workspace),
        upstreamOrigin,
      });
      const wrappedEvents = storage.events.list(wrappedOutput.sessionId, {
        limit: 1000,
      }).events;
      expect(wrappedEvents.map((event) => event.type)).toEqual(
        expect.arrayContaining([
          "workspace.snapshot",
          "process.started",
          "file.delete",
          "file.create",
          "process.exited",
          "model.response.completed",
        ]),
      );
      const deletion = wrappedEvents.find(
        (event) =>
          event.type === "file.delete" &&
          event.summary.timingPrecision === "exact-final-diff",
      );
      expect(deletion).toMatchObject({
        source: "filesystem",
        summary: {
          path: "delete-me.txt",
          payloadKind: "git-binary-patch",
          timingPrecision: "exact-final-diff",
        },
      });
      expect(
        storage.fileChanges.getByEvent(deletion?.id as string),
      ).toMatchObject({
        operation: "delete",
        path: "delete-me.txt",
        beforeHash: expect.stringMatching(/^[a-f\d]{64}$/u),
        patchBlobId: deletion?.payloadRef?.id,
      });
      expect(
        Buffer.from(
          await storage.blobs.get(deletion?.payloadRef?.id as string),
        ).toString("utf8"),
      ).toContain("tracked deletion");

      const directSessionId = inspection?.session.id;
      expect(directSessionId).toBeDefined();
      const row = storage.unsafeDatabase
        .prepare(
          `SELECT id FROM raw_exchanges
           WHERE session_id = ?
           ORDER BY created_at DESC LIMIT 1`,
        )
        .get(directSessionId as string) as { id: string };
      const raw = storage.rawExchanges.getRequired(row.id);
      expect(raw.outcome).toBe("completed");
      expect(raw.requestHeaders.authorization).toBeUndefined();
      expect(raw.requestHeaders.cookie).toBeUndefined();
      expect(raw.requestHeaders["x-api-key"]).toBeUndefined();
      expect(raw.responseHeaders?.["set-cookie"]).toBeUndefined();
      expect(
        Buffer.from(await storage.blobs.get(raw.requestBodyRef?.id as string)),
      ).toEqual(body);
      expect(
        Buffer.from(await storage.blobs.get(raw.responseBodyRef?.id as string)),
      ).toEqual(recorded.body);

      storage.checkpoint("TRUNCATE");
      const database = await readFile(storage.databasePath);
      for (const forbidden of [secret, cookie, apiKey, token]) {
        expect(database.includes(Buffer.from(forbidden))).toBe(false);
      }
      const blobIds = storage.unsafeDatabase
        .prepare("SELECT id FROM blobs ORDER BY id")
        .all() as { id: string }[];
      for (const { id } of blobIds) {
        const blob = Buffer.from(await storage.blobs.get(id));
        for (const forbidden of [secret, cookie, apiKey, token]) {
          expect(blob.includes(Buffer.from(forbidden))).toBe(false);
        }
      }
    } finally {
      storage.close();
    }

    const daemonLog = await readFile(join(root, "logs", "daemon.log"), "utf8");
    expect(daemonLog).not.toContain(secret);
    expect(daemonLog).not.toContain(cookie);
    expect(daemonLog).not.toContain(apiKey);
    expect(daemonLog).not.toContain(token);
    expect(daemonLog).not.toContain("sk-environment-must-not-reach-daemon");
  } finally {
    if (startAttempted) {
      await runCli(["stop", "--home", root, "--timeout-ms", "2000"]).catch(
        () => undefined,
      );
    }
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

it("runs the packaged offline fallback demo twice from a clean reset", async () => {
  const outputRoot = await mkdtemp(
    join(tmpdir(), "tekrion-demo-packaged-e2e-"),
  );
  try {
    for (let run = 0; run < 2; run += 1) {
      const result = await execute(
        process.execPath,
        [offlineDemoPath, "--output", outputRoot],
        {
          encoding: "utf8",
          env: { ...process.env, NO_PROXY: "*", no_proxy: "*" },
          maxBuffer: 16 * 1024 * 1024,
        },
      );
      expect(result.stdout).toContain("# Tekrion Incident Report");
      expect(result.stdout).toContain("event-read-result");
      expect(result.stderr).toContain("Offline fixture ready");
      await expect(
        readFile(join(outputRoot, "incident-report.md"), "utf8"),
      ).resolves.toContain("# Tekrion Incident Report");
      await expect(
        readFile(join(outputRoot, "incident-report.json"), "utf8"),
      ).resolves.toContain('"schemaVersion": 1');
      await expect(
        readFile(
          join(outputRoot, "rogue-repo", "test", "math.test.js"),
          "utf8",
        ),
      ).resolves.toContain("adds two numbers");
    }
  } finally {
    await execute(process.execPath, [
      resetDemoPath,
      "--output",
      outputRoot,
      "--clean",
    ]).catch(() => undefined);
    await rm(outputRoot, { recursive: true, force: true });
  }
});
