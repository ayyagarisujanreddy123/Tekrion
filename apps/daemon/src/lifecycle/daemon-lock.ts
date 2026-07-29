import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

import { z } from "zod";

import {
  createPrivateFileExclusive,
  isMissingFileError,
  readPrivateTextFile,
  replacePrivateFile,
} from "./private-files.js";

export const DaemonLockRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    instanceId: z.string().min(1).max(128),
    pid: z.number().int().positive(),
    startedAt: z.iso.datetime({ offset: true }),
    updatedAt: z.iso.datetime({ offset: true }),
    state: z.enum(["starting", "ready", "stopping"]),
    proxyOrigin: z.url().optional(),
    controlOrigin: z.url().optional(),
  })
  .strict();

export type DaemonLockRecord = z.infer<typeof DaemonLockRecordSchema>;
export type ProcessAlive = (pid: number) => boolean;

const AcquisitionGuardSchema = z
  .object({
    pid: z.number().int().positive(),
    nonce: z.string().uuid(),
    createdAt: z.iso.datetime({ offset: true }),
  })
  .strict();

type AcquisitionGuard = z.infer<typeof AcquisitionGuardSchema>;

export interface AcquireDaemonLockOptions {
  readonly path: string;
  readonly instanceId?: string;
  readonly pid?: number;
  readonly now?: () => Date;
  readonly processAlive?: ProcessAlive;
}

export interface DaemonLockRecovery {
  readonly reason: "corrupt" | "dead-process";
  readonly previous?: DaemonLockRecord;
}

export class DaemonAlreadyRunningError extends Error {
  constructor(readonly record: DaemonLockRecord) {
    super(
      `Tekrion daemon ${record.instanceId} is already running as PID ${record.pid}.`,
    );
    this.name = "DaemonAlreadyRunningError";
  }
}

export class CorruptDaemonLockError extends Error {
  constructor(
    readonly path: string,
    options?: ErrorOptions,
  ) {
    super(`Daemon lock is corrupt: ${path}`, options);
    this.name = "CorruptDaemonLockError";
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ESRCH"
    ) {
      return false;
    }
    return true;
  }
}

export async function readDaemonLockRecord(
  path: string,
): Promise<DaemonLockRecord | undefined> {
  let contents: string;
  try {
    contents = await readPrivateTextFile(path);
  } catch (error: unknown) {
    if (isMissingFileError(error)) {
      return undefined;
    }
    throw new CorruptDaemonLockError(path, { cause: error });
  }
  try {
    return DaemonLockRecordSchema.parse(JSON.parse(contents));
  } catch (error: unknown) {
    throw new CorruptDaemonLockError(path, { cause: error });
  }
}

function serialized(record: DaemonLockRecord): string {
  return `${JSON.stringify(record)}\n`;
}

async function readAcquisitionGuard(
  path: string,
): Promise<AcquisitionGuard | undefined> {
  try {
    return AcquisitionGuardSchema.parse(
      JSON.parse(await readPrivateTextFile(path)),
    );
  } catch (error: unknown) {
    if (isMissingFileError(error)) {
      return undefined;
    }
    throw error;
  }
}

async function acquireAcquisitionGuard(
  lockPath: string,
): Promise<() => Promise<void>> {
  const path = `${lockPath}.acquire`;
  const guard = AcquisitionGuardSchema.parse({
    pid: process.pid,
    nonce: randomUUID(),
    createdAt: new Date().toISOString(),
  });

  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (await createPrivateFileExclusive(path, `${JSON.stringify(guard)}\n`)) {
      return async () => {
        let current: AcquisitionGuard | undefined;
        try {
          current = await readAcquisitionGuard(path);
        } catch {
          return;
        }
        if (current?.nonce === guard.nonce) {
          await rm(path, { force: true });
        }
      };
    }

    let existing: AcquisitionGuard | undefined;
    try {
      existing = await readAcquisitionGuard(path);
    } catch {
      await rm(path, { force: true });
      continue;
    }
    if (existing === undefined) {
      continue;
    }
    const ageMilliseconds = Date.now() - Date.parse(existing.createdAt);
    if (!isProcessAlive(existing.pid) && ageMilliseconds >= 2_000) {
      const confirmation = await readAcquisitionGuard(path).catch(
        () => undefined,
      );
      if (confirmation?.nonce === existing.nonce) {
        await rm(path, { force: true });
      }
      continue;
    }
    await delay(10);
  }
  throw new Error(`Timed out acquiring daemon lock guard: ${path}`);
}

export class DaemonLock {
  readonly recovery?: DaemonLockRecovery;

  private constructor(
    readonly path: string,
    private recordValue: DaemonLockRecord,
    recovery: DaemonLockRecovery | undefined,
    private readonly now: () => Date,
  ) {
    if (recovery !== undefined) {
      this.recovery = recovery;
    }
  }

  static async acquire(options: AcquireDaemonLockOptions): Promise<DaemonLock> {
    const now = options.now ?? (() => new Date());
    const pid = options.pid ?? process.pid;
    const instanceId = options.instanceId ?? `daemon-${randomUUID()}`;
    const processAlive = options.processAlive ?? isProcessAlive;
    let recovery: DaemonLockRecovery | undefined;
    const releaseGuard = await acquireAcquisitionGuard(options.path);

    try {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const timestamp = now().toISOString();
        const initial = DaemonLockRecordSchema.parse({
          schemaVersion: 1,
          instanceId,
          pid,
          startedAt: timestamp,
          updatedAt: timestamp,
          state: "starting",
        });
        if (
          await createPrivateFileExclusive(options.path, serialized(initial))
        ) {
          return new DaemonLock(options.path, initial, recovery, now);
        }

        let existing: DaemonLockRecord | undefined;
        try {
          existing = await readDaemonLockRecord(options.path);
        } catch (error: unknown) {
          if (!(error instanceof CorruptDaemonLockError)) {
            throw error;
          }
          recovery = { reason: "corrupt" };
        }

        if (existing !== undefined && processAlive(existing.pid)) {
          throw new DaemonAlreadyRunningError(existing);
        }
        if (existing !== undefined) {
          recovery = { reason: "dead-process", previous: existing };
        }

        try {
          await rm(options.path);
        } catch (error: unknown) {
          if (!isMissingFileError(error)) {
            throw error;
          }
        }
      }
      throw new Error(
        `Could not acquire daemon lock after repeated races: ${options.path}`,
      );
    } finally {
      await releaseGuard();
    }
  }

  get record(): DaemonLockRecord {
    return this.recordValue;
  }

  async update(
    update: Pick<DaemonLockRecord, "state"> &
      Partial<Pick<DaemonLockRecord, "proxyOrigin" | "controlOrigin">>,
  ): Promise<DaemonLockRecord> {
    const current = await readDaemonLockRecord(this.path);
    if (current?.instanceId !== this.recordValue.instanceId) {
      throw new Error("Daemon lock ownership changed before update.");
    }
    const replacement = DaemonLockRecordSchema.parse({
      ...this.recordValue,
      ...update,
      updatedAt: this.now().toISOString(),
    });
    await replacePrivateFile(this.path, serialized(replacement));
    this.recordValue = replacement;
    return replacement;
  }

  async release(): Promise<boolean> {
    let current: DaemonLockRecord | undefined;
    try {
      current = await readDaemonLockRecord(this.path);
    } catch (error: unknown) {
      if (!(error instanceof CorruptDaemonLockError)) {
        throw error;
      }
      return false;
    }
    if (current?.instanceId !== this.recordValue.instanceId) {
      return false;
    }
    await rm(this.path, { force: true });
    return true;
  }
}
