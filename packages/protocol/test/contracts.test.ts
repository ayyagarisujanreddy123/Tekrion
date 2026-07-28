import { describe, expect, it } from "vitest";

import {
  AiReportRequestSchema,
  BbxArchiveSchema,
  BlackBoxEventSchema,
  BlameResultSchema,
  ContextResultSchema,
  CONTEXT_VISIBILITY_NOTICE,
  FileDeltaPayloadSchema,
  IncidentReportSchema,
  parseCurrentRecord,
  PreservedRecordSchema,
  RawExchangeSchema,
  SafeHeadersSchema,
  SessionSchema,
  UnsupportedSchemaVersionError,
} from "../src/index.js";

const timestamp = "2026-07-15T12:00:00.000Z";
const blobReference = {
  id: "blob-1",
  sha256: "a".repeat(64),
  codec: "identity",
  mediaType: "application/json",
  byteLength: 42,
  truncated: false,
} as const;

const canonicalEvent = {
  schemaVersion: 1,
  id: "event-1",
  sessionId: "session-1",
  sequence: 1,
  occurredAt: timestamp,
  observedAt: timestamp,
  source: "proxy",
  type: "model.request",
  evidence: "observed",
  payloadRef: blobReference,
  summary: { model: "gpt-5.2" },
  redaction: { applied: false, ruleIds: [] },
} as const;

describe("versioned evidence contracts", () => {
  it("accepts representative current-version records", () => {
    const session = SessionSchema.parse({
      schemaVersion: 1,
      id: "session-1",
      startedAt: timestamp,
      endedAt: "2026-07-15T12:01:00.000Z",
      status: "completed",
      captureLevel: "wrapped-process",
      command: {
        executable: "npm",
        arguments: ["test"],
        cwd: "/tmp/repository",
      },
      repoRoot: "/tmp/repository",
      agentName: "fixture-agent",
      models: ["gpt-5.2"],
      upstreamOrigin: "https://api.openai.com",
      upstreamRoute: "codex-auth",
      tags: ["golden"],
      counts: {
        events: 1,
        errors: 0,
        inputTokens: 12,
        outputTokens: null,
      },
      metadata: {},
    });

    const rawExchange = RawExchangeSchema.parse({
      schemaVersion: 1,
      id: "exchange-1",
      sessionId: session.id,
      sequence: 1,
      protocol: "openai.responses",
      method: "POST",
      path: "/v1/responses",
      query: {},
      requestHeaders: { "content-type": ["application/json"] },
      requestBodyRef: blobReference,
      responseStatus: 200,
      responseHeaders: { "content-type": ["application/json"] },
      responseBodyRef: blobReference,
      startedAt: timestamp,
      firstByteAt: timestamp,
      endedAt: timestamp,
      outcome: "completed",
      parseStatus: "parsed",
      capture: {
        requestComplete: true,
        responseComplete: true,
        droppedRequestBytes: 0,
        droppedResponseBytes: 0,
      },
    });

    expect(BlackBoxEventSchema.parse(canonicalEvent).type).toBe(
      "model.request",
    );
    expect(rawExchange.protocol).toBe("openai.responses");
    expect(session.counts.outputTokens).toBeNull();
  });

  it("rejects a future required version with a specific recoverable error", () => {
    const futureEvent = { ...canonicalEvent, schemaVersion: 2 };

    expect(() =>
      parseCurrentRecord("event", BlackBoxEventSchema, futureEvent),
    ).toThrow(UnsupportedSchemaVersionError);

    try {
      parseCurrentRecord("event", BlackBoxEventSchema, futureEvent);
    } catch (error: unknown) {
      expect(error).toMatchObject({
        actualVersion: 2,
        expectedVersion: 1,
        recordKind: "event",
      });
    }
  });

  it("represents an unsupported payload by a pointer to untouched raw bytes", () => {
    const preserved = PreservedRecordSchema.parse({
      status: "preserved",
      recordKind: "event",
      declaredSchemaVersion: 2,
      reason: "unsupported-schema-version",
      rawPayloadRef: blobReference,
    });

    expect(preserved.rawPayloadRef.sha256).toBe("a".repeat(64));
  });

  it("retains unknown canonical event types without inventing semantics", () => {
    const event = BlackBoxEventSchema.parse({
      ...canonicalEvent,
      type: "provider.future_item",
      evidence: "unknown",
      summary: { providerType: "future_item", rawPayloadPreserved: true },
    });

    expect(event.type).toBe("provider.future_item");
    expect(event.payloadRef?.id).toBe("blob-1");
  });

  it("validates retained file delta state transitions", () => {
    const side = {
      sha256: "a".repeat(64),
      byteLength: 3,
      encoding: "base64",
      content: "b2xk",
    } as const;
    expect(
      FileDeltaPayloadSchema.parse({
        schemaVersion: 1,
        path: "README.md",
        operation: "modify",
        before: side,
        after: { ...side, content: "bmV3" },
      }).operation,
    ).toBe("modify");
    expect(
      FileDeltaPayloadSchema.safeParse({
        schemaVersion: 1,
        path: "created.ts",
        operation: "create",
        before: side,
        after: side,
      }).success,
    ).toBe(false);
  });
});

describe("privacy and inference constraints", () => {
  it.each([
    "authorization",
    "Authorization",
    "chatgpt-account-id",
    "ChatGPT-Account-ID",
    "cookie",
    "set-cookie",
    "x-api-key",
    "X-Api-Key",
  ])("refuses to persist the %s header", (headerName) => {
    expect(
      SafeHeadersSchema.safeParse({ [headerName]: ["fixture-secret"] }).success,
    ).toBe(false);
  });

  it("requires a hard provenance edge for high-confidence blame", () => {
    const result = BlameResultSchema.safeParse({
      schemaVersion: 1,
      scoringVersion: "deterministic-v1",
      target: {
        eventId: "delete-event",
        verb: "delete",
        path: "test/example.test.ts",
        arguments: {},
      },
      contextCompleteness: "exact-client-request",
      conclusion: "A preceding instruction may have influenced the deletion.",
      confidence: "high",
      confidenceReasons: ["Strong lexical overlap"],
      candidates: [
        {
          eventId: "readme-event",
          score: 0.8,
          features: { lexicalOverlap: 1 },
          hardProvenanceEdge: false,
        },
      ],
      propagation: [],
      evidence: [],
      counterevidence: [],
      alternatives: [],
      limitations: [],
    });

    expect(result.success).toBe(false);
  });

  it("caps blame confidence when the relevant client chain is partial", () => {
    const result = BlameResultSchema.safeParse({
      schemaVersion: 1,
      scoringVersion: "deterministic-v1",
      target: {
        eventId: "delete-event",
        verb: "delete",
        path: "test/example.test.ts",
        arguments: {},
      },
      contextCompleteness: "partial-client-chain",
      conclusion: "A preceding instruction may have influenced the deletion.",
      confidence: "high",
      confidenceReasons: ["Direct read-result propagation"],
      candidates: [
        {
          eventId: "readme-event",
          score: 0.9,
          features: { provenance: 1 },
          hardProvenanceEdge: true,
        },
      ],
      propagation: [
        {
          from: "readme-event",
          to: "delete-event",
          relation: "read-result-propagation",
        },
      ],
      evidence: [],
      counterevidence: [],
      alternatives: [],
      limitations: ["One previous response is unavailable."],
    });

    expect(result.success).toBe(false);
  });

  it("labels missing context and missing token usage explicitly", () => {
    const result = ContextResultSchema.parse({
      schemaVersion: 1,
      requestEventId: "request-event",
      completeness: "partial-client-chain",
      items: [
        {
          id: "context-item",
          position: 0,
          kind: "message",
          role: "user",
          evidence: "observed",
          summary: { text: "Continue." },
          provenance: { eventId: "request-event" },
        },
      ],
      ancestry: {
        nodes: [
          {
            id: "missing-response",
            kind: "missing",
            locallyAvailable: false,
          },
        ],
        edges: [],
      },
      reportedInputTokens: null,
      estimatedInputTokens: null,
      modelContextLimit: null,
      limitationReasons: ["previous response resp_missing is unavailable"],
      visibilityNotice: CONTEXT_VISIBILITY_NOTICE,
    });

    expect(result.reportedInputTokens).toBeNull();
    expect(result.completeness).toBe("partial-client-chain");
  });

  it("keeps report facts separate from the root-cause hypothesis", () => {
    const report = IncidentReportSchema.parse({
      schemaVersion: 1,
      id: "report-1",
      sessionId: "session-1",
      generatedAt: timestamp,
      capture: {
        level: "wrapped-process",
        contextCompleteness: "exact-client-request",
        missingSignals: [],
      },
      impact: "One test file was deleted.",
      factualTimeline: [
        {
          eventId: "delete-event",
          occurredAt: timestamp,
          statement: "The final Git diff records a deleted test file.",
          evidence: "observed",
        },
      ],
      rootCauseHypothesis: {
        statement: "A README instruction may have influenced the deletion.",
        evidence: "inferred",
        confidence: "medium",
        supports: [
          {
            eventId: "readme-event",
            statement: "The line was returned before the deletion call.",
          },
        ],
      },
      contributingConditions: [],
      counterevidence: [],
      alternatives: [],
      containmentAndRecovery: [],
      preventionActions: [
        {
          action: "Require approval before deleting tests.",
          evidenceIds: ["delete-event"],
        },
      ],
      limitations: ["Provider-hidden reasoning is unavailable."],
      analysis: {
        mode: "deterministic",
        analyzer: "blackbox-rules-v1",
        promptVersion: null,
        model: null,
        externalEvidenceSent: false,
        redactionRuleIds: [],
      },
    });

    expect(report.factualTimeline[0]?.evidence).toBe("observed");
    expect(report.rootCauseHypothesis.evidence).toBe("inferred");
    expect(report.analysis.externalEvidenceSent).toBe(false);
  });

  it("binds AI report consent to one reviewed evidence snapshot", () => {
    expect(
      AiReportRequestSchema.parse({
        schemaVersion: 1,
        consent: true,
        consentFingerprintSha256: "b".repeat(64),
        targetEventId: "event-1",
      }),
    ).toMatchObject({
      consent: true,
      consentFingerprintSha256: "b".repeat(64),
    });
    expect(
      AiReportRequestSchema.safeParse({
        schemaVersion: 1,
        consent: true,
      }).success,
    ).toBe(false);
    expect(
      AiReportRequestSchema.safeParse({
        schemaVersion: 1,
        consent: false,
        consentFingerprintSha256: "b".repeat(64),
      }).success,
    ).toBe(false);
  });

  it("accepts normalized BBX manifests and rejects unsafe paths", () => {
    const archive = {
      schemaVersion: 1,
      manifest: {
        schemaVersion: 1,
        format: "blackbox-bbx",
        archiveId: "archive-1",
        exportedAt: timestamp,
        profile: "share",
        sourceSessionId: "session-1",
        sourceSessionStatus: "completed",
        storageSchemaVersion: 2,
        entries: [
          {
            path: "records/events.jsonl",
            mediaType: "application/x-ndjson",
            byteLength: 0,
            sha256:
              "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
          },
        ],
        blobs: [],
        counts: {
          sessions: 1,
          events: 0,
          rawExchanges: 0,
          normalizationRuns: 0,
          fileChanges: 0,
          contextEdges: 0,
          analysisRuns: 0,
          redactions: 0,
          blobs: 0,
          reports: 0,
        },
        totalBytes: 0,
        redaction: { applied: false, count: 0, ruleIds: [] },
        warnings: ["Fixture archive."],
      },
      manifestSha256: "a".repeat(64),
      entries: [
        {
          path: "records/events.jsonl",
          encoding: "base64",
          data: "",
        },
      ],
    };
    expect(BbxArchiveSchema.parse(archive).manifest.profile).toBe("share");
    for (const unsafePath of [
      "/absolute/evidence.json",
      "../evidence.json",
      "records/../evidence.json",
      "records/./evidence.json",
      "records//evidence.json",
      "C:/evidence.json",
    ]) {
      expect(
        BbxArchiveSchema.safeParse({
          ...archive,
          manifest: {
            ...archive.manifest,
            entries: [
              {
                ...archive.manifest.entries[0],
                path: unsafePath,
              },
            ],
          },
          entries: [{ ...archive.entries[0], path: unsafePath }],
        }).success,
        unsafePath,
      ).toBe(false);
    }
  });
});
