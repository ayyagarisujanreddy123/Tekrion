import { RawExchangeSchema, type RawExchange } from "@tekrion/protocol";
import type Database from "better-sqlite3";

import { ImmutableEvidenceError } from "./errors.js";

export type RawJournalState = "recording" | "complete" | "recovered";

interface RawExchangeRow {
  readonly record_json: string;
  readonly journal_state: RawJournalState;
}

function parseRow(row: RawExchangeRow): RawExchange {
  return RawExchangeSchema.parse(JSON.parse(row.record_json));
}

function exchangeParameters(
  exchange: RawExchange,
  journalState: RawJournalState,
  now: string,
): Record<string, unknown> {
  return {
    id: exchange.id,
    sessionId: exchange.sessionId,
    sequence: exchange.sequence,
    protocol: exchange.protocol,
    method: exchange.method,
    path: exchange.path,
    queryJson: JSON.stringify(exchange.query),
    requestHeadersJson: JSON.stringify(exchange.requestHeaders),
    requestBlobId: exchange.requestBodyRef?.id ?? null,
    responseStatus: exchange.responseStatus ?? null,
    responseHeadersJson:
      exchange.responseHeaders === undefined
        ? null
        : JSON.stringify(exchange.responseHeaders),
    responseBlobId: exchange.responseBodyRef?.id ?? null,
    streamManifestBlobId: exchange.streamManifestRef?.id ?? null,
    startedAt: exchange.startedAt,
    firstByteAt: exchange.firstByteAt ?? null,
    endedAt: exchange.endedAt ?? null,
    outcome: exchange.outcome,
    parseStatus: exchange.parseStatus,
    journalState,
    recordJson: JSON.stringify(exchange),
    now,
  };
}

function assertImmutableIdentity(
  existing: RawExchange,
  replacement: RawExchange,
): void {
  const identityChanged =
    existing.sessionId !== replacement.sessionId ||
    existing.sequence !== replacement.sequence ||
    existing.method !== replacement.method ||
    existing.path !== replacement.path ||
    existing.protocol !== replacement.protocol ||
    existing.startedAt !== replacement.startedAt ||
    JSON.stringify(existing.query) !== JSON.stringify(replacement.query) ||
    JSON.stringify(existing.requestHeaders) !==
      JSON.stringify(replacement.requestHeaders) ||
    (existing.requestBodyRef !== undefined &&
      JSON.stringify(existing.requestBodyRef) !==
        JSON.stringify(replacement.requestBodyRef));

  if (identityChanged) {
    throw new ImmutableEvidenceError(
      `Raw exchange ${existing.id} request identity cannot be changed during finalization.`,
    );
  }
}

export class RawExchangeRepository {
  constructor(private readonly database: Database.Database) {}

  begin(
    input: RawExchange,
    now: string = new Date().toISOString(),
  ): RawExchange {
    const exchange = RawExchangeSchema.parse(input);

    if (exchange.endedAt !== undefined || exchange.capture.responseComplete) {
      throw new ImmutableEvidenceError(
        "A recording exchange must not already have a completion time or complete response.",
      );
    }

    this.insert(exchange, "recording", now);
    return exchange;
  }

  insertComplete(
    input: RawExchange,
    now: string = new Date().toISOString(),
  ): RawExchange {
    const exchange = RawExchangeSchema.parse(input);

    if (exchange.endedAt === undefined) {
      throw new ImmutableEvidenceError(
        "A complete raw exchange requires an end time.",
      );
    }

    this.insert(exchange, "complete", now);
    return exchange;
  }

  insertArchived(
    input: RawExchange,
    journalState: Exclude<RawJournalState, "recording">,
    now: string = new Date().toISOString(),
  ): RawExchange {
    const exchange = RawExchangeSchema.parse(input);
    if (exchange.endedAt === undefined) {
      throw new ImmutableEvidenceError(
        "An archived raw exchange requires an end time.",
      );
    }
    this.insert(exchange, journalState, now);
    return exchange;
  }

  private insert(
    exchange: RawExchange,
    journalState: RawJournalState,
    now: string,
  ): void {
    this.database
      .prepare(
        `INSERT INTO raw_exchanges(
           id, session_id, sequence, protocol, method, path, query_json,
           request_headers_json, request_blob_id, response_status,
           response_headers_json, response_blob_id, stream_manifest_blob_id,
           started_at, first_byte_at, ended_at, outcome, parse_status,
           journal_state, record_json, created_at, updated_at
         ) VALUES (
           @id, @sessionId, @sequence, @protocol, @method, @path, @queryJson,
           @requestHeadersJson, @requestBlobId, @responseStatus,
           @responseHeadersJson, @responseBlobId, @streamManifestBlobId,
           @startedAt, @firstByteAt, @endedAt, @outcome, @parseStatus,
           @journalState, @recordJson, @now, @now
         )`,
      )
      .run(exchangeParameters(exchange, journalState, now));
  }

  finalize(
    input: RawExchange,
    now: string = new Date().toISOString(),
  ): RawExchange {
    const exchange = RawExchangeSchema.parse(input);
    const existingRow = this.getRow(exchange.id);

    if (existingRow === undefined) {
      throw new ImmutableEvidenceError(
        `Cannot finalize missing raw exchange ${exchange.id}.`,
      );
    }
    if (existingRow.journal_state !== "recording") {
      throw new ImmutableEvidenceError(
        `Raw exchange ${exchange.id} is already ${existingRow.journal_state}.`,
      );
    }
    if (exchange.endedAt === undefined) {
      throw new ImmutableEvidenceError(
        `Final raw exchange ${exchange.id} requires an end time.`,
      );
    }

    assertImmutableIdentity(parseRow(existingRow), exchange);
    const result = this.database
      .prepare(
        `UPDATE raw_exchanges SET
           request_blob_id = @requestBlobId,
           response_status = @responseStatus,
           response_headers_json = @responseHeadersJson,
           response_blob_id = @responseBlobId,
           stream_manifest_blob_id = @streamManifestBlobId,
           first_byte_at = @firstByteAt,
           ended_at = @endedAt,
           outcome = @outcome,
           parse_status = @parseStatus,
           journal_state = @journalState,
           record_json = @recordJson,
           updated_at = @now
         WHERE id = @id AND journal_state = 'recording'`,
      )
      .run(exchangeParameters(exchange, "complete", now));

    if (result.changes !== 1) {
      throw new ImmutableEvidenceError(
        `Raw exchange ${exchange.id} changed during finalization.`,
      );
    }
    return exchange;
  }

  get(id: string): RawExchange | undefined {
    const row = this.getRow(id);
    return row === undefined ? undefined : parseRow(row);
  }

  getRequired(id: string): RawExchange {
    const exchange = this.get(id);
    if (exchange === undefined) {
      throw new ImmutableEvidenceError(`Raw exchange ${id} does not exist.`);
    }
    return exchange;
  }

  getJournalState(id: string): RawJournalState | undefined {
    return this.getRow(id)?.journal_state;
  }

  recoverIncomplete(recoveredAt: string = new Date().toISOString()): string[] {
    const rows = this.database
      .prepare(
        `SELECT record_json, journal_state
         FROM raw_exchanges
         WHERE journal_state = 'recording'
         ORDER BY started_at, id`,
      )
      .all() as RawExchangeRow[];
    const recoveredIds: string[] = [];

    this.database.transaction(() => {
      for (const row of rows) {
        const exchange = parseRow(row);
        const recovered = RawExchangeSchema.parse({
          ...exchange,
          endedAt: exchange.endedAt ?? recoveredAt,
          outcome: "capture-incomplete",
          parseStatus:
            exchange.parseStatus === "pending"
              ? "skipped"
              : exchange.parseStatus,
          capture: {
            ...exchange.capture,
            responseComplete: false,
          },
        });
        const result = this.database
          .prepare(
            `UPDATE raw_exchanges SET
               ended_at = @endedAt,
               outcome = @outcome,
               parse_status = @parseStatus,
               journal_state = 'recovered',
               record_json = @recordJson,
               updated_at = @recoveredAt
             WHERE id = @id AND journal_state = 'recording'`,
          )
          .run({
            id: recovered.id,
            endedAt: recovered.endedAt,
            outcome: recovered.outcome,
            parseStatus: recovered.parseStatus,
            recordJson: JSON.stringify(recovered),
            recoveredAt,
          });

        if (result.changes === 1) {
          recoveredIds.push(recovered.id);
        }
      }
    })();

    return recoveredIds;
  }

  private getRow(id: string): RawExchangeRow | undefined {
    return this.database
      .prepare(
        "SELECT record_json, journal_state FROM raw_exchanges WHERE id = ?",
      )
      .get(id) as RawExchangeRow | undefined;
  }
}
