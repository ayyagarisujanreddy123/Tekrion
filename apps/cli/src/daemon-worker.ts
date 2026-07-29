import { setTimeout as delay } from "node:timers/promises";

import {
  TekrionDaemon,
  openAiReportProviderFromEnvironment,
} from "@tekrion/daemon";

import {
  parseCliArguments,
  resolveStartConfiguration,
} from "./configuration.js";
import { packagedViewerDirectory } from "./viewer-assets.js";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function runDaemonWorker(arguments_: readonly string[]): Promise<number> {
  let daemon: TekrionDaemon | undefined;
  let shutdownError: unknown;
  try {
    const parsed = parseCliArguments(["start", ...arguments_]);
    const configuration = resolveStartConfiguration(parsed.flags, {});
    const aiReportProvider = (() => {
      try {
        return openAiReportProviderFromEnvironment(process.env);
      } catch (error: unknown) {
        process.stderr.write(
          `[${new Date().toISOString()}] optional AI analysis disabled: ${errorMessage(error)}\n`,
        );
        return undefined;
      }
    })();
    daemon = new TekrionDaemon({
      homeDirectory: configuration.paths.homeDirectory,
      proxy: {
        listenHost: configuration.proxy.listenHost,
        listenPort: configuration.proxy.listenPort,
        upstream: configuration.proxy.upstream,
        allowNonLoopback: configuration.proxy.allowNonLoopback,
        captureQueueMaxBytes: configuration.proxy.captureQueueMaxBytes,
        maxRequestBodyBytes: configuration.proxy.maxRequestBodyBytes,
        maxResponseBodyBytes: configuration.proxy.maxResponseBodyBytes,
        maxChunkManifestEntries: configuration.proxy.maxChunkManifestEntries,
        ...(configuration.proxy.upstreamTimeoutMs === undefined
          ? {}
          : {
              upstreamTimeoutMs: configuration.proxy.upstreamTimeoutMs,
            }),
      },
      control: {
        listenHost: configuration.controlHost,
        listenPort: configuration.controlPort,
      },
      ...(configuration.maximumStoredBytes === undefined
        ? {}
        : {
            blobStore: {
              maxStoredBytes: configuration.maximumStoredBytes,
            },
          }),
      viewerDirectory: packagedViewerDirectory(),
      ...(aiReportProvider === undefined ? {} : { aiReportProvider }),
      shutdownGraceMilliseconds: configuration.shutdownGraceMilliseconds,
    });

    const requestStop = () => {
      void daemon?.stop().catch((error: unknown) => {
        shutdownError = error;
      });
    };
    process.once("SIGINT", requestStop);
    process.once("SIGTERM", requestStop);
    if (process.platform !== "win32") {
      process.once("SIGHUP", requestStop);
    }

    const status = await daemon.start();
    process.stdout.write(
      `[${new Date().toISOString()}] daemon ready pid=${status.pid} proxy=${status.proxyOrigin} control=${status.controlOrigin}\n`,
    );
    while (!new Set(["stopped", "failed"]).has(daemon.lifecycleState)) {
      await delay(50);
    }
    if (shutdownError !== undefined) {
      process.stderr.write(
        `[${new Date().toISOString()}] daemon shutdown error: ${errorMessage(shutdownError)}\n`,
      );
      return 1;
    }
    return 0;
  } catch (error: unknown) {
    await daemon?.stop().catch(() => undefined);
    process.stderr.write(
      `[${new Date().toISOString()}] daemon startup error: ${errorMessage(error)}\n`,
    );
    return 1;
  }
}

process.exitCode = await runDaemonWorker(process.argv.slice(2));
