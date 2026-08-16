import {
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { prepareDaemonLog } from "../src/daemon-launcher.js";

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tekrion-daemon-log-test-"));
  roots.push(root);
  return root;
}

async function expectPosixMode(path: string, expected: number): Promise<void> {
  const information = await stat(path);
  if (process.platform !== "win32") {
    expect(information.mode & 0o777).toBe(expected);
  }
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("daemon log preparation", () => {
  it("creates a private regular log and preserves content below the limit", async () => {
    const root = await temporaryRoot();
    const logPath = join(root, "daemon.log");

    await prepareDaemonLog(logPath, 16);
    await writeFile(logPath, "healthy\n", { mode: 0o666 });
    await prepareDaemonLog(logPath, 16);

    expect(await readFile(logPath, "utf8")).toBe("healthy\n");
    await expectPosixMode(logPath, 0o600);
  });

  it("retains one private backup when the log reaches its bound", async () => {
    const root = await temporaryRoot();
    const logPath = join(root, "daemon.log");
    const backupPath = `${logPath}.1`;
    await writeFile(logPath, "12345678", { mode: 0o666 });
    await writeFile(backupPath, "previous", { mode: 0o666 });

    await prepareDaemonLog(logPath, 8);

    expect(await readFile(logPath, "utf8")).toBe("");
    expect(await readFile(backupPath, "utf8")).toBe("12345678");
    await expectPosixMode(logPath, 0o600);
    await expectPosixMode(backupPath, 0o600);
  });

  it("refuses symlinked and non-file log targets", async () => {
    const root = await temporaryRoot();
    const targetPath = join(root, "target.log");
    const linkPath = join(root, "daemon.log");
    await writeFile(targetPath, "target");
    await symlink(targetPath, linkPath);

    await expect(prepareDaemonLog(linkPath)).rejects.toThrow(
      "Refusing unsafe daemon log path",
    );
    await expect(prepareDaemonLog(root)).rejects.toThrow(
      "Refusing unsafe daemon log path",
    );
    expect(await readFile(targetPath, "utf8")).toBe("target");
  });
});
