import { randomUUID } from "node:crypto";
import { chmod, link, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const MAX_PRIVATE_TEXT_BYTES = 64 * 1024;

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

export async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const information = await lstat(path);
  if (!information.isDirectory() || information.isSymbolicLink()) {
    throw new Error(`Private data path is not a real directory: ${path}`);
  }
  await chmod(path, PRIVATE_DIRECTORY_MODE);
}

async function writeTemporaryPrivateFile(
  targetPath: string,
  contents: string,
): Promise<string> {
  const temporaryPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporaryPath, "wx", PRIVATE_FILE_MODE);
  try {
    await handle.writeFile(contents, { encoding: "utf8" });
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(temporaryPath, PRIVATE_FILE_MODE);
  return temporaryPath;
}

export async function createPrivateFileExclusive(
  path: string,
  contents: string,
): Promise<boolean> {
  await ensurePrivateDirectory(dirname(path));
  const temporaryPath = await writeTemporaryPrivateFile(path, contents);
  try {
    try {
      await link(temporaryPath, path);
    } catch (error: unknown) {
      if (hasCode(error, "EEXIST")) {
        return false;
      }
      throw error;
    }
    await chmod(path, PRIVATE_FILE_MODE);
    return true;
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

export async function replacePrivateFile(
  path: string,
  contents: string,
): Promise<void> {
  await ensurePrivateDirectory(dirname(path));
  const temporaryPath = await writeTemporaryPrivateFile(path, contents);
  try {
    await rename(temporaryPath, path);
    await chmod(path, PRIVATE_FILE_MODE);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

export async function readPrivateTextFile(path: string): Promise<string> {
  const handle = await open(path, "r");
  try {
    const [information, target] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat(path, { bigint: true }),
    ]);
    if (!information.isFile() || !target.isFile() || target.isSymbolicLink()) {
      throw new Error(`Sensitive path is not a regular file: ${path}`);
    }

    // Node 22.15 reports dev=0 for path stats on Windows while handle stats
    // contain the volume identifier. Compare two independently opened handles
    // so the identity check remains exact without weakening symlink defenses.
    const verificationHandle = await open(path, "r");
    try {
      const verification = await verificationHandle.stat({ bigint: true });
      if (
        !verification.isFile() ||
        information.dev !== verification.dev ||
        information.ino !== verification.ino
      ) {
        throw new Error(`Sensitive path changed while opening: ${path}`);
      }
    } finally {
      await verificationHandle.close();
    }

    if (information.size > BigInt(MAX_PRIVATE_TEXT_BYTES)) {
      throw new Error(
        `Sensitive file exceeds ${MAX_PRIVATE_TEXT_BYTES} bytes: ${path}`,
      );
    }
    await handle.chmod(PRIVATE_FILE_MODE);

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    while (totalBytes <= MAX_PRIVATE_TEXT_BYTES) {
      const remaining = MAX_PRIVATE_TEXT_BYTES + 1 - totalBytes;
      const chunk = Buffer.allocUnsafe(Math.min(16 * 1024, remaining));
      const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, null);
      if (bytesRead === 0) {
        return Buffer.concat(chunks, totalBytes).toString("utf8");
      }
      chunks.push(chunk.subarray(0, bytesRead));
      totalBytes += bytesRead;
    }
    throw new Error(
      `Sensitive file exceeds ${MAX_PRIVATE_TEXT_BYTES} bytes: ${path}`,
    );
  } finally {
    await handle.close();
  }
}

export function isMissingFileError(error: unknown): boolean {
  return hasCode(error, "ENOENT");
}
