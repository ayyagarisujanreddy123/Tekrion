import { createHash } from "node:crypto";

import {
  TekrionEventSchema,
  ProcessExitedSummarySchema,
  ProcessFailureSummarySchema,
  ProcessObservationIdentitySchema,
  ProcessOutputSummarySchema,
  ProcessStartedSummarySchema,
  SessionSchema,
  WorkspaceFileChangeSummarySchema,
  WorkspaceManifestSchema,
  WorkspaceSnapshotSummarySchema,
  type TekrionEvent,
  type EvidenceKind,
  type EvidenceSource,
  type ProcessObservationIdentity,
  type ProcessOutputStream,
  type SessionUpstreamRoute,
  type WorkspaceFileChangeSummary,
  type WorkspaceManifest,
  type WorkspaceSnapshotSummary,
} from "@tekrion/protocol";
import type { TekrionStorage } from "@tekrion/storage";

const NO_REDACTION = { applied: false, ruleIds: [] } as const;

export const DEFAULT_PROCESS_RUN_CONFIGURATION = {
  schemaVersion: 1,
  maxOutputFrameBytes: 256 * 1024,
  maxUntrackedFileBytes: 1024 * 1024,
  watcherDebounceMilliseconds: 100,
  cleanupGraceMilliseconds: 10_000,
  excludedPathSegments: [
    ".git",
    "node_modules",
    "dist",
    "build",
    ".next",
    ".cache",
  ],
} as const;

export interface ProcessExitObservation {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly endedAt: string;
}

export interface ProcessSpawnFailure {
  readonly message: string;
  readonly code?: string;
  readonly failedAt: string;
}

export interface WorkspaceSnapshotEvidence {
  readonly summary: WorkspaceSnapshotSummary;
  readonly manifest: WorkspaceManifest;
}

export interface WorkspaceFileChangeEvidence {
  readonly summary: WorkspaceFileChangeSummary;
  readonly observedAt: string;
  readonly payload?: Uint8Array;
  readonly mediaType?: string;
}

export interface RunSessionOptions {
  readonly agentName?: string;
  readonly upstreamOrigin?: string;
  readonly upstreamRoute?: SessionUpstreamRoute;
}

interface EventOptions {
  readonly payloadRef?: TekrionEvent["payloadRef"];
  readonly source?: EvidenceSource;
  readonly evidence?: EvidenceKind;
}

function eventId(sessionId: string, sequence: number): string {
  const candidate = `event-${sessionId}-${sequence}`;
  if (candidate.length <= 512) {
    return candidate;
  }
  return `event-${createHash("sha256").update(sessionId).digest("hex")}-${sequence}`;
}

function frameEncoding(bytes: Uint8Array): "utf-8" | "binary" {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return "utf-8";
  } catch {
    return "binary";
  }
}

export class RunEventJournal {
  readonly identity: ProcessObservationIdentity;
  private readonly frameIndexes: Record<ProcessOutputStream, number> = {
    stdout: 0,
    stderr: 0,
  };
  private pending: Promise<void> = Promise.resolve();
  private pid?: number;
  private terminal = false;
  private workspaceBaselineRecorded = false;
  private workspaceFinalRecorded = false;

  constructor(
    private readonly storage: TekrionStorage,
    input: ProcessObservationIdentity,
    sessionOptions: RunSessionOptions = {},
  ) {
    this.identity = ProcessObservationIdentitySchema.parse(input);
    this.storage.transaction(() => {
      this.storage.sessions.create(
        SessionSchema.parse({
          schemaVersion: 1,
          id: this.identity.sessionId,
          startedAt: this.identity.startedAt,
          status: "active",
          captureLevel: "wrapped-process",
          command: {
            executable: this.identity.executable,
            arguments: this.identity.arguments,
            cwd: this.identity.cwd,
          },
          ...(sessionOptions.agentName === undefined
            ? {}
            : { agentName: sessionOptions.agentName }),
          ...(sessionOptions.upstreamOrigin === undefined
            ? {}
            : { upstreamOrigin: sessionOptions.upstreamOrigin }),
          ...(sessionOptions.upstreamRoute === undefined
            ? {}
            : { upstreamRoute: sessionOptions.upstreamRoute }),
          models: [],
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
            ...(sessionOptions.agentName === undefined
              ? {}
              : { agentIntegration: sessionOptions.agentName }),
            processCaptureConfiguration: this.identity.configuration,
          },
        }),
      );
      this.insertEvent(
        "session.started",
        { captureLevel: "wrapped-process" },
        this.identity.startedAt,
      );
    });
  }

  recordStarted(pid: number, observedAt: string): Promise<void> {
    if (this.pid !== undefined || this.terminal) {
      throw new Error("Process start may only be recorded once.");
    }
    const summary = ProcessStartedSummarySchema.parse({
      pid,
      parentPid: process.pid,
      executable: this.identity.executable,
      arguments: this.identity.arguments,
      cwd: this.identity.cwd,
    });
    this.pid = summary.pid;
    return this.enqueue(() => {
      this.insertEvent("process.started", summary, observedAt);
    });
  }

  appendOutput(
    stream: ProcessOutputStream,
    bytes: Uint8Array,
    observedAt: string,
  ): Promise<void> {
    if (this.pid === undefined || this.terminal) {
      throw new Error("Process output requires a running process.");
    }
    const captured = Buffer.from(bytes);
    if (captured.length === 0) {
      return this.pending;
    }
    const pid = this.pid;
    return this.enqueue(async () => {
      const maximum = this.identity.configuration.maxOutputFrameBytes;
      for (let offset = 0; offset < captured.length; offset += maximum) {
        const frame = captured.subarray(
          offset,
          Math.min(captured.length, offset + maximum),
        );
        const payloadRef = await this.storage.blobs.put(frame, {
          mediaType:
            frameEncoding(frame) === "utf-8"
              ? "text/plain; charset=utf-8"
              : "application/octet-stream",
        });
        const summary = ProcessOutputSummarySchema.parse({
          pid,
          stream,
          frameIndex: ++this.frameIndexes[stream],
          byteLength: frame.length,
          encoding: frameEncoding(frame),
          truncated: false,
        });
        this.insertEvent(`process.${stream}`, summary, observedAt, {
          payloadRef,
        });
      }
    });
  }

  recordWorkspaceSnapshot(input: WorkspaceSnapshotEvidence): Promise<void> {
    if (this.terminal) {
      throw new Error("Workspace snapshots cannot follow a terminal event.");
    }
    const summary = WorkspaceSnapshotSummarySchema.parse(input.summary);
    const manifest = WorkspaceManifestSchema.parse(input.manifest);
    if (
      summary.root !== manifest.root ||
      summary.capturedAt !== manifest.capturedAt ||
      summary.fileCount !== manifest.entries.length
    ) {
      throw new Error(
        "Workspace snapshot summary does not match its manifest.",
      );
    }
    if (summary.phase === "baseline") {
      if (this.workspaceBaselineRecorded) {
        throw new Error("Workspace baseline may only be recorded once.");
      }
      this.workspaceBaselineRecorded = true;
    } else {
      if (!this.workspaceBaselineRecorded || this.workspaceFinalRecorded) {
        throw new Error(
          "Workspace final snapshot requires exactly one recorded baseline.",
        );
      }
      this.workspaceFinalRecorded = true;
    }
    const bytes = Buffer.from(JSON.stringify(manifest), "utf8");
    return this.enqueue(async () => {
      const payloadRef = await this.storage.blobs.put(bytes, {
        mediaType: "application/vnd.tekrion.workspace-manifest+json",
      });
      this.storage.transaction(() => {
        this.insertEvent("workspace.snapshot", summary, summary.capturedAt, {
          payloadRef,
          source: "filesystem",
        });
        const session = this.storage.sessions.getRequired(
          this.identity.sessionId,
        );
        const metadataKey =
          summary.phase === "baseline" ? "workspaceBaseline" : "workspaceFinal";
        this.storage.sessions.replace(
          SessionSchema.parse({
            ...session,
            repoRoot: summary.root,
            metadata: {
              ...session.metadata,
              [metadataKey]: summary,
            },
          }),
          summary.capturedAt,
        );
      });
    });
  }

  recordFileChange(input: WorkspaceFileChangeEvidence): Promise<void> {
    if (
      this.terminal ||
      !this.workspaceBaselineRecorded ||
      this.workspaceFinalRecorded
    ) {
      throw new Error(
        "File changes require a baseline and must precede the final snapshot.",
      );
    }
    const summary = WorkspaceFileChangeSummarySchema.parse(input.summary);
    const payload =
      input.payload === undefined ? undefined : Buffer.from(input.payload);
    if (
      (payload === undefined) !== (input.mediaType === undefined) ||
      (payload === undefined) !== (summary.payloadKind === undefined)
    ) {
      throw new Error(
        "File change payload, media type, and payload kind must be supplied together.",
      );
    }
    const payloadEvidence =
      payload === undefined || input.mediaType === undefined
        ? undefined
        : { bytes: payload, mediaType: input.mediaType };
    return this.enqueue(async () => {
      const payloadRef =
        payloadEvidence === undefined
          ? undefined
          : await this.storage.blobs.put(payloadEvidence.bytes, {
              mediaType: payloadEvidence.mediaType,
            });
      this.storage.transaction(() => {
        const event = this.insertEvent(
          `file.${summary.operation}`,
          summary,
          input.observedAt,
          {
            ...(payloadRef === undefined ? {} : { payloadRef }),
            source: "filesystem",
            evidence: "derived",
          },
        );
        this.storage.fileChanges.insert({
          schemaVersion: 1,
          eventId: event.id,
          path: summary.path,
          operation: summary.operation,
          ...(summary.previousPath === undefined
            ? {}
            : { previousPath: summary.previousPath }),
          ...(summary.beforeHash === undefined
            ? {}
            : { beforeHash: summary.beforeHash }),
          ...(summary.afterHash === undefined
            ? {}
            : { afterHash: summary.afterHash }),
          ...(payloadRef === undefined ? {} : { patchBlobId: payloadRef.id }),
          timingPrecision: summary.timingPrecision,
          sensitivity: summary.sensitivity,
        });
      });
    });
  }

  recordWorkspaceError(
    phase: "baseline" | "watcher" | "final",
    error: unknown,
    observedAt: string,
  ): Promise<void> {
    if (this.terminal) {
      throw new Error("Workspace errors cannot follow a terminal event.");
    }
    const message =
      error instanceof Error ? error.message : String(error || "Unknown error");
    return this.enqueue(() => {
      this.insertEvent(
        "workspace.error",
        { phase, message: message.slice(0, 4096) },
        observedAt,
        { source: "filesystem" },
      );
    });
  }

  finish(observation: ProcessExitObservation): Promise<void> {
    if (this.pid === undefined || this.terminal) {
      throw new Error("A running process may only finish once.");
    }
    this.terminal = true;
    const pid = this.pid;
    const summary = ProcessExitedSummarySchema.parse({
      pid,
      exitCode: observation.exitCode,
      signal: observation.signal,
      success: observation.exitCode === 0 && observation.signal === null,
    });
    return this.enqueue(() => {
      this.storage.transaction(() => {
        this.insertEvent("process.exited", summary, observation.endedAt);
        this.insertEvent(
          "session.ended",
          { exitCode: summary.exitCode, signal: summary.signal },
          observation.endedAt,
        );
        this.updateSession("completed", observation.endedAt);
      });
    });
  }

  fail(failure: ProcessSpawnFailure): Promise<void> {
    if (this.pid !== undefined || this.terminal) {
      throw new Error("Only an unstarted process can record a spawn failure.");
    }
    this.terminal = true;
    const summary = ProcessFailureSummarySchema.parse({
      executable: this.identity.executable,
      ...(failure.code === undefined ? {} : { code: failure.code }),
      message: failure.message.slice(0, 4096),
    });
    return this.enqueue(() => {
      this.storage.transaction(() => {
        this.insertEvent("process.error", summary, failure.failedAt);
        this.insertEvent("session.crashed", summary, failure.failedAt);
        this.updateSession("crashed", failure.failedAt);
      });
    });
  }

  flush(): Promise<void> {
    return this.pending;
  }

  private enqueue(operation: () => void | Promise<void>): Promise<void> {
    this.pending = this.pending.then(operation);
    return this.pending;
  }

  private insertEvent(
    type: string,
    summary: TekrionEvent["summary"],
    observedAt: string,
    options: EventOptions = {},
  ): TekrionEvent {
    const sequence = this.storage.sequences.reserve(this.identity.sessionId)[0];
    if (sequence === undefined) {
      throw new Error(
        `Failed to allocate process event sequence for ${this.identity.sessionId}.`,
      );
    }
    return this.storage.events.insert(
      TekrionEventSchema.parse({
        schemaVersion: 1,
        id: eventId(this.identity.sessionId, sequence),
        sessionId: this.identity.sessionId,
        sequence,
        occurredAt: observedAt,
        observedAt,
        source: options.source ?? "process",
        type,
        evidence: options.evidence ?? "observed",
        ...(options.payloadRef === undefined
          ? {}
          : { payloadRef: options.payloadRef }),
        summary,
        redaction: NO_REDACTION,
      }),
    );
  }

  private updateSession(
    status: "completed" | "crashed",
    endedAt: string,
  ): void {
    const session = this.storage.sessions.getRequired(this.identity.sessionId);
    this.storage.sessions.replace(
      SessionSchema.parse({ ...session, status, endedAt }),
      endedAt,
    );
  }
}
