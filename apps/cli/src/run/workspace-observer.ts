import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, type Stats } from "node:fs";
import { lstat, open, readdir, readlink, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import {
  WorkspaceFileChangeSummarySchema,
  WorkspaceManifestSchema,
  WorkspaceSnapshotSummarySchema,
  type ProcessRunConfiguration,
  type WorkspaceFileChangeSummary,
  type WorkspaceManifest,
  type WorkspaceManifestEntry,
  type WorkspaceSnapshotSummary,
} from "@tekrion/protocol";

import {
  DebouncedWorkspaceWatcher,
  type ApproximateWorkspaceChange,
  type WorkspaceWatchPathState,
} from "./workspace-watcher.js";

const MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024;
const MAX_GIT_ERROR_BYTES = 64 * 1024;
const MAX_MANIFEST_ENTRIES = 250_000;
const DEFAULT_MAX_CAPTURED_CONTENT_BYTES = 16 * 1024 * 1024;
const GIT_COMMAND_TIMEOUT_MILLISECONDS = 30_000;
const MAX_INCOMPLETE_REASONS = 100;
const MAX_FILE_CHANGE_EVENTS = 10_000;
const MAX_FILE_PAYLOADS = 256;

type ContentSensitivity = "normal" | "secret";

export interface WorkspaceObserverOptions {
  readonly cwd: string;
  readonly dataDirectory?: string;
  readonly configuration: ProcessRunConfiguration;
  readonly now?: () => Date;
  readonly maxCapturedContentBytes?: number;
}

export interface CapturedWorkspaceSnapshot {
  readonly summary: WorkspaceSnapshotSummary;
  readonly manifest: WorkspaceManifest;
}

export interface ObservedWorkspaceChange {
  readonly summary: WorkspaceFileChangeSummary;
  readonly observedAt: string;
  readonly payload?: Uint8Array;
  readonly mediaType?: string;
}

export interface CompletedWorkspaceObservation {
  readonly snapshot: CapturedWorkspaceSnapshot;
  readonly changes: readonly ObservedWorkspaceChange[];
  readonly watcherErrors: readonly Error[];
}

interface WorkspaceDescriptor {
  readonly kind: "git" | "directory";
  readonly cwd: string;
  readonly root: string;
}

interface CapturedEntry {
  readonly manifest: WorkspaceManifestEntry;
  readonly content?: Buffer;
  readonly sensitivity: ContentSensitivity;
}

interface InternalSnapshot {
  readonly evidence: CapturedWorkspaceSnapshot;
  readonly entries: ReadonlyMap<string, CapturedEntry>;
  readonly gitDirtyPaths: ReadonlySet<string>;
}

interface ChangeCandidate {
  readonly path: string;
  readonly operation: "create" | "modify" | "delete" | "rename";
  readonly previousPath?: string;
  readonly before?: CapturedEntry;
  readonly after?: CapturedEntry;
}

interface CommandResult {
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly exitCode: number | null;
  readonly outputExceeded: boolean;
  readonly timedOut: boolean;
  readonly aborted: boolean;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function errorCode(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return "UNKNOWN";
}

function normalizeRelativePath(path: string): string | undefined {
  const normalized = sep === "/" ? path : path.split(sep).join("/");
  if (
    normalized.length === 0 ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    isAbsolute(normalized)
  ) {
    return undefined;
  }
  return normalized;
}

function isWithin(parent: string, candidate: string): boolean {
  const child = relative(parent, candidate);
  return (
    child.length === 0 ||
    (!child.startsWith(`..${sep}`) && child !== ".." && !isAbsolute(child))
  );
}

function secretPath(path: string): boolean {
  const name = path.split("/").at(-1)?.toLowerCase() ?? "";
  if ([".env.example", ".env.sample", ".env.template"].includes(name)) {
    return false;
  }
  return (
    name === ".env" ||
    name.startsWith(".env.") ||
    [
      ".netrc",
      ".npmrc",
      ".pypirc",
      "credentials",
      "credentials.json",
      "id_ed25519",
      "id_rsa",
    ].includes(name) ||
    name.startsWith("secrets.") ||
    name.endsWith(".key") ||
    name.endsWith(".pem")
  );
}

function sameEntry(
  left: WorkspaceManifestEntry,
  right: WorkspaceManifestEntry,
): boolean {
  return (
    left.kind === right.kind &&
    left.byteLength === right.byteLength &&
    left.mode === right.mode &&
    left.sha256 === right.sha256
  );
}

function sameFilesystemState(before: Stats, after: Stats): boolean {
  return (
    before.size === after.size &&
    before.mode === after.mode &&
    before.mtimeMs === after.mtimeMs
  );
}

async function runCommand(
  executable: string,
  arguments_: readonly string[],
  cwd: string,
  maximumOutputBytes: number,
  signal?: AbortSignal,
): Promise<CommandResult> {
  signal?.throwIfAborted();
  return await new Promise<CommandResult>((resolveCommand, rejectCommand) => {
    const child = spawn(executable, arguments_, {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutLength = 0;
    let stderrLength = 0;
    let outputExceeded = false;
    let timedOut = false;
    let aborted = false;
    let settled = false;

    const abort = () => {
      aborted = true;
      child.kill("SIGKILL");
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted === true) {
      abort();
    }

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, GIT_COMMAND_TIMEOUT_MILLISECONDS);
    timer.unref();

    child.stdout.on("data", (chunk: Buffer) => {
      if (outputExceeded) {
        return;
      }
      const bytes = Buffer.from(chunk);
      stdoutLength += bytes.length;
      if (stdoutLength > maximumOutputBytes) {
        outputExceeded = true;
        child.kill("SIGKILL");
        return;
      }
      stdout.push(bytes);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderrLength >= MAX_GIT_ERROR_BYTES) {
        return;
      }
      const bytes = Buffer.from(chunk);
      const remaining = MAX_GIT_ERROR_BYTES - stderrLength;
      stderr.push(bytes.subarray(0, remaining));
      stderrLength += Math.min(bytes.length, remaining);
    });
    child.once("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      rejectCommand(error);
    });
    child.once("close", (exitCode) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      resolveCommand({
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        exitCode,
        outputExceeded,
        timedOut,
        aborted,
      });
    });
  });
}

async function git(
  root: string,
  arguments_: readonly string[],
  maximumOutputBytes = MAX_GIT_OUTPUT_BYTES,
  signal?: AbortSignal,
): Promise<Buffer> {
  const result = await runCommand(
    "git",
    ["-C", root, ...arguments_],
    root,
    maximumOutputBytes,
    signal,
  );
  if (result.aborted) {
    signal?.throwIfAborted();
    throw new Error("Git command was aborted.");
  }
  if (result.timedOut) {
    throw new Error(`Git command timed out: git ${arguments_[0] ?? ""}`);
  }
  if (result.outputExceeded) {
    throw new Error(
      `Git command output exceeded ${maximumOutputBytes} bytes: git ${arguments_[0] ?? ""}`,
    );
  }
  if (result.exitCode !== 0) {
    const detail = result.stderr.toString("utf8").trim();
    throw new Error(
      `Git command failed (${String(result.exitCode)}): git ${arguments_[0] ?? ""}${
        detail.length === 0 ? "" : `: ${detail}`
      }`,
    );
  }
  return result.stdout;
}

async function gitPathIgnored(
  root: string,
  path: string,
  signal: AbortSignal,
): Promise<boolean> {
  const result = await runCommand(
    "git",
    ["-C", root, "check-ignore", "-q", "--", path],
    root,
    1024,
    signal,
  );
  if (result.aborted) {
    signal.throwIfAborted();
  }
  if (result.timedOut || result.outputExceeded) {
    throw new Error(`Git ignore check did not complete for ${path}.`);
  }
  if (result.exitCode === 0) {
    return true;
  }
  if (result.exitCode === 1) {
    return false;
  }
  throw new Error(
    `Git ignore check failed (${String(result.exitCode)}) for ${path}.`,
  );
}

async function detectWorkspace(cwd: string): Promise<WorkspaceDescriptor> {
  try {
    const output = await git(
      cwd,
      ["rev-parse", "--show-toplevel"],
      1024 * 1024,
    );
    const root = output.toString("utf8").trim();
    if (root.length > 0) {
      return { kind: "git", cwd, root: await canonicalPath(root) };
    }
  } catch {
    // Git absence and a non-repository directory both use directory capture.
  }
  return { kind: "directory", cwd, root: await canonicalPath(cwd) };
}

async function canonicalPath(path: string): Promise<string> {
  const absolutePath = resolve(path);
  try {
    return await realpath(absolutePath);
  } catch {
    return absolutePath;
  }
}

function nullSeparatedPaths(bytes: Buffer): string[] {
  const paths = bytes.toString("utf8").split("\0");
  if (paths.at(-1) === "") {
    paths.pop();
  }
  return paths;
}

function dirtyPaths(status: Buffer): ReadonlySet<string> {
  const records = nullSeparatedPaths(status);
  const paths = new Set<string>();
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] as string;
    if (record.length < 4 || record[2] !== " ") {
      continue;
    }
    const statusCode = record.slice(0, 2);
    const path = normalizeRelativePath(record.slice(3));
    if (path !== undefined) {
      paths.add(path);
    }
    if (/[RC]/u.test(statusCode)) {
      const previous = normalizeRelativePath(records[index + 1] ?? "");
      if (previous !== undefined) {
        paths.add(previous);
      }
      index += 1;
    }
  }
  return paths;
}

async function readFileAtSize(
  path: string,
  size: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  signal?.throwIfAborted();
  const handle = await open(path, "r");
  try {
    const bytes = Buffer.alloc(size);
    let offset = 0;
    while (offset < bytes.length) {
      signal?.throwIfAborted();
      const result = await handle.read(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (result.bytesRead === 0) {
        break;
      }
      offset += result.bytesRead;
    }
    return bytes.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

async function hashFile(path: string, signal?: AbortSignal): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path, { signal })) {
    digest.update(chunk as Buffer);
  }
  return digest.digest("hex");
}

class SnapshotCollector {
  readonly entries = new Map<string, CapturedEntry>();
  readonly reasons = new Set<string>();
  capturedContentBytes = 0;
  private readonly excludedSegments: ReadonlySet<string>;

  constructor(
    private readonly descriptor: WorkspaceDescriptor,
    private readonly configuration: ProcessRunConfiguration,
    private readonly dataDirectory: string | undefined,
    private readonly maxCapturedContentBytes: number,
    private readonly signal?: AbortSignal,
  ) {
    this.excludedSegments = new Set(configuration.excludedPathSegments);
  }

  addReason(reason: string): void {
    if (this.reasons.size < MAX_INCOMPLETE_REASONS) {
      this.reasons.add(reason);
    } else {
      this.reasons.add("additional-incomplete-reasons-omitted");
    }
  }

  throwIfAborted(): void {
    this.signal?.throwIfAborted();
  }

  excluded(path: string): boolean {
    const absolutePath = resolve(this.descriptor.root, path);
    if (
      this.dataDirectory !== undefined &&
      isWithin(this.dataDirectory, absolutePath)
    ) {
      return true;
    }
    return path
      .split("/")
      .some((segment) => this.excludedSegments.has(segment));
  }

  async capture(path: string, tracked: boolean): Promise<void> {
    this.throwIfAborted();
    if (this.entries.size >= MAX_MANIFEST_ENTRIES) {
      this.addReason("manifest-entry-limit-reached");
      return;
    }
    const normalized = normalizeRelativePath(path);
    if (normalized === undefined || this.excluded(normalized)) {
      return;
    }
    const absolutePath = resolve(this.descriptor.root, normalized);
    if (!isWithin(this.descriptor.root, absolutePath)) {
      this.addReason(`out-of-scope-path:${normalized}`);
      return;
    }

    try {
      const stats = await lstat(absolutePath);
      if (stats.isSymbolicLink()) {
        await this.captureSymlink(normalized, absolutePath, tracked, stats);
      } else if (stats.isFile()) {
        await this.captureFile(normalized, absolutePath, tracked, stats);
      } else if (!stats.isDirectory()) {
        this.addReason(`unsupported-file-type:${normalized}`);
      }
    } catch (error: unknown) {
      this.throwIfAborted();
      if (errorCode(error) !== "ENOENT") {
        this.addReason(`unreadable:${normalized}:${errorCode(error)}`);
      }
    }
  }

  private canCaptureContent(
    size: number,
    sensitivity: ContentSensitivity,
  ): boolean {
    if (sensitivity !== "normal") {
      this.addReason("sensitive-content-omitted");
      return false;
    }
    if (size > this.configuration.maxUntrackedFileBytes) {
      this.addReason("per-file-content-limit-reached");
      return false;
    }
    if (size > this.maxCapturedContentBytes - this.capturedContentBytes) {
      this.addReason("snapshot-content-limit-reached");
      return false;
    }
    return true;
  }

  private async captureSymlink(
    path: string,
    absolutePath: string,
    tracked: boolean,
    initialStats: Stats,
  ): Promise<void> {
    let stats = initialStats;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      this.throwIfAborted();
      const target = await readlink(absolutePath, { encoding: "buffer" });
      const finalStats = await lstat(absolutePath);
      if (sameFilesystemState(stats, finalStats)) {
        const sensitivity: ContentSensitivity = secretPath(path)
          ? "secret"
          : "normal";
        const capture = this.canCaptureContent(target.length, sensitivity);
        const content = capture ? Buffer.from(target) : undefined;
        if (content !== undefined) {
          this.capturedContentBytes += content.length;
        }
        this.entries.set(path, {
          manifest: {
            path,
            kind: "symlink",
            byteLength: target.length,
            mode: finalStats.mode,
            modifiedAt: new Date(finalStats.mtimeMs).toISOString(),
            sha256: sha256(target),
            tracked,
          },
          ...(content === undefined ? {} : { content }),
          sensitivity,
        });
        return;
      }
      stats = finalStats;
    }
    this.addReason(`changed-during-snapshot:${path}`);
  }

  private async captureFile(
    path: string,
    absolutePath: string,
    tracked: boolean,
    initialStats: Stats,
  ): Promise<void> {
    let stats = initialStats;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      this.throwIfAborted();
      const sensitivity: ContentSensitivity = secretPath(path)
        ? "secret"
        : "normal";
      const capture = this.canCaptureContent(stats.size, sensitivity);
      const content = capture
        ? await readFileAtSize(absolutePath, stats.size, this.signal)
        : undefined;
      const digest =
        content === undefined
          ? await hashFile(absolutePath, this.signal)
          : sha256(content);
      const finalStats = await lstat(absolutePath);
      if (
        sameFilesystemState(stats, finalStats) &&
        (content === undefined || content.length === finalStats.size)
      ) {
        if (content !== undefined) {
          this.capturedContentBytes += content.length;
        }
        this.entries.set(path, {
          manifest: {
            path,
            kind: "file",
            byteLength: finalStats.size,
            mode: finalStats.mode,
            modifiedAt: new Date(finalStats.mtimeMs).toISOString(),
            sha256: digest,
            tracked,
          },
          ...(content === undefined ? {} : { content }),
          sensitivity,
        });
        return;
      }
      stats = finalStats;
    }
    this.addReason(`changed-during-snapshot:${path}`);
  }
}

async function directoryPaths(
  collector: SnapshotCollector,
  root: string,
  directory = root,
): Promise<void> {
  let entries;
  try {
    collector.throwIfAborted();
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error: unknown) {
    collector.throwIfAborted();
    const path = normalizeRelativePath(relative(root, directory)) ?? ".";
    collector.addReason(`unreadable-directory:${path}:${errorCode(error)}`);
    return;
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    collector.throwIfAborted();
    const absolutePath = resolve(directory, entry.name);
    const path = normalizeRelativePath(relative(root, absolutePath));
    if (path === undefined || collector.excluded(path)) {
      continue;
    }
    if (entry.isDirectory()) {
      await directoryPaths(collector, root, absolutePath);
    } else {
      await collector.capture(path, false);
    }
  }
}

async function captureSnapshot(
  descriptor: WorkspaceDescriptor,
  options: WorkspaceObserverOptions,
  phase: "baseline" | "final",
  signal?: AbortSignal,
): Promise<InternalSnapshot> {
  signal?.throwIfAborted();
  const capturedAt = (options.now ?? (() => new Date()))().toISOString();
  const collector = new SnapshotCollector(
    descriptor,
    options.configuration,
    options.dataDirectory === undefined
      ? undefined
      : resolve(options.dataDirectory),
    options.maxCapturedContentBytes ?? DEFAULT_MAX_CAPTURED_CONTENT_BYTES,
    signal,
  );
  let gitHead: string | null | undefined;
  let statusSha256: string | undefined;
  let gitDirtyPaths: ReadonlySet<string> = new Set();

  if (descriptor.kind === "git") {
    try {
      const head = await git(
        descriptor.root,
        ["rev-parse", "--verify", "HEAD"],
        MAX_GIT_OUTPUT_BYTES,
        signal,
      );
      gitHead = head.toString("utf8").trim() || null;
    } catch {
      signal?.throwIfAborted();
      gitHead = null;
    }
    try {
      const status = await git(
        descriptor.root,
        [
          "status",
          "--porcelain=v1",
          "-z",
          "--untracked-files=all",
          "--ignored=no",
        ],
        MAX_GIT_OUTPUT_BYTES,
        signal,
      );
      statusSha256 = sha256(status);
      gitDirtyPaths = dirtyPaths(status);
    } catch (error: unknown) {
      signal?.throwIfAborted();
      collector.addReason(`git-status-failed:${errorCode(error)}`);
    }

    try {
      const [allOutput, trackedOutput] = await Promise.all([
        git(
          descriptor.root,
          ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
          MAX_GIT_OUTPUT_BYTES,
          signal,
        ),
        git(
          descriptor.root,
          ["ls-files", "-z", "--cached"],
          MAX_GIT_OUTPUT_BYTES,
          signal,
        ),
      ]);
      const tracked = new Set(
        nullSeparatedPaths(trackedOutput)
          .map(normalizeRelativePath)
          .filter((path): path is string => path !== undefined),
      );
      const paths = [
        ...new Set(
          nullSeparatedPaths(allOutput)
            .map(normalizeRelativePath)
            .filter((path): path is string => path !== undefined),
        ),
      ].sort();
      for (const path of paths) {
        signal?.throwIfAborted();
        await collector.capture(path, tracked.has(path));
      }
    } catch (error: unknown) {
      signal?.throwIfAborted();
      collector.addReason(`git-manifest-failed:${errorCode(error)}`);
    }
  } else {
    await directoryPaths(collector, descriptor.root);
  }

  signal?.throwIfAborted();
  const entries = [...collector.entries.values()]
    .map((entry) => entry.manifest)
    .sort((left, right) => left.path.localeCompare(right.path));
  const manifest = WorkspaceManifestSchema.parse({
    schemaVersion: 1,
    root: descriptor.root,
    capturedAt,
    entries,
  });
  const summary = WorkspaceSnapshotSummarySchema.parse({
    schemaVersion: 1,
    kind: descriptor.kind,
    cwd: descriptor.cwd,
    root: descriptor.root,
    capturedAt,
    ...(descriptor.kind === "git"
      ? {
          gitHead: gitHead ?? null,
          ...(statusSha256 === undefined ? {} : { statusSha256 }),
        }
      : {}),
    phase,
    fileCount: entries.length,
    capturedContentBytes: collector.capturedContentBytes,
    incompleteReasons: [...collector.reasons].sort(),
  });
  return {
    evidence: { summary, manifest },
    entries: collector.entries,
    gitDirtyPaths,
  };
}

function changesBetween(
  baseline: InternalSnapshot,
  final: InternalSnapshot,
): ChangeCandidate[] {
  const changes: ChangeCandidate[] = [];
  const deleted = new Map<string, CapturedEntry>();
  const created = new Map<string, CapturedEntry>();

  for (const [path, before] of baseline.entries) {
    const after = final.entries.get(path);
    if (after === undefined) {
      deleted.set(path, before);
    } else if (!sameEntry(before.manifest, after.manifest)) {
      changes.push({ path, operation: "modify", before, after });
    }
  }
  for (const [path, after] of final.entries) {
    if (!baseline.entries.has(path)) {
      created.set(path, after);
    }
  }

  const deletedByIdentity = new Map<string, string[]>();
  const createdByIdentity = new Map<string, string[]>();
  for (const [path, entry] of deleted) {
    const key = `${entry.manifest.kind}:${entry.manifest.sha256}`;
    deletedByIdentity.set(key, [...(deletedByIdentity.get(key) ?? []), path]);
  }
  for (const [path, entry] of created) {
    const key = `${entry.manifest.kind}:${entry.manifest.sha256}`;
    createdByIdentity.set(key, [...(createdByIdentity.get(key) ?? []), path]);
  }
  for (const [key, deletedPaths] of deletedByIdentity) {
    const createdPaths = createdByIdentity.get(key);
    if (deletedPaths.length !== 1 || createdPaths?.length !== 1) {
      continue;
    }
    const previousPath = deletedPaths[0] as string;
    const path = createdPaths[0] as string;
    const before = deleted.get(previousPath) as CapturedEntry;
    const after = created.get(path) as CapturedEntry;
    deleted.delete(previousPath);
    created.delete(path);
    changes.push({ path, previousPath, operation: "rename", before, after });
  }

  for (const [path, before] of deleted) {
    changes.push({ path, operation: "delete", before });
  }
  for (const [path, after] of created) {
    changes.push({ path, operation: "create", after });
  }
  return changes.sort(
    (left, right) =>
      left.path.localeCompare(right.path) ||
      left.operation.localeCompare(right.operation) ||
      (left.previousPath ?? "").localeCompare(right.previousPath ?? ""),
  );
}

function withinContentLimit(
  candidate: ChangeCandidate,
  maximumBytes: number,
): boolean {
  return (
    (candidate.before?.manifest.byteLength ?? 0) <= maximumBytes &&
    (candidate.after?.manifest.byteLength ?? 0) <= maximumBytes
  );
}

function deltaPayload(candidate: ChangeCandidate): Buffer | undefined {
  if (
    (candidate.before !== undefined &&
      candidate.before.content === undefined) ||
    (candidate.after !== undefined && candidate.after.content === undefined)
  ) {
    return undefined;
  }
  return Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      path: candidate.path,
      operation: candidate.operation,
      ...(candidate.previousPath === undefined
        ? {}
        : { previousPath: candidate.previousPath }),
      before:
        candidate.before === undefined
          ? null
          : {
              sha256: candidate.before.manifest.sha256,
              byteLength: candidate.before.manifest.byteLength,
              encoding: "base64",
              content: (candidate.before.content as Buffer).toString("base64"),
            },
      after:
        candidate.after === undefined
          ? null
          : {
              sha256: candidate.after.manifest.sha256,
              byteLength: candidate.after.manifest.byteLength,
              encoding: "base64",
              content: (candidate.after.content as Buffer).toString("base64"),
            },
    }),
    "utf8",
  );
}

async function gitPatch(
  root: string,
  head: string,
  candidate: ChangeCandidate,
  maximumBytes: number,
  signal?: AbortSignal,
): Promise<Buffer | undefined> {
  const paths = [candidate.previousPath, candidate.path].filter(
    (path, index, values): path is string =>
      path !== undefined && values.indexOf(path) === index,
  );
  try {
    const patch = await git(
      root,
      [
        "diff",
        "--binary",
        "--full-index",
        "--no-ext-diff",
        "--no-textconv",
        "-M",
        head,
        "--",
        ...paths.map((path) => `:(literal)${path}`),
      ],
      maximumBytes,
      signal,
    );
    return patch.length === 0 ? undefined : patch;
  } catch {
    signal?.throwIfAborted();
    return undefined;
  }
}

function candidateSensitivity(
  candidate: ChangeCandidate,
  hasPayload: boolean,
): "normal" | "secret" | "truncated" {
  if (
    candidate.before?.sensitivity === "secret" ||
    candidate.after?.sensitivity === "secret"
  ) {
    return "secret";
  }
  return hasPayload ? "normal" : "truncated";
}

function baseSummary(
  candidate: ChangeCandidate,
): Omit<WorkspaceFileChangeSummary, "payloadKind" | "sensitivity"> {
  return {
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
    timingPrecision: "exact-final-diff",
  };
}

export class WorkspaceObserver {
  readonly baseline: CapturedWorkspaceSnapshot;
  private completed = false;
  private watcher: DebouncedWorkspaceWatcher | undefined;
  private watchingStarted = false;

  private constructor(
    private readonly descriptor: WorkspaceDescriptor,
    private readonly options: WorkspaceObserverOptions,
    private readonly baselineSnapshot: InternalSnapshot,
  ) {
    this.baseline = baselineSnapshot.evidence;
  }

  static async start(
    options: WorkspaceObserverOptions,
  ): Promise<WorkspaceObserver> {
    if (
      options.maxCapturedContentBytes !== undefined &&
      (!Number.isSafeInteger(options.maxCapturedContentBytes) ||
        options.maxCapturedContentBytes < 0)
    ) {
      throw new RangeError(
        "Maximum captured workspace content must be a non-negative safe integer.",
      );
    }
    const normalizedOptions: WorkspaceObserverOptions = {
      ...options,
      cwd: resolve(options.cwd),
      ...(options.dataDirectory === undefined
        ? {}
        : { dataDirectory: await canonicalPath(options.dataDirectory) }),
    };
    const descriptor = await detectWorkspace(normalizedOptions.cwd);
    const baseline = await captureSnapshot(
      descriptor,
      normalizedOptions,
      "baseline",
    );
    return new WorkspaceObserver(descriptor, normalizedOptions, baseline);
  }

  startWatching(
    listener: (change: ApproximateWorkspaceChange) => void | Promise<void>,
  ): void {
    if (this.completed || this.watchingStarted) {
      throw new Error(
        "Workspace watching must start once before observation completes.",
      );
    }
    this.watchingStarted = true;
    const exclusionCollector = new SnapshotCollector(
      this.descriptor,
      this.options.configuration,
      this.options.dataDirectory,
      0,
    );
    const baseline = new Map<string, WorkspaceWatchPathState>(
      [...this.baselineSnapshot.entries].map(([path, entry]) => [
        path,
        { manifest: entry.manifest, sensitivity: entry.sensitivity },
      ]),
    );
    this.watcher = new DebouncedWorkspaceWatcher({
      root: this.descriptor.root,
      debounceMilliseconds:
        this.options.configuration.watcherDebounceMilliseconds,
      baseline,
      now: this.options.now ?? (() => new Date()),
      excluded: (path) => exclusionCollector.excluded(path),
      inspect: async (path, signal) =>
        await this.inspectWatchedPath(path, signal),
      listener,
    });
  }

  async stopWatching(signal?: AbortSignal): Promise<readonly Error[]> {
    const watcher = this.watcher;
    this.watcher = undefined;
    return watcher === undefined ? [] : await watcher.stop(signal);
  }

  async complete(signal?: AbortSignal): Promise<CompletedWorkspaceObservation> {
    if (this.completed) {
      throw new Error("Workspace observation may only be completed once.");
    }
    this.completed = true;
    const watcherErrors = await this.stopWatching(signal);
    signal?.throwIfAborted();
    const final = await captureSnapshot(
      this.descriptor,
      this.options,
      "final",
      signal,
    );
    const allCandidates = changesBetween(this.baselineSnapshot, final);
    const candidates = allCandidates.slice(0, MAX_FILE_CHANGE_EVENTS);
    const observedAt = final.evidence.summary.capturedAt;
    const maximumFileBytes = this.options.configuration.maxUntrackedFileBytes;
    const maximumPayloadBytes = Math.max(
      64 * 1024,
      Math.min(64 * 1024 * 1024, maximumFileBytes * 4 + 64 * 1024),
    );
    const baselineHead = this.baselineSnapshot.evidence.summary.gitHead;
    const changes: ObservedWorkspaceChange[] = [];
    const incompleteReasons = new Set(final.evidence.summary.incompleteReasons);
    const maximumTotalPayloadBytes =
      this.options.maxCapturedContentBytes ??
      DEFAULT_MAX_CAPTURED_CONTENT_BYTES;
    let payloadAttempts = 0;
    let payloadBytes = 0;
    if (candidates.length !== allCandidates.length) {
      incompleteReasons.add("file-change-event-limit-reached");
    }

    for (const candidate of candidates) {
      signal?.throwIfAborted();
      let payload: Buffer | undefined;
      let payloadKind: "git-binary-patch" | "file-delta" | undefined;
      let mediaType: string | undefined;
      const tracked =
        candidate.before?.manifest.tracked === true ||
        candidate.after?.manifest.tracked === true;
      const baselineDirty = [candidate.previousPath, candidate.path].some(
        (path) =>
          path !== undefined && this.baselineSnapshot.gitDirtyPaths.has(path),
      );
      const contentAllowed =
        candidate.before?.sensitivity !== "secret" &&
        candidate.after?.sensitivity !== "secret" &&
        withinContentLimit(candidate, maximumFileBytes);
      const payloadAllowed =
        contentAllowed &&
        payloadAttempts < MAX_FILE_PAYLOADS &&
        payloadBytes < maximumTotalPayloadBytes;
      if (contentAllowed && !payloadAllowed) {
        incompleteReasons.add("file-payload-limit-reached");
      }
      if (payloadAllowed) {
        payloadAttempts += 1;
      }

      if (
        payloadAllowed &&
        tracked &&
        !baselineDirty &&
        this.descriptor.kind === "git" &&
        baselineHead !== undefined &&
        baselineHead !== null
      ) {
        payload = await gitPatch(
          this.descriptor.root,
          baselineHead,
          candidate,
          Math.min(
            maximumPayloadBytes,
            maximumTotalPayloadBytes - payloadBytes,
          ),
          signal,
        );
        if (payload !== undefined) {
          payloadKind = "git-binary-patch";
          mediaType = "application/vnd.git.binary-patch";
        }
      }
      if (payload === undefined && payloadAllowed) {
        const delta = deltaPayload(candidate);
        if (
          delta !== undefined &&
          delta.length <= maximumPayloadBytes &&
          delta.length <= maximumTotalPayloadBytes - payloadBytes
        ) {
          payload = delta;
          payloadKind = "file-delta";
          mediaType = "application/vnd.tekrion.file-delta+json";
        }
      }
      if (payload !== undefined) {
        payloadBytes += payload.length;
      }

      const summary = WorkspaceFileChangeSummarySchema.parse({
        ...baseSummary(candidate),
        sensitivity: candidateSensitivity(candidate, payload !== undefined),
        ...(payloadKind === undefined ? {} : { payloadKind }),
      });
      changes.push({
        summary,
        observedAt,
        ...(payload === undefined ? {} : { payload }),
        ...(mediaType === undefined ? {} : { mediaType }),
      });
    }

    const snapshotSummary = WorkspaceSnapshotSummarySchema.parse({
      ...final.evidence.summary,
      changedFileCount: allCandidates.length,
      incompleteReasons: [...incompleteReasons].sort(),
    });
    signal?.throwIfAborted();
    return {
      snapshot: {
        summary: snapshotSummary,
        manifest: final.evidence.manifest,
      },
      changes,
      watcherErrors,
    };
  }

  private async inspectWatchedPath(
    path: string,
    signal: AbortSignal,
  ): Promise<WorkspaceWatchPathState | undefined> {
    signal.throwIfAborted();
    const absolutePath = resolve(this.descriptor.root, path);
    if (!isWithin(this.descriptor.root, absolutePath)) {
      return undefined;
    }
    const baselineEntry = this.baselineSnapshot.entries.get(path);
    if (
      this.descriptor.kind === "git" &&
      baselineEntry === undefined &&
      (await gitPathIgnored(this.descriptor.root, path, signal))
    ) {
      return undefined;
    }
    let parent = dirname(absolutePath);
    while (isWithin(this.descriptor.root, parent)) {
      try {
        const canonicalParent = await realpath(parent);
        if (
          canonicalParent !== parent ||
          !isWithin(this.descriptor.root, canonicalParent)
        ) {
          return undefined;
        }
        break;
      } catch (error: unknown) {
        if (errorCode(error) !== "ENOENT") {
          throw error;
        }
        if (parent === this.descriptor.root) {
          return undefined;
        }
        parent = dirname(parent);
      }
    }
    signal.throwIfAborted();
    const collector = new SnapshotCollector(
      this.descriptor,
      this.options.configuration,
      this.options.dataDirectory,
      0,
      signal,
    );
    await collector.capture(path, baselineEntry?.manifest.tracked ?? false);
    const entry = collector.entries.get(path);
    return entry === undefined
      ? undefined
      : { manifest: entry.manifest, sensitivity: entry.sensitivity };
  }
}
