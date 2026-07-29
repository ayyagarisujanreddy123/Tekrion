import {
  AiCitationValidationError,
  generateDeterministicReport,
  mergeAiNarrative,
  minimizeReportEvidence,
  snapshotEvidenceById,
  validateAiNarrativeCitations,
} from "@tekrion/analysis";
import {
  AiIncidentNarrativeSchema,
  IncidentReportSchema,
  type AiIncidentNarrative,
  type AiReportCitation,
} from "@tekrion/protocol";
import { describe, expect, it } from "vitest";

import { REPORT_TIME, reportFixture } from "./report-fixture.js";

function preparedFixture() {
  const fixture = reportFixture();
  const report = generateDeterministicReport({
    session: fixture.session,
    events: fixture.events,
    blame: fixture.analysis,
    generatedAt: REPORT_TIME,
  });
  const minimized = minimizeReportEvidence({
    session: fixture.session,
    events: fixture.events,
    report,
    blame: fixture.analysis,
    provider: "fixture-provider",
    model: "fixture-model",
  });
  const excerpt = snapshotEvidenceById(minimized.snapshot).get(
    "event-file-delete",
  )?.[0];
  if (excerpt === undefined) {
    throw new Error("The report fixture must transmit the target evidence.");
  }
  return { ...fixture, report, minimized, excerpt };
}

function narrative(citation: AiReportCitation): AiIncidentNarrative {
  return AiIncidentNarrativeSchema.parse({
    schemaVersion: 1,
    impact: {
      statement: "A test file was deleted.",
      citations: [citation],
    },
    rootCauseHypothesis: {
      statement:
        "Preceding untrusted content may have influenced the deletion.",
      confidence: "high",
      citations: [citation],
    },
    contributingConditions: [],
    counterevidence: [],
    alternatives: [],
    preventionActions: [],
    limitations: ["The model received only the minimized evidence snapshot."],
  });
}

describe("AI incident narrative validation", () => {
  it("accepts only exact excerpts from transmitted event evidence", () => {
    const fixture = preparedFixture();
    const citation = {
      eventId: "event-file-delete",
      excerpt: fixture.excerpt.slice(0, 24),
    };

    expect(
      validateAiNarrativeCitations(
        narrative(citation),
        fixture.minimized.snapshot,
      ),
    ).toEqual(narrative(citation));
  });

  it("rejects invented event IDs and mismatched excerpts", () => {
    const fixture = preparedFixture();

    expect(() =>
      validateAiNarrativeCitations(
        narrative({ eventId: "event-invented", excerpt: "invented" }),
        fixture.minimized.snapshot,
      ),
    ).toThrow(AiCitationValidationError);
    expect(() =>
      validateAiNarrativeCitations(
        narrative({
          eventId: "event-file-delete",
          excerpt: "this exact text was never transmitted",
        }),
        fixture.minimized.snapshot,
      ),
    ).toThrow("does not exactly occur");
  });

  it("requires citations for every AI factual or inferential claim group", () => {
    const fixture = preparedFixture();
    const invalid = {
      ...narrative({
        eventId: "event-file-delete",
        excerpt: fixture.excerpt,
      }),
      impact: { statement: "A test file was deleted.", citations: [] },
    };

    expect(() =>
      validateAiNarrativeCitations(invalid, fixture.minimized.snapshot),
    ).toThrow("At least one transmitted evidence citation is required");
  });

  it("caps confidence and leaves deterministic facts intact during enrichment", () => {
    const fixture = preparedFixture();
    const deterministic = IncidentReportSchema.parse({
      ...fixture.report,
      rootCauseHypothesis: {
        ...fixture.report.rootCauseHypothesis,
        confidence: "low",
      },
    });
    const citation = {
      eventId: "event-file-delete",
      excerpt: fixture.excerpt,
    };
    const withAdditionalCounterevidence = {
      ...narrative(citation),
      counterevidence: [
        {
          statement:
            "The target call did not state where its choice came from.",
          citations: [citation],
        },
      ],
    };
    const validated = validateAiNarrativeCitations(
      withAdditionalCounterevidence,
      fixture.minimized.snapshot,
    );
    const merged = mergeAiNarrative({
      deterministic,
      narrative: validated,
      provider: "fixture-provider",
      model: "fixture-model",
      analysisSessionId: "session-analysis-report",
      preflight: fixture.minimized.preflight,
      usage: { inputTokens: 200, outputTokens: 80, totalTokens: 280 },
    });

    expect(merged.factualTimeline).toEqual(deterministic.factualTimeline);
    expect(merged.impact).toBe(deterministic.impact);
    expect(merged.containmentAndRecovery).toEqual(
      deterministic.containmentAndRecovery,
    );
    expect(merged.preventionActions).toEqual(deterministic.preventionActions);
    expect(merged.counterevidence).toEqual(
      expect.arrayContaining([
        ...deterministic.counterevidence,
        {
          eventId: "event-file-delete",
          statement:
            "The target call did not state where its choice came from.",
        },
      ]),
    );
    expect(merged.rootCauseHypothesis.confidence).toBe("low");
    expect(merged.analysis).toMatchObject({
      mode: "ai-enriched",
      provider: "fixture-provider",
      model: "fixture-model",
      externalEvidenceSent: true,
      analysisSessionId: "session-analysis-report",
      transmittedEvidenceSha256: fixture.minimized.preflight.snapshotSha256,
      usage: { inputTokens: 200, outputTokens: 80, totalTokens: 280 },
    });
  });
});
