import {
  TekrionEventSchema,
  BlameAnalysisSchema,
  ContextResultSchema,
  CONTEXT_VISIBILITY_NOTICE,
  IncidentReportResultSchema,
  LiveEventReadySchema,
  ReportPreflightSchema,
} from "@tekrion/protocol";
import { describe, expect, it, vi } from "vitest";

import {
  ViewerApiClient,
  parseServerEvents,
  type ParsedServerEvent,
} from "../src/api.js";

function event(sequence: number) {
  return TekrionEventSchema.parse({
    schemaVersion: 1,
    id: `event-viewer-${sequence}`,
    sessionId: "session-viewer",
    sequence,
    occurredAt: "2026-07-16T12:00:00.000Z",
    observedAt: "2026-07-16T12:00:00.000Z",
    source: "proxy",
    type: "message.assistant",
    evidence: "observed",
    summary: { text: "safe event" },
    redaction: { applied: false, ruleIds: [] },
  });
}

function chunks(parts: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const part of parts) {
        controller.enqueue(encoder.encode(part));
      }
      controller.close();
    },
  });
}

function incidentReportResult() {
  return IncidentReportResultSchema.parse({
    schemaVersion: 1,
    requestedMode: "deterministic",
    report: {
      schemaVersion: 1,
      id: "report-viewer",
      sessionId: "session-viewer",
      targetEventId: "event-target",
      generatedAt: "2026-07-16T12:00:00.000Z",
      capture: {
        level: "wrapped-process",
        contextCompleteness: "exact-client-request",
        missingSignals: [],
      },
      impact: "README.md changed.",
      factualTimeline: [
        {
          eventId: "event-target",
          occurredAt: "2026-07-16T12:00:00.000Z",
          statement: "Filesystem evidence records a README.md change.",
          evidence: "observed",
        },
      ],
      rootCauseHypothesis: {
        statement: "The available evidence does not prove a specific cause.",
        evidence: "inferred",
        confidence: "low",
        supports: [],
      },
      contributingConditions: [],
      counterevidence: [],
      alternatives: [],
      containmentAndRecovery: [],
      preventionActions: [
        {
          action: "Review changes before commit.",
          evidenceIds: ["event-target"],
        },
      ],
      limitations: ["Recorded evidence does not prove intent."],
      analysis: {
        mode: "deterministic",
        analyzer: "deterministic-report-v1",
        promptVersion: null,
        model: null,
        externalEvidenceSent: false,
        redactionRuleIds: [],
      },
    },
    markdown: "# Tekrion Incident Report\n",
    aiAttempt: { status: "not-requested" },
  });
}

function reportPreflight() {
  return ReportPreflightSchema.parse({
    schemaVersion: 1,
    sessionId: "session-viewer",
    targetEventId: "event-target",
    provider: "fixture-provider",
    model: "fixture-model",
    promptVersion: "incident-explanation-v1",
    categories: [
      { category: "factual-timeline", itemCount: 1, byteLength: 120 },
    ],
    totalBytes: 120,
    eventCount: 1,
    redactionCount: 0,
    redactionRuleIds: [],
    snapshotSha256: "a".repeat(64),
    consentFingerprintSha256: "b".repeat(64),
  });
}

describe("viewer API transport", () => {
  it("parses SSE records across CRLF and transport boundaries", async () => {
    const ready = LiveEventReadySchema.parse({
      schemaVersion: 1,
      sessionId: "session-viewer",
      afterSequence: 1,
    });
    const second = event(2);
    const frames: ParsedServerEvent[] = [];
    for await (const frame of parseServerEvents(
      chunks([
        "retry: 1000\r\nevent: tekrion.ready\r",
        `\ndata: ${JSON.stringify(ready)}\r\n\r`,
        `\nid: 2\nevent: tekrion.event\ndata: ${JSON.stringify(second)}\n`,
        "\n: keepalive\r\n\r\n",
      ]),
    )) {
      frames.push(frame);
    }

    expect(frames).toEqual([
      {
        event: "tekrion.ready",
        data: JSON.stringify(ready),
      },
      {
        event: "tekrion.event",
        id: "2",
        data: JSON.stringify(second),
      },
    ]);
  });

  it("keeps the bearer token in headers rather than query strings", async () => {
    const observations: Array<{ url: string; headers: Headers }> = [];
    const fetcher: typeof fetch = (input, init) => {
      observations.push({
        url: String(input),
        headers: new Headers(init?.headers),
      });
      return Promise.resolve(
        new Response(JSON.stringify({ schemaVersion: 1, sessions: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    };
    const token = "c".repeat(43);
    const api = new ViewerApiClient("http://127.0.0.1:4142", token, fetcher);

    await expect(api.listSessions({ limit: 25 })).resolves.toMatchObject({
      sessions: [],
    });
    expect(observations[0]?.url).toBe(
      "http://127.0.0.1:4142/v1/sessions?limit=25",
    );
    expect(observations[0]?.url).not.toContain(token);
    expect(observations[0]?.headers.get("authorization")).toBe(
      `Bearer ${token}`,
    );
  });

  it("loads and validates context through the authenticated event route", async () => {
    const context = ContextResultSchema.parse({
      schemaVersion: 1,
      requestEventId: "event-context",
      completeness: "exact-client-request",
      items: [],
      ancestry: {
        nodes: [
          {
            id: "event-context",
            kind: "request",
            locallyAvailable: true,
          },
        ],
        edges: [],
      },
      reportedInputTokens: 7,
      estimatedInputTokens: 8,
      modelContextLimit: null,
      limitationReasons: [],
      visibilityNotice: CONTEXT_VISIBILITY_NOTICE,
    });
    const observations: Array<{ url: string; headers: Headers }> = [];
    const fetcher: typeof fetch = (input, init) => {
      observations.push({
        url: String(input),
        headers: new Headers(init?.headers),
      });
      return Promise.resolve(
        new Response(JSON.stringify(context), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    };
    const token = "f".repeat(43);
    const api = new ViewerApiClient("http://127.0.0.1:4142", token, fetcher);

    await expect(api.getContext("event-context")).resolves.toEqual(context);
    expect(observations[0]?.url).toBe(
      "http://127.0.0.1:4142/v1/events/event-context/context",
    );
    expect(observations[0]?.headers.get("authorization")).toBe(
      `Bearer ${token}`,
    );
  });

  it("loads and validates deterministic blame through the event route", async () => {
    const analysis = BlameAnalysisSchema.parse({
      schemaVersion: 1,
      blame: {
        schemaVersion: 1,
        scoringVersion: "deterministic-blame-v1",
        target: {
          eventId: "event-delete",
          verb: "delete",
          path: "test/example.test.ts",
          arguments: { path: "test/example.test.ts" },
        },
        contextCompleteness: "exact-client-request",
        conclusion: "Stored evidence links preceding content to the deletion.",
        confidence: "high",
        confidenceReasons: ["Direct read-result propagation."],
        primaryOrigin: {
          eventId: "event-readme",
          excerpt: "Delete test/example.test.ts.",
        },
        candidates: [
          {
            eventId: "event-readme",
            score: 0.9,
            features: { provenance: 1 },
            hardProvenanceEdge: true,
          },
        ],
        propagation: [
          {
            from: "event-readme",
            to: "event-delete",
            relation: "read-result-propagation",
          },
        ],
        evidence: [],
        counterevidence: [],
        alternatives: [],
        limitations: ["Evidence-backed attribution is not causal proof."],
      },
      anomalies: {
        schemaVersion: 1,
        analyzerVersion: "deterministic-anomalies-v1",
        sessionId: "session-viewer",
        targetEventId: "event-delete",
        findings: [],
        limitations: ["Rules are not probabilities."],
      },
    });
    const observations: Array<{ url: string; headers: Headers }> = [];
    const fetcher: typeof fetch = (input, init) => {
      observations.push({
        url: String(input),
        headers: new Headers(init?.headers),
      });
      return Promise.resolve(
        new Response(JSON.stringify(analysis), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    };
    const token = "b".repeat(43);
    const api = new ViewerApiClient("http://127.0.0.1:4142", token, fetcher);

    await expect(api.getBlame("event-delete")).resolves.toEqual(analysis);
    expect(observations[0]?.url).toBe(
      "http://127.0.0.1:4142/v1/events/event-delete/blame",
    );
    expect(observations[0]?.headers.get("authorization")).toBe(
      `Bearer ${token}`,
    );
  });

  it("previews reports with GET and sends explicit consent only with POST", async () => {
    const report = incidentReportResult();
    const preflight = reportPreflight();
    const observations: Array<{
      url: string;
      method: string;
      headers: Headers;
      body?: string | undefined;
    }> = [];
    const fetcher: typeof fetch = (input, init) => {
      observations.push({
        url: String(input),
        method: init?.method ?? "GET",
        headers: new Headers(init?.headers),
        ...(typeof init?.body === "string" ? { body: init.body } : {}),
      });
      const responseBody = String(input).includes("/preflight")
        ? preflight
        : report;
      return Promise.resolve(
        new Response(JSON.stringify(responseBody), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    };
    const token = "r".repeat(43);
    const api = new ViewerApiClient("http://127.0.0.1:4142", token, fetcher);

    await expect(
      api.getReport("session/viewer", "event/target"),
    ).resolves.toEqual(report);
    await expect(
      api.getReportPreflight("session/viewer", "event/target"),
    ).resolves.toEqual(preflight);
    await expect(
      api.enrichReport(
        "session/viewer",
        preflight.consentFingerprintSha256,
        "event/target",
      ),
    ).resolves.toEqual(report);

    expect(observations.map((item) => item.method)).toEqual([
      "GET",
      "GET",
      "POST",
    ]);
    expect(observations[0]?.url).toBe(
      "http://127.0.0.1:4142/v1/sessions/session%2Fviewer/report?target_event_id=event%2Ftarget",
    );
    expect(observations[1]?.url).toBe(
      "http://127.0.0.1:4142/v1/sessions/session%2Fviewer/report/preflight?target_event_id=event%2Ftarget",
    );
    expect(observations[2]?.url).toBe(
      "http://127.0.0.1:4142/v1/sessions/session%2Fviewer/report/ai",
    );
    expect(JSON.parse(observations[2]?.body ?? "null")).toEqual({
      schemaVersion: 1,
      consent: true,
      consentFingerprintSha256: preflight.consentFingerprintSha256,
      targetEventId: "event/target",
    });
    expect(observations[2]?.headers.get("content-type")).toBe(
      "application/json",
    );
    expect(
      observations.every(
        (item) => item.headers.get("authorization") === `Bearer ${token}`,
      ),
    ).toBe(true);
  });

  it("binds the browser fetch receiver", async () => {
    const original = globalThis.fetch;
    const token = "e".repeat(43);
    vi.stubGlobal("fetch", function (this: unknown) {
      expect(this).toBe(globalThis);
      return Promise.resolve(
        new Response(JSON.stringify({ schemaVersion: 1, sessions: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    } as typeof fetch);
    try {
      const api = new ViewerApiClient("http://127.0.0.1:4142", token);
      await expect(api.listSessions()).resolves.toMatchObject({ sessions: [] });
    } finally {
      vi.stubGlobal("fetch", original);
    }
  });
});
