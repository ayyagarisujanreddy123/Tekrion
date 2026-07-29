import { spawn } from "node:child_process";
import { chmod, lstat, open, rename, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import type { ResolvedStartConfiguration } from "./configuration.js";

export type DaemonLauncher = (
  configuration: ResolvedStartConfiguration,
) => Promise<number>;

export const MAX_DAEMON_LOG_BYTES = 1024 * 1024;

function isMissingPath(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

async function existingRegularFile(path: string) {
  try {
    const details = await lstat(path);
    if (details.isSymbolicLink() || !details.isFile()) {
      throw new Error(`Refusing unsafe daemon log path: ${path}`);
    }
    return details;
  } catch (error: unknown) {
    if (isMissingPath(error)) {
      return undefined;
    }
    throw error;
  }
}

export async function prepareDaemonLog(
  logPath: string,
  maximumBytes = MAX_DAEMON_LOG_BYTES,
): Promise<void> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) {
    throw new Error("Daemon log rotation limit must be a positive integer.");
  }

  const current = await existingRegularFile(logPath);
  if (current !== undefined && current.size >= maximumBytes) {
    const backupPath = `${logPath}.1`;
    const backup = await existingRegularFile(backupPath);
    if (backup !== undefined) {
      await rm(backupPath);
    }
    await rename(logPath, backupPath);
    await chmod(backupPath, 0o600);
  }

  if ((await existingRegularFile(logPath)) === undefined) {
    const created = await open(logPath, "wx", 0o600);
    await created.close();
  }
  await chmod(logPath, 0o600);
}

export function daemonWorkerArguments(
  configuration: ResolvedStartConfiguration,
): string[] {
  const { paths, proxy } = configuration;
  return [
    "--home",
    paths.homeDirectory,
    "--upstream",
    proxy.upstream.origin,
    "--proxy-host",
    proxy.listenHost,
    "--proxy-port",
    String(proxy.listenPort),
    "--control-host",
    configuration.controlHost,
    "--control-port",
    String(configuration.controlPort),
    "--capture-queue-max-bytes",
    String(proxy.captureQueueMaxBytes),
    "--max-request-body-bytes",
    String(proxy.maxRequestBodyBytes),
    "--max-response-body-bytes",
    String(proxy.maxResponseBodyBytes),
    "--max-chunk-manifest-entries",
    String(proxy.maxChunkManifestEntries),
    "--shutdown-grace-ms",
    String(configuration.shutdownGraceMilliseconds),
    ...(configuration.maximumStoredBytes === undefined
      ? []
      : ["--max-stored-bytes", String(configuration.maximumStoredBytes)]),
    ...(proxy.allowNonLoopback ? ["--allow-non-loopback"] : []),
    ...(proxy.upstreamTimeoutMs === undefined
      ? []
      : ["--upstream-timeout-ms", String(proxy.upstreamTimeoutMs)]),
  ];
}

function daemonEnvironment(): NodeJS.ProcessEnv {
  const names = [
    "HOME",
    "USER",
    "LOGNAME",
    "PATH",
    "TMPDIR",
    "TMP",
    "TEMP",
    "SystemRoot",
    "WINDIR",
    "LANG",
    "LC_ALL",
    "TZ",
    "NODE_EXTRA_CA_CERTS",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "TEKRION_ANALYSIS_API_KEY",
    "TEKRION_ANALYSIS_MODEL",
    "TEKRION_ANALYSIS_BASE_URL",
    "TEKRION_ANALYSIS_PROVIDER",
    "BLACKBOX_ANALYSIS_API_KEY",
    "BLACKBOX_ANALYSIS_MODEL",
    "BLACKBOX_ANALYSIS_BASE_URL",
    "BLACKBOX_ANALYSIS_PROVIDER",
  ];
  const environment: NodeJS.ProcessEnv = { TEKRION_DAEMON_CHILD: "1" };
  for (const name of names) {
    if (process.env[name] !== undefined) {
      environment[name] = process.env[name];
    }
  }
  return environment;
}

export const launchDaemonProcess: DaemonLauncher = async (configuration) => {
  await prepareDaemonLog(configuration.paths.logPath);
  const logHandle = await open(configuration.paths.logPath, "a", 0o600);
  try {
    const [opened, target] = await Promise.all([
      logHandle.stat(),
      lstat(configuration.paths.logPath),
    ]);
    if (
      target.isSymbolicLink() ||
      !target.isFile() ||
      opened.dev !== target.dev ||
      opened.ino !== target.ino
    ) {
      throw new Error(
        `Refusing replaced daemon log path: ${configuration.paths.logPath}`,
      );
    }
    const workerPath = fileURLToPath(
      new URL("./daemon-worker.js", import.meta.url),
    );
    const child = spawn(
      process.execPath,
      [workerPath, ...daemonWorkerArguments(configuration)],
      {
        cwd: configuration.paths.homeDirectory,
        detached: true,
        env: daemonEnvironment(),
        stdio: ["ignore", logHandle.fd, logHandle.fd],
        windowsHide: true,
      },
    );
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      child.once("error", onError);
      setImmediate(() => {
        child.off("error", onError);
        resolve();
      });
    });
    if (child.pid === undefined) {
      throw new Error("Daemon child did not receive a process ID.");
    }
    child.unref();
    return child.pid;
  } finally {
    await logHandle.close();
  }
};
