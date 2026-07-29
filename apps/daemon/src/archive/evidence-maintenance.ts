import { SessionSchema, type Session } from "@tekrion/protocol";
import {
  type TekrionStorage,
  type BlobGarbageCollectionResult,
} from "@tekrion/storage";

export interface EvidenceUsageSummary {
  readonly logicalBytes: number;
  readonly sessionCount: number;
  readonly blobCount: number;
}

export interface SessionMaintenanceCandidate {
  readonly sessionId: string;
  readonly status: Session["status"];
  readonly startedAt: string;
  readonly logicalBytes: number;
  readonly reasons: readonly (
    "age" | "size" | "linked-internal" | "explicit"
  )[];
}

export interface EvidencePrunePlan {
  readonly current: EvidenceUsageSummary;
  readonly projected: EvidenceUsageSummary;
  readonly satisfied: boolean;
  readonly sessions: readonly SessionMaintenanceCandidate[];
}

export interface EvidencePruneInput {
  readonly olderThanDays?: number;
  readonly maximumBytes?: number;
  readonly now?: Date;
}

export interface EvidenceDeletionResult {
  readonly deletedSessionIds: readonly string[];
  readonly before: EvidenceUsageSummary;
  readonly after: EvidenceUsageSummary;
  readonly garbageCollection: BlobGarbageCollectionResult;
}

interface BlobUsage {
  readonly bytes: number;
  readonly sessionIds: ReadonlySet<string>;
}

interface UsageSnapshot {
  readonly sessions: readonly Session[];
  readonly recordBytes: ReadonlyMap<string, number>;
  readonly blobs: ReadonlyMap<string, BlobUsage>;
}

interface SizeRow {
  readonly session_id: string;
  readonly bytes: number;
}

interface BlobRow {
  readonly blob_id: string;
  readonly session_id: string;
  readonly stored_length: number;
}

function allSessions(storage: TekrionStorage): Session[] {
  const sessions: Session[] = [];
  let cursor: string | undefined;
  do {
    const page = storage.sessions.listPage({
      limit: 1_000,
      includeInternal: true,
      ...(cursor === undefined ? {} : { cursor }),
    });
    sessions.push(...page.sessions);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return sessions.map((session) => SessionSchema.parse(session));
}

function usageSnapshot(storage: TekrionStorage): UsageSnapshot {
  const sessions = allSessions(storage);
  const sizeRows = storage.unsafeDatabase
    .prepare(
      `SELECT session_id, SUM(bytes) AS bytes
       FROM (
         SELECT id AS session_id,
                LENGTH(CAST(record_json AS BLOB)) AS bytes
         FROM sessions
         UNION ALL
         SELECT session_id, LENGTH(CAST(record_json AS BLOB))
         FROM raw_exchanges
         UNION ALL
         SELECT session_id, LENGTH(CAST(record_json AS BLOB))
         FROM events
         UNION ALL
         SELECT events.session_id,
                LENGTH(CAST(file_changes.record_json AS BLOB))
         FROM file_changes
         JOIN events ON events.id = file_changes.event_id
         UNION ALL
         SELECT session_id, LENGTH(CAST(record_json AS BLOB))
         FROM context_edges
         UNION ALL
         SELECT session_id, LENGTH(CAST(record_json AS BLOB))
         FROM analysis_runs
         UNION ALL
         SELECT session_id, LENGTH(CAST(record_json AS BLOB))
         FROM redactions
         UNION ALL
         SELECT raw_exchanges.session_id,
                LENGTH(CAST(normalization_runs.exchange_id AS BLOB)) +
                LENGTH(CAST(normalization_runs.parser_version AS BLOB)) +
                LENGTH(CAST(normalization_runs.event_ids_json AS BLOB)) + 128
         FROM normalization_runs
         JOIN raw_exchanges
           ON raw_exchanges.id = normalization_runs.exchange_id
       )
       GROUP BY session_id`,
    )
    .all() as SizeRow[];
  const recordBytes = new Map(
    sizeRows.map((row) => [row.session_id, row.bytes]),
  );
  const blobRows = storage.unsafeDatabase
    .prepare(
      `SELECT references_.session_id, references_.blob_id, blobs.stored_length
       FROM (
         SELECT session_id, request_blob_id AS blob_id
         FROM raw_exchanges WHERE request_blob_id IS NOT NULL
         UNION
         SELECT session_id, response_blob_id
         FROM raw_exchanges WHERE response_blob_id IS NOT NULL
         UNION
         SELECT session_id, stream_manifest_blob_id
         FROM raw_exchanges WHERE stream_manifest_blob_id IS NOT NULL
         UNION
         SELECT session_id, payload_blob_id
         FROM events WHERE payload_blob_id IS NOT NULL
         UNION
         SELECT events.session_id, file_changes.patch_blob_id
         FROM file_changes
         JOIN events ON events.id = file_changes.event_id
         WHERE file_changes.patch_blob_id IS NOT NULL
         UNION
         SELECT session_id, result_blob_id
         FROM analysis_runs WHERE result_blob_id IS NOT NULL
       ) AS references_
       JOIN blobs ON blobs.id = references_.blob_id
       ORDER BY references_.blob_id, references_.session_id`,
    )
    .all() as BlobRow[];
  const mutableBlobs = new Map<
    string,
    { bytes: number; sessionIds: Set<string> }
  >();
  for (const row of blobRows) {
    const usage = mutableBlobs.get(row.blob_id) ?? {
      bytes: row.stored_length,
      sessionIds: new Set<string>(),
    };
    usage.sessionIds.add(row.session_id);
    mutableBlobs.set(row.blob_id, usage);
  }
  return {
    sessions,
    recordBytes,
    blobs: new Map(
      [...mutableBlobs].map(([id, usage]) => [
        id,
        { bytes: usage.bytes, sessionIds: usage.sessionIds },
      ]),
    ),
  };
}

function summary(
  snapshot: UsageSnapshot,
  removedSessionIds: ReadonlySet<string> = new Set(),
): EvidenceUsageSummary {
  const retainedSessions = snapshot.sessions.filter(
    (session) => !removedSessionIds.has(session.id),
  );
  const recordBytes = retainedSessions.reduce(
    (total, session) => total + (snapshot.recordBytes.get(session.id) ?? 0),
    0,
  );
  const retainedBlobEntries = [...snapshot.blobs.values()].filter((blob) =>
    [...blob.sessionIds].some((sessionId) => !removedSessionIds.has(sessionId)),
  );
  return {
    logicalBytes:
      recordBytes +
      retainedBlobEntries.reduce((total, blob) => total + blob.bytes, 0),
    sessionCount: retainedSessions.length,
    blobCount: retainedBlobEntries.length,
  };
}

function sessionLogicalBytes(
  snapshot: UsageSnapshot,
  sessionId: string,
): number {
  return (
    (snapshot.recordBytes.get(sessionId) ?? 0) +
    [...snapshot.blobs.values()]
      .filter((blob) => blob.sessionIds.has(sessionId))
      .reduce((total, blob) => total + blob.bytes, 0)
  );
}

function linkedInternalSessions(
  sessions: readonly Session[],
  selected: ReadonlySet<string>,
): Session[] {
  return sessions.filter(
    (session) =>
      session.metadata.internalAnalysis === true &&
      typeof session.metadata.analysisTargetSessionId === "string" &&
      selected.has(session.metadata.analysisTargetSessionId),
  );
}

function expandLinkedSessions(
  sessions: readonly Session[],
  selected: Set<string>,
  reasons: Map<string, Set<SessionMaintenanceCandidate["reasons"][number]>>,
): void {
  let changed: boolean;
  do {
    changed = false;
    for (const linked of linkedInternalSessions(sessions, selected)) {
      if (linked.status === "active") {
        throw new RangeError(
          `Linked internal analysis session ${linked.id} is active; retry after it finishes.`,
        );
      }
      if (!selected.has(linked.id)) {
        selected.add(linked.id);
        reasons.set(linked.id, new Set(["linked-internal"]));
        changed = true;
      }
    }
  } while (changed);
}

function candidateList(
  snapshot: UsageSnapshot,
  selected: ReadonlySet<string>,
  reasons: ReadonlyMap<
    string,
    ReadonlySet<SessionMaintenanceCandidate["reasons"][number]>
  >,
): SessionMaintenanceCandidate[] {
  return snapshot.sessions
    .filter((session) => selected.has(session.id))
    .sort(
      (left, right) =>
        Date.parse(left.startedAt) - Date.parse(right.startedAt) ||
        left.id.localeCompare(right.id),
    )
    .map((session) => ({
      sessionId: session.id,
      status: session.status,
      startedAt: session.startedAt,
      logicalBytes: sessionLogicalBytes(snapshot, session.id),
      reasons: [...(reasons.get(session.id) ?? new Set())].sort(),
    }));
}

export function evidenceUsage(storage: TekrionStorage): EvidenceUsageSummary {
  return summary(usageSnapshot(storage));
}

export function planSessionDeletion(
  storage: TekrionStorage,
  sessionId: string,
): EvidencePrunePlan {
  const snapshot = usageSnapshot(storage);
  const session = snapshot.sessions.find((item) => item.id === sessionId);
  if (session === undefined) {
    throw new RangeError(`Session ${sessionId} does not exist.`);
  }
  if (session.status === "active") {
    throw new RangeError(`Active session ${sessionId} cannot be deleted.`);
  }
  const selected = new Set([session.id]);
  const reasons = new Map<
    string,
    Set<SessionMaintenanceCandidate["reasons"][number]>
  >([[session.id, new Set(["explicit"])]]);
  expandLinkedSessions(snapshot.sessions, selected, reasons);
  return {
    current: summary(snapshot),
    projected: summary(snapshot, selected),
    satisfied: true,
    sessions: candidateList(snapshot, selected, reasons),
  };
}

export function planEvidencePrune(
  storage: TekrionStorage,
  input: EvidencePruneInput,
): EvidencePrunePlan {
  if (input.olderThanDays === undefined && input.maximumBytes === undefined) {
    throw new RangeError(
      "A prune plan requires olderThanDays, maximumBytes, or both.",
    );
  }
  if (
    input.olderThanDays !== undefined &&
    (!Number.isFinite(input.olderThanDays) || input.olderThanDays < 0)
  ) {
    throw new RangeError("olderThanDays must be a nonnegative number.");
  }
  if (
    input.maximumBytes !== undefined &&
    (!Number.isSafeInteger(input.maximumBytes) || input.maximumBytes < 0)
  ) {
    throw new RangeError("maximumBytes must be a nonnegative safe integer.");
  }
  const snapshot = usageSnapshot(storage);
  const selected = new Set<string>();
  const reasons = new Map<
    string,
    Set<SessionMaintenanceCandidate["reasons"][number]>
  >();
  const terminal = snapshot.sessions
    .filter((session) => session.status !== "active")
    .sort(
      (left, right) =>
        Date.parse(left.endedAt ?? left.startedAt) -
          Date.parse(right.endedAt ?? right.startedAt) ||
        left.id.localeCompare(right.id),
    );
  if (input.olderThanDays !== undefined) {
    const cutoff =
      (input.now ?? new Date()).getTime() -
      input.olderThanDays * 24 * 60 * 60 * 1_000;
    for (const session of terminal) {
      if (Date.parse(session.endedAt ?? session.startedAt) < cutoff) {
        selected.add(session.id);
        reasons.set(session.id, new Set(["age"]));
      }
    }
    expandLinkedSessions(snapshot.sessions, selected, reasons);
  }
  if (input.maximumBytes !== undefined) {
    for (const session of terminal) {
      if (summary(snapshot, selected).logicalBytes <= input.maximumBytes) {
        break;
      }
      if (!selected.has(session.id)) {
        selected.add(session.id);
        reasons.set(session.id, new Set(["size"]));
        expandLinkedSessions(snapshot.sessions, selected, reasons);
      } else {
        reasons.get(session.id)?.add("size");
      }
    }
  }
  const projected = summary(snapshot, selected);
  return {
    current: summary(snapshot),
    projected,
    satisfied:
      input.maximumBytes === undefined ||
      projected.logicalBytes <= input.maximumBytes,
    sessions: candidateList(snapshot, selected, reasons),
  };
}

export async function executeEvidenceDeletion(
  storage: TekrionStorage,
  plan: EvidencePrunePlan,
): Promise<EvidenceDeletionResult> {
  if (storage.readOnly) {
    throw new RangeError("The evidence store is read-only.");
  }
  const ids = plan.sessions.map((session) => session.sessionId);
  storage.transaction(() => {
    for (const id of ids) {
      const current = storage.sessions.get(id);
      if (current === undefined) {
        throw new RangeError(
          `Session ${id} changed after the deletion preview.`,
        );
      }
      if (current.status === "active") {
        throw new RangeError(
          `Session ${id} became active after the deletion preview.`,
        );
      }
    }
    for (const id of ids) {
      storage.sessions.remove(id);
    }
  });
  const garbageCollection = await storage.blobs.removeUnreferenced();
  return {
    deletedSessionIds: ids,
    before: plan.current,
    after: evidenceUsage(storage),
    garbageCollection,
  };
}
