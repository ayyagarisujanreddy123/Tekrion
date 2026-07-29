import { SessionSchema, type Session } from "@tekrion/protocol";
import type Database from "better-sqlite3";

import { ImmutableEvidenceError, SequenceAllocationError } from "./errors.js";

interface SessionRow {
  readonly record_json: string;
  readonly ended_at: string | null;
  readonly status: Session["status"];
  readonly event_count: number;
  readonly error_count: number;
  readonly input_tokens: number | null;
  readonly output_tokens: number | null;
}

interface SessionCursor {
  readonly startedAt: string;
  readonly id: string;
}

export interface SessionListOptions {
  readonly cursor?: string;
  readonly limit?: number;
  readonly includeInternal?: boolean;
}

export interface SessionCursorPage {
  readonly sessions: Session[];
  readonly nextCursor?: string;
}

function encodeCursor(cursor: SessionCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): SessionCursor {
  if (cursor.length === 0 || cursor.length > 4096) {
    throw new RangeError("Invalid session cursor.");
  }
  try {
    const value = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as Partial<SessionCursor>;
    if (
      typeof value.startedAt !== "string" ||
      !Number.isFinite(Date.parse(value.startedAt)) ||
      typeof value.id !== "string" ||
      value.id.length === 0 ||
      value.id.length > 512
    ) {
      throw new Error("invalid cursor fields");
    }
    return { startedAt: value.startedAt, id: value.id };
  } catch (error: unknown) {
    throw new RangeError("Invalid session cursor.", { cause: error });
  }
}

function hydrateSession(row: SessionRow): Session {
  const stored = JSON.parse(row.record_json) as Record<string, unknown>;
  const hydrated: Record<string, unknown> = {
    ...stored,
    status: row.status,
    counts: {
      events: row.event_count,
      errors: row.error_count,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
    },
  };

  if (row.ended_at === null) {
    delete hydrated.endedAt;
  } else {
    hydrated.endedAt = row.ended_at;
  }

  return SessionSchema.parse(hydrated);
}

function sessionParameters(
  session: Session,
  now: string,
): Record<string, unknown> {
  return {
    id: session.id,
    schemaVersion: session.schemaVersion,
    startedAt: session.startedAt,
    endedAt: session.endedAt ?? null,
    status: session.status,
    captureLevel: session.captureLevel,
    commandJson:
      session.command === undefined ? null : JSON.stringify(session.command),
    cwd: session.command?.cwd ?? null,
    repoRoot: session.repoRoot ?? null,
    agentName: session.agentName ?? null,
    modelsJson: JSON.stringify(session.models),
    upstreamOrigin: session.upstreamOrigin ?? null,
    tagsJson: JSON.stringify(session.tags),
    eventCount: session.counts.events,
    errorCount: session.counts.errors,
    inputTokens: session.counts.inputTokens,
    outputTokens: session.counts.outputTokens,
    metadataJson: JSON.stringify(session.metadata),
    recordJson: JSON.stringify(session),
    now,
  };
}

export class SessionRepository {
  constructor(private readonly database: Database.Database) {}

  create(input: Session, now: string = new Date().toISOString()): Session {
    const session = SessionSchema.parse(input);
    const parameters = sessionParameters(session, now);

    this.database.transaction(() => {
      this.database
        .prepare(
          `INSERT INTO sessions(
             id, schema_version, started_at, ended_at, status, capture_level,
             command_json, cwd, repo_root, agent_name, models_json,
             upstream_origin, tags_json, event_count, error_count, input_tokens,
             output_tokens, metadata_json, record_json, created_at, updated_at
           ) VALUES (
             @id, @schemaVersion, @startedAt, @endedAt, @status, @captureLevel,
             @commandJson, @cwd, @repoRoot, @agentName, @modelsJson,
             @upstreamOrigin, @tagsJson, @eventCount, @errorCount, @inputTokens,
             @outputTokens, @metadataJson, @recordJson, @now, @now
           )`,
        )
        .run(parameters);
      this.database
        .prepare(
          "INSERT INTO session_sequences(session_id, next_sequence) VALUES (?, ?)",
        )
        .run(session.id, 1);
    })();

    return session;
  }

  replace(input: Session, now: string = new Date().toISOString()): Session {
    const session = SessionSchema.parse(input);
    const existing = this.get(session.id);

    if (existing === undefined) {
      throw new ImmutableEvidenceError(
        `Cannot replace missing session ${session.id}.`,
      );
    }

    if (existing.status === "imported-readonly") {
      throw new ImmutableEvidenceError(
        `Imported session ${session.id} is read-only.`,
      );
    }

    if (
      existing.startedAt !== session.startedAt ||
      existing.captureLevel !== session.captureLevel
    ) {
      throw new ImmutableEvidenceError(
        `Session ${session.id} start time and capture level are immutable.`,
      );
    }

    const parameters = sessionParameters(session, now);
    const result = this.database
      .prepare(
        `UPDATE sessions SET
           ended_at = @endedAt,
           status = @status,
           command_json = @commandJson,
           cwd = @cwd,
           repo_root = @repoRoot,
           agent_name = @agentName,
           models_json = @modelsJson,
           upstream_origin = @upstreamOrigin,
           tags_json = @tagsJson,
           input_tokens = @inputTokens,
           output_tokens = @outputTokens,
           metadata_json = @metadataJson,
           record_json = @recordJson,
           updated_at = @now
         WHERE id = @id`,
      )
      .run(parameters);

    if (result.changes !== 1) {
      throw new ImmutableEvidenceError(
        `Failed to update session ${session.id}.`,
      );
    }

    return this.getRequired(session.id);
  }

  remove(id: string): Session {
    const session = this.getRequired(id);
    if (session.status === "active") {
      throw new ImmutableEvidenceError(
        `Active session ${id} cannot be deleted.`,
      );
    }
    const result = this.database
      .prepare("DELETE FROM sessions WHERE id = ?")
      .run(id);
    if (result.changes !== 1) {
      throw new ImmutableEvidenceError(`Session ${id} was not deleted.`);
    }
    return session;
  }

  get(id: string): Session | undefined {
    const row = this.database
      .prepare(
        `SELECT record_json, ended_at, status, event_count, error_count,
                input_tokens, output_tokens
         FROM sessions WHERE id = ?`,
      )
      .get(id) as SessionRow | undefined;
    return row === undefined ? undefined : hydrateSession(row);
  }

  getRequired(id: string): Session {
    const session = this.get(id);
    if (session === undefined) {
      throw new ImmutableEvidenceError(`Session ${id} does not exist.`);
    }
    return session;
  }

  list(limit = 100): Session[] {
    return this.listPage({ limit, includeInternal: true }).sessions;
  }

  listPage(options: SessionListOptions = {}): SessionCursorPage {
    const limit = Math.max(1, Math.min(options.limit ?? 100, 1000));
    const cursor =
      options.cursor === undefined
        ? { startedAt: "", id: "" }
        : decodeCursor(options.cursor);
    const rows = this.database
      .prepare(
        `SELECT record_json, ended_at, status, event_count, error_count,
                input_tokens, output_tokens
         FROM sessions
         WHERE (
           @startedAt = '' OR
           started_at < @startedAt OR
           (started_at = @startedAt AND id < @id)
         )
           AND (
             @includeInternal = 1 OR
             COALESCE(json_extract(metadata_json, '$.internalAnalysis'), 0) <> 1
           )
         ORDER BY started_at DESC, id DESC
         LIMIT @fetchLimit`,
      )
      .all({
        startedAt: cursor.startedAt,
        id: cursor.id,
        includeInternal: options.includeInternal === true ? 1 : 0,
        fetchLimit: limit + 1,
      }) as SessionRow[];
    const hasMore = rows.length > limit;
    const sessions = (hasMore ? rows.slice(0, limit) : rows).map(
      hydrateSession,
    );
    const last = sessions.at(-1);
    return {
      sessions,
      ...(hasMore && last !== undefined
        ? {
            nextCursor: encodeCursor({
              startedAt: last.startedAt,
              id: last.id,
            }),
          }
        : {}),
    };
  }
}

export class SequenceAllocator {
  constructor(private readonly database: Database.Database) {}

  reserve(sessionId: string, count = 1): number[] {
    if (!Number.isInteger(count) || count < 1 || count > 10_000) {
      throw new RangeError(
        "Sequence reservation count must be between 1 and 10000.",
      );
    }

    const row = this.database
      .prepare(
        `UPDATE session_sequences
         SET next_sequence = next_sequence + @count
         WHERE session_id = @sessionId
         RETURNING next_sequence - @count AS first_sequence`,
      )
      .get({ sessionId, count }) as { first_sequence: number } | undefined;

    if (row === undefined) {
      throw new SequenceAllocationError(sessionId);
    }

    return Array.from(
      { length: count },
      (_, index) => row.first_sequence + index,
    );
  }
}
