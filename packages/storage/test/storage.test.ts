import { once } from "node:events";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

import {
  TekrionEventSchema,
  RawExchangeSchema,
  SessionSchema,
  type TekrionEvent,
  type BlobReference,
  type RawExchange,
  type Session,
} from "@tekrion/protocol";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import {
  BlobCorruptionError,
  ChunkManifestBuilder,
  ChunkManifestSchema,
  LATEST_SCHEMA_VERSION,
  MIGRATIONS,
  MigrationError,
  StorageCapacityError,
  StorageCompatibilityError,
  StorageIntegrityError,
  applyMigrations,
  defineMigration,
  openTekrionStorage,
  type TekrionStorage,
  type OpenStorageOptions,
} from "../src/index.js";

const TIME = "2026-07-16T12:00:00.000Z";
const LATER = "2026-07-16T12:00:01.000Z";
const roots: string[] = [];
const openedStorages: TekrionStorage[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tekrion-storage-test-"));
  roots.push(root);
  return root;
}

async function openTestStorage(
  overrides: Partial<OpenStorageOptions> = {},
): Promise<{ storage: TekrionStorage; root: string }> {
  const root = await makeRoot();
  const storage = await openTekrionStorage({
    databasePath: join(root, "tekrion.sqlite"),
    dataDirectory: join(root, "data"),
    now: () => new Date(TIME),
    ...overrides,
  });
  openedStorages.push(storage);
  return { storage, root };
}

function session(id = "session-storage"): Session {
  return SessionSchema.parse({
    schemaVersion: 1,
    id,
    startedAt: TIME,
    status: "active",
    captureLevel: "api",
    models: [],
    tags: [],
    counts: {
      events: 0,
      errors: 0,
      inputTokens: null,
      outputTokens: null,
    },
    metadata: {},
  });
}

function event(
  id: string,
  sessionId: string,
  sequence: number,
  type = "model.request",
  summary: Record<string, unknown> = { text: "fixture evidence" },
): TekrionEvent {
  return TekrionEventSchema.parse({
    schemaVersion: 1,
    id,
    sessionId,
    sequence,
    occurredAt: TIME,
    observedAt: TIME,
    source: "proxy",
    type,
    evidence: "observed",
    summary,
    redaction: { applied: false, ruleIds: [] },
  });
}

function rawExchange(
  sessionId: string,
  requestBodyRef?: BlobReference,
  responseBodyRef?: BlobReference,
  completed = true,
): RawExchange {
  return RawExchangeSchema.parse({
    schemaVersion: 1,
    id: "exchange-storage",
    sessionId,
    sequence: 1,
    protocol: "openai.responses",
    method: "POST",
    path: "/v1/responses",
    query: {},
    requestHeaders: { "content-type": ["application/json"] },
    ...(requestBodyRef === undefined ? {} : { requestBodyRef }),
    ...(completed
      ? {
          responseStatus: 200,
          responseHeaders: { "content-type": ["application/json"] },
          ...(responseBodyRef === undefined ? {} : { responseBodyRef }),
          endedAt: LATER,
          outcome: "completed",
          capture: {
            requestComplete: true,
            responseComplete: true,
            droppedRequestBytes: 0,
            droppedResponseBytes: 0,
          },
        }
      : {
          outcome: "capture-incomplete",
          capture: {
            requestComplete: true,
            responseComplete: false,
            droppedRequestBytes: 0,
            droppedResponseBytes: 0,
          },
        }),
    startedAt: TIME,
    parseStatus: "pending",
  });
}

afterEach(async () => {
  for (const storage of openedStorages.splice(0)) {
    storage.close();
  }
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("database lifecycle and migrations", () => {
  it("reuses a pre-rebrand default blob directory", async () => {
    const root = await makeRoot();
    const legacyDataDirectory = join(root, "blackbox-data");
    await mkdir(legacyDataDirectory);
    const storage = await openTekrionStorage({
      databasePath: join(root, "tekrion.sqlite"),
      now: () => new Date(TIME),
    });
    openedStorages.push(storage);

    expect(storage.dataDirectory).toBe(legacyDataDirectory);
  });

  it("initializes WAL, private files, and an integrity-clean schema", async () => {
    const { storage } = await openTestStorage();
    const databaseMode = (await stat(storage.databasePath)).mode & 0o777;
    const dataMode = (await stat(storage.dataDirectory)).mode & 0o777;

    expect(storage.schemaVersion).toBe(LATEST_SCHEMA_VERSION);
    expect(
      storage.unsafeDatabase.pragma("journal_mode", { simple: true }),
    ).toBe("wal");
    expect(
      storage.unsafeDatabase.pragma("foreign_keys", { simple: true }),
    ).toBe(1);
    expect(storage.integrityCheck()).toBe("ok");
    if (process.platform !== "win32") {
      expect(databaseMode).toBe(0o600);
      expect(dataMode).toBe(0o700);
    }
  });

  it("allows a reader while a writer holds an uncommitted WAL transaction", async () => {
    const { storage } = await openTestStorage();
    storage.sessions.create(session());
    const reader = new Database(storage.databasePath, {
      readonly: true,
      fileMustExist: true,
    });

    storage.unsafeDatabase.exec("BEGIN IMMEDIATE");
    try {
      storage.unsafeDatabase
        .prepare("UPDATE sessions SET status = 'completed' WHERE id = ?")
        .run("session-storage");
      const visible = reader
        .prepare("SELECT status FROM sessions WHERE id = ?")
        .get("session-storage") as { status: string };
      expect(visible.status).toBe("active");
    } finally {
      storage.unsafeDatabase.exec("ROLLBACK");
      reader.close();
    }
  });

  it("opens an existing store explicitly without writes or migrations", async () => {
    const { storage, root } = await openTestStorage();
    storage.sessions.create(session());
    const databasePath = storage.databasePath;
    const dataDirectory = join(root, "unused-read-only-data");
    storage.close();
    openedStorages.splice(openedStorages.indexOf(storage), 1);

    const readOnly = await openTekrionStorage({
      databasePath,
      dataDirectory,
      readOnly: true,
    });
    openedStorages.push(readOnly);

    expect(readOnly.readOnly).toBe(true);
    expect(readOnly.schemaVersion).toBe(LATEST_SCHEMA_VERSION);
    expect(readOnly.integrityCheck()).toBe("ok");
    expect(readOnly.sessions.get("session-storage")?.id).toBe(
      "session-storage",
    );
    expect(() =>
      readOnly.unsafeDatabase.exec("CREATE TABLE forbidden(value TEXT)"),
    ).toThrow();
    await expect(stat(dataDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a symlinked read-only database target", async () => {
    const { storage, root } = await openTestStorage();
    const databasePath = storage.databasePath;
    const linkPath = join(root, "linked.sqlite");
    storage.close();
    openedStorages.splice(openedStorages.indexOf(storage), 1);
    await symlink(databasePath, linkPath);

    await expect(
      openTekrionStorage({
        databasePath: linkPath,
        dataDirectory: join(root, "unused-read-only-data"),
        readOnly: true,
      }),
    ).rejects.toThrow("Read-only database path is not a regular file");
  });

  it("rolls back every migration in a failed migration transaction", () => {
    const database = new Database(":memory:");
    const migrations = [
      defineMigration(
        1,
        "test-foundation",
        `CREATE TABLE schema_migrations (
           version INTEGER PRIMARY KEY,
           name TEXT NOT NULL,
           checksum TEXT NOT NULL,
           applied_at TEXT NOT NULL
         );
         CREATE TABLE should_rollback(id INTEGER PRIMARY KEY);`,
      ),
      defineMigration(2, "intentional-failure", "THIS IS NOT VALID SQL;"),
    ];

    expect(() => applyMigrations(database, migrations, TIME)).toThrow(
      MigrationError,
    );
    expect(database.pragma("user_version", { simple: true })).toBe(0);
    const table = database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'should_rollback'",
      )
      .get();
    expect(table).toBeUndefined();
    database.close();
  });

  it("creates a consistent backup before migrating an existing database", async () => {
    const root = await makeRoot();
    const databasePath = join(root, "legacy.sqlite");
    const legacy = new Database(databasePath);
    legacy.exec("CREATE TABLE legacy_marker(value TEXT NOT NULL)");
    legacy
      .prepare("INSERT INTO legacy_marker(value) VALUES (?)")
      .run("present");
    legacy.close();

    const storage = await openTekrionStorage({
      databasePath,
      dataDirectory: join(root, "data"),
      now: () => new Date(TIME),
    });
    openedStorages.push(storage);

    expect(storage.migrationBackupPath).toBeDefined();
    const backup = new Database(storage.migrationBackupPath as string, {
      readonly: true,
    });
    expect(
      backup.prepare("SELECT value FROM legacy_marker").pluck().get(),
    ).toBe("present");
    backup.close();
  });

  it("scrubs previously persisted provider credential and account headers", async () => {
    const root = await makeRoot();
    const databasePath = join(root, "headers-v3.sqlite");
    const legacy = new Database(databasePath);
    applyMigrations(legacy, MIGRATIONS.slice(0, 3), TIME);
    const legacySession = session("session-legacy-headers");
    legacy
      .prepare(
        `INSERT INTO sessions(
           id, schema_version, started_at, status, capture_level, models_json,
           tags_json, event_count, error_count, input_tokens, output_tokens,
           metadata_json, record_json, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        legacySession.id,
        legacySession.schemaVersion,
        legacySession.startedAt,
        legacySession.status,
        legacySession.captureLevel,
        JSON.stringify(legacySession.models),
        JSON.stringify(legacySession.tags),
        0,
        0,
        null,
        null,
        JSON.stringify(legacySession.metadata),
        JSON.stringify(legacySession),
        TIME,
        TIME,
      );
    const secret = "sk-ant-legacy-header-secret";
    const accountId = "chatgpt-legacy-account-id";
    const organizationId = "anthropic-legacy-organization-id";
    const legacyExchange = {
      schemaVersion: 1,
      id: "exchange-legacy-headers",
      sessionId: legacySession.id,
      sequence: 1,
      protocol: "unknown-openai-compatible",
      method: "POST",
      path: "/v1/messages",
      query: {},
      requestHeaders: {
        "Anthropic-Organization-ID": [organizationId],
        "X-API-Key": [secret],
        "ChatGPT-Account-ID": [accountId],
        "content-type": ["application/json"],
      },
      responseStatus: 200,
      responseHeaders: {
        "anthropic-organization-id": ["response-organization-id"],
        "chatgpt-account-id": ["response-account-id"],
        "x-api-key": ["response-secret"],
        "request-id": ["req_fixture"],
      },
      startedAt: TIME,
      endedAt: LATER,
      outcome: "completed",
      parseStatus: "unsupported",
      capture: {
        requestComplete: true,
        responseComplete: true,
        droppedRequestBytes: 0,
        droppedResponseBytes: 0,
      },
    };
    legacy
      .prepare(
        `INSERT INTO raw_exchanges(
           id, session_id, sequence, protocol, method, path, query_json,
           request_headers_json, response_status, response_headers_json,
           started_at, ended_at, outcome, parse_status, journal_state,
           record_json, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        legacyExchange.id,
        legacyExchange.sessionId,
        legacyExchange.sequence,
        legacyExchange.protocol,
        legacyExchange.method,
        legacyExchange.path,
        JSON.stringify(legacyExchange.query),
        JSON.stringify(legacyExchange.requestHeaders),
        legacyExchange.responseStatus,
        JSON.stringify(legacyExchange.responseHeaders),
        legacyExchange.startedAt,
        legacyExchange.endedAt,
        legacyExchange.outcome,
        legacyExchange.parseStatus,
        "complete",
        JSON.stringify(legacyExchange),
        TIME,
        TIME,
      );
    legacy.close();

    const storage = await openTekrionStorage({
      databasePath,
      dataDirectory: join(root, "data"),
      now: () => new Date(TIME),
    });
    openedStorages.push(storage);
    const migrated = storage.rawExchanges.getRequired(legacyExchange.id);

    expect(storage.schemaVersion).toBe(LATEST_SCHEMA_VERSION);
    expect(migrated.requestHeaders).toEqual({
      "content-type": ["application/json"],
    });
    expect(migrated.responseHeaders).toEqual({
      "request-id": ["req_fixture"],
    });
    expect(
      storage.unsafeDatabase
        .prepare("SELECT request_headers_json FROM raw_exchanges WHERE id = ?")
        .pluck()
        .get(legacyExchange.id),
    ).not.toContain("api-key");
    expect(
      storage.unsafeDatabase
        .prepare("SELECT record_json FROM raw_exchanges WHERE id = ?")
        .pluck()
        .get(legacyExchange.id),
    ).not.toContain(accountId);
    expect(
      storage.unsafeDatabase
        .prepare("SELECT response_headers_json FROM raw_exchanges WHERE id = ?")
        .pluck()
        .get(legacyExchange.id),
    ).not.toContain("organization-id");
    expect(
      storage.unsafeDatabase
        .prepare("SELECT record_json FROM raw_exchanges WHERE id = ?")
        .pluck()
        .get(legacyExchange.id),
    ).not.toContain(organizationId);
    storage.checkpoint("TRUNCATE");
    expect(
      (await readFile(storage.databasePath)).includes(
        Buffer.from(organizationId),
      ),
    ).toBe(false);
  });

  it("scrubs Anthropic organization headers from imported read-only evidence", async () => {
    const root = await makeRoot();
    const databasePath = join(root, "headers-v5-imported.sqlite");
    const legacy = new Database(databasePath);
    applyMigrations(legacy, MIGRATIONS.slice(0, 5), TIME);
    const activeSession = session("session-imported-legacy-headers");
    legacy
      .prepare(
        `INSERT INTO sessions(
           id, schema_version, started_at, status, capture_level, models_json,
           tags_json, event_count, error_count, input_tokens, output_tokens,
           metadata_json, record_json, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        activeSession.id,
        activeSession.schemaVersion,
        activeSession.startedAt,
        activeSession.status,
        activeSession.captureLevel,
        JSON.stringify(activeSession.models),
        JSON.stringify(activeSession.tags),
        0,
        0,
        null,
        null,
        JSON.stringify(activeSession.metadata),
        JSON.stringify(activeSession),
        TIME,
        TIME,
      );
    const organizationId = "anthropic-imported-organization-id";
    const legacyExchange = {
      schemaVersion: 1,
      id: "exchange-imported-legacy-headers",
      sessionId: activeSession.id,
      sequence: 1,
      protocol: "anthropic.messages",
      method: "POST",
      path: "/v1/messages",
      query: {},
      requestHeaders: { "content-type": ["application/json"] },
      responseStatus: 200,
      responseHeaders: {
        "anthropic-organization-id": [organizationId],
        "request-id": ["req_imported_fixture"],
      },
      startedAt: TIME,
      endedAt: LATER,
      outcome: "completed",
      parseStatus: "parsed",
      capture: {
        requestComplete: true,
        responseComplete: true,
        droppedRequestBytes: 0,
        droppedResponseBytes: 0,
      },
    };
    legacy
      .prepare(
        `INSERT INTO raw_exchanges(
           id, session_id, sequence, protocol, method, path, query_json,
           request_headers_json, response_status, response_headers_json,
           started_at, ended_at, outcome, parse_status, journal_state,
           record_json, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        legacyExchange.id,
        legacyExchange.sessionId,
        legacyExchange.sequence,
        legacyExchange.protocol,
        legacyExchange.method,
        legacyExchange.path,
        JSON.stringify(legacyExchange.query),
        JSON.stringify(legacyExchange.requestHeaders),
        legacyExchange.responseStatus,
        JSON.stringify(legacyExchange.responseHeaders),
        legacyExchange.startedAt,
        legacyExchange.endedAt,
        legacyExchange.outcome,
        legacyExchange.parseStatus,
        "complete",
        JSON.stringify(legacyExchange),
        TIME,
        TIME,
      );
    const importedSession = SessionSchema.parse({
      ...activeSession,
      endedAt: LATER,
      status: "imported-readonly",
      metadata: { importedReadOnly: true },
    });
    legacy
      .prepare(
        `UPDATE sessions
         SET ended_at = ?, status = ?, metadata_json = ?, record_json = ?,
             updated_at = ?
         WHERE id = ?`,
      )
      .run(
        importedSession.endedAt,
        importedSession.status,
        JSON.stringify(importedSession.metadata),
        JSON.stringify(importedSession),
        TIME,
        importedSession.id,
      );
    legacy.close();

    const storage = await openTekrionStorage({
      databasePath,
      dataDirectory: join(root, "data"),
      now: () => new Date(TIME),
    });
    openedStorages.push(storage);

    expect(storage.schemaVersion).toBe(LATEST_SCHEMA_VERSION);
    expect(storage.sessions.getRequired(importedSession.id).status).toBe(
      "imported-readonly",
    );
    expect(
      storage.rawExchanges.getRequired(legacyExchange.id).responseHeaders,
    ).toEqual({ "request-id": ["req_imported_fixture"] });
    expect(
      storage.unsafeDatabase
        .prepare("SELECT record_json FROM raw_exchanges WHERE id = ?")
        .pluck()
        .get(legacyExchange.id),
    ).not.toContain(organizationId);
    expect(() =>
      storage.unsafeDatabase
        .prepare("UPDATE raw_exchanges SET parse_status = ? WHERE id = ?")
        .run("malformed", legacyExchange.id),
    ).toThrow("imported session is read-only");
  });

  it("rejects a newer schema unless query-only access is explicit", async () => {
    const root = await makeRoot();
    const databasePath = join(root, "future.sqlite");
    const future = new Database(databasePath);
    future.pragma("user_version = 999");
    future.close();

    await expect(
      openTekrionStorage({ databasePath, dataDirectory: join(root, "data") }),
    ).rejects.toBeInstanceOf(StorageCompatibilityError);

    const readOnly = await openTekrionStorage({
      databasePath,
      dataDirectory: join(root, "data"),
      allowNewerReadOnly: true,
    });
    openedStorages.push(readOnly);
    expect(readOnly.readOnly).toBe(true);
    expect(() =>
      readOnly.unsafeDatabase.exec("CREATE TABLE forbidden(value TEXT)"),
    ).toThrow();
  });

  it("detects migration-ledger tampering", async () => {
    const { storage, root } = await openTestStorage();
    const databasePath = storage.databasePath;
    storage.close();
    openedStorages.splice(openedStorages.indexOf(storage), 1);
    const tamper = new Database(databasePath);
    tamper
      .prepare("UPDATE schema_migrations SET checksum = ? WHERE version = 1")
      .run("0".repeat(64));
    tamper.close();

    await expect(
      openTekrionStorage({
        databasePath,
        dataDirectory: join(root, "data"),
      }),
    ).rejects.toBeInstanceOf(StorageIntegrityError);
  });
});

describe("content-addressed blobs and chunk manifests", () => {
  it("deduplicates blobs and verifies decoded bytes", async () => {
    const { storage } = await openTestStorage();
    const first = await storage.blobs.put(
      "repeated repeated repeated repeated",
      {
        mediaType: "text/plain",
      },
    );
    const second = await storage.blobs.put(
      Buffer.from("repeated repeated repeated repeated"),
      { mediaType: "text/plain" },
    );

    expect(second.id).toBe(first.id);
    expect(storage.blobs.count()).toBe(1);
    expect(
      Buffer.from(await storage.blobs.get(first.id)).toString("utf8"),
    ).toBe("repeated repeated repeated repeated");
  });

  it("stores large blobs externally and detects tampering", async () => {
    const { storage } = await openTestStorage({
      blobStore: { inlineThresholdBytes: 8 },
    });
    const reference = await storage.blobs.put(Buffer.alloc(2048, 7), {
      mediaType: "application/octet-stream",
    });
    const location = storage.blobs.location(reference.id);

    expect(location.kind).toBe("external");
    if (location.kind === "external") {
      await writeFile(location.path, "corrupted");
    }
    await expect(storage.blobs.get(reference.id)).rejects.toBeInstanceOf(
      BlobCorruptionError,
    );
  });

  it("deduplicates concurrent external writes from two connections", async () => {
    const { storage, root } = await openTestStorage({
      blobStore: { inlineThresholdBytes: 8 },
    });
    const second = await openTekrionStorage({
      databasePath: storage.databasePath,
      dataDirectory: join(root, "data"),
      blobStore: { inlineThresholdBytes: 8 },
      recoverIncompleteExchanges: false,
    });
    openedStorages.push(second);
    const bytes = Buffer.alloc(4096, 11);

    const [firstReference, secondReference] = await Promise.all([
      storage.blobs.put(bytes, { mediaType: "application/octet-stream" }),
      second.blobs.put(bytes, { mediaType: "application/octet-stream" }),
    ]);

    expect(firstReference.id).toBe(secondReference.id);
    expect(storage.blobs.count()).toBe(1);
    expect(await storage.blobs.get(firstReference.id)).toEqual(bytes);
  });

  it("fails capacity checks without leaving partial metadata", async () => {
    const { storage } = await openTestStorage({
      blobStore: { maxStoredBytes: 1 },
    });

    await expect(
      storage.blobs.put(Buffer.alloc(100, 3), {
        mediaType: "application/octet-stream",
      }),
    ).rejects.toBeInstanceOf(StorageCapacityError);
    expect(storage.blobs.count()).toBe(0);
    expect(storage.integrityCheck()).toBe("ok");
  });

  it("translates SQLite disk-full failures without committing a partial blob", async () => {
    const { storage } = await openTestStorage({
      blobStore: { inlineThresholdBytes: 1024 * 1024 },
    });
    const pageCount = Number(
      storage.unsafeDatabase.pragma("page_count", { simple: true }),
    );
    storage.unsafeDatabase.pragma(`max_page_count = ${pageCount}`);

    await expect(
      storage.blobs.put(randomBytes(512 * 1024), {
        mediaType: "application/octet-stream",
      }),
    ).rejects.toBeInstanceOf(StorageCapacityError);
    expect(storage.blobs.count()).toBe(0);
    expect(storage.integrityCheck()).toBe("ok");
  });

  it("removes orphan temporary blob files on startup", async () => {
    const { storage, root } = await openTestStorage();
    const temporaryDirectory = join(storage.blobs.blobDirectory, "aa", "bb");
    const temporaryPath = join(temporaryDirectory, ".orphan.tmp");
    await mkdir(temporaryDirectory, { recursive: true });
    await writeFile(temporaryPath, "partial");
    storage.close();
    openedStorages.splice(openedStorages.indexOf(storage), 1);

    const reopened = await openTekrionStorage({
      databasePath: join(root, "tekrion.sqlite"),
      dataDirectory: join(root, "data"),
      now: () => new Date(TIME),
    });
    openedStorages.push(reopened);
    expect(reopened.recovery.removedTemporaryBlobs).toBe(1);
    await expect(readFile(temporaryPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("records monotonic time and independent request/response byte offsets", async () => {
    const { storage } = await openTestStorage();
    const builder = new ChunkManifestBuilder("exchange-chunks", 1_000n);
    builder.append("request", Buffer.from("abc"), 1_010n);
    builder.append("response", Buffer.from("xy"), 1_020n);
    builder.append("request", Buffer.from("defg"), 1_030n);
    const manifest = builder.build(false);

    expect(manifest.entries.map((entry) => entry.byteOffset)).toEqual([
      0, 0, 3,
    ]);
    expect(manifest.entries.map((entry) => entry.monotonicOffsetNs)).toEqual([
      "10",
      "20",
      "30",
    ]);
    const reference = await builder.persist(storage.blobs, false);
    const stored = JSON.parse(
      Buffer.from(await storage.blobs.get(reference.id)).toString("utf8"),
    );
    expect(ChunkManifestSchema.parse(stored)).toEqual(manifest);
    expect(() =>
      builder.append("response", Buffer.from("late"), 1_029n),
    ).toThrow(RangeError);
  });

  it("bounds chunk provenance and accounts for dropped manifest entries", () => {
    const builder = new ChunkManifestBuilder(
      "exchange-bounded-chunks",
      1_000n,
      2,
    );
    builder.append("request", Buffer.from("abc"), 1_010n);
    builder.append("response", Buffer.from("xy"), 1_020n);
    expect(
      builder.append("request", Buffer.from("defg"), 1_030n),
    ).toBeUndefined();

    const manifest = builder.build(true);
    expect(manifest).toMatchObject({
      completed: true,
      truncated: true,
      droppedEntryCount: 1,
      droppedByteCount: 4,
    });
    expect(manifest.entries).toHaveLength(2);
  });
});

describe("repositories, recovery, and stable ordering", () => {
  it("allocates monotonic sequences across connections and paginates stably", async () => {
    const { storage, root } = await openTestStorage();
    storage.sessions.create(session());
    const second = await openTekrionStorage({
      databasePath: storage.databasePath,
      dataDirectory: join(root, "data"),
      recoverIncompleteExchanges: false,
    });
    openedStorages.push(second);

    expect(storage.sequences.reserve("session-storage", 2)).toEqual([1, 2]);
    expect(second.sequences.reserve("session-storage", 2)).toEqual([3, 4]);

    for (const sequence of [4, 1, 3, 2]) {
      storage.events.insert(
        event(`event-${sequence}`, "session-storage", sequence),
      );
    }

    const firstPage = storage.events.list("session-storage", { limit: 2 });
    expect(firstPage.nextCursor).toBeDefined();
    const secondPage = storage.events.list("session-storage", {
      limit: 2,
      cursor: firstPage.nextCursor as string,
    });
    expect(firstPage.events.map((item) => item.sequence)).toEqual([1, 2]);
    expect(secondPage.events.map((item) => item.sequence)).toEqual([3, 4]);
    expect(secondPage.nextCursor).toBeUndefined();
    expect(
      second.events
        .listAfterSequence("session-storage", 2, 2)
        .map((item) => item.sequence),
    ).toEqual([3, 4]);
    expect(() =>
      storage.events.listAfterSequence("session-storage", -1),
    ).toThrow("non-negative integer");
    expect(storage.sessions.getRequired("session-storage").counts.events).toBe(
      4,
    );
  });

  it("normalizes idempotently without changing raw hashes and rebuilds FTS", async () => {
    const { storage } = await openTestStorage();
    storage.sessions.create(session());
    const request = await storage.blobs.put('{"input":"fixture"}', {
      mediaType: "application/json",
    });
    const response = await storage.blobs.put('{"output":"fixture"}', {
      mediaType: "application/json",
    });
    storage.rawExchanges.insertComplete(
      rawExchange("session-storage", request, response),
    );
    const before = storage.rawExchanges.getRequired("exchange-storage");
    const normalizedEvent = event(
      "event-normalized",
      "session-storage",
      1,
      "tool.call",
      { name: "read_file", path: "README.md" },
    );

    const first = storage.events.insertNormalization({
      exchangeId: "exchange-storage",
      parserVersion: "responses-v1",
      events: [normalizedEvent],
      completedAt: LATER,
    });
    const second = storage.events.insertNormalization({
      exchangeId: "exchange-storage",
      parserVersion: "responses-v1",
      events: [normalizedEvent],
      completedAt: LATER,
    });
    const after = storage.rawExchanges.getRequired("exchange-storage");

    expect(first.inserted).toBe(true);
    expect(second).toEqual({ inserted: false, eventIds: ["event-normalized"] });
    expect(storage.events.count("session-storage")).toBe(1);
    expect(after.parseStatus).toBe("parsed");
    expect(after.requestBodyRef?.sha256).toBe(before.requestBodyRef?.sha256);
    expect(after.responseBodyRef?.sha256).toBe(before.responseBodyRef?.sha256);
    expect(storage.events.search("session-storage", "README")).toHaveLength(1);
    storage.unsafeDatabase.exec("DELETE FROM event_search");
    expect(storage.events.search("session-storage", "README")).toHaveLength(0);
    expect(storage.events.rebuildSearchIndex()).toBe(1);
    expect(storage.events.search("session-storage", "README")).toHaveLength(1);
    expect(() =>
      storage.events.insertNormalization({
        exchangeId: "exchange-storage",
        parserVersion: "responses-v1",
        events: [
          event("event-conflict", "session-storage", 2, "message.assistant"),
        ],
      }),
    ).toThrow(StorageIntegrityError);
    expect(() =>
      storage.events.insertNormalization({
        exchangeId: "exchange-storage",
        parserVersion: "responses-v1",
        events: [
          TekrionEventSchema.parse({
            ...normalizedEvent,
            summary: { name: "changed_after_normalization" },
          }),
        ],
      }),
    ).toThrow(StorageIntegrityError);
  });

  it("refuses to rewrite captured request identity during finalization", async () => {
    const { storage } = await openTestStorage();
    storage.sessions.create(session());
    const request = await storage.blobs.put('{"input":"original"}', {
      mediaType: "application/json",
    });
    const response = await storage.blobs.put('{"output":"done"}', {
      mediaType: "application/json",
    });
    storage.rawExchanges.begin(
      rawExchange("session-storage", request, undefined, false),
    );
    const changed = RawExchangeSchema.parse({
      ...rawExchange("session-storage", request, response, true),
      query: { rewritten: ["true"] },
    });

    expect(() => storage.rawExchanges.finalize(changed)).toThrow(
      StorageIntegrityError,
    );
    expect(storage.rawExchanges.getJournalState("exchange-storage")).toBe(
      "recording",
    );
  });

  it("recovers an exchange left open when a recorder process is killed", async () => {
    const { storage, root } = await openTestStorage();
    storage.sessions.create(session());
    const databasePath = storage.databasePath;
    storage.close();
    openedStorages.splice(openedStorages.indexOf(storage), 1);
    const exchange = rawExchange(
      "session-storage",
      undefined,
      undefined,
      false,
    );
    const encodedRecord = Buffer.from(JSON.stringify(exchange)).toString(
      "base64url",
    );
    const childProgram = String.raw`
      const Database = require("better-sqlite3");
      const database = new Database(process.argv[1]);
      database.pragma("journal_mode = WAL");
      const record = JSON.parse(Buffer.from(process.argv[2], "base64url").toString("utf8"));
      database.prepare(
        "INSERT INTO raw_exchanges(id, session_id, sequence, protocol, method, path, query_json, request_headers_json, started_at, outcome, parse_status, journal_state, record_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'recording', ?, ?, ?)"
      ).run(record.id, record.sessionId, record.sequence, record.protocol, record.method, record.path, JSON.stringify(record.query), JSON.stringify(record.requestHeaders), record.startedAt, record.outcome, record.parseStatus, JSON.stringify(record), record.startedAt, record.startedAt);
      process.stdout.write("ready\n");
      setInterval(() => {}, 1000);
    `;
    const child = spawn(
      process.execPath,
      ["-e", childProgram, databasePath, encodedRecord],
      { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
    );
    const ready = await once(child.stdout, "data");
    expect(Buffer.concat(ready as Buffer[]).toString("utf8")).toContain(
      "ready",
    );
    child.kill("SIGKILL");
    await once(child, "exit");

    const recovered = await openTekrionStorage({
      databasePath,
      dataDirectory: join(root, "data"),
      now: () => new Date(LATER),
    });
    openedStorages.push(recovered);
    const stored = recovered.rawExchanges.getRequired("exchange-storage");
    expect(recovered.recovery.incompleteExchangeIds).toEqual([
      "exchange-storage",
    ]);
    expect(recovered.rawExchanges.getJournalState("exchange-storage")).toBe(
      "recovered",
    );
    expect(stored.outcome).toBe("capture-incomplete");
    expect(stored.parseStatus).toBe("skipped");
    expect(stored.capture.responseComplete).toBe(false);
    expect(stored.endedAt).toBe(LATER);
  });

  it("stores file, context, analysis, and redaction records", async () => {
    const { storage } = await openTestStorage();
    storage.sessions.create(session());
    storage.events.insert(
      event("event-origin", "session-storage", 1, "tool.result"),
    );
    storage.events.insert(
      event("event-delete", "session-storage", 2, "file.delete", {
        path: "test/math.test.js",
      }),
    );

    storage.fileChanges.insert({
      schemaVersion: 1,
      eventId: "event-delete",
      path: "test/math.test.js",
      operation: "delete",
      beforeHash: "a".repeat(64),
      timingPrecision: "exact-final-diff",
      sensitivity: "normal",
    });
    storage.contextEdges.insert({
      schemaVersion: 1,
      sessionId: "session-storage",
      fromEventId: "event-origin",
      toEventId: "event-delete",
      edgeType: "read-result-propagation",
      evidence: "derived",
      metadata: { path: "test/math.test.js" },
    });
    storage.analysisRuns.insert({
      schemaVersion: 1,
      id: "analysis-1",
      sessionId: "session-storage",
      kind: "blame",
      targetEventId: "event-delete",
      status: "running",
      analyzer: "deterministic-v1",
      startedAt: TIME,
    });
    storage.analysisRuns.replace({
      schemaVersion: 1,
      id: "analysis-1",
      sessionId: "session-storage",
      kind: "blame",
      targetEventId: "event-delete",
      status: "completed",
      analyzer: "deterministic-v1",
      startedAt: TIME,
      endedAt: LATER,
    });
    storage.redactions.insert({
      schemaVersion: 1,
      id: "redaction-1",
      sessionId: "session-storage",
      location: "event-origin.summary.text",
      ruleId: "secret-token",
      replacement: "[REDACTED]",
      hash: "b".repeat(64),
    });

    expect(storage.fileChanges.getByEvent("event-delete")?.operation).toBe(
      "delete",
    );
    expect(
      storage.contextEdges.listForTarget("session-storage", "event-delete"),
    ).toHaveLength(1);
    expect(storage.analysisRuns.get("analysis-1")?.status).toBe("completed");
    expect(storage.redactions.listForSession("session-storage")).toHaveLength(
      1,
    );
  });

  it("enforces imported session immutability while allowing explicit deletion", async () => {
    const { storage } = await openTestStorage();
    storage.sessions.create(session());
    storage.events.insert(event("event-imported", "session-storage", 1));
    const current = storage.sessions.getRequired("session-storage");
    storage.sessions.replace({
      ...current,
      endedAt: LATER,
      status: "imported-readonly",
      metadata: { importedReadOnly: true },
    });

    expect(() =>
      storage.events.insert(
        event("event-imported-write", "session-storage", 2),
      ),
    ).toThrow("imported session is read-only");
    expect(() =>
      storage.sessions.replace({
        ...storage.sessions.getRequired("session-storage"),
        tags: ["changed"],
      }),
    ).toThrow("read-only");
    expect(() =>
      storage.unsafeDatabase
        .prepare("UPDATE events SET summary_json = '{}' WHERE id = ?")
        .run("event-imported"),
    ).toThrow("imported session is read-only");
    expect(() =>
      storage.unsafeDatabase
        .prepare("DELETE FROM events WHERE id = ?")
        .run("event-imported"),
    ).toThrow("imported session is read-only");
    expect(storage.sessions.remove("session-storage").status).toBe(
      "imported-readonly",
    );
    expect(storage.sessions.get("session-storage")).toBeUndefined();
  });

  it("garbage-collects only blobs that have no evidence references", async () => {
    const { storage } = await openTestStorage();
    storage.sessions.create(session());
    const retained = await storage.blobs.put("retained", {
      mediaType: "text/plain",
    });
    const orphan = await storage.blobs.put("orphan", {
      mediaType: "text/plain",
    });
    const deferredOrphan = await storage.blobs.put("deferred orphan", {
      mediaType: "text/plain",
    });
    storage.events.insert({
      ...event("event-with-blob", "session-storage", 1),
      payloadRef: retained,
    });

    const result = await storage.blobs.removeUnreferenced([orphan.id]);
    expect(result.removedBlobs).toBe(1);
    expect(storage.blobs.describe(orphan.id)).toBeUndefined();
    expect(storage.blobs.describe(deferredOrphan.id)).toBeDefined();
    expect(storage.blobs.describe(retained.id)).toBeDefined();
    await expect(storage.blobs.get(retained.id)).resolves.toEqual(
      Buffer.from("retained"),
    );
  });
});
