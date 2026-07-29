import { createHash, randomUUID } from "node:crypto";

import {
  DETERMINISTIC_REPORT_VERSION,
  redactSensitiveValue,
} from "@tekrion/analysis";
import {
  TekrionArchiveImportResultSchema,
  TekrionArchiveManifestSchema,
  TekrionArchiveProfileSchema,
  TekrionArchiveSchema,
  TekrionEventSchema,
  IdentifierSchema,
  IncidentReportResultSchema,
  RawExchangeSchema,
  SessionSchema,
  Sha256Schema,
  type TekrionArchive,
  type TekrionArchiveBlob,
  type TekrionArchiveImportResult,
  type TekrionArchiveProfile,
  type TekrionEvent,
  type BlobReference,
  type IncidentReportResult,
  type RawExchange,
  type Session,
} from "@tekrion/protocol";
import {
  AnalysisRunRecordSchema,
  ContextEdgeRecordSchema,
  FileChangeRecordSchema,
  RedactionRecordSchema,
  type AnalysisRunRecord,
  type TekrionStorage,
  type FileChangeRecord,
} from "@tekrion/storage";
import { z } from "zod";

import {
  TekrionArchiveIntegrityError,
  TekrionArchiveSizeError,
  DEFAULT_MAXIMUM_ARCHIVE_BYTES,
  archiveSha256,
  canonicalJson,
  encodeTekrionArchive,
  materializeArchiveEntries,
  verifyTekrionArchive,
  type TekrionArchiveContentEntry,
  type VerifiedTekrionArchive,
} from "./tkr-integrity.js";

const RECORD_PATHS = {
  session: "records/session.json",
  events: "records/events.jsonl",
  rawExchanges: "records/raw-exchanges.jsonl",
  normalizationRuns: "records/normalization-runs.jsonl",
  fileChanges: "records/file-changes.jsonl",
  contextEdges: "records/context-edges.jsonl",
  analysisRuns: "records/analysis-runs.jsonl",
  redactions: "records/redactions.jsonl",
  reportJson: "report/incident-report.json",
  reportMarkdown: "report/incident-report.md",
} as const;

const REPORT_MEDIA_TYPE = "application/vnd.tekrion.incident-report+json";

const EventOriginSchema = z
  .object({
    rawExchangeId: IdentifierSchema.optional(),
    normalizationVersion: z.string().trim().min(1).max(512).optional(),
  })
  .strict();

const ArchiveEventRecordSchema = z
  .object({
    event: TekrionEventSchema,
    origin: EventOriginSchema,
  })
  .strict();

const ArchiveRawExchangeRecordSchema = z
  .object({
    exchange: RawExchangeSchema,
    journalState: z.enum(["complete", "recovered"]),
  })
  .strict();

const ArchiveNormalizationRunSchema = z
  .object({
    exchangeId: IdentifierSchema,
    parserVersion: z.string().trim().min(1).max(512),
    requestSha256: Sha256Schema.nullable(),
    responseSha256: Sha256Schema.nullable(),
    eventIds: z.array(IdentifierSchema).max(100_000),
    completedAt: z.iso.datetime({ offset: true }),
  })
  .strict();

type ArchiveEventRecord = z.infer<typeof ArchiveEventRecordSchema>;
type ArchiveRawExchangeRecord = z.infer<typeof ArchiveRawExchangeRecordSchema>;

interface RecordJsonRow {
  readonly record_json: string;
}

interface EventRow extends RecordJsonRow {
  readonly raw_exchange_id: string | null;
  readonly normalization_version: string | null;
}

interface RawExchangeRow extends RecordJsonRow {
  readonly journal_state: "recording" | "complete" | "recovered";
}

interface NormalizationRow {
  readonly exchange_id: string;
  readonly parser_version: string;
  readonly request_sha256: string | null;
  readonly response_sha256: string | null;
  readonly event_ids_json: string;
  readonly completed_at: string;
}

interface ArchiveRedactionSummary {
  readonly count: number;
  readonly ruleIds: readonly string[];
}

const PRIVATE_SCOPE_KEYS = new Set([
  "cwd",
  "repoRoot",
  "repositoryRoot",
  "root",
  "workingDirectory",
  "workspaceRoot",
]);

function omitPrivateScope(value: unknown): {
  readonly value: unknown;
  readonly count: number;
} {
  if (Array.isArray(value)) {
    const items = value.map(omitPrivateScope);
    return {
      value: items.map((item) => item.value),
      count: items.reduce((total, item) => total + item.count, 0),
    };
  }
  if (typeof value !== "object" || value === null) {
    return { value, count: 0 };
  }
  let count = 0;
  const entries = Object.entries(value).map(([key, item]) => {
    if (PRIVATE_SCOPE_KEYS.has(key) && typeof item === "string") {
      count += 1;
      return [key, "[OMITTED:archive.private-scope]"];
    }
    const nested = omitPrivateScope(item);
    count += nested.count;
    return [key, nested.value];
  });
  return { value: Object.fromEntries(entries), count };
}

function portableBasename(value: string): string {
  return value.split(/[\\/]/u).filter(Boolean).at(-1) ?? value;
}

class ArchiveRedactionAccumulator {
  private countValue = 0;
  private readonly ruleIdsValue = new Set<string>();

  redact<T>(value: T, scopeId: string, location: string): T {
    return this.redactWithRuleIds(value, scopeId, location).value;
  }

  redactWithRuleIds<T>(
    value: T,
    scopeId: string,
    location: string,
  ): { readonly value: T; readonly ruleIds: readonly string[] } {
    const privateScope = omitPrivateScope(value);
    if (privateScope.count > 0) {
      this.omit("archive.private-scope-omitted", privateScope.count);
    }
    const result = redactSensitiveValue(privateScope.value as T, {
      scopeId,
      location,
    });
    this.countValue += result.redactions.length;
    for (const redaction of result.redactions) {
      this.ruleIdsValue.add(redaction.ruleId);
    }
    return {
      value: result.value,
      ruleIds: [
        ...new Set([
          ...(privateScope.count === 0
            ? []
            : ["archive.private-scope-omitted"]),
          ...result.redactions.map((redaction) => redaction.ruleId),
        ]),
      ].sort(),
    };
  }

  omit(ruleId: string, count: number): void {
    if (count < 1) {
      return;
    }
    this.countValue += count;
    this.ruleIdsValue.add(ruleId);
  }

  summary(): ArchiveRedactionSummary {
    return {
      count: this.countValue,
      ruleIds: [...this.ruleIdsValue].sort(),
    };
  }
}

export class TekrionArchiveConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TekrionArchiveConflictError";
  }
}

export interface ExportTekrionArchiveInput {
  readonly sessionId: string;
  readonly profile?: TekrionArchiveProfile;
  readonly report?: IncidentReportResult;
  readonly exportedAt?: string;
  readonly maximumBytes?: number;
}

export interface ExportedTekrionArchive {
  readonly archive: TekrionArchive;
  readonly bytes: Uint8Array;
}

export interface ImportTekrionArchiveInput {
  readonly bytes: Uint8Array;
  readonly importedAt?: string;
  readonly maximumBytes?: number;
}

function jsonBytes(value: unknown): Uint8Array {
  return Buffer.from(`${canonicalJson(value)}\n`, "utf8");
}

function jsonLinesBytes(values: readonly unknown[]): Uint8Array {
  return Buffer.from(
    values.length === 0
      ? ""
      : `${values.map((value) => canonicalJson(value)).join("\n")}\n`,
    "utf8",
  );
}

function parsedRows<T>(
  rows: readonly RecordJsonRow[],
  schema: { readonly parse: (value: unknown) => T },
): T[] {
  return rows.map((row) => schema.parse(JSON.parse(row.record_json)));
}

function shareSession(
  session: Session,
  redactions: ArchiveRedactionAccumulator,
): Session {
  redactions.omit(
    "archive.private-paths-omitted",
    Number(session.command !== undefined) +
      Number(session.repoRoot !== undefined) +
      Number(session.upstreamOrigin !== undefined),
  );
  return SessionSchema.parse(
    redactions.redact(
      {
        schemaVersion: session.schemaVersion,
        id: session.id,
        startedAt: session.startedAt,
        ...(session.endedAt === undefined ? {} : { endedAt: session.endedAt }),
        status: session.status,
        captureLevel: session.captureLevel,
        ...(session.agentName === undefined
          ? {}
          : { agentName: session.agentName }),
        models: session.models,
        tags: [...new Set([...session.tags, "archive:share"])],
        counts: session.counts,
        metadata: {
          ...session.metadata,
          archiveDisclosure:
            "Command, repository, upstream, raw exchanges, and payload bytes were omitted by the share profile.",
        },
      },
      session.id,
      "$.records.session",
    ),
  );
}

function shareEvent(
  record: ArchiveEventRecord,
  redactions: ArchiveRedactionAccumulator,
): ArchiveEventRecord {
  const event = record.event;
  let summary = event.summary;
  const archiveRuleIds = new Set<string>();
  if (new Set(["process.started", "process.failed"]).has(event.type)) {
    const executable = summary.executable;
    if (typeof executable === "string") {
      const name = portableBasename(executable);
      if (name !== executable) {
        redactions.omit("archive.executable-scope-omitted", 1);
        archiveRuleIds.add("archive.executable-scope-omitted");
        summary = { ...summary, executable: name };
      }
    }
  }
  if (event.type === "process.started" && Array.isArray(summary.arguments)) {
    if (summary.arguments.length > 0) {
      redactions.omit(
        "archive.command-arguments-omitted",
        summary.arguments.length,
      );
      archiveRuleIds.add("archive.command-arguments-omitted");
      summary = {
        ...summary,
        arguments: ["[OMITTED:archive.command-arguments]"],
      };
    }
  }
  const redactedSummary = redactions.redactWithRuleIds(
    summary,
    event.sessionId,
    `$.records.events[${event.id}].summary`,
  );
  const ruleIds = new Set(event.redaction.ruleIds);
  if (event.payloadRef !== undefined) {
    redactions.omit("archive.payload-omitted", 1);
    ruleIds.add("archive.payload-omitted");
  }
  for (const ruleId of redactedSummary.ruleIds) {
    ruleIds.add(ruleId);
  }
  for (const ruleId of archiveRuleIds) {
    ruleIds.add(ruleId);
  }
  return {
    event: TekrionEventSchema.parse({
      schemaVersion: event.schemaVersion,
      id: event.id,
      sessionId: event.sessionId,
      ...(event.parentId === undefined ? {} : { parentId: event.parentId }),
      ...(event.correlationId === undefined
        ? {}
        : { correlationId: event.correlationId }),
      sequence: event.sequence,
      occurredAt: event.occurredAt,
      observedAt: event.observedAt,
      ...(event.durationMs === undefined
        ? {}
        : { durationMs: event.durationMs }),
      source: event.source,
      type: event.type,
      evidence: event.evidence,
      summary: redactedSummary.value,
      redaction: {
        applied: ruleIds.size > 0,
        ruleIds: [...ruleIds].sort(),
      },
    }),
    origin: {},
  };
}

function shareFileChange(
  record: FileChangeRecord,
  sessionId: string,
  redactions: ArchiveRedactionAccumulator,
): FileChangeRecord {
  if (record.patchBlobId !== undefined) {
    redactions.omit("archive.payload-omitted", 1);
  }
  return FileChangeRecordSchema.parse(
    redactions.redact(
      {
        schemaVersion: record.schemaVersion,
        eventId: record.eventId,
        path: record.path,
        operation: record.operation,
        ...(record.previousPath === undefined
          ? {}
          : { previousPath: record.previousPath }),
        ...(record.beforeHash === undefined
          ? {}
          : { beforeHash: record.beforeHash }),
        ...(record.afterHash === undefined
          ? {}
          : { afterHash: record.afterHash }),
        timingPrecision: record.timingPrecision,
        sensitivity: record.sensitivity,
      },
      sessionId,
      `$.records.fileChanges[${record.eventId}]`,
    ),
  );
}

function referencedBlobIds(input: {
  readonly rawExchanges: readonly ArchiveRawExchangeRecord[];
  readonly events: readonly ArchiveEventRecord[];
  readonly fileChanges: readonly FileChangeRecord[];
  readonly analysisRuns: readonly AnalysisRunRecord[];
}): string[] {
  return [
    ...input.rawExchanges.flatMap(({ exchange }) => [
      ...(exchange.requestBodyRef === undefined
        ? []
        : [exchange.requestBodyRef.id]),
      ...(exchange.responseBodyRef === undefined
        ? []
        : [exchange.responseBodyRef.id]),
      ...(exchange.streamManifestRef === undefined
        ? []
        : [exchange.streamManifestRef.id]),
    ]),
    ...input.events.flatMap(({ event }) =>
      event.payloadRef === undefined ? [] : [event.payloadRef.id],
    ),
    ...input.fileChanges.flatMap((record) =>
      record.patchBlobId === undefined ? [] : [record.patchBlobId],
    ),
    ...input.analysisRuns.flatMap((record) =>
      record.resultBlobId === undefined ? [] : [record.resultBlobId],
    ),
  ].filter((id, index, all) => all.indexOf(id) === index);
}

function reportAnalysisRunId(
  sessionId: string,
  targetEventId?: string,
): string {
  const digest = createHash("sha256")
    .update(
      `${sessionId}\u0000${targetEventId ?? "session"}\u0000${DETERMINISTIC_REPORT_VERSION}`,
    )
    .digest("hex");
  return `analysis-report-${digest}`;
}

export async function exportTekrionArchive(
  storage: TekrionStorage,
  input: ExportTekrionArchiveInput,
): Promise<ExportedTekrionArchive> {
  const sessionId = IdentifierSchema.parse(input.sessionId);
  const profile = TekrionArchiveProfileSchema.parse(input.profile ?? "share");
  const session = storage.sessions.getRequired(sessionId);
  if (session.status === "active") {
    throw new RangeError(
      `Active session ${session.id} must finish before it can be exported.`,
    );
  }
  if (
    input.report !== undefined &&
    input.report.report.sessionId !== session.id
  ) {
    throw new RangeError("The exported report belongs to another session.");
  }
  const eventRows = storage.unsafeDatabase
    .prepare(
      `SELECT record_json, raw_exchange_id, normalization_version
       FROM events WHERE session_id = ? ORDER BY sequence, id`,
    )
    .all(session.id) as EventRow[];
  const sourceEvents = eventRows.map((row) =>
    ArchiveEventRecordSchema.parse({
      event: JSON.parse(row.record_json),
      origin: {
        ...(row.raw_exchange_id === null
          ? {}
          : { rawExchangeId: row.raw_exchange_id }),
        ...(row.normalization_version === null
          ? {}
          : { normalizationVersion: row.normalization_version }),
      },
    }),
  );
  const rawRows = storage.unsafeDatabase
    .prepare(
      `SELECT record_json, journal_state
       FROM raw_exchanges WHERE session_id = ? ORDER BY sequence, id`,
    )
    .all(session.id) as RawExchangeRow[];
  if (rawRows.some((row) => row.journal_state === "recording")) {
    throw new RangeError(
      "A terminal session contains an unfinished raw exchange and cannot be exported safely.",
    );
  }
  const sourceRawExchanges = rawRows.map((row) =>
    ArchiveRawExchangeRecordSchema.parse({
      exchange: JSON.parse(row.record_json),
      journalState: row.journal_state,
    }),
  );
  const sourceNormalizations = (
    storage.unsafeDatabase
      .prepare(
        `SELECT normalization_runs.exchange_id,
                normalization_runs.parser_version,
                normalization_runs.request_sha256,
                normalization_runs.response_sha256,
                normalization_runs.event_ids_json,
                normalization_runs.completed_at
         FROM normalization_runs
         JOIN raw_exchanges
           ON raw_exchanges.id = normalization_runs.exchange_id
         WHERE raw_exchanges.session_id = ?
         ORDER BY normalization_runs.exchange_id,
                  normalization_runs.parser_version`,
      )
      .all(session.id) as NormalizationRow[]
  ).map((row) =>
    ArchiveNormalizationRunSchema.parse({
      exchangeId: row.exchange_id,
      parserVersion: row.parser_version,
      requestSha256: row.request_sha256,
      responseSha256: row.response_sha256,
      eventIds: JSON.parse(row.event_ids_json),
      completedAt: row.completed_at,
    }),
  );
  const sourceFileChanges = parsedRows(
    storage.unsafeDatabase
      .prepare(
        `SELECT file_changes.record_json
         FROM file_changes
         JOIN events ON events.id = file_changes.event_id
         WHERE events.session_id = ?
         ORDER BY events.sequence, file_changes.event_id`,
      )
      .all(session.id) as RecordJsonRow[],
    FileChangeRecordSchema,
  );
  const sourceContextEdges = parsedRows(
    storage.unsafeDatabase
      .prepare(
        `SELECT record_json FROM context_edges
         WHERE session_id = ?
         ORDER BY from_event_id, to_event_id, edge_type`,
      )
      .all(session.id) as RecordJsonRow[],
    ContextEdgeRecordSchema,
  );
  const sourceAnalysisRuns = parsedRows(
    storage.unsafeDatabase
      .prepare(
        `SELECT record_json FROM analysis_runs
         WHERE session_id = ? ORDER BY started_at, id`,
      )
      .all(session.id) as RecordJsonRow[],
    AnalysisRunRecordSchema,
  );
  const sourceRedactions = parsedRows(
    storage.unsafeDatabase
      .prepare(
        `SELECT record_json FROM redactions
         WHERE session_id = ? ORDER BY id`,
      )
      .all(session.id) as RecordJsonRow[],
    RedactionRecordSchema,
  );

  const exportRedactions = new ArchiveRedactionAccumulator();
  const exportedSession =
    profile === "share" ? shareSession(session, exportRedactions) : session;
  const events =
    profile === "share"
      ? sourceEvents.map((record) => shareEvent(record, exportRedactions))
      : sourceEvents;
  const rawExchanges = profile === "share" ? [] : sourceRawExchanges;
  const normalizationRuns = profile === "share" ? [] : sourceNormalizations;
  const fileChanges =
    profile === "share"
      ? sourceFileChanges.map((record) =>
          shareFileChange(record, session.id, exportRedactions),
        )
      : sourceFileChanges;
  const contextEdges =
    profile === "share"
      ? sourceContextEdges.map((record, index) =>
          ContextEdgeRecordSchema.parse(
            exportRedactions.redact(
              record,
              session.id,
              `$.records.contextEdges[${index}]`,
            ),
          ),
        )
      : sourceContextEdges;
  const analysisRuns = profile === "share" ? [] : sourceAnalysisRuns;
  const storedRedactions = profile === "share" ? [] : sourceRedactions;
  if (profile === "share") {
    exportRedactions.omit(
      "archive.raw-evidence-omitted",
      sourceRawExchanges.length +
        sourceNormalizations.length +
        sourceAnalysisRuns.length +
        sourceRedactions.length,
    );
  }
  const report =
    input.report === undefined
      ? undefined
      : profile === "share"
        ? IncidentReportResultSchema.parse(
            exportRedactions.redact(input.report, session.id, "$.report"),
          )
        : input.report;

  const entries: TekrionArchiveContentEntry[] = [
    {
      path: RECORD_PATHS.session,
      mediaType: "application/json",
      bytes: jsonBytes(exportedSession),
    },
    {
      path: RECORD_PATHS.events,
      mediaType: "application/x-ndjson",
      bytes: jsonLinesBytes(events),
    },
    {
      path: RECORD_PATHS.rawExchanges,
      mediaType: "application/x-ndjson",
      bytes: jsonLinesBytes(rawExchanges),
    },
    {
      path: RECORD_PATHS.normalizationRuns,
      mediaType: "application/x-ndjson",
      bytes: jsonLinesBytes(normalizationRuns),
    },
    {
      path: RECORD_PATHS.fileChanges,
      mediaType: "application/x-ndjson",
      bytes: jsonLinesBytes(fileChanges),
    },
    {
      path: RECORD_PATHS.contextEdges,
      mediaType: "application/x-ndjson",
      bytes: jsonLinesBytes(contextEdges),
    },
    {
      path: RECORD_PATHS.analysisRuns,
      mediaType: "application/x-ndjson",
      bytes: jsonLinesBytes(analysisRuns),
    },
    {
      path: RECORD_PATHS.redactions,
      mediaType: "application/x-ndjson",
      bytes: jsonLinesBytes(storedRedactions),
    },
    ...(report === undefined
      ? []
      : [
          {
            path: RECORD_PATHS.reportJson,
            mediaType: REPORT_MEDIA_TYPE,
            bytes: jsonBytes(report),
          },
          {
            path: RECORD_PATHS.reportMarkdown,
            mediaType: "text/markdown; charset=utf-8",
            bytes: Buffer.from(report.markdown, "utf8"),
          },
        ]),
  ];
  const blobManifest: TekrionArchiveBlob[] = [];
  if (profile === "forensic") {
    const blobIds = referencedBlobIds({
      rawExchanges,
      events,
      fileChanges,
      analysisRuns,
    }).sort();
    for (const blobId of blobIds) {
      const reference = storage.blobs.describe(blobId);
      if (reference === undefined) {
        throw new TekrionArchiveIntegrityError(
          `Referenced blob ${blobId} is unavailable for export.`,
        );
      }
      const path = `blobs/${reference.sha256}.bin`;
      const bytes = await storage.blobs.get(reference.id);
      entries.push({ path, mediaType: reference.mediaType, bytes });
      blobManifest.push({ entryPath: path, reference });
    }
  }
  const materialized = materializeArchiveEntries(entries);
  const maximumBytes = input.maximumBytes ?? DEFAULT_MAXIMUM_ARCHIVE_BYTES;
  if (materialized.totalBytes > maximumBytes) {
    throw new TekrionArchiveSizeError(maximumBytes);
  }
  const redaction = exportRedactions.summary();
  const manifest = TekrionArchiveManifestSchema.parse({
    schemaVersion: 1,
    format: "tekrion-tkr",
    archiveId: `archive-${randomUUID()}`,
    exportedAt: input.exportedAt ?? new Date().toISOString(),
    profile,
    sourceSessionId: session.id,
    sourceSessionStatus: session.status,
    storageSchemaVersion: storage.schemaVersion,
    entries: materialized.descriptors,
    blobs: blobManifest.sort((left, right) =>
      left.entryPath < right.entryPath
        ? -1
        : left.entryPath > right.entryPath
          ? 1
          : 0,
    ),
    counts: {
      sessions: 1,
      events: events.length,
      rawExchanges: rawExchanges.length,
      normalizationRuns: normalizationRuns.length,
      fileChanges: fileChanges.length,
      contextEdges: contextEdges.length,
      analysisRuns: analysisRuns.length,
      redactions: storedRedactions.length,
      blobs: blobManifest.length,
      reports: report === undefined ? 0 : 1,
    },
    totalBytes: materialized.totalBytes,
    redaction: {
      applied: redaction.count > 0,
      count: redaction.count,
      ruleIds: redaction.ruleIds,
    },
    warnings:
      profile === "share"
        ? [
            "Share archives omit raw exchanges and payload bytes and redact recognized secrets; review the report before redistribution.",
          ]
        : [
            "Forensic archives can contain source code, prompts, outputs, paths, and other sensitive evidence.",
          ],
  });
  const archive = TekrionArchiveSchema.parse({
    schemaVersion: 1,
    manifest,
    manifestSha256: archiveSha256(canonicalJson(manifest)),
    entries: materialized.payloads,
  });
  const bytes = encodeTekrionArchive(archive);
  if (bytes.byteLength > maximumBytes) {
    throw new TekrionArchiveSizeError(maximumBytes);
  }
  verifyTekrionArchive(bytes, maximumBytes);
  return { archive, bytes };
}

function utf8Entry(verified: VerifiedTekrionArchive, path: string): string {
  const bytes = verified.entries.get(path);
  if (bytes === undefined) {
    throw new TekrionArchiveIntegrityError(
      `Required TKR archive entry ${path} is missing.`,
    );
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error: unknown) {
    throw new TekrionArchiveIntegrityError(
      `Archive entry ${path} is not valid UTF-8.`,
      { cause: error },
    );
  }
}

function jsonEntry<T>(
  verified: VerifiedTekrionArchive,
  path: string,
  schema: { readonly parse: (value: unknown) => T },
): T {
  try {
    return schema.parse(JSON.parse(utf8Entry(verified, path)));
  } catch (error: unknown) {
    throw new TekrionArchiveIntegrityError(
      `Archive entry ${path} contains an invalid record.`,
      { cause: error },
    );
  }
}

function jsonLinesEntry<T>(
  verified: VerifiedTekrionArchive,
  path: string,
  schema: { readonly parse: (value: unknown) => T },
): T[] {
  const text = utf8Entry(verified, path);
  if (text.length === 0) {
    return [];
  }
  if (!text.endsWith("\n")) {
    throw new TekrionArchiveIntegrityError(
      `Archive JSONL entry ${path} must end with a newline.`,
    );
  }
  return text
    .slice(0, -1)
    .split("\n")
    .map((line, index) => {
      try {
        return schema.parse(JSON.parse(line));
      } catch (error: unknown) {
        throw new TekrionArchiveIntegrityError(
          `Archive entry ${path} has an invalid record at line ${index + 1}.`,
          { cause: error },
        );
      }
    });
}

function assertCount(name: string, actual: number, expected: number): void {
  if (actual !== expected) {
    throw new TekrionArchiveIntegrityError(
      `Archive ${name} count ${actual} does not match manifest count ${expected}.`,
    );
  }
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw new TekrionArchiveIntegrityError(
      `Archive ${label} identifiers must be unique.`,
    );
  }
}

function assertNoIdentifierConflicts(
  storage: TekrionStorage,
  table: "events" | "raw_exchanges" | "analysis_runs" | "redactions",
  ids: readonly string[],
): void {
  const uniqueIds = [...new Set(ids)];
  for (let offset = 0; offset < uniqueIds.length; offset += 500) {
    const batch = uniqueIds.slice(offset, offset + 500);
    if (batch.length === 0) {
      continue;
    }
    const placeholders = batch.map(() => "?").join(",");
    const conflict = storage.unsafeDatabase
      .prepare(`SELECT id FROM ${table} WHERE id IN (${placeholders}) LIMIT 1`)
      .get(...batch) as { id: string } | undefined;
    if (conflict !== undefined) {
      throw new TekrionArchiveConflictError(
        `Archive record ${conflict.id} already exists; no data was overwritten.`,
      );
    }
  }
}

function referencesFromRaw(exchange: RawExchange): BlobReference[] {
  return [
    ...(exchange.requestBodyRef === undefined ? [] : [exchange.requestBodyRef]),
    ...(exchange.responseBodyRef === undefined
      ? []
      : [exchange.responseBodyRef]),
    ...(exchange.streamManifestRef === undefined
      ? []
      : [exchange.streamManifestRef]),
  ];
}

function importedRawExchange(
  exchange: RawExchange,
  blobs: ReadonlyMap<string, BlobReference>,
): RawExchange {
  const value: Record<string, unknown> = { ...exchange };
  for (const [name, reference] of [
    ["requestBodyRef", exchange.requestBodyRef],
    ["responseBodyRef", exchange.responseBodyRef],
    ["streamManifestRef", exchange.streamManifestRef],
  ] as const) {
    if (reference === undefined) {
      delete value[name];
    } else {
      value[name] = blobs.get(reference.id);
    }
  }
  return RawExchangeSchema.parse(value);
}

function importedEvent(
  event: TekrionEvent,
  blobs: ReadonlyMap<string, BlobReference>,
): TekrionEvent {
  if (event.payloadRef === undefined) {
    return event;
  }
  return TekrionEventSchema.parse({
    ...event,
    payloadRef: blobs.get(event.payloadRef.id),
  });
}

export async function importTekrionArchive(
  storage: TekrionStorage,
  input: ImportTekrionArchiveInput,
): Promise<TekrionArchiveImportResult> {
  if (storage.readOnly) {
    throw new TekrionArchiveConflictError(
      "The destination evidence store is read-only.",
    );
  }
  const maximumBytes = input.maximumBytes ?? DEFAULT_MAXIMUM_ARCHIVE_BYTES;
  const verified = verifyTekrionArchive(input.bytes, maximumBytes);
  const manifest = verified.archive.manifest;
  const session = jsonEntry(verified, RECORD_PATHS.session, SessionSchema);
  const eventRecords = jsonLinesEntry(
    verified,
    RECORD_PATHS.events,
    ArchiveEventRecordSchema,
  );
  const rawExchangeRecords = jsonLinesEntry(
    verified,
    RECORD_PATHS.rawExchanges,
    ArchiveRawExchangeRecordSchema,
  );
  const normalizationRuns = jsonLinesEntry(
    verified,
    RECORD_PATHS.normalizationRuns,
    ArchiveNormalizationRunSchema,
  );
  const fileChanges = jsonLinesEntry(
    verified,
    RECORD_PATHS.fileChanges,
    FileChangeRecordSchema,
  );
  const contextEdges = jsonLinesEntry(
    verified,
    RECORD_PATHS.contextEdges,
    ContextEdgeRecordSchema,
  );
  const analysisRuns = jsonLinesEntry(
    verified,
    RECORD_PATHS.analysisRuns,
    AnalysisRunRecordSchema,
  );
  const redactions = jsonLinesEntry(
    verified,
    RECORD_PATHS.redactions,
    RedactionRecordSchema,
  );
  const report =
    manifest.counts.reports === 0
      ? undefined
      : jsonEntry(
          verified,
          RECORD_PATHS.reportJson,
          IncidentReportResultSchema,
        );
  if (
    report !== undefined &&
    utf8Entry(verified, RECORD_PATHS.reportMarkdown) !== report.markdown
  ) {
    throw new TekrionArchiveIntegrityError(
      "The archived Markdown report does not match the JSON report.",
    );
  }
  assertCount("event", eventRecords.length, manifest.counts.events);
  assertCount(
    "raw exchange",
    rawExchangeRecords.length,
    manifest.counts.rawExchanges,
  );
  assertCount(
    "normalization run",
    normalizationRuns.length,
    manifest.counts.normalizationRuns,
  );
  assertCount("file change", fileChanges.length, manifest.counts.fileChanges);
  assertCount(
    "context edge",
    contextEdges.length,
    manifest.counts.contextEdges,
  );
  assertCount(
    "analysis run",
    analysisRuns.length,
    manifest.counts.analysisRuns,
  );
  assertCount("redaction", redactions.length, manifest.counts.redactions);
  const allowedPaths = new Set([
    RECORD_PATHS.session,
    RECORD_PATHS.events,
    RECORD_PATHS.rawExchanges,
    RECORD_PATHS.normalizationRuns,
    RECORD_PATHS.fileChanges,
    RECORD_PATHS.contextEdges,
    RECORD_PATHS.analysisRuns,
    RECORD_PATHS.redactions,
    ...(report === undefined
      ? []
      : [RECORD_PATHS.reportJson, RECORD_PATHS.reportMarkdown]),
    ...manifest.blobs.map((blob) => blob.entryPath),
  ]);
  if (
    verified.archive.entries.some((entry) => !allowedPaths.has(entry.path)) ||
    allowedPaths.size !== verified.archive.entries.length
  ) {
    throw new TekrionArchiveIntegrityError(
      "The TKR archive contains missing or unexpected entries.",
    );
  }
  if (
    manifest.sourceSessionId !== session.id ||
    manifest.sourceSessionStatus !== session.status
  ) {
    throw new TekrionArchiveIntegrityError(
      "The archive source session identity does not match its manifest.",
    );
  }
  if (session.counts.events !== eventRecords.length) {
    throw new TekrionArchiveIntegrityError(
      "The archived session event count does not match its event records.",
    );
  }
  if (session.status === "active") {
    throw new TekrionArchiveIntegrityError(
      "Active sessions cannot be imported from a TKR archive.",
    );
  }
  if (report !== undefined && report.report.sessionId !== session.id) {
    throw new TekrionArchiveIntegrityError(
      "The archived incident report belongs to another session.",
    );
  }
  if (
    manifest.profile === "share" &&
    (rawExchangeRecords.length > 0 ||
      normalizationRuns.length > 0 ||
      analysisRuns.length > 0 ||
      redactions.length > 0 ||
      manifest.blobs.length > 0)
  ) {
    throw new TekrionArchiveIntegrityError(
      "A share archive must not contain raw exchanges, stored analyses, redaction hashes, or payload blobs.",
    );
  }
  const eventIds = eventRecords.map((record) => record.event.id);
  const eventIdSet = new Set(eventIds);
  const rawIds = rawExchangeRecords.map((record) => record.exchange.id);
  const rawIdSet = new Set(rawIds);
  assertUnique(eventIds, "event");
  assertUnique(
    eventRecords.map((record) => String(record.event.sequence)),
    "event sequence",
  );
  assertUnique(rawIds, "raw exchange");
  assertUnique(
    rawExchangeRecords.map((record) => String(record.exchange.sequence)),
    "raw exchange sequence",
  );
  assertUnique(
    analysisRuns.map((record) => record.id),
    "analysis run",
  );
  assertUnique(
    redactions.map((record) => record.id),
    "redaction",
  );
  if (
    eventRecords.some(
      (record) =>
        record.event.sessionId !== session.id ||
        (record.origin.rawExchangeId !== undefined &&
          !rawIdSet.has(record.origin.rawExchangeId)),
    ) ||
    rawExchangeRecords.some(
      (record) => record.exchange.sessionId !== session.id,
    ) ||
    fileChanges.some((record) => !eventIdSet.has(record.eventId)) ||
    contextEdges.some(
      (record) =>
        record.sessionId !== session.id ||
        !eventIdSet.has(record.fromEventId) ||
        !eventIdSet.has(record.toEventId),
    ) ||
    analysisRuns.some(
      (record) =>
        record.sessionId !== session.id ||
        (record.targetEventId !== undefined &&
          !eventIdSet.has(record.targetEventId)),
    ) ||
    redactions.some((record) => record.sessionId !== session.id) ||
    normalizationRuns.some(
      (record) =>
        !rawIdSet.has(record.exchangeId) ||
        record.eventIds.some((eventId) => !eventIdSet.has(eventId)),
    )
  ) {
    throw new TekrionArchiveIntegrityError(
      "The archive contains a cross-session or missing record relationship.",
    );
  }
  if (storage.sessions.get(session.id) !== undefined) {
    throw new TekrionArchiveConflictError(
      `Session ${session.id} already exists; no data was overwritten.`,
    );
  }
  assertNoIdentifierConflicts(storage, "events", eventIds);
  assertNoIdentifierConflicts(storage, "raw_exchanges", rawIds);
  assertNoIdentifierConflicts(
    storage,
    "analysis_runs",
    analysisRuns.map((record) => record.id),
  );
  assertNoIdentifierConflicts(
    storage,
    "redactions",
    redactions.map((record) => record.id),
  );

  const blobMetadataById = new Map<string, TekrionArchiveBlob>();
  for (const blob of manifest.blobs) {
    if (blobMetadataById.has(blob.reference.id)) {
      throw new TekrionArchiveIntegrityError(
        `Blob ${blob.reference.id} is declared more than once.`,
      );
    }
    blobMetadataById.set(blob.reference.id, blob);
  }
  const requiredReferences = [
    ...rawExchangeRecords.flatMap((record) =>
      referencesFromRaw(record.exchange),
    ),
    ...eventRecords.flatMap((record) =>
      record.event.payloadRef === undefined ? [] : [record.event.payloadRef],
    ),
  ];
  const requiredBlobIds = new Set([
    ...requiredReferences.map((reference) => reference.id),
    ...fileChanges.flatMap((record) =>
      record.patchBlobId === undefined ? [] : [record.patchBlobId],
    ),
    ...analysisRuns.flatMap((record) =>
      record.resultBlobId === undefined ? [] : [record.resultBlobId],
    ),
  ]);
  if (
    [...requiredBlobIds].some((blobId) => !blobMetadataById.has(blobId)) ||
    [...blobMetadataById.keys()].some((blobId) => !requiredBlobIds.has(blobId))
  ) {
    throw new TekrionArchiveIntegrityError(
      "The archive blob manifest does not exactly cover record references.",
    );
  }
  for (const reference of requiredReferences) {
    const declared = blobMetadataById.get(reference.id)?.reference;
    if (
      declared === undefined ||
      canonicalJson(declared) !== canonicalJson(reference)
    ) {
      throw new TekrionArchiveIntegrityError(
        `Record blob reference ${reference.id} conflicts with the blob manifest.`,
      );
    }
  }

  const importedBlobReferences = new Map<string, BlobReference>();
  const createdBlobIds = new Set<string>();
  let reportBlob: BlobReference | undefined;
  const importedAt = input.importedAt ?? new Date().toISOString();
  try {
    for (const blob of manifest.blobs) {
      const bytes = verified.entries.get(blob.entryPath);
      if (bytes === undefined) {
        throw new TekrionArchiveIntegrityError(
          `Archive blob entry ${blob.entryPath} is missing.`,
        );
      }
      const existed = storage.blobs.describe(blob.reference.id) !== undefined;
      const stored = await storage.blobs.put(bytes, {
        mediaType: blob.reference.mediaType,
        truncated: blob.reference.truncated,
      });
      if (
        stored.id !== blob.reference.id ||
        stored.sha256 !== blob.reference.sha256 ||
        stored.byteLength !== blob.reference.byteLength ||
        stored.codec !== blob.reference.codec ||
        stored.mediaType !== blob.reference.mediaType ||
        stored.truncated !== blob.reference.truncated
      ) {
        throw new TekrionArchiveIntegrityError(
          `Imported blob ${blob.reference.id} changed content identity.`,
        );
      }
      if (!existed) {
        createdBlobIds.add(stored.id);
      }
      importedBlobReferences.set(blob.reference.id, stored);
    }
    if (report !== undefined) {
      const serializedReport = JSON.stringify(report);
      const expectedReportBlobId = `blob-${archiveSha256(serializedReport)}`;
      const existed =
        storage.blobs.describe(expectedReportBlobId) !== undefined;
      reportBlob = await storage.blobs.put(serializedReport, {
        mediaType: REPORT_MEDIA_TYPE,
      });
      if (!existed) {
        createdBlobIds.add(reportBlob.id);
      }
    }
    storage.transaction(() => {
      const initialStatus =
        session.status === "imported-readonly" ? "completed" : session.status;
      storage.sessions.create(
        SessionSchema.parse({
          ...session,
          status: initialStatus,
          counts: {
            events: 0,
            errors: 0,
            inputTokens: null,
            outputTokens: null,
          },
        }),
        importedAt,
      );
      for (const record of rawExchangeRecords) {
        storage.rawExchanges.insertArchived(
          importedRawExchange(record.exchange, importedBlobReferences),
          record.journalState,
          importedAt,
        );
      }
      for (const record of eventRecords) {
        storage.events.insert(
          importedEvent(record.event, importedBlobReferences),
          {
            ...(record.origin.rawExchangeId === undefined
              ? {}
              : { rawExchangeId: record.origin.rawExchangeId }),
            ...(record.origin.normalizationVersion === undefined
              ? {}
              : {
                  normalizationVersion: record.origin.normalizationVersion,
                }),
          },
          importedAt,
        );
      }
      const normalizationInsert = storage.unsafeDatabase.prepare(
        `INSERT INTO normalization_runs(
           exchange_id, parser_version, request_sha256, response_sha256,
           event_ids_json, completed_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      );
      for (const record of normalizationRuns) {
        normalizationInsert.run(
          record.exchangeId,
          record.parserVersion,
          record.requestSha256,
          record.responseSha256,
          JSON.stringify(record.eventIds),
          record.completedAt,
        );
      }
      for (const record of fileChanges) {
        storage.fileChanges.insert(record);
      }
      for (const record of contextEdges) {
        storage.contextEdges.insert(record);
      }
      for (const record of analysisRuns) {
        storage.analysisRuns.insert(record);
      }
      for (const record of redactions) {
        storage.redactions.insert(record);
      }
      const targetEventId = report?.report.targetEventId;
      if (report !== undefined && reportBlob !== undefined) {
        const storedReportRun = storage.analysisRuns.insertIfAbsent({
          schemaVersion: 1,
          id: reportAnalysisRunId(session.id, targetEventId),
          sessionId: session.id,
          kind: "report",
          ...(targetEventId === undefined ? {} : { targetEventId }),
          status: "completed",
          analyzer: DETERMINISTIC_REPORT_VERSION,
          startedAt: report.report.generatedAt,
          endedAt: report.report.generatedAt,
          resultBlobId: reportBlob.id,
        }).record;
        if (storedReportRun.resultBlobId !== reportBlob.id) {
          throw new TekrionArchiveIntegrityError(
            "The archived report conflicts with its stored analysis result.",
          );
        }
      }
      const inserted = storage.sessions.getRequired(session.id);
      storage.sessions.replace(
        SessionSchema.parse({
          ...inserted,
          endedAt: session.endedAt ?? importedAt,
          status: "imported-readonly",
          command: session.command,
          repoRoot: session.repoRoot,
          agentName: session.agentName,
          models: session.models,
          upstreamOrigin: session.upstreamOrigin,
          tags: [...new Set([...session.tags, "archive:imported-readonly"])],
          counts: {
            events: inserted.counts.events,
            errors: inserted.counts.errors,
            inputTokens: session.counts.inputTokens,
            outputTokens: session.counts.outputTokens,
          },
          metadata: {
            ...session.metadata,
            importedReadOnly: true,
            importedAt,
            sourceArchiveId: manifest.archiveId,
            sourceArchiveProfile: manifest.profile,
            sourceSessionStatus: manifest.sourceSessionStatus,
          },
        }),
        importedAt,
      );
    });
  } catch (error: unknown) {
    await storage.blobs
      .removeUnreferenced([...createdBlobIds])
      .catch(() => undefined);
    throw error;
  }
  return TekrionArchiveImportResultSchema.parse({
    schemaVersion: 1,
    archiveId: manifest.archiveId,
    sessionId: session.id,
    profile: manifest.profile,
    importedAt,
    readOnly: true,
    eventCount: eventRecords.length,
    blobCount: manifest.blobs.length,
  });
}
