import { createHash, randomUUID } from "node:crypto";

import {
  AI_INCIDENT_NARRATIVE_JSON_SCHEMA,
  DETERMINISTIC_REPORT_VERSION,
  ANOMALY_ANALYZER_VERSION,
  DETERMINISTIC_SCORING_VERSION,
  DeterministicAnalyzer,
  REPORT_AI_INSTRUCTIONS,
  REPORT_PROMPT_VERSION,
  aiEnrichedReportResult,
  deterministicReportResult,
  failedAiReportResult,
  isAnalyzableTarget,
  minimizeReportEvidence,
  normalizedTargetForEvent,
  selectIncidentTarget,
  validateAiNarrativeCitations,
  type AiReportProvider,
  type AnalysisContextWindow,
  type MinimizedReportEvidence,
} from "@tekrion/analysis";
import { ContextReconstructor } from "@tekrion/context";
import {
  BlameAnalysisSchema,
  TekrionEventSchema,
  ContextResultSchema,
  EventDetailSchema,
  EventListQuerySchema,
  EventPageSchema,
  EventSearchQuerySchema,
  EventSearchResultSchema,
  FileChangeListQuerySchema,
  FileChangePageSchema,
  IdentifierSchema,
  IncidentReportResultSchema,
  LiveEventCursorSchema,
  SessionDetailSchema,
  SessionListQuerySchema,
  SessionPageSchema,
  WorkspaceFileChangeSummarySchema,
  type BlobReference,
  type BlameAnalysis,
  type AiReportRequest,
  type EventDetail,
  type EventListQueryInput,
  type EventPage,
  type EventSearchQueryInput,
  type EventSearchResult,
  type FileChangeListQueryInput,
  type FileChangePage,
  type TekrionEvent,
  type ContextResult,
  type IncidentReportResult,
  type ReportAnalysisUsage,
  type ReportPreflight,
  type Session,
  type SessionDetail,
  type SessionListQueryInput,
  type SessionPage,
} from "@tekrion/protocol";
import type { TekrionStorage } from "@tekrion/storage";

const DETERMINISTIC_ANALYZER_ID = `${DETERMINISTIC_SCORING_VERSION}+${ANOMALY_ANALYZER_VERSION}`;
const ANALYSIS_MEDIA_TYPE = "application/vnd.tekrion.blame+json";
const REPORT_MEDIA_TYPE = "application/vnd.tekrion.incident-report+json";
const REPORT_SNAPSHOT_MEDIA_TYPE =
  "application/vnd.tekrion.report-evidence+json";
const AI_OUTPUT_MEDIA_TYPE = "application/vnd.tekrion.ai-report-narrative+json";
const MAXIMUM_ANALYSIS_EVENTS = 5_000;
const MAXIMUM_BLAME_CANDIDATES = 500;
const MAXIMUM_REPORT_EVENTS = 10_000;

export interface EvidenceQueryServiceOptions {
  readonly aiReportProvider?: AiReportProvider;
  readonly now?: () => Date;
}

export class EvidenceQueryNotFoundError extends Error {
  constructor(
    readonly kind: "session" | "event" | "payload",
    readonly id: string,
  ) {
    super(
      `${kind[0]?.toUpperCase() ?? "E"}${kind.slice(1)} ${id} was not found.`,
    );
    this.name = "EvidenceQueryNotFoundError";
  }
}

export class EvidencePayloadTooLargeError extends Error {
  constructor(
    readonly reference: BlobReference,
    readonly maximumBytes: number,
  ) {
    super(
      `Payload ${reference.id} is ${reference.byteLength} bytes; the query limit is ${maximumBytes} bytes.`,
    );
    this.name = "EvidencePayloadTooLargeError";
  }
}

export interface EvidencePayload {
  readonly reference: BlobReference;
  readonly bytes: Uint8Array;
}

interface PreparedReportEvidence {
  readonly deterministic: IncidentReportResult;
  readonly minimized: MinimizedReportEvidence;
  readonly session: Session;
}

function literalFtsQuery(query: string): string {
  return query
    .split(/\s+/u)
    .map((term) => `"${term.replaceAll('"', '""')}"`)
    .join(" AND ");
}

function collectVisibleStrings(value: unknown, output: string[]): void {
  if (typeof value === "string") {
    output.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectVisibleStrings(item, output);
    }
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) {
      collectVisibleStrings(item, output);
    }
  }
}

function blameAnalysisRunId(sessionId: string, targetEventId: string): string {
  const digest = createHash("sha256")
    .update(
      `${sessionId}\u0000${targetEventId}\u0000${DETERMINISTIC_ANALYZER_ID}`,
    )
    .digest("hex");
  return `analysis-blame-${digest}`;
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

function recordId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message
      .replace(/\p{Cc}/gu, " ")
      .replace(/\s+/gu, " ")
      .trim()
      .slice(0, 2_000) || "Unknown AI analysis failure."
  );
}

function normalizedEvidencePath(path: string): string {
  return path.trim().replaceAll("\\", "/").replace(/^\.\//u, "").toLowerCase();
}

function relatedInvocation(
  events: readonly TekrionEvent[],
  target: TekrionEvent,
): TekrionEvent {
  if (target.type === "tool.call") {
    return target;
  }
  const byId = new Map(events.map((event) => [event.id, event]));
  const parent =
    target.parentId === undefined ? undefined : byId.get(target.parentId);
  if (parent?.type === "tool.call") {
    return parent;
  }
  const grandparent =
    parent?.parentId === undefined ? undefined : byId.get(parent.parentId);
  if (grandparent?.type === "tool.call") {
    return grandparent;
  }
  const targetPath = normalizedTargetForEvent(target).path;
  const candidates = events
    .filter(
      (event) => event.type === "tool.call" && event.sequence < target.sequence,
    )
    .map((event) => {
      let score = 0;
      if (
        target.correlationId !== undefined &&
        event.correlationId === target.correlationId
      ) {
        score += 2;
      }
      const candidatePath = normalizedTargetForEvent(event).path;
      if (
        targetPath !== undefined &&
        candidatePath !== undefined &&
        normalizedEvidencePath(candidatePath) ===
          normalizedEvidencePath(targetPath)
      ) {
        score += 1;
      }
      return { event, score };
    })
    .filter((candidate) => candidate.score > 0)
    .sort(
      (left, right) =>
        right.score - left.score || right.event.sequence - left.event.sequence,
    );
  return candidates[0]?.event ?? target;
}

export class EvidenceQueryService {
  private readonly context: ContextReconstructor;
  private readonly analyzer = new DeterministicAnalyzer();

  constructor(
    private readonly storage: TekrionStorage,
    private readonly options: EvidenceQueryServiceOptions = {},
  ) {
    this.context = new ContextReconstructor({
      getEvent: (eventId) => this.storage.events.get(eventId),
      getEventOrigin: (eventId) => this.storage.events.getOrigin(eventId),
      getExchange: (exchangeId) => this.storage.rawExchanges.get(exchangeId),
      getEventsForExchange: (exchangeId) =>
        this.storage.events.listForExchange(exchangeId),
      findResponseEvent: (sessionId, responseId) =>
        this.storage.events.findResponseEvent(sessionId, responseId),
      getPayload: (payloadId) => this.storage.blobs.get(payloadId),
    });
  }

  private now(): Date {
    return (this.options.now ?? (() => new Date()))();
  }

  listSessions(input: SessionListQueryInput = {}): SessionPage {
    const query = SessionListQuerySchema.parse(input);
    const page = this.storage.sessions.listPage({
      limit: query.limit,
      includeInternal: query.includeInternal,
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
    });
    return SessionPageSchema.parse({
      schemaVersion: 1,
      sessions: page.sessions,
      ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
    });
  }

  getSession(sessionId: string): SessionDetail {
    const id = IdentifierSchema.parse(sessionId);
    const session = this.storage.sessions.get(id);
    if (session === undefined) {
      throw new EvidenceQueryNotFoundError("session", id);
    }
    return SessionDetailSchema.parse({ schemaVersion: 1, session });
  }

  listEvents(sessionId: string, input: EventListQueryInput = {}): EventPage {
    const { session } = this.getSession(sessionId);
    const query = EventListQuerySchema.parse(input);
    const page = this.storage.events.list(session.id, {
      limit: query.limit,
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      ...(query.type === undefined ? {} : { type: query.type }),
      ...(query.source === undefined ? {} : { source: query.source }),
      ...(query.occurredAfter === undefined
        ? {}
        : { occurredAfter: query.occurredAfter }),
      ...(query.occurredBefore === undefined
        ? {}
        : { occurredBefore: query.occurredBefore }),
    });
    return EventPageSchema.parse({
      schemaVersion: 1,
      sessionId: session.id,
      events: page.events,
      ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
    });
  }

  getEvent(eventId: string): EventDetail {
    const id = IdentifierSchema.parse(eventId);
    const event = this.storage.events.get(id);
    if (event === undefined) {
      throw new EvidenceQueryNotFoundError("event", id);
    }
    const origin = this.storage.events.getOrigin(id);
    const rawExchange =
      origin?.rawExchangeId === undefined
        ? undefined
        : this.storage.rawExchanges.get(origin.rawExchangeId);
    const parsedChange = event.type.startsWith("file.")
      ? WorkspaceFileChangeSummarySchema.safeParse(event.summary)
      : undefined;
    return EventDetailSchema.parse({
      schemaVersion: 1,
      event,
      ...(parsedChange?.success === true
        ? { fileChange: parsedChange.data }
        : {}),
      ...(rawExchange === undefined ? {} : { rawExchange }),
      ...(origin?.normalizationVersion === undefined
        ? {}
        : { normalizationVersion: origin.normalizationVersion }),
    });
  }

  async getContext(eventId: string): Promise<ContextResult> {
    const { event } = this.getEvent(eventId);
    if (event.type !== "model.request") {
      throw new RangeError(
        "Context is only available for model.request events.",
      );
    }
    return ContextResultSchema.parse(await this.context.reconstruct(event.id));
  }

  async getBlame(eventId: string): Promise<BlameAnalysis> {
    const { event } = this.getEvent(eventId);
    if (!isAnalyzableTarget(event)) {
      throw new RangeError(
        "Blame analysis is only available for tool invocations and file actions.",
      );
    }
    const cached = await this.getCachedBlame(event.sessionId, event.id);
    if (cached !== undefined) {
      return cached;
    }
    const { session } = this.getSession(event.sessionId);
    const window = this.storage.events.listThroughSequence(
      session.id,
      event.sequence,
      MAXIMUM_ANALYSIS_EVENTS,
    );
    const invocation = relatedInvocation(window.events, event);
    const invocationOrigin = this.storage.events.getOrigin(invocation.id);
    const requestEvent =
      invocationOrigin?.rawExchangeId === undefined
        ? invocation.source === "proxy"
          ? [...window.events]
              .reverse()
              .find(
                (candidate) =>
                  candidate.type === "model.request" &&
                  candidate.sequence <= invocation.sequence,
              )
          : undefined
        : this.storage.events
            .listForExchange(invocationOrigin.rawExchangeId)
            .find((candidate) => candidate.type === "model.request");
    let context: AnalysisContextWindow | undefined;
    if (requestEvent !== undefined) {
      try {
        const reconstructed = await this.context.reconstruct(requestEvent.id);
        const visibleTexts: string[] = [];
        for (const item of reconstructed.items) {
          collectVisibleStrings(item.summary, visibleTexts);
        }
        context = {
          completeness: reconstructed.completeness,
          limitationReasons: reconstructed.limitationReasons,
          requestEventId: reconstructed.requestEventId,
          availableEventIds: reconstructed.items.flatMap((item) =>
            item.provenance.eventId === undefined
              ? []
              : [item.provenance.eventId],
          ),
          visibleTexts,
        };
      } catch {
        context = {
          completeness: "unknown-unsupported",
          limitationReasons: [
            "The nearest recorded model request could not be reconstructed for this target.",
          ],
          requestEventId: requestEvent.id,
        };
      }
    }
    const result = this.analyzer.analyze({
      session,
      events: window.events,
      targetEventId: event.id,
      ...(context === undefined ? {} : { context }),
      provenanceEdges: this.storage.contextEdges
        .listForTarget(session.id, event.id)
        .map((edge) => ({
          from: edge.fromEventId,
          to: edge.toEventId,
          relation: edge.edgeType,
        })),
      limitations: window.truncated
        ? [
            `Analysis was bounded to the ${MAXIMUM_ANALYSIS_EVENTS} events nearest the target.`,
          ]
        : [],
      maximumCandidates: MAXIMUM_BLAME_CANDIDATES,
    });
    if (this.storage.readOnly || session.status === "imported-readonly") {
      return result;
    }
    const serialized = JSON.stringify(result);
    const resultBlob = await this.storage.blobs.put(serialized, {
      mediaType: ANALYSIS_MEDIA_TYPE,
    });
    const completedAt = this.now().toISOString();
    const stored = this.storage.analysisRuns.insertIfAbsent({
      schemaVersion: 1,
      id: blameAnalysisRunId(session.id, event.id),
      sessionId: session.id,
      kind: "blame",
      targetEventId: event.id,
      status: "completed",
      analyzer: DETERMINISTIC_ANALYZER_ID,
      startedAt: completedAt,
      endedAt: completedAt,
      resultBlobId: resultBlob.id,
    }).record;
    if (stored.resultBlobId === undefined) {
      throw new Error(
        `Completed analysis run ${stored.id} has no result payload.`,
      );
    }
    if (stored.resultBlobId !== resultBlob.id) {
      return this.readBlameBlob(stored.resultBlobId);
    }
    return result;
  }

  private async getCachedBlame(
    sessionId: string,
    targetEventId: string,
  ): Promise<BlameAnalysis | undefined> {
    const run = this.storage.analysisRuns.findCompleted(
      sessionId,
      "blame",
      targetEventId,
      DETERMINISTIC_ANALYZER_ID,
    );
    return run?.resultBlobId === undefined
      ? undefined
      : this.readBlameBlob(run.resultBlobId);
  }

  private async readBlameBlob(blobId: string): Promise<BlameAnalysis> {
    const bytes = await this.storage.blobs.get(blobId);
    return BlameAnalysisSchema.parse(
      JSON.parse(Buffer.from(bytes).toString("utf8")),
    );
  }

  async getReport(
    sessionId: string,
    targetEventId?: string,
  ): Promise<IncidentReportResult> {
    const { session } = this.getSession(sessionId);
    const window = this.reportEventWindow(session, targetEventId);
    const target = selectIncidentTarget(window.events, targetEventId);
    const cacheReadable = session.status !== "active";
    const cacheWritable = !new Set(["active", "imported-readonly"]).has(
      session.status,
    );
    if (cacheReadable) {
      const cached = await this.getCachedReport(session.id, target?.id);
      if (cached !== undefined) {
        return cached;
      }
    }
    const blame =
      target === undefined ? undefined : await this.getBlame(target.id);
    const result = deterministicReportResult({
      session,
      events: window.events,
      ...(blame === undefined ? {} : { blame }),
      generatedAt: this.now().toISOString(),
      limitations: window.truncated
        ? [
            `Report generation was bounded to the ${MAXIMUM_REPORT_EVENTS} most recent canonical events.`,
          ]
        : [],
    });
    if (this.storage.readOnly || !cacheWritable) {
      return result;
    }
    const resultBlob = await this.storage.blobs.put(JSON.stringify(result), {
      mediaType: REPORT_MEDIA_TYPE,
    });
    const completedAt = this.now().toISOString();
    const stored = this.storage.analysisRuns.insertIfAbsent({
      schemaVersion: 1,
      id: reportAnalysisRunId(session.id, target?.id),
      sessionId: session.id,
      kind: "report",
      ...(target === undefined ? {} : { targetEventId: target.id }),
      status: "completed",
      analyzer: DETERMINISTIC_REPORT_VERSION,
      startedAt: completedAt,
      endedAt: completedAt,
      resultBlobId: resultBlob.id,
    }).record;
    if (stored.resultBlobId === undefined) {
      throw new Error(
        `Completed report run ${stored.id} has no result payload.`,
      );
    }
    return stored.resultBlobId === resultBlob.id
      ? result
      : this.readReportBlob(stored.resultBlobId);
  }

  async getReportPreflight(
    sessionId: string,
    targetEventId?: string,
  ): Promise<ReportPreflight> {
    return (await this.prepareReportEvidence(sessionId, targetEventId))
      .minimized.preflight;
  }

  async generateAiReport(
    sessionId: string,
    request: AiReportRequest,
  ): Promise<IncidentReportResult> {
    if (request.consent !== true) {
      throw new RangeError(
        "AI report generation requires explicit evidence-transmission consent.",
      );
    }
    const prepared = await this.prepareReportEvidence(
      sessionId,
      request.targetEventId,
    );
    const provider = this.options.aiReportProvider;
    const descriptor = this.aiProviderDescriptor();
    const deterministic = prepared.deterministic.report;
    if (
      request.consentFingerprintSha256 !==
      prepared.minimized.preflight.consentFingerprintSha256
    ) {
      throw new RangeError(
        "The report evidence changed after preflight; review the new transmission preview before consenting.",
      );
    }
    if (prepared.session.status === "imported-readonly") {
      return failedAiReportResult({
        deterministic,
        preflight: prepared.minimized.preflight,
        ...descriptor,
        error:
          "AI analysis was not started because imported archive sessions are read-only.",
        externalEvidenceSent: false,
      });
    }
    if (this.storage.readOnly) {
      return failedAiReportResult({
        deterministic,
        preflight: prepared.minimized.preflight,
        ...descriptor,
        error:
          "AI analysis was not started because the evidence store is read-only and the call could not be recorded safely.",
        externalEvidenceSent: false,
      });
    }

    const runId = recordId("analysis-ai-report");
    const startedAt = this.now().toISOString();
    const targetEventId = deterministic.targetEventId;
    this.storage.analysisRuns.insert({
      schemaVersion: 1,
      id: runId,
      sessionId: prepared.session.id,
      kind: "ai-report",
      ...(targetEventId === undefined ? {} : { targetEventId }),
      status: "running",
      analyzer: `${descriptor.provider}:${descriptor.model}`,
      promptVersion: REPORT_PROMPT_VERSION,
      startedAt,
    });

    if (
      provider === undefined ||
      prepared.minimized.preflight.eventCount === 0
    ) {
      const endedAt = this.now().toISOString();
      const failure =
        provider === undefined
          ? "AI analysis is not configured. Set TEKRION_ANALYSIS_API_KEY and TEKRION_ANALYSIS_MODEL before starting the daemon or invoking --ai."
          : "AI analysis was not started because the minimized snapshot contains no citeable event evidence.";
      try {
        this.storage.analysisRuns.replace({
          schemaVersion: 1,
          id: runId,
          sessionId: prepared.session.id,
          kind: "ai-report",
          ...(targetEventId === undefined ? {} : { targetEventId }),
          status: "failed",
          analyzer: `${descriptor.provider}:${descriptor.model}`,
          promptVersion: REPORT_PROMPT_VERSION,
          startedAt,
          endedAt,
          error: failure,
        });
      } catch {
        // The offline report remains usable even if failure bookkeeping cannot finish.
      }
      return failedAiReportResult({
        deterministic,
        preflight: prepared.minimized.preflight,
        ...descriptor,
        error: failure,
        externalEvidenceSent: false,
      });
    }

    let analysisSessionId: string | undefined;
    let externalEvidenceSent = false;
    let responseUsage: ReportAnalysisUsage | undefined;
    let outputBlob: BlobReference | undefined;
    try {
      analysisSessionId = this.startAiAnalysisSession(
        prepared,
        runId,
        startedAt,
      );
      await this.recordAiAnalysisRequest(prepared, analysisSessionId, runId);
      externalEvidenceSent = true;
      const response = await provider.analyze({
        analysisSessionId,
        targetSessionId: prepared.session.id,
        promptVersion: REPORT_PROMPT_VERSION,
        instructions: REPORT_AI_INSTRUCTIONS,
        evidenceSnapshot: prepared.minimized.serialized,
        jsonSchema: AI_INCIDENT_NARRATIVE_JSON_SCHEMA,
      });
      responseUsage = response.usage;
      outputBlob = await this.storage.blobs.put(
        JSON.stringify(response.output),
        { mediaType: AI_OUTPUT_MEDIA_TYPE },
      );
      const narrative = validateAiNarrativeCitations(
        response.output,
        prepared.minimized.snapshot,
      );
      const result = aiEnrichedReportResult({
        deterministic,
        narrative,
        provider: provider.provider,
        model: provider.model,
        promptVersion: REPORT_PROMPT_VERSION,
        analysisSessionId,
        preflight: prepared.minimized.preflight,
        ...(responseUsage === undefined ? {} : { usage: responseUsage }),
      });
      await this.recordAiAnalysisEvent(
        analysisSessionId,
        "analysis.report.completed",
        "inferred",
        {
          provider: provider.provider,
          model: provider.model,
          promptVersion: REPORT_PROMPT_VERSION,
          targetSessionId: prepared.session.id,
          citationValidation: "passed",
          usage: responseUsage ?? {
            inputTokens: null,
            outputTokens: null,
            totalTokens: null,
          },
        },
        outputBlob,
      );
      const resultBlob = await this.storage.blobs.put(JSON.stringify(result), {
        mediaType: REPORT_MEDIA_TYPE,
      });
      const endedAt = this.now().toISOString();
      this.storage.analysisRuns.replace({
        schemaVersion: 1,
        id: runId,
        sessionId: prepared.session.id,
        kind: "ai-report",
        ...(targetEventId === undefined ? {} : { targetEventId }),
        status: "completed",
        analyzer: `${provider.provider}:${provider.model}`,
        promptVersion: REPORT_PROMPT_VERSION,
        startedAt,
        endedAt,
        resultBlobId: resultBlob.id,
      });
      this.finishAiAnalysisSession(
        analysisSessionId,
        "completed",
        endedAt,
        responseUsage,
      );
      return result;
    } catch (error: unknown) {
      const failure = errorMessage(error);
      const endedAt = this.now().toISOString();
      if (analysisSessionId !== undefined) {
        await this.recordAiAnalysisEvent(
          analysisSessionId,
          "analysis.report.error",
          "observed",
          {
            provider: provider.provider,
            model: provider.model,
            promptVersion: REPORT_PROMPT_VERSION,
            targetSessionId: prepared.session.id,
            error: failure,
            externalEvidenceSent,
            ...(responseUsage === undefined ? {} : { usage: responseUsage }),
          },
          outputBlob,
        ).catch(() => undefined);
        try {
          this.finishAiAnalysisSession(
            analysisSessionId,
            "crashed",
            endedAt,
            responseUsage,
          );
        } catch {
          // Preserve the deterministic fallback even if failure bookkeeping is incomplete.
        }
      }
      try {
        this.storage.analysisRuns.replace({
          schemaVersion: 1,
          id: runId,
          sessionId: prepared.session.id,
          kind: "ai-report",
          ...(targetEventId === undefined ? {} : { targetEventId }),
          status: "failed",
          analyzer: `${provider.provider}:${provider.model}`,
          promptVersion: REPORT_PROMPT_VERSION,
          startedAt,
          endedAt,
          error: failure,
        });
      } catch {
        // Preserve the deterministic fallback even if failure bookkeeping is incomplete.
      }
      return failedAiReportResult({
        deterministic,
        preflight: prepared.minimized.preflight,
        provider: provider.provider,
        model: provider.model,
        error: failure,
        externalEvidenceSent,
        ...(analysisSessionId === undefined ? {} : { analysisSessionId }),
        ...(responseUsage === undefined ? {} : { usage: responseUsage }),
      });
    }
  }

  private reportEventWindow(
    session: Session,
    targetEventId?: string,
  ): { readonly events: TekrionEvent[]; readonly truncated: boolean } {
    const recent = this.storage.events.listThroughSequence(
      session.id,
      Number.MAX_SAFE_INTEGER,
      MAXIMUM_REPORT_EVENTS,
    );
    if (
      targetEventId === undefined ||
      recent.events.some((event) => event.id === targetEventId)
    ) {
      return recent;
    }
    const target = this.getEvent(targetEventId).event;
    if (target.sessionId !== session.id) {
      throw new RangeError("The report target belongs to a different session.");
    }
    return this.storage.events.listThroughSequence(
      session.id,
      target.sequence,
      MAXIMUM_REPORT_EVENTS,
    );
  }

  private async prepareReportEvidence(
    sessionId: string,
    targetEventId?: string,
  ): Promise<PreparedReportEvidence> {
    const deterministic = await this.getReport(sessionId, targetEventId);
    const { session } = this.getSession(sessionId);
    const window = this.reportEventWindow(
      session,
      deterministic.report.targetEventId,
    );
    const blame =
      deterministic.report.targetEventId === undefined
        ? undefined
        : await this.getBlame(deterministic.report.targetEventId);
    const descriptor = this.aiProviderDescriptor();
    const minimized = minimizeReportEvidence({
      session,
      events: window.events,
      report: deterministic.report,
      ...(blame === undefined ? {} : { blame }),
      ...descriptor,
      promptVersion: REPORT_PROMPT_VERSION,
    });
    return {
      deterministic,
      minimized,
      session,
    };
  }

  private aiProviderDescriptor(): {
    readonly provider: string;
    readonly model: string;
  } {
    return this.options.aiReportProvider === undefined
      ? { provider: "not-configured", model: "not-configured" }
      : {
          provider: this.options.aiReportProvider.provider,
          model: this.options.aiReportProvider.model,
        };
  }

  private async getCachedReport(
    sessionId: string,
    targetEventId?: string,
  ): Promise<IncidentReportResult | undefined> {
    const run = this.storage.analysisRuns.findCompleted(
      sessionId,
      "report",
      targetEventId,
      DETERMINISTIC_REPORT_VERSION,
    );
    return run?.resultBlobId === undefined
      ? undefined
      : this.readReportBlob(run.resultBlobId);
  }

  private async readReportBlob(blobId: string): Promise<IncidentReportResult> {
    const bytes = await this.storage.blobs.get(blobId);
    return IncidentReportResultSchema.parse(
      JSON.parse(Buffer.from(bytes).toString("utf8")),
    );
  }

  private startAiAnalysisSession(
    prepared: PreparedReportEvidence,
    runId: string,
    startedAt: string,
  ): string {
    const provider = this.options.aiReportProvider;
    if (provider === undefined) {
      throw new Error("AI analysis provider is not configured.");
    }
    const analysisSessionId = recordId("session-analysis-report");
    this.storage.sessions.create({
      schemaVersion: 1,
      id: analysisSessionId,
      startedAt,
      status: "active",
      captureLevel: "api",
      agentName: "tekrion-report-analyzer",
      models: [provider.model],
      tags: ["internal-analysis", "incident-report"],
      counts: {
        events: 0,
        errors: 0,
        inputTokens: null,
        outputTokens: null,
      },
      metadata: {
        internalAnalysis: true,
        analysisTargetSessionId: prepared.session.id,
        analysisRunId: runId,
        provider: provider.provider,
        promptVersion: REPORT_PROMPT_VERSION,
      },
    });
    return analysisSessionId;
  }

  private async recordAiAnalysisRequest(
    prepared: PreparedReportEvidence,
    analysisSessionId: string,
    runId: string,
  ): Promise<void> {
    const provider = this.options.aiReportProvider;
    if (provider === undefined) {
      throw new Error("AI analysis provider is not configured.");
    }
    const snapshotBlob = await this.storage.blobs.put(
      prepared.minimized.serialized,
      { mediaType: REPORT_SNAPSHOT_MEDIA_TYPE },
    );
    for (const redaction of prepared.minimized.redactions) {
      this.storage.redactions.insert({
        schemaVersion: 1,
        id: `redaction-${createHash("sha256")
          .update(`${runId}\u0000${redaction.id}`)
          .digest("hex")}`,
        sessionId: prepared.session.id,
        location: redaction.location,
        ruleId: redaction.ruleId,
        replacement: redaction.replacement,
        hash: redaction.hash,
      });
    }
    await this.recordAiAnalysisEvent(
      analysisSessionId,
      "analysis.report.requested",
      "derived",
      {
        targetSessionId: prepared.session.id,
        targetEventId: prepared.deterministic.report.targetEventId ?? null,
        provider: provider.provider,
        model: provider.model,
        promptVersion: REPORT_PROMPT_VERSION,
        categories: prepared.minimized.preflight.categories,
        totalBytes: prepared.minimized.preflight.totalBytes,
        eventCount: prepared.minimized.preflight.eventCount,
        redactionCount: prepared.minimized.preflight.redactionCount,
        snapshotSha256: prepared.minimized.preflight.snapshotSha256,
      },
      snapshotBlob,
      prepared.minimized.preflight.redactionRuleIds,
    );
  }

  private async recordAiAnalysisEvent(
    sessionId: string,
    type: string,
    evidence: TekrionEvent["evidence"],
    summary: Record<string, unknown>,
    payloadRef?: BlobReference,
    redactionRuleIds: readonly string[] = [],
  ): Promise<void> {
    const sequence = this.storage.sequences.reserve(sessionId)[0];
    if (sequence === undefined) {
      throw new Error(`Could not allocate an event sequence for ${sessionId}.`);
    }
    const timestamp = this.now().toISOString();
    this.storage.events.insert(
      TekrionEventSchema.parse({
        schemaVersion: 1,
        id: recordId("event-analysis-report"),
        sessionId,
        sequence,
        occurredAt: timestamp,
        observedAt: timestamp,
        source: "analysis",
        type,
        evidence,
        ...(payloadRef === undefined ? {} : { payloadRef }),
        summary,
        redaction: {
          applied: redactionRuleIds.length > 0,
          ruleIds: [...redactionRuleIds],
        },
      }),
    );
  }

  private finishAiAnalysisSession(
    sessionId: string,
    status: "completed" | "crashed",
    endedAt: string,
    usage?: {
      readonly inputTokens: number | null;
      readonly outputTokens: number | null;
    },
  ): void {
    const session = this.storage.sessions.getRequired(sessionId);
    this.storage.sessions.replace({
      ...session,
      status,
      endedAt,
      counts: {
        ...session.counts,
        inputTokens: usage?.inputTokens ?? session.counts.inputTokens,
        outputTokens: usage?.outputTokens ?? session.counts.outputTokens,
      },
    });
  }

  listFileChanges(
    sessionId: string,
    input: FileChangeListQueryInput = {},
  ): FileChangePage {
    const { session } = this.getSession(sessionId);
    const query = FileChangeListQuerySchema.parse(input);
    const page = this.storage.events.list(session.id, {
      limit: query.limit,
      source: "filesystem",
      typePrefix: "file.",
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
    });
    return FileChangePageSchema.parse({
      schemaVersion: 1,
      sessionId: session.id,
      changes: page.events.map((event) => {
        const change = WorkspaceFileChangeSummarySchema.safeParse(
          event.summary,
        );
        return { event, change: change.success ? change.data : null };
      }),
      ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
    });
  }

  listEventsAfterSequence(
    sessionId: string,
    afterSequence: number,
    limit: number,
  ): TekrionEvent[] {
    const id = IdentifierSchema.parse(sessionId);
    const cursor = LiveEventCursorSchema.parse(afterSequence);
    return this.storage.events.listAfterSequence(id, cursor, limit);
  }

  searchEvents(
    sessionId: string,
    input: EventSearchQueryInput,
  ): EventSearchResult {
    const { session } = this.getSession(sessionId);
    const query = EventSearchQuerySchema.parse(input);
    return EventSearchResultSchema.parse({
      schemaVersion: 1,
      sessionId: session.id,
      query: query.query,
      events: this.storage.events.search(
        session.id,
        literalFtsQuery(query.query),
        query.limit,
      ),
    });
  }

  async getPayload(
    payloadId: string,
    maximumBytes: number,
  ): Promise<EvidencePayload> {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
      throw new RangeError("Maximum query payload bytes must be positive.");
    }
    const id = IdentifierSchema.parse(payloadId);
    const reference = this.storage.blobs.describe(id);
    if (reference === undefined) {
      throw new EvidenceQueryNotFoundError("payload", id);
    }
    if (reference.byteLength > maximumBytes) {
      throw new EvidencePayloadTooLargeError(reference, maximumBytes);
    }
    return { reference, bytes: await this.storage.blobs.get(id) };
  }
}
