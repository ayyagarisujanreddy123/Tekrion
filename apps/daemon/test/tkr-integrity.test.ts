import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  TekrionArchiveIntegrityError,
  TekrionArchiveSizeError,
  readTekrionArchiveFile,
} from "../src/index.js";

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tekrion-tkr-read-test-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("bounded TKR file reads", () => {
  it("reads through one descriptor and enforces the byte limit", async () => {
    const root = await temporaryRoot();
    const exactPath = join(root, "exact.tkr");
    const oversizedPath = join(root, "oversized.tkr");
    await writeFile(exactPath, "12345678");
    await writeFile(oversizedPath, "123456789");

    expect(
      Buffer.from(await readTekrionArchiveFile(exactPath, 8)).toString(),
    ).toBe("12345678");
    await expect(
      readTekrionArchiveFile(oversizedPath, 8),
    ).rejects.toBeInstanceOf(TekrionArchiveSizeError);
  });

  it("rejects a non-file descriptor", async () => {
    const root = await temporaryRoot();

    await expect(readTekrionArchiveFile(root, 8)).rejects.toBeInstanceOf(
      TekrionArchiveIntegrityError,
    );
  });
});
