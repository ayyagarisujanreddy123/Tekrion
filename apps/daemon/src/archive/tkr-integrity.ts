import { createHash, randomUUID } from "node:crypto";
import { chmod, link, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  TekrionArchiveSchema,
  type TekrionArchive,
  type TekrionArchiveEntryDescriptor,
} from "@tekrion/protocol";

export const DEFAULT_MAXIMUM_ARCHIVE_BYTES = 512 * 1024 * 1024;

export class TekrionArchiveIntegrityError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TekrionArchiveIntegrityError";
  }
}

export class TekrionArchiveSizeError extends Error {
  constructor(readonly maximumBytes: number) {
    super(`The TKR archive exceeds the ${maximumBytes}-byte safety limit.`);
    this.name = "TekrionArchiveSizeError";
  }
}

function normalizedJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizedJsonValue);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, item]) => [key, normalizedJsonValue(item)]),
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalizedJsonValue(value));
}

export function archiveSha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalBase64(value: string): Uint8Array {
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) {
    throw new TekrionArchiveIntegrityError(
      "A TKR archive entry is not canonical base64.",
    );
  }
  return bytes;
}

export interface VerifiedTekrionArchive {
  readonly archive: TekrionArchive;
  readonly entries: ReadonlyMap<string, Uint8Array>;
}

export function encodeTekrionArchive(archive: TekrionArchive): Uint8Array {
  const parsed = TekrionArchiveSchema.parse(archive);
  return Buffer.from(`${canonicalJson(parsed)}\n`, "utf8");
}

export function verifyTekrionArchive(
  input: Uint8Array,
  maximumBytes = DEFAULT_MAXIMUM_ARCHIVE_BYTES,
): VerifiedTekrionArchive {
  if (input.byteLength > maximumBytes) {
    throw new TekrionArchiveSizeError(maximumBytes);
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(input),
    );
  } catch (error: unknown) {
    throw new TekrionArchiveIntegrityError(
      "The TKR archive is not valid UTF-8 JSON.",
      { cause: error },
    );
  }
  let archive: TekrionArchive;
  try {
    archive = TekrionArchiveSchema.parse(decoded);
  } catch (error: unknown) {
    throw new TekrionArchiveIntegrityError(
      "The TKR archive does not match the supported versioned schema.",
      { cause: error },
    );
  }
  if (
    archiveSha256(canonicalJson(archive.manifest)) !== archive.manifestSha256
  ) {
    throw new TekrionArchiveIntegrityError(
      "The TKR archive manifest digest does not match.",
    );
  }
  const descriptors = new Map(
    archive.manifest.entries.map((entry) => [entry.path, entry]),
  );
  const entries = new Map<string, Uint8Array>();
  let decodedBytes = 0;
  for (const entry of archive.entries) {
    const descriptor = descriptors.get(entry.path);
    if (descriptor === undefined) {
      throw new TekrionArchiveIntegrityError(
        `Archive entry ${entry.path} is not declared in the manifest.`,
      );
    }
    const bytes = canonicalBase64(entry.data);
    decodedBytes += bytes.byteLength;
    if (decodedBytes > maximumBytes) {
      throw new TekrionArchiveSizeError(maximumBytes);
    }
    if (
      bytes.byteLength !== descriptor.byteLength ||
      archiveSha256(bytes) !== descriptor.sha256
    ) {
      throw new TekrionArchiveIntegrityError(
        `Archive entry ${entry.path} failed its size or SHA-256 check.`,
      );
    }
    entries.set(entry.path, bytes);
  }
  if (decodedBytes !== archive.manifest.totalBytes) {
    throw new TekrionArchiveIntegrityError(
      "The decoded TKR archive size does not match the manifest.",
    );
  }
  for (const blob of archive.manifest.blobs) {
    const descriptor = descriptors.get(blob.entryPath);
    if (
      descriptor === undefined ||
      descriptor.sha256 !== blob.reference.sha256 ||
      descriptor.byteLength !== blob.reference.byteLength ||
      descriptor.mediaType !== blob.reference.mediaType ||
      blob.reference.id !== `blob-${blob.reference.sha256}`
    ) {
      throw new TekrionArchiveIntegrityError(
        `Blob metadata for ${blob.entryPath} does not match its entry.`,
      );
    }
  }
  return { archive, entries };
}

function entryDescriptor(
  path: string,
  mediaType: string,
  bytes: Uint8Array,
): TekrionArchiveEntryDescriptor {
  return {
    path,
    mediaType,
    byteLength: bytes.byteLength,
    sha256: archiveSha256(bytes),
  };
}

export interface TekrionArchiveContentEntry {
  readonly path: string;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
}

export function materializeArchiveEntries(
  entries: readonly TekrionArchiveContentEntry[],
): {
  readonly descriptors: TekrionArchiveEntryDescriptor[];
  readonly payloads: TekrionArchive["entries"];
  readonly totalBytes: number;
} {
  const ordered = [...entries].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  return {
    descriptors: ordered.map((entry) =>
      entryDescriptor(entry.path, entry.mediaType, entry.bytes),
    ),
    payloads: ordered.map((entry) => ({
      path: entry.path,
      encoding: "base64",
      data: Buffer.from(entry.bytes).toString("base64"),
    })),
    totalBytes: ordered.reduce(
      (total, entry) => total + entry.bytes.byteLength,
      0,
    ),
  };
}

async function syncDirectory(path: string): Promise<void> {
  let handle;
  try {
    handle = await open(path, "r");
    await handle.sync();
  } catch (error: unknown) {
    if (
      typeof error !== "object" ||
      error === null ||
      !("code" in error) ||
      !["EINVAL", "ENOTSUP", "EBADF"].includes(String(error.code))
    ) {
      throw error;
    }
  } finally {
    await handle?.close();
  }
}

export async function writeTekrionArchiveFile(
  path: string,
  bytes: Uint8Array,
  overwrite = false,
): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = join(
    directory,
    `.tekrion-export-${process.pid}-${randomUUID()}.tmp`,
  );
  let handle;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (overwrite) {
      await rename(temporaryPath, path);
    } else {
      try {
        await link(temporaryPath, path);
      } catch (error: unknown) {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "EEXIST"
        ) {
          throw new Error(
            `Refusing to overwrite existing archive ${path}; pass --force to replace it.`,
            { cause: error },
          );
        }
        throw error;
      }
      await rm(temporaryPath, { force: true });
    }
    await chmod(path, 0o600);
    await syncDirectory(directory);
  } catch (error: unknown) {
    await handle?.close();
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

export async function readTekrionArchiveFile(
  path: string,
  maximumBytes = DEFAULT_MAXIMUM_ARCHIVE_BYTES,
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
    throw new RangeError(
      "The TKR archive byte limit must be a non-negative integer.",
    );
  }
  const handle = await open(path, "r");
  try {
    const information = await handle.stat();
    if (!information.isFile()) {
      throw new TekrionArchiveIntegrityError(
        "The TKR archive path is not a file.",
      );
    }
    if (information.size > maximumBytes) {
      throw new TekrionArchiveSizeError(maximumBytes);
    }

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    while (totalBytes <= maximumBytes) {
      const remaining = maximumBytes + 1 - totalBytes;
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
      const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, null);
      if (bytesRead === 0) {
        return Buffer.concat(chunks, totalBytes);
      }
      chunks.push(chunk.subarray(0, bytesRead));
      totalBytes += bytesRead;
    }
    throw new TekrionArchiveSizeError(maximumBytes);
  } finally {
    await handle.close();
  }
}
