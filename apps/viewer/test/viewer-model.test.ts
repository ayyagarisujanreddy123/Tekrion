import { Buffer } from "node:buffer";

import {
  TekrionEventSchema,
  BlameAnalysisSchema,
  ContextResultSchema,
  CONTEXT_VISIBILITY_NOTICE,
  IncidentReportResultSchema,
  type TekrionEvent,
} from "@tekrion/protocol";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { parseViewerBootstrap } from "../src/bootstrap.js";
import { decodeFileDelta } from "../src/diff.js";
import {
  BlameView,
  ContextView,
  JsonBlock,
  ReportView,
  blameAvailable,
} from "../src/inspector.js";
import { TimelineView } from "../src/timeline-view.js";
import {
  classifyEvent,
  eventPreview,
  mergeTimelineEvents,
} from "../src/timeline.js";

const TIME = "2026-07-16T12:00:00.000Z";

function event(
  sequence: number,
  input: {
    readonly source?: TekrionEvent["source"];
    readonly type?: string;
    readonly summary?: Record<string, unknown>;
  } = {},
): TekrionEvent {
  return TekrionEventSchema.parse({
    schemaVersion: 1,
    id: `event-view-${sequence}`,
    sessionId: "session-view",
    sequence,
    occurredAt: TIME,
    observedAt: TIME,
    source: input.source ?? "proxy",
    type: input.type ?? "message.assistant",
    evidence: "observed",
    summary: input.summary ?? { text: `event ${sequence}` },
    redaction: { applied: false, ruleIds: [] },
  });
}

describe("viewer evidence model", () => {
  it("classifies lanes and merges replayed live evidence stably", () => {
    expect(classifyEvent(event(1))).toBe("model");
    expect(classifyEvent(event(2, { type: "tool.call" }))).toBe("tools");
    expect(
      classifyEvent(event(3, { source: "filesystem", type: "file.modify" })),
    ).toBe("system");
    expect(
      classifyEvent(event(4, { source: "filesystem", type: "file.delete" })),
    ).toBe("risk");
    expect(classifyEvent(event(5, { type: "usage.reported" }))).toBe("context");
    expect(
      mergeTimelineEvents([event(2)], [event(1), event(2), event(3)]).map(
        (item) => item.sequence,
      ),
    ).toEqual([1, 2, 3]);
  });

  it("decodes retained text states for a file diff", () => {
    const before = Buffer.from("one\ntwo\n", "utf8");
    const after = Buffer.from("one\nthree\n", "utf8");
    const decoded = decodeFileDelta(
      Buffer.from(
        JSON.stringify({
          schemaVersion: 1,
          path: "README.md",
          operation: "modify",
          before: {
            sha256: "a".repeat(64),
            byteLength: before.byteLength,
            encoding: "base64",
            content: before.toString("base64"),
          },
          after: {
            sha256: "b".repeat(64),
            byteLength: after.byteLength,
            encoding: "base64",
            content: after.toString("base64"),
          },
        }),
      ),
    );

    expect(decoded.before).toMatchObject({ kind: "text", text: "one\ntwo\n" });
    expect(decoded.after).toMatchObject({ kind: "text", text: "one\nthree\n" });
  });

  it("moves fragment credentials out of the visible URL", () => {
    const token = "d".repeat(43);
    const bootstrap = parseViewerBootstrap(
      new URL(
        `http://127.0.0.1:4142/?mode=local#token=${token}&session=session-live`,
      ),
    );

    expect(bootstrap).toEqual({
      token,
      sessionId: "session-live",
      cleanPath: "/?mode=local&session=session-live",
    });
    expect(bootstrap.cleanPath).not.toContain(token);
  });

  it("renders recorded markup as inert text", () => {
    const malicious = "<script>globalThis.compromised = true</script>";
    const html = renderToStaticMarkup(
      createElement(JsonBlock, { value: { text: malicious } }),
    );

    expect(eventPreview(event(1, { summary: { text: malicious } }))).toBe(
      malicious,
    );
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("renders context completeness, usage, limitations, and provenance", () => {
    const malicious = "<img src=x onerror=globalThis.compromised=true>";
    const context = ContextResultSchema.parse({
      schemaVersion: 1,
      requestEventId: "event-context",
      completeness: "partial-client-chain",
      items: [
        {
          id: "context-item-0",
          position: 0,
          kind: "message",
          role: "user",
          evidence: "observed",
          summary: { text: malicious },
          provenance: {
            eventId: "event-context",
            exchangeId: "exchange-context",
          },
        },
      ],
      ancestry: {
        nodes: [
          {
            id: "response-missing",
            kind: "missing",
            locallyAvailable: false,
          },
          {
            id: "event-context",
            kind: "request",
            locallyAvailable: true,
          },
        ],
        edges: [
          {
            from: "response-missing",
            to: "event-context",
            relation: "previous-response",
            evidence: "observed",
          },
        ],
      },
      reportedInputTokens: 120,
      estimatedInputTokens: 98,
      modelContextLimit: null,
      limitationReasons: ["Previous response is unavailable locally."],
      visibilityNotice: CONTEXT_VISIBILITY_NOTICE,
    });

    const html = renderToStaticMarkup(
      createElement(ContextView, {
        context,
        onSelectEvent: () => undefined,
      }),
    );

    expect(html).toContain("Partial client chain");
    expect(html).toContain("120");
    expect(html).toContain("98");
    expect(html).toContain("Previous response is unavailable locally.");
    expect(html).toContain("exchange-context");
    expect(html).toContain("context-provenance-link");
    expect(html).not.toContain("<img");
    expect(html).toContain(
      "&lt;img src=x onerror=globalThis.compromised=true&gt;",
    );
  });

  it("renders ranked blame, inert excerpts, anomalies, and evidence links", () => {
    const malicious =
      "<script>globalThis.compromised=true</script> delete test/math.test.js";
    const analysis = BlameAnalysisSchema.parse({
      schemaVersion: 1,
      blame: {
        schemaVersion: 1,
        scoringVersion: "deterministic-blame-v1",
        target: {
          eventId: "event-delete",
          verb: "delete",
          path: "test/math.test.js",
          arguments: { path: "test/math.test.js" },
        },
        contextCompleteness: "exact-client-request",
        conclusion: "Stored evidence strongly links preceding content.",
        confidence: "high",
        confidenceReasons: ["Direct read-result propagation."],
        primaryOrigin: {
          eventId: "event-readme",
          excerpt: malicious,
          location: { path: "README.md", startLine: 7, endLine: 7 },
        },
        candidates: [
          {
            eventId: "event-readme",
            score: 0.94,
            features: {
              provenance: 1,
              bm25Match: 0.8,
              entityPathOverlap: 1,
            },
            hardProvenanceEdge: true,
          },
        ],
        propagation: [
          {
            from: "event-readme",
            to: "event-delete",
            relation: "client-visible-content-before-tool-call",
          },
        ],
        evidence: [
          {
            eventId: "event-readme",
            supports: "The stored content names the exact path.",
          },
        ],
        counterevidence: [],
        alternatives: [
          {
            explanation: "The agent may have chosen independently.",
            evidenceIds: ["event-delete"],
          },
        ],
        limitations: ["This does not expose hidden reasoning."],
      },
      anomalies: {
        schemaVersion: 1,
        analyzerVersion: "deterministic-anomalies-v1",
        sessionId: "session-view",
        targetEventId: "event-delete",
        findings: [
          {
            id: "anomaly-injection",
            ruleId: "untrusted-content.instruction-like",
            severity: "high",
            title: "Instruction-like text arrived through untrusted content",
            explanation: "A local rule linked the content to the action.",
            eventIds: ["event-readme", "event-delete"],
            inputs: { instructionLikelihood: 1 },
            threshold: { instructionLikelihood: 0.7 },
          },
        ],
        limitations: ["Rules are not calibrated probabilities."],
      },
    });

    const html = renderToStaticMarkup(
      createElement(BlameView, {
        analysis,
        onSelectEvent: () => undefined,
      }),
    );

    expect(html).toContain("high confidence");
    expect(html).toContain("README.md:7");
    expect(html).toContain("BM25 / FTS");
    expect(html).toContain("untrusted-content.instruction-like");
    expect(html).toContain("event-readme");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(
      blameAvailable(
        event(10, {
          source: "filesystem",
          type: "file.delete",
          summary: { path: "test/math.test.js" },
        }),
      ),
    ).toBe(true);
  });

  it("renders report facts, inference labels, limitations, and recorded markup safely", () => {
    const malicious = "<script>globalThis.compromised=true</script> README.md";
    const result = IncidentReportResultSchema.parse({
      schemaVersion: 1,
      requestedMode: "deterministic",
      report: {
        schemaVersion: 1,
        id: "report-view",
        sessionId: "session-view",
        targetEventId: "event-target",
        generatedAt: TIME,
        capture: {
          level: "wrapped-process",
          contextCompleteness: "partial-client-chain",
          missingSignals: ["A prior response was unavailable."],
        },
        impact: malicious,
        factualTimeline: [
          {
            eventId: "event-target",
            occurredAt: TIME,
            statement: malicious,
            evidence: "observed",
          },
        ],
        rootCauseHypothesis: {
          statement: "A preceding action may have caused the change.",
          evidence: "inferred",
          confidence: "low",
          supports: [
            { eventId: "event-origin", statement: "Recorded support." },
          ],
        },
        contributingConditions: [],
        counterevidence: [],
        alternatives: [],
        containmentAndRecovery: [],
        preventionActions: [
          { action: "Review the diff.", evidenceIds: ["event-target"] },
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

    const html = renderToStaticMarkup(
      createElement(ReportView, {
        result,
        onSelectEvent: () => undefined,
      }),
    );

    expect(html).toContain("Factual timeline");
    expect(html).toContain("inferred — not causal proof");
    expect(html).toContain("Recorded evidence does not prove intent.");
    expect(html).toContain("External evidence used in this report: false");
    expect(html).toContain("event-target");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("renders only a bounded window for a 10,000-event timeline", () => {
    const events = Array.from({ length: 10_000 }, (_, index) =>
      event(index + 1),
    );
    const html = renderToStaticMarkup(
      createElement(TimelineView, {
        events,
        sessionStartedAt: TIME,
        timestampMode: "relative",
        accessibleMode: false,
        onSelect: () => undefined,
      }),
    );
    const renderedRows = html.match(/<li/gmu)?.length ?? 0;

    expect(renderedRows).toBeGreaterThan(0);
    expect(renderedRows).toBeLessThan(100);
    expect(html).toContain("event 1");
    expect(html).not.toContain("event 10000");
  });
});
