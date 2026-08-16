import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import * as zlib from "node:zlib";

import {
  BlobReferenceSchema,
  MINIMUM_NODE_VERSION,
  type BlobReference,
} from "@tekrion/protocol";
import type Database from "better-sqlite3";

import {
  BlobCorruptionError,
  StorageCapacityError,
  StorageRuntimeCompatibilityError,
  throwTranslatedCapacityError,
} from "./errors.js";

interface BlobRow {
  readonly id: string;
  readonly sha256: string;
  readonly codec: "identity" | "zstd";
  readonly media_type: string;
  readonly byte_length: number;
  readonly stored_length: number;
  readonly truncated: number;
  readonly inline_data: Buffer | null;
  readonly relative_path: string | null;
}

export interface BlobStoreOptions {
  readonly inlineThresholdBytes?: number;
  readonly maxStoredBytes?: number;
}

export interface PutBlobOptions {
  readonly mediaType: string;
  readonly truncated?: boolean;
}

export interface BlobGarbageCollectionResult {
  readonly removedBlobs: number;
  readonly removedStoredBytes: number;
  readonly removedExternalFiles: number;
}

export type BlobLocation =
  | { readonly kind: "inline" }
  | { readonly kind: "external"; readonly path: string };

const TEMP_FILE_SUFFIX = ".tmp";

function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export function assertBlobCodecRuntimeSupport(): void {
  if (
    typeof zlib.zstdCompressSync !== "function" ||
    typeof zlib.zstdDecompressSync !== "function"
  ) {
    throw new StorageRuntimeCompatibilityError(
      process.versions.node,
      MINIMUM_NODE_VERSION,
    );
  }
}

function toReference(row: BlobRow): BlobReference {
  return BlobReferenceSchema.parse({
    id: row.id,
    sha256: row.sha256,
    codec: row.codec,
    mediaType: row.media_type,
    byteLength: row.byte_length,
    truncated: row.truncated === 1,
  });
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error: unknown) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
}

async function syncDirectory(path: string): Promise<void> {
  let handle;
  try {
    handle = await open(path, "r");
    await handle.sync();
  } catch (error: unknown) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String(error.code)
        : undefined;
    if (
      code === undefined ||
      (!["EINVAL", "ENOTSUP", "EBADF"].includes(code) &&
        // Node/libuv rejects fsync on an open directory with EPERM on Windows.
        // The temporary file itself was synced before it was renamed.
        !(
          process.platform === "win32" &&
          handle !== undefined &&
          code === "EPERM"
        ))
    ) {
      throw error;
    }
  } finally {
    await handle?.close();
  }
}

async function listFilesRecursively(directory: string): Promise<string[]> {
  if (!(await pathExists(directory))) {
    return [];
  }

  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFilesRecursively(path)));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files;
}

export class BlobStore {
  readonly blobDirectory: string;
  private readonly inlineThresholdBytes: number;
  private readonly maxStoredBytes: number;

  constructor(
    private readonly database: Database.Database,
    private readonly dataDirectory: string,
    options: BlobStoreOptions = {},
  ) {
    assertBlobCodecRuntimeSupport();
    this.blobDirectory = join(dataDirectory, "blobs");
    this.inlineThresholdBytes = options.inlineThresholdBytes ?? 32 * 1024;
    this.maxStoredBytes = options.maxStoredBytes ?? Number.POSITIVE_INFINITY;
  }

  async initialize(): Promise<number> {
    await mkdir(this.blobDirectory, { recursive: true, mode: 0o700 });
    await chmod(this.blobDirectory, 0o700);
    return this.removeOrphanTempFiles();
  }

  async put(
    input: Uint8Array | string,
    options: PutBlobOptions,
  ): Promise<BlobReference> {
    const raw =
      typeof input === "string"
        ? Buffer.from(input, "utf8")
        : Buffer.from(input);
    const digest = sha256(raw);
    const id = `blob-${digest}`;
    const existing = this.getRow(id);

    if (existing !== undefined) {
      await this.get(id);
      return toReference(existing);
    }

    const compressed = zlib.zstdCompressSync(raw);
    const useCompression = compressed.length < raw.length;
    const codec: BlobRow["codec"] = useCompression ? "zstd" : "identity";
    const stored = useCompression ? compressed : raw;
    this.assertWithinQuota(stored.length);

    const truncated = options.truncated === true ? 1 : 0;
    const createdAt = new Date().toISOString();
    const inline = raw.length <= this.inlineThresholdBytes;

    if (inline) {
      try {
        const result = this.database
          .prepare(
            `INSERT OR IGNORE INTO blobs(
               id, sha256, codec, media_type, byte_length, stored_length,
               truncated, inline_data, relative_path, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
          )
          .run(
            id,
            digest,
            codec,
            options.mediaType,
            raw.length,
            stored.length,
            truncated,
            stored,
            createdAt,
          );
        if (result.changes === 0) {
          const concurrent = this.getRequiredRow(id);
          await this.get(id);
          return toReference(concurrent);
        }
      } catch (error: unknown) {
        throwTranslatedCapacityError(error, "Inline blob write");
      }
      return toReference(this.getRequiredRow(id));
    }

    const relativePath = join(
      digest.slice(0, 2),
      digest.slice(2, 4),
      `${digest}.blob`,
    );
    const targetPath = this.safeExternalPath(relativePath);
    const targetExisted = await pathExists(targetPath);

    try {
      await this.writeAtomically(targetPath, stored);
      const result = this.database
        .prepare(
          `INSERT OR IGNORE INTO blobs(
             id, sha256, codec, media_type, byte_length, stored_length,
             truncated, inline_data, relative_path, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
        )
        .run(
          id,
          digest,
          codec,
          options.mediaType,
          raw.length,
          stored.length,
          truncated,
          relativePath,
          createdAt,
        );
      if (result.changes === 0) {
        const concurrent = this.getRequiredRow(id);
        await this.get(id);
        return toReference(concurrent);
      }
    } catch (error: unknown) {
      const concurrent = this.getRow(id);
      if (concurrent !== undefined) {
        await this.get(id);
        return toReference(concurrent);
      }
      if (!targetExisted) {
        await rm(targetPath, { force: true });
      }
      throwTranslatedCapacityError(error, "External blob write");
    }

    return toReference(this.getRequiredRow(id));
  }

  async get(id: string): Promise<Uint8Array> {
    const row = this.getRequiredRow(id);
    let stored: Buffer;

    if (row.inline_data !== null) {
      stored = Buffer.from(row.inline_data);
    } else if (row.relative_path !== null) {
      try {
        stored = await readFile(this.safeExternalPath(row.relative_path));
      } catch (error: unknown) {
        throw new BlobCorruptionError(id, "external payload is unavailable", {
          cause: error,
        });
      }
    } else {
      throw new BlobCorruptionError(id, "no payload location is recorded");
    }

    if (stored.length !== row.stored_length) {
      throw new BlobCorruptionError(
        id,
        `stored length ${stored.length} does not match ${row.stored_length}`,
      );
    }

    let raw: Buffer;
    try {
      raw =
        row.codec === "zstd"
          ? Buffer.from(zlib.zstdDecompressSync(stored))
          : stored;
    } catch (error: unknown) {
      throw new BlobCorruptionError(id, "decompression failed", {
        cause: error,
      });
    }

    if (raw.length !== row.byte_length) {
      throw new BlobCorruptionError(
        id,
        `decoded length ${raw.length} does not match ${row.byte_length}`,
      );
    }
    if (sha256(raw) !== row.sha256) {
      throw new BlobCorruptionError(id, "SHA-256 digest does not match");
    }
    return raw;
  }

  describe(id: string): BlobReference | undefined {
    const row = this.getRow(id);
    return row === undefined ? undefined : toReference(row);
  }

  location(id: string): BlobLocation {
    const row = this.getRequiredRow(id);
    return row.relative_path === null
      ? { kind: "inline" }
      : { kind: "external", path: this.safeExternalPath(row.relative_path) };
  }

  count(): number {
    const row = this.database
      .prepare("SELECT COUNT(*) AS count FROM blobs")
      .get() as { count: number };
    return row.count;
  }

  async removeOrphanTempFiles(): Promise<number> {
    const files = await listFilesRecursively(this.blobDirectory);
    const temporaryFiles = files.filter((path) =>
      path.endsWith(TEMP_FILE_SUFFIX),
    );
    await Promise.all(temporaryFiles.map((path) => rm(path, { force: true })));
    return temporaryFiles.length;
  }

  async removeUnreferenced(
    candidateIds?: readonly string[],
  ): Promise<BlobGarbageCollectionResult> {
    const requested =
      candidateIds === undefined ? undefined : new Set(candidateIds);
    const candidates = (
      this.database
        .prepare(
          `SELECT id
         FROM blobs
         WHERE NOT EXISTS (
           SELECT 1 FROM raw_exchanges
           WHERE request_blob_id = blobs.id
              OR response_blob_id = blobs.id
              OR stream_manifest_blob_id = blobs.id
         )
           AND NOT EXISTS (
             SELECT 1 FROM events WHERE payload_blob_id = blobs.id
           )
           AND NOT EXISTS (
             SELECT 1 FROM file_changes WHERE patch_blob_id = blobs.id
           )
           AND NOT EXISTS (
             SELECT 1 FROM analysis_runs WHERE result_blob_id = blobs.id
           )
         ORDER BY id`,
        )
        .all() as Array<{ id: string }>
    ).filter((candidate) => requested?.has(candidate.id) ?? true);
    const removed = this.database.transaction(() => {
      const rows: Array<{
        relative_path: string | null;
        stored_length: number;
      }> = [];
      const statement = this.database.prepare(
        `DELETE FROM blobs
         WHERE id = @id
           AND NOT EXISTS (
             SELECT 1 FROM raw_exchanges
             WHERE request_blob_id = blobs.id
                OR response_blob_id = blobs.id
                OR stream_manifest_blob_id = blobs.id
           )
           AND NOT EXISTS (
             SELECT 1 FROM events WHERE payload_blob_id = blobs.id
           )
           AND NOT EXISTS (
             SELECT 1 FROM file_changes WHERE patch_blob_id = blobs.id
           )
           AND NOT EXISTS (
             SELECT 1 FROM analysis_runs WHERE result_blob_id = blobs.id
           )
         RETURNING relative_path, stored_length`,
      );
      for (const candidate of candidates) {
        const row = statement.get(candidate) as
          { relative_path: string | null; stored_length: number } | undefined;
        if (row !== undefined) {
          rows.push(row);
        }
      }
      return rows;
    })();
    const externalPaths = removed.flatMap((row) =>
      row.relative_path === null
        ? []
        : [this.safeExternalPath(row.relative_path)],
    );
    await Promise.all(externalPaths.map((path) => rm(path, { force: true })));
    return {
      removedBlobs: removed.length,
      removedStoredBytes: removed.reduce(
        (total, row) => total + row.stored_length,
        0,
      ),
      removedExternalFiles: externalPaths.length,
    };
  }

  private assertWithinQuota(additionalBytes: number): void {
    if (!Number.isFinite(this.maxStoredBytes)) {
      return;
    }
    const row = this.database
      .prepare("SELECT COALESCE(SUM(stored_length), 0) AS total FROM blobs")
      .get() as { total: number };
    if (row.total + additionalBytes > this.maxStoredBytes) {
      throw new StorageCapacityError(
        `Blob write would exceed the configured ${this.maxStoredBytes}-byte storage limit.`,
      );
    }
  }

  private getRow(id: string): BlobRow | undefined {
    return this.database
      .prepare(
        `SELECT id, sha256, codec, media_type, byte_length, stored_length,
                truncated, inline_data, relative_path
         FROM blobs WHERE id = ?`,
      )
      .get(id) as BlobRow | undefined;
  }

  private getRequiredRow(id: string): BlobRow {
    const row = this.getRow(id);
    if (row === undefined) {
      throw new BlobCorruptionError(id, "metadata row is missing");
    }
    return row;
  }

  private safeExternalPath(relativePath: string): string {
    const absolute = resolve(this.blobDirectory, relativePath);
    const relation = relative(this.blobDirectory, absolute);
    if (relation === ".." || relation.startsWith(`..${sep}`)) {
      throw new BlobCorruptionError(
        "unknown",
        "external blob path escapes the data directory",
      );
    }
    return absolute;
  }

  private async writeAtomically(
    targetPath: string,
    data: Uint8Array,
  ): Promise<void> {
    const directory = dirname(targetPath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const temporaryPath = join(
      directory,
      `.${process.pid}.${randomUUID()}${TEMP_FILE_SUFFIX}`,
    );
    let handle;

    try {
      handle = await open(temporaryPath, "wx", 0o600);
      await handle.writeFile(data);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporaryPath, targetPath);
      await chmod(targetPath, 0o600);
      await syncDirectory(directory);
    } catch (error: unknown) {
      await handle?.close();
      await rm(temporaryPath, { force: true });
      throw error;
    }
  }
}
