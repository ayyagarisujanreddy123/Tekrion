import { watch, type FSWatcher } from "node:fs";
import { isAbsolute, sep } from "node:path";

import {
  WorkspaceFileChangeSummarySchema,
  type WorkspaceFileChangeSummary,
  type WorkspaceManifestEntry,
} from "@tekrion/protocol";

const MAX_PENDING_PATHS = 10_000;
const MAX_SAMPLES_PER_PATH = 32;
const MAX_OUTSTANDING_SAMPLES = 64;
const MAX_REMEMBERED_SIGNATURES = 100_000;
const MAX_WATCHER_ERRORS = 100;

export interface WorkspaceWatchPathState {
  readonly manifest: WorkspaceManifestEntry;
  readonly sensitivity: "normal" | "secret";
}

export interface ApproximateWorkspaceChange {
  readonly summary: WorkspaceFileChangeSummary;
  readonly observedAt: string;
}

export interface WorkspaceWatcherOptions {
  readonly root: string;
  readonly debounceMilliseconds: number;
  readonly baseline: ReadonlyMap<string, WorkspaceWatchPathState>;
  readonly now: () => Date;
  readonly excluded: (path: string) => boolean;
  readonly inspect: (
    path: string,
    signal: AbortSignal,
  ) => Promise<WorkspaceWatchPathState | undefined>;
  readonly listener: (
    change: ApproximateWorkspaceChange,
  ) => void | Promise<void>;
}

interface WatchSample {
  readonly inspected: boolean;
  readonly observedAt: string;
  readonly state?: WorkspaceWatchPathState;
}

interface PendingPath {
  readonly path: string;
  lastObservedAt: string;
  readonly samples: Promise<WatchSample>[];
}

interface WatchCandidate {
  readonly path: string;
  readonly operation: "create" | "modify" | "delete" | "rename";
  readonly observedAt: string;
  readonly previousPath?: string;
  readonly before?: WorkspaceWatchPathState;
  readonly after?: WorkspaceWatchPathState;
}

function normalizeWatchPath(path: string): string | undefined {
  const normalized = sep === "/" ? path : path.split(sep).join("/");
  if (
    normalized.length === 0 ||
    normalized.includes("\0") ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    isAbsolute(normalized)
  ) {
    return undefined;
  }
  return normalized;
}

function sameState(
  left: WorkspaceWatchPathState,
  right: WorkspaceWatchPathState,
): boolean {
  return (
    left.manifest.kind === right.manifest.kind &&
    left.manifest.byteLength === right.manifest.byteLength &&
    left.manifest.mode === right.manifest.mode &&
    left.manifest.sha256 === right.manifest.sha256
  );
}

function mainCandidate(
  path: string,
  before: WorkspaceWatchPathState | undefined,
  after: WorkspaceWatchPathState | undefined,
  observedAt: string,
): WatchCandidate | undefined {
  if (before === undefined && after !== undefined) {
    return { path, operation: "create", observedAt, after };
  }
  if (before !== undefined && after === undefined) {
    return { path, operation: "delete", observedAt, before };
  }
  if (
    before !== undefined &&
    after !== undefined &&
    !sameState(before, after)
  ) {
    return { path, operation: "modify", observedAt, before, after };
  }
  return undefined;
}

function transientCandidates(
  pending: PendingPath,
  baseline: WorkspaceWatchPathState | undefined,
  current: WorkspaceWatchPathState | undefined,
  samples: readonly WatchSample[],
): WatchCandidate[] {
  if (baseline === undefined && current === undefined) {
    const existing = samples.find((sample) => sample.state !== undefined);
    if (existing?.state === undefined) {
      return [];
    }
    return [
      {
        path: pending.path,
        operation: "create",
        observedAt: existing.observedAt,
        after: existing.state,
      },
      {
        path: pending.path,
        operation: "delete",
        observedAt: pending.lastObservedAt,
        before: existing.state,
      },
    ];
  }

  if (
    baseline !== undefined &&
    current !== undefined &&
    sameState(baseline, current)
  ) {
    const changed = samples.find(
      (sample) =>
        sample.state !== undefined && !sameState(baseline, sample.state),
    );
    if (changed?.state !== undefined) {
      return [
        {
          path: pending.path,
          operation: "modify",
          observedAt: changed.observedAt,
          before: baseline,
          after: changed.state,
        },
        {
          path: pending.path,
          operation: "modify",
          observedAt: pending.lastObservedAt,
          before: changed.state,
          after: current,
        },
      ];
    }
    const missing = samples.find(
      (sample) => sample.inspected && sample.state === undefined,
    );
    if (missing !== undefined) {
      return [
        {
          path: pending.path,
          operation: "delete",
          observedAt: missing.observedAt,
          before: baseline,
        },
        {
          path: pending.path,
          operation: "create",
          observedAt: pending.lastObservedAt,
          after: current,
        },
      ];
    }
  }
  return [];
}

function renameCandidates(
  candidates: readonly WatchCandidate[],
): WatchCandidate[] {
  const remaining = new Set(candidates);
  const deleted = new Map<string, WatchCandidate[]>();
  const created = new Map<string, WatchCandidate[]>();
  for (const candidate of candidates) {
    if (candidate.operation === "delete" && candidate.before !== undefined) {
      const identity = `${candidate.before.manifest.kind}:${candidate.before.manifest.sha256}`;
      deleted.set(identity, [...(deleted.get(identity) ?? []), candidate]);
    } else if (
      candidate.operation === "create" &&
      candidate.after !== undefined
    ) {
      const identity = `${candidate.after.manifest.kind}:${candidate.after.manifest.sha256}`;
      created.set(identity, [...(created.get(identity) ?? []), candidate]);
    }
  }

  const renames: WatchCandidate[] = [];
  for (const [identity, deletedCandidates] of deleted) {
    const createdCandidates = created.get(identity);
    if (deletedCandidates.length !== 1 || createdCandidates?.length !== 1) {
      continue;
    }
    const source = deletedCandidates[0] as WatchCandidate;
    const target = createdCandidates[0] as WatchCandidate;
    remaining.delete(source);
    remaining.delete(target);
    renames.push({
      path: target.path,
      operation: "rename",
      previousPath: source.path,
      observedAt:
        source.observedAt > target.observedAt
          ? source.observedAt
          : target.observedAt,
      before: source.before as WorkspaceWatchPathState,
      after: target.after as WorkspaceWatchPathState,
    });
  }
  return [...remaining, ...renames].sort(
    (left, right) =>
      left.observedAt.localeCompare(right.observedAt) ||
      left.path.localeCompare(right.path) ||
      left.operation.localeCompare(right.operation),
  );
}

function summary(candidate: WatchCandidate): WorkspaceFileChangeSummary {
  const secret =
    candidate.before?.sensitivity === "secret" ||
    candidate.after?.sensitivity === "secret";
  return WorkspaceFileChangeSummarySchema.parse({
    path: candidate.path,
    operation: candidate.operation,
    ...(candidate.previousPath === undefined
      ? {}
      : { previousPath: candidate.previousPath }),
    ...(candidate.before === undefined
      ? {}
      : {
          beforeHash: candidate.before.manifest.sha256,
          beforeByteLength: candidate.before.manifest.byteLength,
        }),
    ...(candidate.after === undefined
      ? {}
      : {
          afterHash: candidate.after.manifest.sha256,
          afterByteLength: candidate.after.manifest.byteLength,
        }),
    timingPrecision: "approximate-watcher",
    sensitivity: secret ? "secret" : "normal",
  });
}

function candidateSignature(candidate: WatchCandidate): string {
  return [
    candidate.operation,
    candidate.previousPath ?? "",
    candidate.path,
    candidate.before?.manifest.sha256 ?? "",
    candidate.after?.manifest.sha256 ?? "",
  ].join("\0");
}

function candidatePaths(candidate: WatchCandidate): string[] {
  return candidate.previousPath === undefined
    ? [candidate.path]
    : [candidate.previousPath, candidate.path];
}

export class DebouncedWorkspaceWatcher {
  private readonly watcher: FSWatcher;
  private readonly controller = new AbortController();
  private readonly errors_: Error[] = [];
  private readonly lastSignatures = new Map<string, string>();
  private pending = new Map<string, PendingPath>();
  private timer: NodeJS.Timeout | undefined;
  private activeFlush: Promise<void> | undefined;
  private closed = false;
  private outstandingSamples = 0;
  private pendingLimitReported = false;
  private sampleLimitReported = false;
  private outstandingSampleLimitReported = false;

  constructor(private readonly options: WorkspaceWatcherOptions) {
    this.watcher = watch(
      options.root,
      { recursive: true, persistent: false },
      (_eventType, filename) => {
        this.observe(filename);
      },
    );
    this.watcher.on("error", (error) => {
      this.recordError(error);
    });
  }

  get errors(): readonly Error[] {
    return [...this.errors_];
  }

  async stop(signal?: AbortSignal): Promise<readonly Error[]> {
    if (this.closed) {
      await this.drain();
      return this.errors;
    }
    this.closed = true;
    this.watcher.close();
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }

    const abort = () => {
      this.controller.abort(signal?.reason);
    };
    if (signal?.aborted === true) {
      abort();
    } else {
      signal?.addEventListener("abort", abort, { once: true });
    }
    try {
      await this.drain();
    } finally {
      signal?.removeEventListener("abort", abort);
    }
    return this.errors;
  }

  private observe(filename: string | Buffer | null): void {
    if (this.closed || filename === null) {
      if (filename === null) {
        this.recordError(
          new Error("Filesystem watcher reported a change without a path."),
        );
      }
      return;
    }
    const path = normalizeWatchPath(
      typeof filename === "string" ? filename : filename.toString("utf8"),
    );
    if (path === undefined || this.options.excluded(path)) {
      return;
    }
    const observedAt = this.options.now().toISOString();
    let pending = this.pending.get(path);
    if (pending === undefined) {
      if (this.pending.size >= MAX_PENDING_PATHS) {
        if (!this.pendingLimitReported) {
          this.pendingLimitReported = true;
          this.recordError(
            new Error(
              `Filesystem watcher pending-path limit (${MAX_PENDING_PATHS}) was reached.`,
            ),
          );
        }
        return;
      }
      pending = {
        path,
        lastObservedAt: observedAt,
        samples: [],
      };
      this.pending.set(path, pending);
    } else {
      pending.lastObservedAt = observedAt;
    }
    if (
      pending.samples.length < MAX_SAMPLES_PER_PATH &&
      this.outstandingSamples < MAX_OUTSTANDING_SAMPLES
    ) {
      this.outstandingSamples += 1;
      pending.samples.push(
        this.sample(path, observedAt).finally(() => {
          this.outstandingSamples -= 1;
        }),
      );
    } else {
      if (
        pending.samples.length >= MAX_SAMPLES_PER_PATH &&
        !this.sampleLimitReported
      ) {
        this.sampleLimitReported = true;
        this.recordError(
          new Error(
            `Filesystem watcher per-path sample limit (${MAX_SAMPLES_PER_PATH}) was reached.`,
          ),
        );
      } else if (
        this.outstandingSamples >= MAX_OUTSTANDING_SAMPLES &&
        !this.outstandingSampleLimitReported
      ) {
        this.outstandingSampleLimitReported = true;
        this.recordError(
          new Error(
            `Filesystem watcher outstanding-sample limit (${MAX_OUTSTANDING_SAMPLES}) was reached.`,
          ),
        );
      }
    }
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.startFlush();
    }, this.options.debounceMilliseconds);
    this.timer.unref();
  }

  private async sample(path: string, observedAt: string): Promise<WatchSample> {
    try {
      const state = await this.options.inspect(path, this.controller.signal);
      return {
        inspected: true,
        observedAt,
        ...(state === undefined ? {} : { state }),
      };
    } catch (error: unknown) {
      if (!this.controller.signal.aborted) {
        this.recordError(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
      return { inspected: false, observedAt };
    }
  }

  private startFlush(): Promise<void> {
    if (this.activeFlush !== undefined) {
      return this.activeFlush;
    }
    const operation = this.flush().catch((error: unknown) => {
      if (!this.controller.signal.aborted) {
        this.recordError(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    });
    this.activeFlush = operation;
    void operation.then(
      () => this.finishFlush(operation),
      () => this.finishFlush(operation),
    );
    return operation;
  }

  private finishFlush(operation: Promise<void>): void {
    if (this.activeFlush === operation) {
      this.activeFlush = undefined;
    }
    if (!this.closed && this.pending.size > 0 && this.timer === undefined) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.startFlush();
      }, this.options.debounceMilliseconds);
      this.timer.unref();
    }
  }

  private async drain(): Promise<void> {
    while (this.pending.size > 0 || this.activeFlush !== undefined) {
      if (this.activeFlush !== undefined) {
        await this.activeFlush;
      } else {
        await this.startFlush();
      }
    }
  }

  private async flush(): Promise<void> {
    const batch = this.pending;
    this.pending = new Map();
    if (batch.size === 0) {
      return;
    }
    const candidates: WatchCandidate[] = [];
    for (const pending of batch.values()) {
      const samples = await Promise.all(pending.samples);
      this.controller.signal.throwIfAborted();
      const current = await this.options.inspect(
        pending.path,
        this.controller.signal,
      );
      const baseline = this.options.baseline.get(pending.path);
      const direct = mainCandidate(
        pending.path,
        baseline,
        current,
        pending.lastObservedAt,
      );
      if (direct === undefined) {
        candidates.push(
          ...transientCandidates(pending, baseline, current, samples),
        );
      } else {
        candidates.push(direct);
      }
    }

    for (const candidate of renameCandidates(candidates)) {
      const signature = candidateSignature(candidate);
      const paths = candidatePaths(candidate);
      if (paths.every((path) => this.lastSignatures.get(path) === signature)) {
        continue;
      }
      for (const path of paths) {
        if (
          this.lastSignatures.has(path) ||
          this.lastSignatures.size < MAX_REMEMBERED_SIGNATURES
        ) {
          this.lastSignatures.set(path, signature);
        }
      }
      try {
        await this.options.listener({
          summary: summary(candidate),
          observedAt: candidate.observedAt,
        });
      } catch (error: unknown) {
        this.recordError(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    }
  }

  private recordError(error: Error): void {
    if (this.errors_.length < MAX_WATCHER_ERRORS - 1) {
      this.errors_.push(error);
    } else if (this.errors_.length === MAX_WATCHER_ERRORS - 1) {
      this.errors_.push(
        new Error("Additional filesystem watcher errors were omitted."),
      );
    }
  }
}
