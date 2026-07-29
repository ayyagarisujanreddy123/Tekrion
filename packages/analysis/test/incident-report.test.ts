import {
  deterministicReportResult,
  generateDeterministicReport,
  renderIncidentReportMarkdown,
  selectIncidentTarget,
} from "@tekrion/analysis";
import { describe, expect, it } from "vitest";

import { REPORT_TIME, reportFixture } from "./report-fixture.js";

describe("deterministic incident reports", () => {
  it("selects the highest-impact exact target and keeps facts separate from inference", () => {
    const fixture = reportFixture();
    const target = selectIncidentTarget(fixture.events);
    const report = generateDeterministicReport({
      session: fixture.session,
      events: fixture.events,
      blame: fixture.analysis,
      generatedAt: REPORT_TIME,
    });

    expect(target?.id).toBe("event-file-delete");
    expect(report).toMatchObject({
      sessionId: "session-report",
      targetEventId: "event-file-delete",
      generatedAt: REPORT_TIME,
      impact: expect.stringContaining("test/math.test.js"),
      rootCauseHypothesis: {
        evidence: "inferred",
        confidence: "high",
      },
      analysis: {
        mode: "deterministic",
        externalEvidenceSent: false,
        promptVersion: null,
        model: null,
      },
    });
    expect(report.factualTimeline.length).toBeGreaterThan(0);
    for (const item of report.factualTimeline) {
      expect(["observed", "derived"]).toContain(item.evidence);
    }
    expect(report.containmentAndRecovery).toEqual([
      expect.objectContaining({ eventId: "event-file-recovery" }),
    ]);
    expect(report.limitations.join(" ")).toContain("does not establish intent");
  });

  it("renders recorded markup as escaped text with auditable event links", () => {
    const fixture = reportFixture();
    const report = generateDeterministicReport({
      session: fixture.session,
      events: fixture.events,
      blame: fixture.analysis,
      generatedAt: REPORT_TIME,
    });
    const markdown = renderIncidentReportMarkdown(report);

    expect(markdown).toContain("# Tekrion Incident Report");
    expect(markdown).not.toContain("<script>");
    expect(markdown).toContain("&lt;script&gt;");
    expect(markdown).toContain("tekrion://event/event-file-delete");
    expect(markdown).toContain("## Root-cause hypothesis");
    expect(markdown).toContain("inferred");

    const escaped = renderIncidentReportMarkdown({
      ...report,
      impact: String.raw`C:\temp\*artifact*`,
    });
    expect(escaped).toContain(String.raw`C:\\temp\\\*artifact\*`);
  });

  it("returns stable report identity and a deterministic fallback with no action target", () => {
    const fixture = reportFixture();
    const first = generateDeterministicReport({
      session: fixture.session,
      events: fixture.events,
      blame: fixture.analysis,
      generatedAt: REPORT_TIME,
    });
    const second = generateDeterministicReport({
      session: fixture.session,
      events: fixture.events,
      blame: fixture.analysis,
      generatedAt: "2026-07-18T13:00:00.000Z",
    });
    const noTarget = deterministicReportResult({
      session: fixture.session,
      events: fixture.events.filter((event) => event.type === "message.user"),
      generatedAt: REPORT_TIME,
    });

    expect(first.id).toBe(second.id);
    expect(noTarget.report.targetEventId).toBeUndefined();
    expect(noTarget.report.rootCauseHypothesis.confidence).toBe("low");
    expect(noTarget.aiAttempt).toEqual({ status: "not-requested" });
    expect(noTarget.report.analysis.externalEvidenceSent).toBe(false);
  });

  it("rejects a requested target that is absent or not analyzable", () => {
    const fixture = reportFixture();

    expect(() => selectIncidentTarget(fixture.events, "event-missing")).toThrow(
      "not present",
    );
    expect(() => selectIncidentTarget(fixture.events, "event-user")).toThrow(
      "not an analyzable action",
    );
  });
});
