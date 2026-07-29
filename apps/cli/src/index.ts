import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { constants as osConstants } from "node:os";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import {
  CorruptDaemonLockError,
  DEFAULT_MAXIMUM_ARCHIVE_BYTES,
  DaemonLock,
  EvidenceQueryService,
  executeEvidenceDeletion,
  ensureControlToken,
  ensureInstallLayout,
  exportTekrionArchive,
  importTekrionArchive,
  isProcessAlive,
  planEvidencePrune,
  planSessionDeletion,
  readTekrionArchiveFile,
  readControlToken,
  readDaemonLockRecord,
  openAiReportProviderFromEnvironment,
  sessionScopedProxyOrigin,
  writeTekrionArchiveFile,
  type DaemonLockRecord,
  type DaemonPaths,
  type DaemonStatus,
} from "@tekrion/daemon";
import {
  TekrionArchiveProfileSchema,
  IdentifierSchema,
  type ReportPreflight,
} from "@tekrion/protocol";
import { openTekrionStorage } from "@tekrion/storage";

import {
  defaultUpstreamForAgent,
  prepareAgentLaunch,
  resolveAgentIntegration,
  sessionUpstreamRouteForAgent,
} from "./agent-integration.js";
import {
  createViewerUrl,
  openSystemBrowser,
  type BrowserOpener,
} from "./browser.js";
import {
  CliUsageError,
  integerFlag,
  parseCliArguments,
  pathsFromFlags,
  resolveStartConfiguration,
  stringFlag,
  type ParsedCliArguments,
  type ResolvedStartConfiguration,
} from "./configuration.js";
import {
  requestDaemonSessionSettlement,
  requestDaemonShutdown,
  requestDaemonStatus,
} from "./control-client.js";
import { launchDaemonProcess, type DaemonLauncher } from "./daemon-launcher.js";
import { runDoctor, type DoctorReport } from "./doctor.js";
import {
  DEFAULT_PROCESS_RUN_CONFIGURATION,
  RunEventJournal,
} from "./run/run-event-journal.js";
import { withCleanupDeadline } from "./run/cleanup-deadline.js";
import {
  installSignalForwarding,
  type SignalEventSource,
} from "./run/signal-forwarder.js";
import { WorkspaceObserver } from "./run/workspace-observer.js";
import { TEKRION_VERSION } from "./version.js";

const HELP = `Tekrion — the flight recorder for AI coding agents

Usage:
  tekrion init [--home PATH]
  tekrion start [--upstream URL] [--proxy-port PORT] [--control-port PORT]
  tekrion open [session-id] [--upstream URL] [--control-port PORT]
  tekrion stop [--timeout-ms MS]
  tekrion status [--json]
  tekrion doctor [--upstream URL] [--websocket] [--json]
  tekrion sessions [--limit N] [--json]
  tekrion inspect <session-id> [--limit N] [--type EVENT_TYPE] [--json]
  tekrion report <session-id> [--target-event EVENT_ID] [--ai] [--json]
  tekrion export <session-id> --output PATH [--profile share|forensic]
  tekrion import <archive.tkr> [--json]
  tekrion delete <session-id> [--yes] [--json]
  tekrion prune [--older-than-days N] [--max-bytes N] [--yes] [--json]
  tekrion run [--agent auto|codex|claude|openai-compatible] [--cwd PATH] -- <command...>

Common options:
  --home PATH                     Override the private Tekrion data directory
  --help, -h                      Show this help
  --version, -v                   Show the Tekrion version

Start and doctor options:
  --upstream URL                  Provider origin (or TEKRION_UPSTREAM_URL)
  --proxy-host HOST               Proxy listener (default 127.0.0.1)
  --proxy-port PORT               Proxy port (default 4141; 0 selects one)
  --control-host HOST             Control listener (loopback only)
  --control-port PORT             Control port (default 4142; 0 selects one)
  --allow-non-loopback            Explicitly permit a non-loopback proxy
  --capture-queue-max-bytes N     Global in-memory capture bound
  --max-request-body-bytes N      Per-request capture bound
  --max-response-body-bytes N     Per-response capture bound
  --max-chunk-manifest-entries N  Per-exchange provenance entry bound
  --max-stored-bytes N            Refuse new blobs above this stored-byte quota
  --upstream-timeout-ms MS        Optional provider timeout

Inspection options:
  --limit N                       Bound sessions/events returned (default 100)
  --type EVENT_TYPE               Filter inspect output by canonical event type
  --cursor CURSOR                 Continue inspect from a prior JSON page
  --include-internal              Include isolated analysis sessions in listings

Report options:
  --target-event EVENT_ID         Analyze a specific tool or filesystem action
  --ai                            Explicitly send the previewed redacted snapshot
  --json                          Emit the versioned report result as JSON

Archive and retention options:
  --output PATH                   Destination for a .tkr export
  --profile share|forensic       Redacted share archive (default) or full evidence
  --max-bytes N                  Archive safety limit or retained evidence target
  --older-than-days N            Select terminal sessions older than N days
  --force                         Replace an existing export destination
  --yes                           Apply a displayed delete/prune plan

Run options:
  --agent NAME                    Agent integration (default auto-detect)
                                  Codex/Claude reuse their active native login
  --cwd PATH                      Child working directory (default current directory)
  --max-output-frame-bytes N      Maximum stored stdout/stderr frame (default 262144)
  --max-untracked-file-bytes N    Maximum stored content per changed file (default 1048576)
  --watcher-debounce-ms N         Approximate file timing debounce (default 100)
  --cleanup-timeout-ms N          Final evidence cleanup bound (default 10000)
`;

export interface CliOutput {
  write(value: string | Uint8Array): unknown;
}

export interface CliRuntime {
  readonly stdout: CliOutput;
  readonly stderr: CliOutput;
  readonly environment: NodeJS.ProcessEnv;
  readonly launchDaemon: DaemonLauncher;
  readonly openBrowser: BrowserOpener;
  readonly now: () => Date;
  readonly signalSource: SignalEventSource;
}

const DEFAULT_RUNTIME: CliRuntime = {
  stdout: process.stdout,
  stderr: process.stderr,
  environment: process.env,
  launchDaemon: launchDaemonProcess,
  openBrowser: openSystemBrowser,
  now: () => new Date(),
  signalSource: process,
};

function timeoutFromArguments(
  parsed: ParsedCliArguments,
  fallback: number,
): number {
  return integerFlag(parsed.flags, "timeout-ms", fallback, 100, 120_000);
}

async function initialize(paths: DaemonPaths): Promise<void> {
  await ensureInstallLayout(paths);
  await ensureControlToken(paths.homeDirectory, paths.tokenPath);
  const storage = await openTekrionStorage({
    databasePath: paths.databasePath,
    dataDirectory: paths.dataDirectory,
    recoverIncompleteExchanges: false,
  });
  try {
    const integrity = storage.integrityCheck();
    if (integrity !== "ok") {
      throw new Error(`SQLite integrity check returned '${integrity}'.`);
    }
  } finally {
    storage.close();
  }
}

function writeStatus(
  output: CliOutput,
  status: DaemonStatus,
  json: boolean,
  prefix = "Tekrion daemon",
): void {
  if (json) {
    output.write(`${JSON.stringify(status)}\n`);
    return;
  }
  output.write(`${prefix}: ${status.state} (PID ${status.pid})\n`);
  output.write(`Proxy: ${status.proxyOrigin} (${status.proxy.status})\n`);
  output.write(`OPENAI_BASE_URL=${status.proxyOrigin}/v1\n`);
  output.write(`ANTHROPIC_BASE_URL=${status.proxyOrigin}\n`);
}

async function waitForReady(
  paths: DaemonPaths,
  timeoutMilliseconds: number,
): Promise<DaemonStatus> {
  const deadline = Date.now() + timeoutMilliseconds;
  let lastError: unknown;
  while (Date.now() < deadline) {
    let record: DaemonLockRecord | undefined;
    try {
      record = await readDaemonLockRecord(paths.lockPath);
    } catch (error: unknown) {
      lastError = error;
    }
    if (record !== undefined) {
      if (!isProcessAlive(record.pid)) {
        throw new Error(
          `Daemon process ${record.pid} exited before becoming ready. See ${paths.logPath}.`,
        );
      }
      if (record.state === "ready" && record.controlOrigin !== undefined) {
        try {
          return await requestDaemonStatus(
            record,
            paths,
            Math.min(2_000, Math.max(100, deadline - Date.now())),
          );
        } catch (error: unknown) {
          lastError = error;
        }
      }
    }
    await delay(50);
  }
  throw new Error(
    `Daemon did not become ready within ${timeoutMilliseconds} ms. See ${paths.logPath}.`,
    lastError === undefined ? undefined : { cause: lastError },
  );
}

async function recoverAbandonedLock(paths: DaemonPaths): Promise<void> {
  const recovery = await DaemonLock.acquire({ path: paths.lockPath });
  await recovery.release();
}

async function waitForStopped(
  paths: DaemonPaths,
  target: DaemonLockRecord,
  timeoutMilliseconds: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    let current: DaemonLockRecord | undefined;
    try {
      current = await readDaemonLockRecord(paths.lockPath);
    } catch (error: unknown) {
      if (!(error instanceof CorruptDaemonLockError)) {
        throw error;
      }
      // A lock update uses an atomic rename. The stable-file read can
      // deliberately reject the old descriptor while that rename is in
      // progress; retry instead of treating the transient mismatch as proof
      // that the daemon stopped.
      await delay(10);
      continue;
    }
    if (current === undefined || current.instanceId !== target.instanceId) {
      return;
    }
    if (!isProcessAlive(current.pid)) {
      await recoverAbandonedLock(paths);
      return;
    }
    await delay(50);
  }
  throw new Error(
    `Daemon did not stop within ${timeoutMilliseconds} ms (PID ${target.pid}).`,
  );
}

async function readActiveLock(
  paths: DaemonPaths,
): Promise<DaemonLockRecord | undefined> {
  const record = await readDaemonLockRecord(paths.lockPath);
  return record !== undefined && isProcessAlive(record.pid)
    ? record
    : undefined;
}

async function commandInit(
  parsed: ParsedCliArguments,
  runtime: CliRuntime,
): Promise<number> {
  const paths = pathsFromFlags(parsed.flags);
  await initialize(paths);
  runtime.stdout.write(`Initialized Tekrion at ${paths.homeDirectory}\n`);
  return 0;
}

async function commandStart(
  parsed: ParsedCliArguments,
  runtime: CliRuntime,
): Promise<number> {
  const configuration = resolveStartConfiguration(
    parsed.flags,
    runtime.environment,
  );
  const { status, alreadyRunning } = await ensureDaemonReady(
    configuration,
    runtime,
  );
  writeStatus(
    runtime.stdout,
    status,
    false,
    alreadyRunning
      ? "Tekrion daemon already running"
      : "Tekrion daemon started",
  );
  return 0;
}

async function commandOpen(
  parsed: ParsedCliArguments,
  runtime: CliRuntime,
): Promise<number> {
  const requestedSessionId = parsed.positionals[0];
  const parsedSession =
    requestedSessionId === undefined
      ? undefined
      : IdentifierSchema.safeParse(requestedSessionId);
  if (parsedSession !== undefined && !parsedSession.success) {
    throw new CliUsageError("open session ID must be 1 to 512 characters.");
  }
  const sessionId = parsedSession?.data;
  const configuration = resolveStartConfiguration(
    parsed.flags,
    runtime.environment,
  );

  if (sessionId !== undefined) {
    const storage = await openInspectionStorage(configuration.paths);
    try {
      if (storage.sessions.get(sessionId) === undefined) {
        throw new Error(`Session ${sessionId} does not exist.`);
      }
    } finally {
      storage.close();
    }
  }

  const { status } = await ensureDaemonReady(configuration, runtime);
  const token = await readControlToken(configuration.paths.tokenPath);
  const url = createViewerUrl(status.controlOrigin, token, sessionId);
  await runtime.openBrowser(url);
  runtime.stdout.write(
    sessionId === undefined
      ? `Opened Tekrion cockpit at ${url.origin}.\n`
      : `Opened Tekrion cockpit for session ${sessionId}.\n`,
  );
  return 0;
}

async function ensureDaemonReady(
  configuration: ResolvedStartConfiguration,
  runtime: CliRuntime,
): Promise<{
  readonly status: DaemonStatus;
  readonly alreadyRunning: boolean;
}> {
  let active: DaemonLockRecord | undefined;
  try {
    active = await readActiveLock(configuration.paths);
  } catch (error: unknown) {
    if (!(error instanceof CorruptDaemonLockError)) {
      throw error;
    }
  }

  if (active !== undefined) {
    if (active.state === "stopping") {
      throw new Error(`Daemon PID ${active.pid} is still stopping.`);
    }
    const status = await waitForReady(
      configuration.paths,
      configuration.readinessTimeoutMilliseconds,
    );
    return { status, alreadyRunning: true };
  }

  await initialize(configuration.paths);
  await runtime.launchDaemon(configuration);
  const status = await waitForReady(
    configuration.paths,
    configuration.readinessTimeoutMilliseconds,
  );
  return { status, alreadyRunning: false };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

function childExitStatus(
  exitCode: number | null,
  signal: string | null,
): number {
  if (exitCode !== null) {
    return exitCode;
  }
  if (signal === null) {
    return 1;
  }
  const signalNumber = (osConstants.signals as Record<string, number>)[signal];
  return 128 + (signalNumber ?? 0);
}

async function commandRun(
  parsed: ParsedCliArguments,
  runtime: CliRuntime,
): Promise<number> {
  const executable = parsed.positionals[0];
  if (executable === undefined) {
    throw new CliUsageError("run requires '--' followed by a command.");
  }
  const agent = resolveAgentIntegration(
    stringFlag(parsed.flags, "agent"),
    executable,
  );
  const defaultUpstream = defaultUpstreamForAgent(agent);
  const configuration = resolveStartConfiguration(
    parsed.flags,
    runtime.environment,
    defaultUpstream === undefined ? {} : { upstreamOrigin: defaultUpstream },
  );
  const { status, alreadyRunning } = await ensureDaemonReady(
    configuration,
    runtime,
  );
  const hasExplicitUpstream =
    stringFlag(parsed.flags, "upstream") !== undefined ||
    runtime.environment.TEKRION_UPSTREAM_URL !== undefined ||
    runtime.environment.BLACKBOX_UPSTREAM_URL !== undefined;
  const hasPerRunUpstream =
    hasExplicitUpstream || defaultUpstream !== undefined;
  const sessionUpstreamOrigin = hasPerRunUpstream
    ? configuration.proxy.upstream.origin
    : (status.upstreamOrigin ??
      (alreadyRunning ? undefined : configuration.proxy.upstream.origin));
  const cwd = resolve(stringFlag(parsed.flags, "cwd") ?? process.cwd());
  const sessionId = `session-run-${randomUUID()}`;
  const sessionProxyOrigin = sessionScopedProxyOrigin(
    status.proxyOrigin,
    sessionId,
  );
  const launch = prepareAgentLaunch(
    agent,
    parsed.positionals.slice(1),
    sessionProxyOrigin,
    executable,
  );
  const startedAt = runtime.now().toISOString();
  const storage = await openTekrionStorage({
    databasePath: configuration.paths.databasePath,
    dataDirectory: configuration.paths.dataDirectory,
    recoverIncompleteExchanges: false,
  });
  const journal = new RunEventJournal(
    storage,
    {
      schemaVersion: 1,
      sessionId,
      executable,
      arguments: [...launch.arguments],
      cwd,
      startedAt,
      configuration: {
        ...DEFAULT_PROCESS_RUN_CONFIGURATION,
        excludedPathSegments: [
          ...DEFAULT_PROCESS_RUN_CONFIGURATION.excludedPathSegments,
        ],
        maxOutputFrameBytes: integerFlag(
          parsed.flags,
          "max-output-frame-bytes",
          DEFAULT_PROCESS_RUN_CONFIGURATION.maxOutputFrameBytes,
          1,
          1024 * 1024,
        ),
        maxUntrackedFileBytes: integerFlag(
          parsed.flags,
          "max-untracked-file-bytes",
          DEFAULT_PROCESS_RUN_CONFIGURATION.maxUntrackedFileBytes,
          0,
          1024 * 1024 * 1024,
        ),
        watcherDebounceMilliseconds: integerFlag(
          parsed.flags,
          "watcher-debounce-ms",
          DEFAULT_PROCESS_RUN_CONFIGURATION.watcherDebounceMilliseconds,
          1,
          60_000,
        ),
        cleanupGraceMilliseconds: integerFlag(
          parsed.flags,
          "cleanup-timeout-ms",
          DEFAULT_PROCESS_RUN_CONFIGURATION.cleanupGraceMilliseconds,
          1,
          120_000,
        ),
      },
    },
    {
      agentName: agent,
      ...(sessionUpstreamOrigin === undefined
        ? {}
        : { upstreamOrigin: sessionUpstreamOrigin }),
      upstreamRoute: sessionUpstreamRouteForAgent(agent, hasExplicitUpstream),
    },
  );
  let recordingFailure: unknown;
  let workspaceObserver: WorkspaceObserver | undefined;
  let removeSignalForwarding: () => void = () => undefined;
  const observe = (operation: Promise<void>) => {
    void operation.catch((error: unknown) => {
      recordingFailure ??= error;
    });
  };

  try {
    workspaceObserver = await WorkspaceObserver.start({
      cwd,
      dataDirectory: configuration.paths.homeDirectory,
      configuration: journal.identity.configuration,
      now: runtime.now,
    });
    await journal.recordWorkspaceSnapshot(workspaceObserver.baseline);
    try {
      workspaceObserver.startWatching(async (change) => {
        await journal.recordFileChange(change);
      });
    } catch (error: unknown) {
      recordingFailure ??= error;
      await journal
        .recordWorkspaceError("watcher", error, runtime.now().toISOString())
        .catch((journalError: unknown) => {
          recordingFailure ??= journalError;
        });
    }
  } catch (error: unknown) {
    recordingFailure ??= error;
    await journal
      .recordWorkspaceError("baseline", error, runtime.now().toISOString())
      .catch((journalError: unknown) => {
        recordingFailure ??= journalError;
      });
    workspaceObserver = undefined;
  }

  try {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(executable, launch.arguments, {
        cwd,
        env: {
          ...runtime.environment,
          ...launch.environment,
          TEKRION_PROXY_ORIGIN: status.proxyOrigin,
          TEKRION_SESSION_ID: sessionId,
          TEKRION_CAPTURE_LEVEL: "wrapped-process",
          // Transitional aliases keep pre-Tekrion adapters functional.
          BLACKBOX_PROXY_ORIGIN: status.proxyOrigin,
          BLACKBOX_SESSION_ID: sessionId,
          BLACKBOX_CAPTURE_LEVEL: "wrapped-process",
        },
        shell: false,
        stdio: ["inherit", "pipe", "pipe"],
      });
    } catch (error: unknown) {
      const spawnCode = errorCode(error);
      await journal
        .fail({
          message: errorMessage(error),
          ...(spawnCode === undefined ? {} : { code: spawnCode }),
          failedAt: runtime.now().toISOString(),
        })
        .catch(() => undefined);
      runtime.stderr.write(
        `tekrion: failed to spawn ${executable}: ${errorMessage(error)}\n`,
      );
      return 127;
    }

    const outcome = new Promise<
      | { readonly kind: "spawn-error"; readonly error: unknown }
      | {
          readonly kind: "closed";
          readonly exitCode: number | null;
          readonly signal: string | null;
        }
    >((resolveOutcome) => {
      child.once("error", (error) => {
        if (child.pid === undefined) {
          resolveOutcome({ kind: "spawn-error", error });
        } else {
          recordingFailure ??= error;
        }
      });
      child.once("close", (exitCode, signal) => {
        resolveOutcome({ kind: "closed", exitCode, signal });
      });
    });
    removeSignalForwarding = installSignalForwarding(
      child,
      runtime.signalSource,
    );

    if (child.pid !== undefined) {
      observe(journal.recordStarted(child.pid, runtime.now().toISOString()));
    }
    child.stdout?.on("data", (chunk: Buffer) => {
      const bytes = Buffer.from(chunk);
      runtime.stdout.write(bytes);
      try {
        observe(
          journal.appendOutput("stdout", bytes, runtime.now().toISOString()),
        );
      } catch (error: unknown) {
        recordingFailure ??= error;
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const bytes = Buffer.from(chunk);
      runtime.stderr.write(bytes);
      try {
        observe(
          journal.appendOutput("stderr", bytes, runtime.now().toISOString()),
        );
      } catch (error: unknown) {
        recordingFailure ??= error;
      }
    });

    const result = await outcome;
    if (result.kind === "spawn-error") {
      const spawnCode = errorCode(result.error);
      await journal
        .fail({
          message: errorMessage(result.error),
          ...(spawnCode === undefined ? {} : { code: spawnCode }),
          failedAt: runtime.now().toISOString(),
        })
        .catch((error: unknown) => {
          recordingFailure ??= error;
        });
      runtime.stderr.write(
        `tekrion: failed to spawn ${executable}: ${errorMessage(result.error)}\n`,
      );
      return 127;
    }

    try {
      const daemonRecord = await readDaemonLockRecord(
        configuration.paths.lockPath,
      );
      if (daemonRecord === undefined) {
        throw new Error(
          "Daemon stopped before the wrapped session could be settled.",
        );
      }
      await requestDaemonSessionSettlement(
        daemonRecord,
        configuration.paths,
        sessionId,
        journal.identity.configuration.cleanupGraceMilliseconds,
      );
    } catch (error: unknown) {
      recordingFailure ??= error;
    }

    if (workspaceObserver !== undefined) {
      try {
        await withCleanupDeadline(
          journal.identity.configuration.cleanupGraceMilliseconds,
          async (signal) => {
            const workspace = await workspaceObserver.complete(signal);
            if (workspace.watcherErrors.length > 0) {
              const watcherError = new Error(
                `Filesystem watcher reported ${workspace.watcherErrors.length} error(s): ${
                  workspace.watcherErrors[0]?.message ?? "unknown watcher error"
                }`,
              );
              recordingFailure ??= watcherError;
              await journal.recordWorkspaceError(
                "watcher",
                watcherError,
                runtime.now().toISOString(),
              );
            }
            for (const change of workspace.changes) {
              signal.throwIfAborted();
              await journal.recordFileChange(change);
            }
            signal.throwIfAborted();
            await journal.recordWorkspaceSnapshot(workspace.snapshot);
            signal.throwIfAborted();
          },
        );
      } catch (error: unknown) {
        recordingFailure ??= error;
        await journal
          .recordWorkspaceError("final", error, runtime.now().toISOString())
          .catch((journalError: unknown) => {
            recordingFailure ??= journalError;
          });
      }
    }

    await journal
      .finish({
        exitCode: result.exitCode,
        signal: result.signal,
        endedAt: runtime.now().toISOString(),
      })
      .catch((error: unknown) => {
        recordingFailure ??= error;
      });
    if (recordingFailure !== undefined) {
      runtime.stderr.write(
        `tekrion: process evidence is incomplete: ${errorMessage(recordingFailure)}\n`,
      );
    }
    return childExitStatus(result.exitCode, result.signal);
  } finally {
    if (workspaceObserver !== undefined) {
      await withCleanupDeadline(
        journal.identity.configuration.cleanupGraceMilliseconds,
        async (signal) => {
          await workspaceObserver.stopWatching(signal);
          signal.throwIfAborted();
        },
      ).catch(() => undefined);
    }
    removeSignalForwarding();
    storage.close();
  }
}

async function commandStatus(
  parsed: ParsedCliArguments,
  runtime: CliRuntime,
): Promise<number> {
  const paths = pathsFromFlags(parsed.flags);
  const json = parsed.flags.has("json");
  const record = await readDaemonLockRecord(paths.lockPath);
  if (record === undefined) {
    if (json) {
      runtime.stdout.write('{"state":"stopped"}\n');
    } else {
      runtime.stdout.write("Tekrion daemon: stopped\n");
    }
    return 1;
  }
  if (!isProcessAlive(record.pid)) {
    if (json) {
      runtime.stdout.write(
        `${JSON.stringify({ state: "stale", pid: record.pid })}\n`,
      );
    } else {
      runtime.stdout.write(`Tekrion daemon: stale lock (PID ${record.pid})\n`);
    }
    return 1;
  }
  if (record.state !== "ready" || record.controlOrigin === undefined) {
    const value = { state: record.state, pid: record.pid };
    runtime.stdout.write(
      json
        ? `${JSON.stringify(value)}\n`
        : `Tekrion daemon: ${record.state} (PID ${record.pid})\n`,
    );
    return 0;
  }
  const status = await requestDaemonStatus(
    record,
    paths,
    timeoutFromArguments(parsed, 2_000),
  );
  writeStatus(runtime.stdout, status, json);
  return status.proxy.status === "healthy" ? 0 : 1;
}

async function commandStop(
  parsed: ParsedCliArguments,
  runtime: CliRuntime,
): Promise<number> {
  const paths = pathsFromFlags(parsed.flags);
  const json = parsed.flags.has("json");
  const timeoutMilliseconds = timeoutFromArguments(parsed, 10_000);
  let record: DaemonLockRecord | undefined;
  try {
    record = await readDaemonLockRecord(paths.lockPath);
  } catch (error: unknown) {
    if (!(error instanceof CorruptDaemonLockError)) {
      throw error;
    }
    await recoverAbandonedLock(paths);
    runtime.stdout.write(
      json
        ? '{"state":"stopped","recovered":"corrupt-lock"}\n'
        : "Tekrion daemon was not running; removed corrupt lock.\n",
    );
    return 0;
  }
  if (record === undefined) {
    runtime.stdout.write(
      json ? '{"state":"stopped"}\n' : "Tekrion daemon is already stopped.\n",
    );
    return 0;
  }
  if (!isProcessAlive(record.pid)) {
    await recoverAbandonedLock(paths);
    runtime.stdout.write(
      json
        ? `${JSON.stringify({ state: "stopped", recoveredPid: record.pid })}\n`
        : `Removed stale daemon lock for PID ${record.pid}.\n`,
    );
    return 0;
  }
  if (record.state === "stopping") {
    await waitForStopped(paths, record, timeoutMilliseconds);
    runtime.stdout.write(
      json ? '{"state":"stopped"}\n' : "Tekrion daemon stopped.\n",
    );
    return 0;
  }
  if (record.state !== "ready" || record.controlOrigin === undefined) {
    await waitForReady(paths, timeoutMilliseconds);
  }
  const readyRecord = await readDaemonLockRecord(paths.lockPath);
  if (readyRecord === undefined) {
    runtime.stdout.write(
      json ? '{"state":"stopped"}\n' : "Tekrion daemon stopped.\n",
    );
    return 0;
  }
  await requestDaemonShutdown(
    readyRecord,
    paths,
    Math.min(2_000, timeoutMilliseconds),
  );
  await waitForStopped(paths, readyRecord, timeoutMilliseconds);
  runtime.stdout.write(
    json ? '{"state":"stopped"}\n' : "Tekrion daemon stopped.\n",
  );
  return 0;
}

function writeDoctorReport(
  output: CliOutput,
  report: DoctorReport,
  json: boolean,
): void {
  if (json) {
    output.write(`${JSON.stringify(report)}\n`);
    return;
  }
  for (const check of report.checks) {
    output.write(
      `[${check.status.toUpperCase()}] ${check.id}: ${check.message}\n`,
    );
  }
}

async function commandDoctor(
  parsed: ParsedCliArguments,
  runtime: CliRuntime,
): Promise<number> {
  const configuration = resolveStartConfiguration(
    parsed.flags,
    runtime.environment,
  );
  const report = await runDoctor(configuration, parsed.flags.has("websocket"));
  writeDoctorReport(runtime.stdout, report, parsed.flags.has("json"));
  return report.ok ? 0 : 1;
}

async function openInspectionStorage(paths: DaemonPaths) {
  try {
    await access(paths.databasePath);
  } catch (error: unknown) {
    throw new Error(
      `Tekrion is not initialized at ${paths.homeDirectory}. Run 'tekrion init' first.`,
      { cause: error },
    );
  }
  return openTekrionStorage({
    databasePath: paths.databasePath,
    dataDirectory: paths.dataDirectory,
    recoverIncompleteExchanges: false,
  });
}

async function commandSessions(
  parsed: ParsedCliArguments,
  runtime: CliRuntime,
): Promise<number> {
  const paths = pathsFromFlags(parsed.flags);
  const storage = await openInspectionStorage(paths);
  try {
    const limit = integerFlag(parsed.flags, "limit", 100, 1, 1000);
    const sessions = storage.sessions
      .list(1000)
      .filter(
        (session) =>
          parsed.flags.has("include-internal") ||
          session.metadata.internalAnalysis !== true,
      )
      .slice(0, limit);
    if (parsed.flags.has("json")) {
      runtime.stdout.write(`${JSON.stringify(sessions)}\n`);
      return 0;
    }
    if (sessions.length === 0) {
      runtime.stdout.write("No recorded sessions.\n");
      return 0;
    }
    for (const session of sessions) {
      runtime.stdout.write(
        `${session.id}\t${session.status}\t${session.startedAt}\t${session.counts.events} events\n`,
      );
    }
    return 0;
  } finally {
    storage.close();
  }
}

async function commandInspect(
  parsed: ParsedCliArguments,
  runtime: CliRuntime,
): Promise<number> {
  const sessionId = parsed.positionals[0];
  if (sessionId === undefined) {
    throw new CliUsageError("inspect requires exactly one session ID.");
  }
  const paths = pathsFromFlags(parsed.flags);
  const storage = await openInspectionStorage(paths);
  try {
    const session = storage.sessions.get(sessionId);
    if (session === undefined) {
      throw new Error(`Session ${sessionId} does not exist.`);
    }
    const type = stringFlag(parsed.flags, "type");
    const cursor = stringFlag(parsed.flags, "cursor");
    const page = storage.events.list(sessionId, {
      limit: integerFlag(parsed.flags, "limit", 100, 1, 1000),
      ...(type === undefined ? {} : { type }),
      ...(cursor === undefined ? {} : { cursor }),
    });
    if (parsed.flags.has("json")) {
      runtime.stdout.write(
        `${JSON.stringify({
          session,
          events: page.events,
          ...(page.nextCursor === undefined
            ? {}
            : { nextCursor: page.nextCursor }),
        })}\n`,
      );
      return 0;
    }
    runtime.stdout.write(
      `Session ${session.id}: ${session.status}, ${session.counts.events} canonical events\n`,
    );
    for (const event of page.events) {
      runtime.stdout.write(`${JSON.stringify(event)}\n`);
    }
    if (page.nextCursor !== undefined) {
      runtime.stdout.write(
        `More events remain; continue with --cursor ${page.nextCursor}.\n`,
      );
    }
    return 0;
  } finally {
    storage.close();
  }
}

function writeReportPreflight(
  output: CliOutput,
  preflight: ReportPreflight,
): void {
  output.write(
    `AI preflight: ${preflight.totalBytes.toLocaleString()} bytes of minimized, redacted evidence across ${preflight.eventCount.toLocaleString()} events; provider=${preflight.provider}, model=${preflight.model}.\n`,
  );
  for (const category of preflight.categories) {
    output.write(
      `  ${category.category}: ${category.itemCount.toLocaleString()} items, ${category.byteLength.toLocaleString()} bytes\n`,
    );
  }
  output.write(
    `  redactions: ${preflight.redactionCount.toLocaleString()} (${preflight.redactionRuleIds.join(", ") || "none"})\n`,
  );
  output.write(`  prompt: ${preflight.promptVersion}\n`);
  output.write(`  snapshot sha256: ${preflight.snapshotSha256}\n`);
  output.write(
    `  consent fingerprint: ${preflight.consentFingerprintSha256}\n`,
  );
}

async function commandReport(
  parsed: ParsedCliArguments,
  runtime: CliRuntime,
): Promise<number> {
  const sessionId = parsed.positionals[0];
  if (sessionId === undefined) {
    throw new CliUsageError("report requires exactly one session ID.");
  }
  const paths = pathsFromFlags(parsed.flags);
  const storage = await openInspectionStorage(paths);
  try {
    const aiRequested = parsed.flags.has("ai");
    const aiReportProvider = aiRequested
      ? (() => {
          try {
            return openAiReportProviderFromEnvironment(runtime.environment);
          } catch (error: unknown) {
            runtime.stderr.write(
              `AI configuration is invalid; continuing with the deterministic fallback: ${errorMessage(error)}\n`,
            );
            return undefined;
          }
        })()
      : undefined;
    const service = new EvidenceQueryService(storage, {
      ...(aiReportProvider === undefined ? {} : { aiReportProvider }),
      now: runtime.now,
    });
    const targetEventId = stringFlag(parsed.flags, "target-event");
    const result = aiRequested
      ? await (async () => {
          const preflight = await service.getReportPreflight(
            sessionId,
            targetEventId,
          );
          writeReportPreflight(runtime.stderr, preflight);
          return service.generateAiReport(sessionId, {
            schemaVersion: 1,
            consent: true,
            consentFingerprintSha256: preflight.consentFingerprintSha256,
            ...(targetEventId === undefined ? {} : { targetEventId }),
          });
        })()
      : await service.getReport(sessionId, targetEventId);
    if (parsed.flags.has("json")) {
      runtime.stdout.write(`${JSON.stringify(result)}\n`);
    } else {
      runtime.stdout.write(result.markdown);
    }
    if (result.aiAttempt.status === "failed") {
      runtime.stderr.write(
        `AI enrichment failed ${
          result.aiAttempt.externalEvidenceSent
            ? "after the redacted evidence was sent"
            : "before external evidence was sent"
        }; deterministic report preserved: ${result.aiAttempt.error}\n`,
      );
    }
    return 0;
  } finally {
    storage.close();
  }
}

function archiveMaximumBytes(
  flags: ReadonlyMap<string, string | true>,
): number {
  return integerFlag(
    flags,
    "max-bytes",
    DEFAULT_MAXIMUM_ARCHIVE_BYTES,
    1,
    Number.MAX_SAFE_INTEGER,
  );
}

async function commandExport(
  parsed: ParsedCliArguments,
  runtime: CliRuntime,
): Promise<number> {
  const sessionId = parsed.positionals[0];
  if (sessionId === undefined) {
    throw new CliUsageError("export requires exactly one session ID.");
  }
  const output = stringFlag(parsed.flags, "output");
  if (output === undefined) {
    throw new CliUsageError("export requires --output PATH.");
  }
  const parsedProfile = TekrionArchiveProfileSchema.safeParse(
    stringFlag(parsed.flags, "profile") ?? "share",
  );
  if (!parsedProfile.success) {
    throw new CliUsageError("Flag --profile must be share or forensic.");
  }
  const paths = pathsFromFlags(parsed.flags);
  const storage = await openInspectionStorage(paths);
  try {
    const report = await new EvidenceQueryService(storage, {
      now: runtime.now,
    }).getReport(sessionId);
    const exported = await exportTekrionArchive(storage, {
      sessionId,
      profile: parsedProfile.data,
      report,
      exportedAt: runtime.now().toISOString(),
      maximumBytes: archiveMaximumBytes(parsed.flags),
    });
    const outputPath = resolve(output);
    await writeTekrionArchiveFile(
      outputPath,
      exported.bytes,
      parsed.flags.has("force"),
    );
    if (parsedProfile.data === "forensic") {
      runtime.stderr.write(
        "Forensic archive warning: this file can contain prompts, outputs, paths, source payloads, and other sensitive evidence.\n",
      );
    }
    const summary = {
      archiveId: exported.archive.manifest.archiveId,
      sessionId,
      profile: exported.archive.manifest.profile,
      path: outputPath,
      archiveBytes: exported.bytes.byteLength,
      entryBytes: exported.archive.manifest.totalBytes,
      entries: exported.archive.manifest.entries.length,
      redactions: exported.archive.manifest.redaction,
    };
    runtime.stdout.write(
      parsed.flags.has("json")
        ? `${JSON.stringify(summary)}\n`
        : `Exported ${summary.profile} archive ${summary.archiveId} to ${summary.path} (${summary.archiveBytes.toLocaleString()} bytes, ${summary.redactions.count.toLocaleString()} export redactions).\n`,
    );
    return 0;
  } finally {
    storage.close();
  }
}

async function commandImport(
  parsed: ParsedCliArguments,
  runtime: CliRuntime,
): Promise<number> {
  const archivePath = parsed.positionals[0];
  if (archivePath === undefined) {
    throw new CliUsageError("import requires exactly one archive path.");
  }
  const maximumBytes = archiveMaximumBytes(parsed.flags);
  const resolvedArchivePath = resolve(archivePath);
  const bytes = await readTekrionArchiveFile(resolvedArchivePath, maximumBytes);
  const paths = pathsFromFlags(parsed.flags);
  const storage = await openInspectionStorage(paths);
  try {
    const result = await importTekrionArchive(storage, {
      bytes,
      importedAt: runtime.now().toISOString(),
      maximumBytes,
    });
    runtime.stdout.write(
      parsed.flags.has("json")
        ? `${JSON.stringify(result)}\n`
        : `Imported session ${result.sessionId} as read-only from ${resolvedArchivePath} (${result.eventCount.toLocaleString()} events, ${result.blobCount.toLocaleString()} payload blobs).\n`,
    );
    return 0;
  } finally {
    storage.close();
  }
}

function writeDeletionPlan(
  output: CliOutput,
  plan: ReturnType<typeof planEvidencePrune>,
): void {
  output.write(
    `Deletion preview: ${plan.sessions.length.toLocaleString()} sessions; logical evidence ${plan.current.logicalBytes.toLocaleString()} → ${plan.projected.logicalBytes.toLocaleString()} bytes.\n`,
  );
  for (const session of plan.sessions) {
    output.write(
      `  ${session.sessionId}\t${session.status}\t${session.logicalBytes.toLocaleString()} bytes\t${session.reasons.join(",")}\n`,
    );
  }
  if (!plan.satisfied) {
    output.write(
      "The requested size target cannot be reached without deleting an active session.\n",
    );
  }
}

async function commandDelete(
  parsed: ParsedCliArguments,
  runtime: CliRuntime,
): Promise<number> {
  const sessionId = parsed.positionals[0];
  if (sessionId === undefined) {
    throw new CliUsageError("delete requires exactly one session ID.");
  }
  const storage = await openInspectionStorage(pathsFromFlags(parsed.flags));
  try {
    const plan = planSessionDeletion(storage, sessionId);
    if (!parsed.flags.has("yes")) {
      runtime.stdout.write(
        parsed.flags.has("json")
          ? `${JSON.stringify({ applied: false, plan })}\n`
          : "",
      );
      if (!parsed.flags.has("json")) {
        writeDeletionPlan(runtime.stdout, plan);
        runtime.stdout.write(
          "No evidence deleted; rerun with --yes to apply.\n",
        );
      }
      return 0;
    }
    const result = await executeEvidenceDeletion(storage, plan);
    runtime.stdout.write(
      parsed.flags.has("json")
        ? `${JSON.stringify({ applied: true, result })}\n`
        : `Deleted ${result.deletedSessionIds.length.toLocaleString()} sessions and ${result.garbageCollection.removedBlobs.toLocaleString()} unreferenced blobs; ${result.after.logicalBytes.toLocaleString()} logical bytes remain.\n`,
    );
    return 0;
  } finally {
    storage.close();
  }
}

async function commandPrune(
  parsed: ParsedCliArguments,
  runtime: CliRuntime,
): Promise<number> {
  const olderThanDays =
    stringFlag(parsed.flags, "older-than-days") === undefined
      ? undefined
      : integerFlag(parsed.flags, "older-than-days", 0, 0, 365_000);
  const maximumBytes =
    stringFlag(parsed.flags, "max-bytes") === undefined
      ? undefined
      : integerFlag(parsed.flags, "max-bytes", 0, 0, Number.MAX_SAFE_INTEGER);
  if (olderThanDays === undefined && maximumBytes === undefined) {
    throw new CliUsageError(
      "prune requires --older-than-days N, --max-bytes N, or both.",
    );
  }
  const storage = await openInspectionStorage(pathsFromFlags(parsed.flags));
  try {
    const plan = planEvidencePrune(storage, {
      ...(olderThanDays === undefined ? {} : { olderThanDays }),
      ...(maximumBytes === undefined ? {} : { maximumBytes }),
      now: runtime.now(),
    });
    if (!parsed.flags.has("yes")) {
      runtime.stdout.write(
        parsed.flags.has("json")
          ? `${JSON.stringify({ applied: false, plan })}\n`
          : "",
      );
      if (!parsed.flags.has("json")) {
        writeDeletionPlan(runtime.stdout, plan);
        runtime.stdout.write(
          "No evidence deleted; rerun with --yes to apply.\n",
        );
      }
      return plan.satisfied ? 0 : 1;
    }
    const result = await executeEvidenceDeletion(storage, plan);
    runtime.stdout.write(
      parsed.flags.has("json")
        ? `${JSON.stringify({ applied: true, satisfied: plan.satisfied, result })}\n`
        : `Pruned ${result.deletedSessionIds.length.toLocaleString()} sessions and ${result.garbageCollection.removedBlobs.toLocaleString()} unreferenced blobs; ${result.after.logicalBytes.toLocaleString()} logical bytes remain.\n`,
    );
    return plan.satisfied ? 0 : 1;
  } finally {
    storage.close();
  }
}

export async function runCli(
  arguments_: readonly string[],
  runtimeOverrides: Partial<CliRuntime> = {},
): Promise<number> {
  const runtime: CliRuntime = { ...DEFAULT_RUNTIME, ...runtimeOverrides };
  try {
    if (
      arguments_.length === 1 &&
      (arguments_[0] === "--version" || arguments_[0] === "-v")
    ) {
      runtime.stdout.write(`${TEKRION_VERSION}\n`);
      return 0;
    }
    const parsed = parseCliArguments(arguments_);
    if (parsed.help || parsed.command === undefined) {
      runtime.stdout.write(HELP);
      return 0;
    }
    switch (parsed.command) {
      case "init":
        return await commandInit(parsed, runtime);
      case "start":
        return await commandStart(parsed, runtime);
      case "open":
        return await commandOpen(parsed, runtime);
      case "stop":
        return await commandStop(parsed, runtime);
      case "status":
        return await commandStatus(parsed, runtime);
      case "doctor":
        return await commandDoctor(parsed, runtime);
      case "sessions":
        return await commandSessions(parsed, runtime);
      case "inspect":
        return await commandInspect(parsed, runtime);
      case "report":
        return await commandReport(parsed, runtime);
      case "export":
        return await commandExport(parsed, runtime);
      case "import":
        return await commandImport(parsed, runtime);
      case "delete":
        return await commandDelete(parsed, runtime);
      case "prune":
        return await commandPrune(parsed, runtime);
      case "run":
        return await commandRun(parsed, runtime);
    }
  } catch (error: unknown) {
    const usage = error instanceof CliUsageError;
    const message = error instanceof Error ? error.message : String(error);
    runtime.stderr.write(`tekrion: ${message}\n`);
    if (usage) {
      runtime.stderr.write("Run 'tekrion --help' for usage.\n");
    }
    return usage ? 2 : 1;
  }
}

export * from "./configuration.js";
export * from "./agent-integration.js";
export * from "./browser.js";
export * from "./control-client.js";
export * from "./daemon-launcher.js";
export * from "./doctor.js";
export * from "./run/run-event-journal.js";
export * from "./run/cleanup-deadline.js";
export * from "./run/signal-forwarder.js";
export * from "./run/workspace-observer.js";
export * from "./run/workspace-watcher.js";
export * from "./viewer-assets.js";
export * from "./version.js";
