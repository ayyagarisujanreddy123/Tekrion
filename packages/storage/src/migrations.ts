import { createHash } from "node:crypto";

import type Database from "better-sqlite3";

import {
  MigrationError,
  StorageCompatibilityError,
  StorageIntegrityError,
} from "./errors.js";

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
  readonly checksum: string;
}

export function defineMigration(
  version: number,
  name: string,
  sql: string,
): Migration {
  return {
    version,
    name,
    sql,
    checksum: createHash("sha256").update(sql).digest("hex"),
  };
}

const INITIAL_SCHEMA_SQL = String.raw`
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL
) STRICT;

CREATE TABLE storage_metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  status TEXT NOT NULL,
  capture_level TEXT NOT NULL,
  command_json TEXT,
  cwd TEXT,
  repo_root TEXT,
  agent_name TEXT,
  models_json TEXT NOT NULL,
  upstream_origin TEXT,
  tags_json TEXT NOT NULL,
  event_count INTEGER NOT NULL DEFAULT 0 CHECK (event_count >= 0),
  error_count INTEGER NOT NULL DEFAULT 0 CHECK (error_count >= 0),
  input_tokens INTEGER,
  output_tokens INTEGER,
  metadata_json TEXT NOT NULL,
  record_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX sessions_started_at_idx ON sessions(started_at DESC, id DESC);

CREATE TABLE session_sequences (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  next_sequence INTEGER NOT NULL CHECK (next_sequence > 0)
) STRICT;

CREATE TABLE blobs (
  id TEXT PRIMARY KEY,
  sha256 TEXT NOT NULL UNIQUE,
  codec TEXT NOT NULL CHECK (codec IN ('identity', 'zstd')),
  media_type TEXT NOT NULL,
  byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
  stored_length INTEGER NOT NULL CHECK (stored_length >= 0),
  truncated INTEGER NOT NULL DEFAULT 0 CHECK (truncated IN (0, 1)),
  inline_data BLOB,
  relative_path TEXT,
  created_at TEXT NOT NULL,
  CHECK (
    (inline_data IS NOT NULL AND relative_path IS NULL) OR
    (inline_data IS NULL AND relative_path IS NOT NULL)
  )
) STRICT;

CREATE TABLE raw_exchanges (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  protocol TEXT NOT NULL,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  query_json TEXT NOT NULL,
  request_headers_json TEXT NOT NULL,
  request_blob_id TEXT REFERENCES blobs(id),
  response_status INTEGER,
  response_headers_json TEXT,
  response_blob_id TEXT REFERENCES blobs(id),
  stream_manifest_blob_id TEXT REFERENCES blobs(id),
  started_at TEXT NOT NULL,
  first_byte_at TEXT,
  ended_at TEXT,
  outcome TEXT NOT NULL,
  parse_status TEXT NOT NULL,
  journal_state TEXT NOT NULL CHECK (journal_state IN ('recording', 'complete', 'recovered')),
  record_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(session_id, sequence)
) STRICT;

CREATE INDEX raw_exchanges_session_idx ON raw_exchanges(session_id, sequence);
CREATE INDEX raw_exchanges_incomplete_idx ON raw_exchanges(journal_state, started_at);

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  raw_exchange_id TEXT REFERENCES raw_exchanges(id),
  normalization_version TEXT,
  parent_id TEXT,
  correlation_id TEXT,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  occurred_at TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  duration_ms REAL,
  source TEXT NOT NULL,
  type TEXT NOT NULL,
  evidence TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  payload_blob_id TEXT REFERENCES blobs(id),
  summary_json TEXT NOT NULL,
  redaction_json TEXT NOT NULL,
  record_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(session_id, sequence)
) STRICT;

CREATE INDEX events_session_sequence_idx ON events(session_id, sequence, id);
CREATE INDEX events_session_time_idx ON events(session_id, occurred_at, sequence);
CREATE INDEX events_type_idx ON events(session_id, type, sequence);
CREATE INDEX events_correlation_idx ON events(session_id, correlation_id);

CREATE TABLE normalization_runs (
  exchange_id TEXT NOT NULL REFERENCES raw_exchanges(id) ON DELETE CASCADE,
  parser_version TEXT NOT NULL,
  request_sha256 TEXT,
  response_sha256 TEXT,
  event_ids_json TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  PRIMARY KEY(exchange_id, parser_version)
) STRICT;

CREATE TABLE file_changes (
  event_id TEXT PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
  schema_version INTEGER NOT NULL,
  path TEXT NOT NULL,
  operation TEXT NOT NULL,
  previous_path TEXT,
  before_hash TEXT,
  after_hash TEXT,
  patch_blob_id TEXT REFERENCES blobs(id),
  timing_precision TEXT NOT NULL,
  sensitivity TEXT NOT NULL,
  record_json TEXT NOT NULL
) STRICT;

CREATE TABLE context_edges (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  from_event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  to_event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  edge_type TEXT NOT NULL,
  evidence TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  metadata_json TEXT NOT NULL,
  record_json TEXT NOT NULL,
  PRIMARY KEY(session_id, from_event_id, to_event_id, edge_type)
) STRICT;

CREATE INDEX context_edges_to_idx ON context_edges(session_id, to_event_id);

CREATE TABLE analysis_runs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  schema_version INTEGER NOT NULL,
  kind TEXT NOT NULL,
  target_event_id TEXT REFERENCES events(id),
  status TEXT NOT NULL,
  analyzer TEXT NOT NULL,
  prompt_version TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  result_blob_id TEXT REFERENCES blobs(id),
  error TEXT,
  record_json TEXT NOT NULL
) STRICT;

CREATE INDEX analysis_runs_session_idx ON analysis_runs(session_id, started_at, id);

CREATE TABLE redactions (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  schema_version INTEGER NOT NULL,
  location TEXT NOT NULL,
  rule_id TEXT NOT NULL,
  replacement TEXT NOT NULL,
  hash TEXT NOT NULL,
  record_json TEXT NOT NULL
) STRICT;

CREATE INDEX redactions_session_idx ON redactions(session_id, id);

CREATE VIRTUAL TABLE event_search USING fts5(
  event_id UNINDEXED,
  session_id UNINDEXED,
  type,
  text,
  tokenize = 'unicode61'
);
`;

const IMPORTED_READONLY_GUARDS_SQL = String.raw`
CREATE TRIGGER imported_session_no_update
BEFORE UPDATE ON sessions
WHEN OLD.status = 'imported-readonly'
BEGIN
  SELECT RAISE(ABORT, 'imported session is read-only');
END;

CREATE TRIGGER imported_session_no_sequence_update
BEFORE UPDATE ON session_sequences
WHEN EXISTS (
  SELECT 1 FROM sessions
  WHERE sessions.id = NEW.session_id
    AND sessions.status = 'imported-readonly'
)
BEGIN
  SELECT RAISE(ABORT, 'imported session is read-only');
END;

CREATE TRIGGER imported_session_no_raw_exchange_insert
BEFORE INSERT ON raw_exchanges
WHEN EXISTS (
  SELECT 1 FROM sessions
  WHERE sessions.id = NEW.session_id
    AND sessions.status = 'imported-readonly'
)
BEGIN
  SELECT RAISE(ABORT, 'imported session is read-only');
END;

CREATE TRIGGER imported_session_no_raw_exchange_update
BEFORE UPDATE ON raw_exchanges
WHEN EXISTS (
  SELECT 1 FROM sessions
  WHERE sessions.id = OLD.session_id
    AND sessions.status = 'imported-readonly'
)
BEGIN
  SELECT RAISE(ABORT, 'imported session is read-only');
END;

CREATE TRIGGER imported_session_no_event_insert
BEFORE INSERT ON events
WHEN EXISTS (
  SELECT 1 FROM sessions
  WHERE sessions.id = NEW.session_id
    AND sessions.status = 'imported-readonly'
)
BEGIN
  SELECT RAISE(ABORT, 'imported session is read-only');
END;

CREATE TRIGGER imported_session_no_normalization_insert
BEFORE INSERT ON normalization_runs
WHEN EXISTS (
  SELECT 1
  FROM raw_exchanges
  JOIN sessions ON sessions.id = raw_exchanges.session_id
  WHERE raw_exchanges.id = NEW.exchange_id
    AND sessions.status = 'imported-readonly'
)
BEGIN
  SELECT RAISE(ABORT, 'imported session is read-only');
END;

CREATE TRIGGER imported_session_no_file_change_insert
BEFORE INSERT ON file_changes
WHEN EXISTS (
  SELECT 1
  FROM events
  JOIN sessions ON sessions.id = events.session_id
  WHERE events.id = NEW.event_id
    AND sessions.status = 'imported-readonly'
)
BEGIN
  SELECT RAISE(ABORT, 'imported session is read-only');
END;

CREATE TRIGGER imported_session_no_context_edge_insert
BEFORE INSERT ON context_edges
WHEN EXISTS (
  SELECT 1 FROM sessions
  WHERE sessions.id = NEW.session_id
    AND sessions.status = 'imported-readonly'
)
BEGIN
  SELECT RAISE(ABORT, 'imported session is read-only');
END;

CREATE TRIGGER imported_session_no_analysis_run_insert
BEFORE INSERT ON analysis_runs
WHEN EXISTS (
  SELECT 1 FROM sessions
  WHERE sessions.id = NEW.session_id
    AND sessions.status = 'imported-readonly'
)
BEGIN
  SELECT RAISE(ABORT, 'imported session is read-only');
END;

CREATE TRIGGER imported_session_no_analysis_run_update
BEFORE UPDATE ON analysis_runs
WHEN EXISTS (
  SELECT 1 FROM sessions
  WHERE sessions.id = OLD.session_id
    AND sessions.status = 'imported-readonly'
)
BEGIN
  SELECT RAISE(ABORT, 'imported session is read-only');
END;

CREATE TRIGGER imported_session_no_redaction_insert
BEFORE INSERT ON redactions
WHEN EXISTS (
  SELECT 1 FROM sessions
  WHERE sessions.id = NEW.session_id
    AND sessions.status = 'imported-readonly'
)
BEGIN
  SELECT RAISE(ABORT, 'imported session is read-only');
END;
`;

const IMPORTED_READONLY_COMPLETE_GUARDS_SQL = String.raw`
DROP TRIGGER imported_session_no_raw_exchange_update;
CREATE TRIGGER imported_session_no_raw_exchange_update
BEFORE UPDATE ON raw_exchanges
WHEN EXISTS (
  SELECT 1 FROM sessions
  WHERE sessions.id IN (OLD.session_id, NEW.session_id)
    AND sessions.status = 'imported-readonly'
)
BEGIN
  SELECT RAISE(ABORT, 'imported session is read-only');
END;

DROP TRIGGER imported_session_no_analysis_run_update;
CREATE TRIGGER imported_session_no_analysis_run_update
BEFORE UPDATE ON analysis_runs
WHEN EXISTS (
  SELECT 1 FROM sessions
  WHERE sessions.id IN (OLD.session_id, NEW.session_id)
    AND sessions.status = 'imported-readonly'
)
BEGIN
  SELECT RAISE(ABORT, 'imported session is read-only');
END;

CREATE TRIGGER imported_session_no_event_update
BEFORE UPDATE ON events
WHEN EXISTS (
  SELECT 1 FROM sessions
  WHERE sessions.id IN (OLD.session_id, NEW.session_id)
    AND sessions.status = 'imported-readonly'
)
BEGIN
  SELECT RAISE(ABORT, 'imported session is read-only');
END;

CREATE TRIGGER imported_session_no_normalization_update
BEFORE UPDATE ON normalization_runs
WHEN EXISTS (
  SELECT 1
  FROM raw_exchanges
  JOIN sessions ON sessions.id = raw_exchanges.session_id
  WHERE raw_exchanges.id IN (OLD.exchange_id, NEW.exchange_id)
    AND sessions.status = 'imported-readonly'
)
BEGIN
  SELECT RAISE(ABORT, 'imported session is read-only');
END;

CREATE TRIGGER imported_session_no_file_change_update
BEFORE UPDATE ON file_changes
WHEN EXISTS (
  SELECT 1
  FROM events
  JOIN sessions ON sessions.id = events.session_id
  WHERE events.id IN (OLD.event_id, NEW.event_id)
    AND sessions.status = 'imported-readonly'
)
BEGIN
  SELECT RAISE(ABORT, 'imported session is read-only');
END;

CREATE TRIGGER imported_session_no_context_edge_update
BEFORE UPDATE ON context_edges
WHEN EXISTS (
  SELECT 1 FROM sessions
  WHERE sessions.id IN (OLD.session_id, NEW.session_id)
    AND sessions.status = 'imported-readonly'
)
BEGIN
  SELECT RAISE(ABORT, 'imported session is read-only');
END;

CREATE TRIGGER imported_session_no_redaction_update
BEFORE UPDATE ON redactions
WHEN EXISTS (
  SELECT 1 FROM sessions
  WHERE sessions.id IN (OLD.session_id, NEW.session_id)
    AND sessions.status = 'imported-readonly'
)
BEGIN
  SELECT RAISE(ABORT, 'imported session is read-only');
END;

CREATE TRIGGER imported_session_no_sequence_delete
BEFORE DELETE ON session_sequences
WHEN EXISTS (
  SELECT 1 FROM sessions
  WHERE sessions.id = OLD.session_id
    AND sessions.status = 'imported-readonly'
)
BEGIN
  SELECT RAISE(ABORT, 'imported session is read-only');
END;

CREATE TRIGGER imported_session_no_raw_exchange_delete
BEFORE DELETE ON raw_exchanges
WHEN EXISTS (
  SELECT 1 FROM sessions
  WHERE sessions.id = OLD.session_id
    AND sessions.status = 'imported-readonly'
)
BEGIN
  SELECT RAISE(ABORT, 'imported session is read-only');
END;

CREATE TRIGGER imported_session_no_event_delete
BEFORE DELETE ON events
WHEN EXISTS (
  SELECT 1 FROM sessions
  WHERE sessions.id = OLD.session_id
    AND sessions.status = 'imported-readonly'
)
BEGIN
  SELECT RAISE(ABORT, 'imported session is read-only');
END;

CREATE TRIGGER imported_session_no_normalization_delete
BEFORE DELETE ON normalization_runs
WHEN EXISTS (
  SELECT 1
  FROM raw_exchanges
  JOIN sessions ON sessions.id = raw_exchanges.session_id
  WHERE raw_exchanges.id = OLD.exchange_id
    AND sessions.status = 'imported-readonly'
)
BEGIN
  SELECT RAISE(ABORT, 'imported session is read-only');
END;

CREATE TRIGGER imported_session_no_file_change_delete
BEFORE DELETE ON file_changes
WHEN EXISTS (
  SELECT 1
  FROM events
  JOIN sessions ON sessions.id = events.session_id
  WHERE events.id = OLD.event_id
    AND sessions.status = 'imported-readonly'
)
BEGIN
  SELECT RAISE(ABORT, 'imported session is read-only');
END;

CREATE TRIGGER imported_session_no_context_edge_delete
BEFORE DELETE ON context_edges
WHEN EXISTS (
  SELECT 1 FROM sessions
  WHERE sessions.id = OLD.session_id
    AND sessions.status = 'imported-readonly'
)
BEGIN
  SELECT RAISE(ABORT, 'imported session is read-only');
END;

CREATE TRIGGER imported_session_no_analysis_run_delete
BEFORE DELETE ON analysis_runs
WHEN EXISTS (
  SELECT 1 FROM sessions
  WHERE sessions.id = OLD.session_id
    AND sessions.status = 'imported-readonly'
)
BEGIN
  SELECT RAISE(ABORT, 'imported session is read-only');
END;

CREATE TRIGGER imported_session_no_redaction_delete
BEFORE DELETE ON redactions
WHEN EXISTS (
  SELECT 1 FROM sessions
  WHERE sessions.id = OLD.session_id
    AND sessions.status = 'imported-readonly'
)
BEGIN
  SELECT RAISE(ABORT, 'imported session is read-only');
END;
`;

const REMOVE_FORBIDDEN_HEADER_FIELDS_SQL = String.raw`
PRAGMA secure_delete = ON;

UPDATE raw_exchanges
SET request_headers_json = COALESCE(
      (
        SELECT json_group_object(key, json(value))
        FROM json_each(raw_exchanges.request_headers_json)
        WHERE lower(key) <> 'x-api-key'
      ),
      '{}'
    ),
    record_json = json_set(
      record_json,
      '$.requestHeaders',
      json(
        COALESCE(
          (
            SELECT json_group_object(key, json(value))
            FROM json_each(
              json_extract(raw_exchanges.record_json, '$.requestHeaders')
            )
            WHERE lower(key) <> 'x-api-key'
          ),
          '{}'
        )
      )
    )
WHERE EXISTS (
  SELECT 1
  FROM json_each(raw_exchanges.request_headers_json)
  WHERE lower(key) = 'x-api-key'
);

UPDATE raw_exchanges
SET response_headers_json = COALESCE(
      (
        SELECT json_group_object(key, json(value))
        FROM json_each(raw_exchanges.response_headers_json)
        WHERE lower(key) <> 'x-api-key'
      ),
      '{}'
    ),
    record_json = json_set(
      record_json,
      '$.responseHeaders',
      json(
        COALESCE(
          (
            SELECT json_group_object(key, json(value))
            FROM json_each(
              json_extract(raw_exchanges.record_json, '$.responseHeaders')
            )
            WHERE lower(key) <> 'x-api-key'
          ),
          '{}'
        )
      )
    )
WHERE response_headers_json IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM json_each(raw_exchanges.response_headers_json)
    WHERE lower(key) = 'x-api-key'
  );
`;

const REMOVE_CHATGPT_ACCOUNT_ID_HEADER_SQL = String.raw`
PRAGMA secure_delete = ON;

UPDATE raw_exchanges
SET request_headers_json = COALESCE(
      (
        SELECT json_group_object(key, json(value))
        FROM json_each(raw_exchanges.request_headers_json)
        WHERE lower(key) <> 'chatgpt-account-id'
      ),
      '{}'
    ),
    record_json = json_set(
      record_json,
      '$.requestHeaders',
      json(
        COALESCE(
          (
            SELECT json_group_object(key, json(value))
            FROM json_each(
              json_extract(raw_exchanges.record_json, '$.requestHeaders')
            )
            WHERE lower(key) <> 'chatgpt-account-id'
          ),
          '{}'
        )
      )
    )
WHERE EXISTS (
  SELECT 1
  FROM json_each(raw_exchanges.request_headers_json)
  WHERE lower(key) = 'chatgpt-account-id'
);

UPDATE raw_exchanges
SET response_headers_json = COALESCE(
      (
        SELECT json_group_object(key, json(value))
        FROM json_each(raw_exchanges.response_headers_json)
        WHERE lower(key) <> 'chatgpt-account-id'
      ),
      '{}'
    ),
    record_json = json_set(
      record_json,
      '$.responseHeaders',
      json(
        COALESCE(
          (
            SELECT json_group_object(key, json(value))
            FROM json_each(
              json_extract(raw_exchanges.record_json, '$.responseHeaders')
            )
            WHERE lower(key) <> 'chatgpt-account-id'
          ),
          '{}'
        )
      )
    )
WHERE response_headers_json IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM json_each(raw_exchanges.response_headers_json)
    WHERE lower(key) = 'chatgpt-account-id'
  );
`;

export const MIGRATIONS: readonly Migration[] = [
  defineMigration(1, "initial-evidence-schema", INITIAL_SCHEMA_SQL),
  defineMigration(
    2,
    "imported-session-readonly-guards",
    IMPORTED_READONLY_GUARDS_SQL,
  ),
  defineMigration(
    3,
    "complete-imported-session-readonly-guards",
    IMPORTED_READONLY_COMPLETE_GUARDS_SQL,
  ),
  defineMigration(
    4,
    "remove-forbidden-header-fields",
    REMOVE_FORBIDDEN_HEADER_FIELDS_SQL,
  ),
  defineMigration(
    5,
    "remove-chatgpt-account-id-header",
    REMOVE_CHATGPT_ACCOUNT_ID_HEADER_SQL,
  ),
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS.at(-1)?.version ?? 0;

export function getUserVersion(database: Database.Database): number {
  const row = database.pragma("user_version", { simple: true });
  return typeof row === "number" ? row : Number(row);
}

function tableExists(database: Database.Database, tableName: string): boolean {
  const row = database
    .prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?",
    )
    .get(tableName) as { present: number } | undefined;
  return row?.present === 1;
}

export function verifyMigrationChecksums(
  database: Database.Database,
  migrations: readonly Migration[] = MIGRATIONS,
): void {
  const currentVersion = getUserVersion(database);

  if (currentVersion === 0) {
    return;
  }

  if (!tableExists(database, "schema_migrations")) {
    throw new StorageIntegrityError(
      "Database declares a schema version but has no migration ledger.",
    );
  }

  const appliedRows = database
    .prepare(
      "SELECT version, name, checksum FROM schema_migrations ORDER BY version",
    )
    .all() as Array<{ version: number; name: string; checksum: string }>;
  const appliedByVersion = new Map(
    appliedRows.map((migration) => [migration.version, migration]),
  );

  for (const expected of migrations) {
    if (expected.version > currentVersion) {
      break;
    }

    const applied = appliedByVersion.get(expected.version);
    if (
      applied === undefined ||
      applied.name !== expected.name ||
      applied.checksum !== expected.checksum
    ) {
      throw new StorageIntegrityError(
        `Migration ${expected.version} (${expected.name}) does not match the recorded checksum.`,
      );
    }
  }
}

export function applyMigrations(
  database: Database.Database,
  migrations: readonly Migration[] = MIGRATIONS,
  appliedAt: string = new Date().toISOString(),
): number {
  const latestVersion = migrations.at(-1)?.version ?? 0;
  const currentVersion = getUserVersion(database);

  if (currentVersion > latestVersion) {
    throw new StorageCompatibilityError(currentVersion, latestVersion);
  }

  migrations.forEach((migration, index) => {
    if (migration.version !== index + 1) {
      throw new StorageIntegrityError(
        "Migrations must be contiguous and start at version 1.",
      );
    }
  });

  verifyMigrationChecksums(database, migrations);
  const pending = migrations.filter(
    (migration) => migration.version > currentVersion,
  );

  if (pending.length === 0) {
    return currentVersion;
  }

  try {
    database.transaction(() => {
      for (const migration of pending) {
        database.exec(migration.sql);
        database
          .prepare(
            `INSERT INTO schema_migrations(version, name, checksum, applied_at)
             VALUES (?, ?, ?, ?)`,
          )
          .run(
            migration.version,
            migration.name,
            migration.checksum,
            appliedAt,
          );
        database.pragma(`user_version = ${migration.version}`);
      }
    })();
  } catch (error: unknown) {
    const failedVersion = pending.find(
      (migration) => getUserVersion(database) < migration.version,
    )?.version;
    throw new MigrationError(
      failedVersion ?? pending[0]?.version ?? currentVersion + 1,
      "Storage migration failed and was rolled back.",
      { cause: error },
    );
  }

  verifyMigrationChecksums(database, migrations);
  return getUserVersion(database);
}
