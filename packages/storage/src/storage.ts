import { existsSync } from "node:fs";
import { chmod, lstat, mkdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import Database from "better-sqlite3";

import {
  BlobStore,
  assertBlobCodecRuntimeSupport,
  type BlobStoreOptions,
} from "./blob-store.js";
import { StorageCompatibilityError } from "./errors.js";
import { EventRepository } from "./event-repository.js";
import {
  applyMigrations,
  getUserVersion,
  LATEST_SCHEMA_VERSION,
  verifyMigrationChecksums,
} from "./migrations.js";
import { RawExchangeRepository } from "./raw-exchange-repository.js";
import { SequenceAllocator, SessionRepository } from "./session-repository.js";
import {
  AnalysisRunRepository,
  ContextEdgeRepository,
  FileChangeRepository,
  RedactionRepository,
} from "./support-repositories.js";

export interface OpenStorageOptions {
  readonly databasePath: string;
  readonly dataDirectory?: string;
  readonly readOnly?: boolean;
  readonly allowNewerReadOnly?: boolean;
  readonly recoverIncompleteExchanges?: boolean;
  readonly blobStore?: BlobStoreOptions;
  readonly now?: () => Date;
}

export interface StorageRecoverySummary {
  readonly incompleteExchangeIds: readonly string[];
  readonly removedTemporaryBlobs: number;
}

interface OpenedDatabase {
  readonly database: Database.Database;
  readonly readOnly: boolean;
  readonly schemaVersion: number;
  readonly migrationBackupPath?: string;
}

async function pathSize(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).size;
  } catch (error: unknown) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return undefined;
    }
    throw error;
  }
}

async function setPrivateFileMode(path: string): Promise<void> {
  try {
    await chmod(path, 0o600);
  } catch (error: unknown) {
    if (
      typeof error !== "object" ||
      error === null ||
      !("code" in error) ||
      error.code !== "ENOENT"
    ) {
      throw error;
    }
  }
}

function configureWritableDatabase(database: Database.Database): void {
  database.pragma("foreign_keys = ON");
  database.pragma("busy_timeout = 5000");
  database.pragma("synchronous = NORMAL");
  database.pragma("wal_autocheckpoint = 1000");
  const journalMode = String(
    database.pragma("journal_mode = WAL", { simple: true }),
  ).toLowerCase();
  if (journalMode !== "wal") {
    throw new Error(`SQLite refused WAL mode and returned '${journalMode}'.`);
  }
}

function configureReadOnlyDatabase(database: Database.Database): void {
  database.pragma("foreign_keys = ON");
  database.pragma("busy_timeout = 5000");
  database.pragma("query_only = ON");
}

async function createMigrationBackup(
  database: Database.Database,
  dataDirectory: string,
  currentVersion: number,
  now: Date,
): Promise<string> {
  const backupDirectory = join(dataDirectory, "backups");
  await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
  await chmod(backupDirectory, 0o700);
  const timestamp = now.toISOString().replace(/\D/gu, "");
  const backupPath = join(
    backupDirectory,
    `tekrion-v${currentVersion}-${timestamp}.sqlite`,
  );
  await database.backup(backupPath);
  await setPrivateFileMode(backupPath);
  return backupPath;
}

async function openDatabase(
  options: OpenStorageOptions,
  databasePath: string,
  dataDirectory: string,
): Promise<OpenedDatabase> {
  if (options.readOnly === true) {
    const information = await lstat(databasePath);
    if (information.isSymbolicLink() || !information.isFile()) {
      throw new Error(
        `Read-only database path is not a regular file: ${databasePath}`,
      );
    }
    const database = new Database(databasePath, {
      readonly: true,
      fileMustExist: true,
    });
    try {
      configureReadOnlyDatabase(database);
      const currentVersion = getUserVersion(database);
      if (
        currentVersion > LATEST_SCHEMA_VERSION &&
        options.allowNewerReadOnly !== true
      ) {
        throw new StorageCompatibilityError(
          currentVersion,
          LATEST_SCHEMA_VERSION,
        );
      }
      verifyMigrationChecksums(database);
      return {
        database,
        readOnly: true,
        schemaVersion: currentVersion,
      };
    } catch (error: unknown) {
      if (database.open) {
        database.close();
      }
      throw error;
    }
  }

  const existingSize = await pathSize(databasePath);
  let database = new Database(databasePath);

  try {
    database.pragma("foreign_keys = ON");
    database.pragma("busy_timeout = 5000");
    const currentVersion = getUserVersion(database);

    if (currentVersion > LATEST_SCHEMA_VERSION) {
      database.close();
      if (options.allowNewerReadOnly !== true) {
        throw new StorageCompatibilityError(
          currentVersion,
          LATEST_SCHEMA_VERSION,
        );
      }
      database = new Database(databasePath, {
        readonly: true,
        fileMustExist: true,
      });
      configureReadOnlyDatabase(database);
      return {
        database,
        readOnly: true,
        schemaVersion: currentVersion,
      };
    }

    configureWritableDatabase(database);

    let migrationBackupPath: string | undefined;
    if (
      currentVersion < LATEST_SCHEMA_VERSION &&
      existingSize !== undefined &&
      existingSize > 0
    ) {
      migrationBackupPath = await createMigrationBackup(
        database,
        dataDirectory,
        currentVersion,
        (options.now ?? (() => new Date()))(),
      );
    }

    applyMigrations(
      database,
      undefined,
      (options.now ?? (() => new Date()))().toISOString(),
    );
    verifyMigrationChecksums(database);
    return {
      database,
      readOnly: false,
      schemaVersion: getUserVersion(database),
      ...(migrationBackupPath === undefined ? {} : { migrationBackupPath }),
    };
  } catch (error: unknown) {
    if (database.open) {
      database.close();
    }
    throw error;
  }
}

export class TekrionStorage {
  readonly sessions: SessionRepository;
  readonly sequences: SequenceAllocator;
  readonly rawExchanges: RawExchangeRepository;
  readonly events: EventRepository;
  readonly fileChanges: FileChangeRepository;
  readonly contextEdges: ContextEdgeRepository;
  readonly analysisRuns: AnalysisRunRepository;
  readonly redactions: RedactionRepository;
  readonly blobs: BlobStore;

  constructor(
    private readonly sqlite: Database.Database,
    readonly databasePath: string,
    readonly dataDirectory: string,
    readonly readOnly: boolean,
    readonly schemaVersion: number,
    readonly recovery: StorageRecoverySummary,
    readonly migrationBackupPath: string | undefined,
    blobStoreOptions: BlobStoreOptions,
  ) {
    this.sessions = new SessionRepository(sqlite);
    this.sequences = new SequenceAllocator(sqlite);
    this.rawExchanges = new RawExchangeRepository(sqlite);
    this.events = new EventRepository(sqlite);
    this.fileChanges = new FileChangeRepository(sqlite);
    this.contextEdges = new ContextEdgeRepository(sqlite);
    this.analysisRuns = new AnalysisRunRepository(sqlite);
    this.redactions = new RedactionRepository(sqlite);
    this.blobs = new BlobStore(sqlite, dataDirectory, blobStoreOptions);
  }

  get unsafeDatabase(): Database.Database {
    return this.sqlite;
  }

  transaction<T>(operation: () => T): T {
    return this.sqlite.transaction(operation)();
  }

  checkpoint(mode: "PASSIVE" | "FULL" | "RESTART" | "TRUNCATE" = "PASSIVE") {
    return this.sqlite.pragma(`wal_checkpoint(${mode})`);
  }

  integrityCheck(): string {
    return String(this.sqlite.pragma("integrity_check", { simple: true }));
  }

  close(): void {
    if (this.sqlite.open) {
      this.sqlite.close();
    }
  }
}

export async function openTekrionStorage(
  options: OpenStorageOptions,
): Promise<TekrionStorage> {
  assertBlobCodecRuntimeSupport();
  const databasePath = resolve(options.databasePath);
  const currentDataDirectory = join(dirname(databasePath), "tekrion-data");
  const legacyDataDirectory = join(dirname(databasePath), "blackbox-data");
  const dataDirectory = resolve(
    options.dataDirectory ??
      (!existsSync(currentDataDirectory) && existsSync(legacyDataDirectory)
        ? legacyDataDirectory
        : currentDataDirectory),
  );
  if (options.readOnly !== true) {
    await mkdir(dirname(databasePath), { recursive: true, mode: 0o700 });
    await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
    await chmod(dataDirectory, 0o700);
  }

  const opened = await openDatabase(options, databasePath, dataDirectory);
  if (options.readOnly !== true) {
    await setPrivateFileMode(databasePath);
    await setPrivateFileMode(`${databasePath}-wal`);
    await setPrivateFileMode(`${databasePath}-shm`);
  }

  try {
    const blobStore = new BlobStore(
      opened.database,
      dataDirectory,
      options.blobStore,
    );
    const removedTemporaryBlobs = opened.readOnly
      ? 0
      : await blobStore.initialize();
    const rawExchanges = new RawExchangeRepository(opened.database);
    const incompleteExchangeIds =
      opened.readOnly || options.recoverIncompleteExchanges === false
        ? []
        : rawExchanges.recoverIncomplete(
            (options.now ?? (() => new Date()))().toISOString(),
          );

    return new TekrionStorage(
      opened.database,
      databasePath,
      dataDirectory,
      opened.readOnly,
      opened.schemaVersion,
      { incompleteExchangeIds, removedTemporaryBlobs },
      opened.migrationBackupPath,
      options.blobStore ?? {},
    );
  } catch (error: unknown) {
    if (opened.database.open) {
      opened.database.close();
    }
    throw error;
  }
}
