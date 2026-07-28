import { randomUUID } from "node:crypto";

import type { AiReportProvider } from "@blackbox/analysis";
import {
  openBlackBoxStorage,
  type BlackBoxStorage,
  type BlobStoreOptions,
} from "@blackbox/storage";
import { z } from "zod";

import type { ProxyConfigurationInput } from "../proxy/config.js";
import { RecorderProxy } from "../proxy/recorder-proxy.js";
import { EvidenceQueryService } from "../query/evidence-query-service.js";
import { ViewerAssets } from "../viewer/viewer-assets.js";
import { ControlServer } from "./control-server.js";
import { ensureControlToken } from "./control-token.js";
import { DaemonLock, type DaemonLockRecovery } from "./daemon-lock.js";
import {
  ensureInstallLayout,
  resolveDaemonPaths,
  type DaemonPaths,
} from "./paths.js";
import type { DaemonLifecycleState, DaemonStatus } from "./status.js";

const ShutdownGraceSchema = z.number().int().positive().max(60_000);

export interface DaemonProxyOptions extends ProxyConfigurationInput {
  readonly sensitiveHeaderNames?: readonly string[];
}

export interface BlackBoxDaemonOptions {
  readonly homeDirectory?: string;
  readonly proxy?: DaemonProxyOptions;
  readonly control?: {
    readonly listenHost?: string;
    readonly listenPort?: number;
    readonly allowedOrigins?: readonly string[];
  };
  readonly blobStore?: BlobStoreOptions;
  readonly viewerDirectory?: string;
  readonly aiReportProvider?: AiReportProvider;
  readonly shutdownGraceMilliseconds?: number;
  readonly now?: () => Date;
}

export class BlackBoxDaemon {
  readonly paths: DaemonPaths;
  readonly instanceId = `daemon-${randomUUID()}`;
  readonly shutdownGraceMilliseconds: number;

  private stateValue: DaemonLifecycleState = "new";
  private startedAtValue?: string;
  private storageValue?: BlackBoxStorage;
  private proxyValue?: RecorderProxy;
  private controlValue?: ControlServer;
  private lockValue?: DaemonLock;
  private startPromise?: Promise<DaemonStatus>;
  private stopPromise?: Promise<void>;

  constructor(private readonly options: BlackBoxDaemonOptions = {}) {
    this.paths = resolveDaemonPaths(options.homeDirectory);
    this.shutdownGraceMilliseconds = ShutdownGraceSchema.parse(
      options.shutdownGraceMilliseconds ?? 5_000,
    );
  }

  get lifecycleState(): DaemonLifecycleState {
    return this.stateValue;
  }

  get lockRecovery(): DaemonLockRecovery | undefined {
    return this.lockValue?.recovery;
  }

  start(): Promise<DaemonStatus> {
    if (this.stateValue === "ready") {
      return Promise.resolve(this.status());
    }
    if (this.startPromise !== undefined) {
      return this.startPromise;
    }
    if (this.stateValue !== "new") {
      return Promise.reject(
        new Error(`Cannot start daemon from ${this.stateValue} state.`),
      );
    }
    this.startPromise = this.startInternal();
    return this.startPromise;
  }

  status(): DaemonStatus {
    const proxy = this.proxyValue;
    const controlAddress = this.controlValue?.address();
    const proxyAddress = proxy?.address();
    const storage = this.storageValue;
    if (
      this.startedAtValue === undefined ||
      proxy === undefined ||
      controlAddress === undefined ||
      proxyAddress === undefined ||
      storage === undefined
    ) {
      throw new Error(
        `Daemon status is unavailable in ${this.stateValue} state.`,
      );
    }
    return {
      schemaVersion: 1,
      instanceId: this.instanceId,
      pid: process.pid,
      state: this.stateValue,
      startedAt: this.startedAtValue,
      proxyOrigin: proxyAddress.origin,
      controlOrigin: controlAddress.origin,
      upstreamOrigin: proxy.configuration.upstream.origin,
      proxy: proxy.health(),
      storage: {
        schemaVersion: storage.schemaVersion,
        readOnly: storage.readOnly,
        recoveredIncompleteExchanges:
          storage.recovery.incompleteExchangeIds.length,
        removedTemporaryBlobs: storage.recovery.removedTemporaryBlobs,
      },
    };
  }

  stop(): Promise<void> {
    if (this.stateValue === "new") {
      this.stateValue = "stopped";
      return Promise.resolve();
    }
    if (this.stateValue === "stopped" || this.stateValue === "failed") {
      return Promise.resolve();
    }
    if (this.stopPromise !== undefined) {
      return this.stopPromise;
    }
    if (this.stateValue === "starting") {
      const startPromise = this.startPromise;
      if (startPromise === undefined) {
        return Promise.reject(new Error("Daemon startup promise is missing."));
      }
      this.stopPromise = startPromise.then(
        () => this.stopInternal(),
        () => undefined,
      );
      return this.stopPromise;
    }
    this.stopPromise = this.stopInternal();
    return this.stopPromise;
  }

  private now(): Date {
    return (this.options.now ?? (() => new Date()))();
  }

  private async startInternal(): Promise<DaemonStatus> {
    this.stateValue = "starting";
    try {
      await ensureInstallLayout(this.paths);
      const token = await ensureControlToken(
        this.paths.homeDirectory,
        this.paths.tokenPath,
      );
      this.lockValue = await DaemonLock.acquire({
        path: this.paths.lockPath,
        instanceId: this.instanceId,
        now: () => this.now(),
      });
      this.startedAtValue = this.lockValue.record.startedAt;
      this.storageValue = await openBlackBoxStorage({
        databasePath: this.paths.databasePath,
        dataDirectory: this.paths.dataDirectory,
        ...(this.options.blobStore === undefined
          ? {}
          : { blobStore: this.options.blobStore }),
        now: () => this.now(),
      });
      this.proxyValue = new RecorderProxy({
        storage: this.storageValue,
        ...this.options.proxy,
        now: () => this.now(),
      });
      const proxyAddress = await this.proxyValue.start();
      const viewerAssets =
        this.options.viewerDirectory === undefined
          ? undefined
          : await ViewerAssets.load(this.options.viewerDirectory);
      this.controlValue = new ControlServer({
        token,
        status: () => this.status(),
        shutdown: () => this.stop(),
        settleSession: (sessionId) =>
          this.proxyValue?.settleSession(sessionId) ?? [],
        query: new EvidenceQueryService(this.storageValue, {
          ...(this.options.aiReportProvider === undefined
            ? {}
            : { aiReportProvider: this.options.aiReportProvider }),
          now: () => this.now(),
        }),
        ...(viewerAssets === undefined ? {} : { viewerAssets }),
        ...this.options.control,
      });
      const controlAddress = await this.controlValue.start();
      await this.lockValue.update({
        state: "ready",
        proxyOrigin: proxyAddress.origin,
        controlOrigin: controlAddress.origin,
      });
      this.stateValue = "ready";
      return this.status();
    } catch (error: unknown) {
      const cleanupErrors = await this.releaseResources();
      this.stateValue = "failed";
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          [error, ...cleanupErrors],
          "Daemon startup and cleanup both failed.",
          { cause: error },
        );
      }
      throw error;
    }
  }

  private async stopInternal(): Promise<void> {
    this.stateValue = "stopping";
    const errors: unknown[] = [];
    try {
      await this.lockValue?.update({ state: "stopping" });
    } catch (error: unknown) {
      errors.push(error);
    }
    errors.push(...(await this.releaseResources()));
    this.stateValue = "stopped";
    if (errors.length > 0) {
      throw new AggregateError(errors, "Daemon shutdown encountered errors.");
    }
  }

  private async releaseResources(): Promise<unknown[]> {
    const errors: unknown[] = [];
    const attempt = async (operation: () => void | Promise<void>) => {
      try {
        await operation();
      } catch (error: unknown) {
        errors.push(error);
      }
    };

    if (this.controlValue !== undefined) {
      await attempt(() =>
        this.controlValue?.close(this.shutdownGraceMilliseconds),
      );
      delete this.controlValue;
    }
    if (this.proxyValue !== undefined) {
      await attempt(() =>
        this.proxyValue?.close(this.shutdownGraceMilliseconds),
      );
      delete this.proxyValue;
    }
    if (this.storageValue !== undefined) {
      await attempt(() => {
        this.storageValue?.checkpoint("TRUNCATE");
      });
      await attempt(() => {
        this.storageValue?.close();
      });
      delete this.storageValue;
    }
    if (this.lockValue !== undefined) {
      await attempt(async () => {
        await this.lockValue?.release();
      });
      delete this.lockValue;
    }
    return errors;
  }
}
