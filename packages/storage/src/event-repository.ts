import { isDeepStrictEqual } from "node:util";

import {
  TekrionEventSchema,
  RawExchangeParseStatusSchema,
  RawExchangeSchema,
  type TekrionEvent,
  type EvidenceSource,
  type RawExchange,
  type RawExchangeParseStatus,
} from "@tekrion/protocol";
import type Database from "better-sqlite3";

import { ImmutableEvidenceError, StorageIntegrityError } from "./errors.js";

interface EventRow {
  readonly record_json: string;
}

interface EventOriginRow {
  readonly raw_exchange_id: string | null;
  readonly normalization_version: string | null;
}

export interface EventOrigin {
  readonly rawExchangeId?: string;
  readonly normalizationVersion?: string;
}

interface NormalizationRow {
  readonly request_sha256: string | null;
  readonly response_sha256: string | null;
  readonly event_ids_json: string;
}

interface RawRecordRow {
  readonly record_json: string;
}

export interface EventCursorPage {
  readonly events: TekrionEvent[];
  readonly nextCursor?: string;
}

export interface EventAnalysisWindow {
  readonly events: TekrionEvent[];
  readonly truncated: boolean;
}

export interface EventListOptions {
  readonly cursor?: string;
  readonly limit?: number;
  readonly type?: string;
  readonly source?: EvidenceSource;
  readonly occurredAfter?: string;
  readonly occurredBefore?: string;
  readonly typePrefix?: string;
}

export interface NormalizationInput {
  readonly exchangeId: string;
  readonly parserVersion: string;
  readonly events: readonly TekrionEvent[];
  readonly parseStatus?: Exclude<RawExchangeParseStatus, "pending">;
  readonly completedAt?: string;
}

export interface NormalizationResult {
  readonly inserted: boolean;
  readonly eventIds: readonly string[];
}

export interface StoredNormalization {
  readonly parserVersion: string;
  readonly events: readonly TekrionEvent[];
}

interface EventCursor {
  readonly sequence: number;
  readonly id: string;
}

function encodeCursor(cursor: EventCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): EventCursor {
  try {
    const value = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as Partial<EventCursor>;

    if (
      !Number.isInteger(value.sequence) ||
      (value.sequence ?? 0) < 1 ||
      typeof value.id !== "string" ||
      value.id.length === 0
    ) {
      throw new Error("invalid cursor fields");
    }

    return { sequence: value.sequence as number, id: value.id };
  } catch (error: unknown) {
    throw new RangeError("Invalid event cursor.", { cause: error });
  }
}

function parseEventRow(row: EventRow): TekrionEvent {
  return TekrionEventSchema.parse(JSON.parse(row.record_json));
}

function exchangeHashes(exchange: RawExchange): {
  requestSha256: string | null;
  responseSha256: string | null;
} {
  return {
    requestSha256: exchange.requestBodyRef?.sha256 ?? null,
    responseSha256: exchange.responseBodyRef?.sha256 ?? null,
  };
}

export class EventRepository {
  constructor(private readonly database: Database.Database) {}

  insert(
    input: TekrionEvent,
    origin: {
      readonly rawExchangeId?: string;
      readonly normalizationVersion?: string;
    } = {},
    now: string = new Date().toISOString(),
  ): TekrionEvent {
    const event = TekrionEventSchema.parse(input);
    this.database.transaction(() => {
      this.insertRow(event, origin, now);
    })();
    return event;
  }

  insertNormalization(input: NormalizationInput): NormalizationResult {
    const completedAt = input.completedAt ?? new Date().toISOString();
    const exchange = this.getRawExchange(input.exchangeId);
    const hashes = exchangeHashes(exchange);
    const events = input.events.map((event) => TekrionEventSchema.parse(event));
    const parseStatus: RawExchangeParseStatus =
      RawExchangeParseStatusSchema.parse(input.parseStatus ?? "parsed");
    if (parseStatus === "pending") {
      throw new RangeError("A completed normalization cannot remain pending.");
    }
    const existing = this.getNormalizationRow(
      input.exchangeId,
      input.parserVersion,
    );

    if (existing !== undefined) {
      if (
        existing.request_sha256 !== hashes.requestSha256 ||
        existing.response_sha256 !== hashes.responseSha256
      ) {
        throw new StorageIntegrityError(
          `Raw hashes changed after normalization of exchange ${input.exchangeId}.`,
        );
      }

      const existingEventIds = this.parseEventIds(existing.event_ids_json);
      const requestedEventIds = events.map((event) => event.id);
      if (
        JSON.stringify(existingEventIds) !== JSON.stringify(requestedEventIds)
      ) {
        throw new StorageIntegrityError(
          `Parser ${input.parserVersion} produced conflicting events for exchange ${input.exchangeId}.`,
        );
      }
      const storedEvents = this.getStoredEvents(existingEventIds);
      if (
        storedEvents.length !== events.length ||
        storedEvents.some(
          (event, index) => !isDeepStrictEqual(event, events[index]),
        )
      ) {
        throw new StorageIntegrityError(
          `Parser ${input.parserVersion} changed canonical event content for exchange ${input.exchangeId}.`,
        );
      }

      return {
        inserted: false,
        eventIds: existingEventIds,
      };
    }

    if (events.some((event) => event.sessionId !== exchange.sessionId)) {
      throw new ImmutableEvidenceError(
        "Normalized events must belong to the raw exchange session.",
      );
    }

    this.database.transaction(() => {
      for (const event of events) {
        this.insertRow(
          event,
          {
            rawExchangeId: input.exchangeId,
            normalizationVersion: input.parserVersion,
          },
          completedAt,
        );
      }

      this.database
        .prepare(
          `INSERT INTO normalization_runs(
             exchange_id, parser_version, request_sha256, response_sha256,
             event_ids_json, completed_at
           ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.exchangeId,
          input.parserVersion,
          hashes.requestSha256,
          hashes.responseSha256,
          JSON.stringify(events.map((event) => event.id)),
          completedAt,
        );

      const updatedRaw = RawExchangeSchema.parse({
        ...exchange,
        parseStatus,
      });
      this.database
        .prepare(
          `UPDATE raw_exchanges
           SET parse_status = ?, record_json = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          parseStatus,
          JSON.stringify(updatedRaw),
          completedAt,
          input.exchangeId,
        );
    })();

    return { inserted: true, eventIds: events.map((event) => event.id) };
  }

  get(id: string): TekrionEvent | undefined {
    const row = this.database
      .prepare("SELECT record_json FROM events WHERE id = ?")
      .get(id) as EventRow | undefined;
    return row === undefined ? undefined : parseEventRow(row);
  }

  getOrigin(id: string): EventOrigin | undefined {
    const row = this.database
      .prepare(
        `SELECT raw_exchange_id, normalization_version
         FROM events
         WHERE id = ?`,
      )
      .get(id) as EventOriginRow | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      ...(row.raw_exchange_id === null
        ? {}
        : { rawExchangeId: row.raw_exchange_id }),
      ...(row.normalization_version === null
        ? {}
        : { normalizationVersion: row.normalization_version }),
    };
  }

  listForExchange(exchangeId: string): TekrionEvent[] {
    const rows = this.database
      .prepare(
        `SELECT record_json
         FROM events
         WHERE raw_exchange_id = ?
         ORDER BY sequence ASC, id ASC`,
      )
      .all(exchangeId) as EventRow[];
    return rows.map(parseEventRow);
  }

  findResponseEvent(
    sessionId: string,
    responseId: string,
  ): TekrionEvent | undefined {
    const row = this.database
      .prepare(
        `SELECT record_json
         FROM events
         WHERE session_id = ?
           AND raw_exchange_id IS NOT NULL
           AND type IN ('model.response.completed', 'model.response.started')
           AND json_extract(summary_json, '$.responseId') = ?
         ORDER BY
           CASE type WHEN 'model.response.completed' THEN 0 ELSE 1 END,
           sequence ASC,
           id ASC
         LIMIT 1`,
      )
      .get(sessionId, responseId) as EventRow | undefined;
    return row === undefined ? undefined : parseEventRow(row);
  }

  getNormalization(
    exchangeId: string,
    parserVersion: string,
  ): StoredNormalization | undefined {
    const row = this.getNormalizationRow(exchangeId, parserVersion);
    if (row === undefined) {
      return undefined;
    }
    return {
      parserVersion,
      events: this.getStoredEvents(this.parseEventIds(row.event_ids_json)),
    };
  }

  count(sessionId: string): number {
    const row = this.database
      .prepare("SELECT COUNT(*) AS count FROM events WHERE session_id = ?")
      .get(sessionId) as { count: number };
    return row.count;
  }

  list(sessionId: string, options: EventListOptions = {}): EventCursorPage {
    const limit = Math.max(1, Math.min(options.limit ?? 100, 1000));
    const cursor =
      options.cursor === undefined
        ? { sequence: 0, id: "" }
        : decodeCursor(options.cursor);
    const rows = this.database
      .prepare(
        `SELECT record_json
         FROM events
         WHERE session_id = @sessionId
           AND (sequence > @sequence OR (sequence = @sequence AND id > @id))
           AND (@type IS NULL OR type = @type)
           AND (@source IS NULL OR source = @source)
           AND (@occurredAfter IS NULL OR occurred_at >= @occurredAfter)
           AND (@occurredBefore IS NULL OR occurred_at <= @occurredBefore)
           AND (@typePrefix IS NULL OR type LIKE @typePrefix)
         ORDER BY sequence ASC, id ASC
         LIMIT @fetchLimit`,
      )
      .all({
        sessionId,
        sequence: cursor.sequence,
        id: cursor.id,
        type: options.type ?? null,
        source: options.source ?? null,
        occurredAfter: options.occurredAfter ?? null,
        occurredBefore: options.occurredBefore ?? null,
        typePrefix:
          options.typePrefix === undefined ? null : `${options.typePrefix}%`,
        fetchLimit: limit + 1,
      }) as EventRow[];
    const hasMore = rows.length > limit;
    const visibleRows = hasMore ? rows.slice(0, limit) : rows;
    const events = visibleRows.map(parseEventRow);
    const last = events.at(-1);

    return {
      events,
      ...(hasMore && last !== undefined
        ? { nextCursor: encodeCursor({ sequence: last.sequence, id: last.id }) }
        : {}),
    };
  }

  listAfterSequence(
    sessionId: string,
    afterSequence: number,
    limit = 100,
  ): TekrionEvent[] {
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
      throw new RangeError(
        "Event sequence cursor must be a non-negative integer.",
      );
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      throw new RangeError("Live event batch size must be between 1 and 1000.");
    }
    const rows = this.database
      .prepare(
        `SELECT record_json
         FROM events
         WHERE session_id = ? AND sequence > ?
         ORDER BY sequence ASC, id ASC
         LIMIT ?`,
      )
      .all(sessionId, afterSequence, limit) as EventRow[];
    return rows.map(parseEventRow);
  }

  listThroughSequence(
    sessionId: string,
    throughSequence: number,
    limit = 5_000,
  ): EventAnalysisWindow {
    if (!Number.isSafeInteger(throughSequence) || throughSequence < 1) {
      throw new RangeError(
        "Analysis event sequence must be a positive integer.",
      );
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
      throw new RangeError(
        "Analysis event window must contain between 1 and 10000 events.",
      );
    }
    const rows = this.database
      .prepare(
        `SELECT record_json
         FROM events
         WHERE session_id = ? AND sequence <= ?
         ORDER BY sequence DESC, id DESC
         LIMIT ?`,
      )
      .all(sessionId, throughSequence, limit + 1) as EventRow[];
    const truncated = rows.length > limit;
    const visible = (truncated ? rows.slice(0, limit) : rows)
      .map(parseEventRow)
      .reverse();
    return { events: visible, truncated };
  }

  search(sessionId: string, query: string, limit = 50): TekrionEvent[] {
    const rows = this.database
      .prepare(
        `SELECT events.record_json
         FROM event_search
         JOIN events ON events.id = event_search.event_id
         WHERE event_search MATCH ? AND event_search.session_id = ?
         ORDER BY bm25(event_search), events.sequence
         LIMIT ?`,
      )
      .all(query, sessionId, Math.max(1, Math.min(limit, 200))) as EventRow[];
    return rows.map(parseEventRow);
  }

  rebuildSearchIndex(): number {
    return this.database.transaction(() => {
      this.database.exec("DELETE FROM event_search");
      const rows = this.database
        .prepare("SELECT id, session_id, type, summary_json FROM events")
        .all() as Array<{
        id: string;
        session_id: string;
        type: string;
        summary_json: string;
      }>;
      const insert = this.database.prepare(
        "INSERT INTO event_search(event_id, session_id, type, text) VALUES (?, ?, ?, ?)",
      );

      for (const row of rows) {
        insert.run(row.id, row.session_id, row.type, row.summary_json);
      }

      return rows.length;
    })();
  }

  private insertRow(
    event: TekrionEvent,
    origin: {
      readonly rawExchangeId?: string;
      readonly normalizationVersion?: string;
    },
    now: string,
  ): void {
    this.database
      .prepare(
        `INSERT INTO events(
           id, session_id, raw_exchange_id, normalization_version, parent_id,
           correlation_id, sequence, occurred_at, observed_at, duration_ms,
           source, type, evidence, schema_version, payload_blob_id,
           summary_json, redaction_json, record_json, created_at
         ) VALUES (
           @id, @sessionId, @rawExchangeId, @normalizationVersion, @parentId,
           @correlationId, @sequence, @occurredAt, @observedAt, @durationMs,
           @source, @type, @evidence, @schemaVersion, @payloadBlobId,
           @summaryJson, @redactionJson, @recordJson, @now
         )`,
      )
      .run({
        id: event.id,
        sessionId: event.sessionId,
        rawExchangeId: origin.rawExchangeId ?? null,
        normalizationVersion: origin.normalizationVersion ?? null,
        parentId: event.parentId ?? null,
        correlationId: event.correlationId ?? null,
        sequence: event.sequence,
        occurredAt: event.occurredAt,
        observedAt: event.observedAt,
        durationMs: event.durationMs ?? null,
        source: event.source,
        type: event.type,
        evidence: event.evidence,
        schemaVersion: event.schemaVersion,
        payloadBlobId: event.payloadRef?.id ?? null,
        summaryJson: JSON.stringify(event.summary),
        redactionJson: JSON.stringify(event.redaction),
        recordJson: JSON.stringify(event),
        now,
      });
    this.database
      .prepare(
        "INSERT INTO event_search(event_id, session_id, type, text) VALUES (?, ?, ?, ?)",
      )
      .run(
        event.id,
        event.sessionId,
        event.type,
        JSON.stringify(event.summary),
      );
    this.database
      .prepare(
        `UPDATE sessions SET
           event_count = event_count + 1,
           error_count = error_count + @errorIncrement,
           updated_at = @now
         WHERE id = @sessionId`,
      )
      .run({
        sessionId: event.sessionId,
        errorIncrement:
          event.type.endsWith(".error") || event.type === "session.crashed"
            ? 1
            : 0,
        now,
      });
    this.database
      .prepare(
        `UPDATE session_sequences
         SET next_sequence = MAX(next_sequence, ?)
         WHERE session_id = ?`,
      )
      .run(event.sequence + 1, event.sessionId);
  }

  private getRawExchange(id: string): RawExchange {
    const row = this.database
      .prepare("SELECT record_json FROM raw_exchanges WHERE id = ?")
      .get(id) as RawRecordRow | undefined;
    if (row === undefined) {
      throw new ImmutableEvidenceError(`Raw exchange ${id} does not exist.`);
    }
    return RawExchangeSchema.parse(JSON.parse(row.record_json));
  }

  private getNormalizationRow(
    exchangeId: string,
    parserVersion: string,
  ): NormalizationRow | undefined {
    return this.database
      .prepare(
        `SELECT request_sha256, response_sha256, event_ids_json
         FROM normalization_runs
         WHERE exchange_id = ? AND parser_version = ?`,
      )
      .get(exchangeId, parserVersion) as NormalizationRow | undefined;
  }

  private parseEventIds(value: string): string[] {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (
        !Array.isArray(parsed) ||
        parsed.some((id) => typeof id !== "string" || id.length === 0)
      ) {
        throw new TypeError("event ID list is invalid");
      }
      return parsed;
    } catch (error: unknown) {
      throw new StorageIntegrityError(
        "A normalization run contains an invalid event ID list.",
        { cause: error },
      );
    }
  }

  private getStoredEvents(eventIds: readonly string[]): TekrionEvent[] {
    return eventIds.map((eventId) => {
      try {
        const event = this.get(eventId);
        if (event === undefined) {
          throw new Error(`Event ${eventId} is missing.`);
        }
        return event;
      } catch (error: unknown) {
        if (error instanceof StorageIntegrityError) {
          throw error;
        }
        throw new StorageIntegrityError(
          `Normalization event ${eventId} is missing or corrupt.`,
          { cause: error },
        );
      }
    });
  }
}
