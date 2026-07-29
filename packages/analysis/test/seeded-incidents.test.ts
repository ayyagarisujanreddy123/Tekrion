import { analyzeDeterministically } from "@tekrion/analysis";
import {
  incidentFixtures,
  REQUIRED_INCIDENT_COVERAGE,
} from "@tekrion/test-fixtures";
import type { BlameConfidence } from "@tekrion/protocol";
import { describe, expect, it } from "vitest";

const CONFIDENCE_ORDER: Readonly<Record<BlameConfidence, number>> = {
  low: 0,
  medium: 1,
  high: 2,
};

function stringsIn(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap(stringsIn);
  }
  if (typeof value === "object" && value !== null) {
    return Object.values(value).flatMap(stringsIn);
  }
  return [];
}

describe("seeded incident evaluation set", () => {
  it("covers every declared M7 incident class", () => {
    expect(incidentFixtures.map((fixture) => fixture.id).sort()).toEqual(
      [...REQUIRED_INCIDENT_COVERAGE].sort(),
    );
  });

  it.each(incidentFixtures)(
    "$id satisfies deterministic ranking and anomaly expectations",
    (fixture) => {
      const result = analyzeDeterministically({
        session: fixture.session,
        events: fixture.events,
        targetEventId: fixture.targetEventId,
        ...(fixture.context === undefined ? {} : { context: fixture.context }),
      });
      const target = fixture.events.find(
        (event) => event.id === fixture.targetEventId,
      );
      const ruleIds = result.anomalies.findings.map(
        (finding) => finding.ruleId,
      );

      expect(target).toBeDefined();
      expect(CONFIDENCE_ORDER[result.blame.confidence]).toBeLessThanOrEqual(
        CONFIDENCE_ORDER[fixture.expected.confidenceCeiling],
      );
      if (fixture.expected.topCandidateEventId !== undefined) {
        expect(result.blame.candidates[0]?.eventId).toBe(
          fixture.expected.topCandidateEventId,
        );
      }
      for (const ruleId of fixture.expected.requiredAnomalyRuleIds) {
        expect(ruleIds).toContain(ruleId);
      }
      for (const ruleId of fixture.expected.forbiddenAnomalyRuleIds ?? []) {
        expect(ruleIds).not.toContain(ruleId);
      }
      for (const eventId of fixture.expected.excludedCandidateEventIds ?? []) {
        expect(
          result.blame.candidates.map((candidate) => candidate.eventId),
        ).not.toContain(eventId);
      }
      for (const candidate of result.blame.candidates) {
        const event = fixture.events.find(
          (value) => value.id === candidate.eventId,
        );
        expect(event).toBeDefined();
        expect(event?.sequence).toBeLessThan(target?.sequence ?? 0);
      }
      if (result.blame.primaryOrigin !== undefined) {
        const origin = fixture.events.find(
          (event) => event.id === result.blame.primaryOrigin?.eventId,
        );
        expect(origin).toBeDefined();
        expect(
          stringsIn(origin?.summary).some((value) =>
            value.includes(result.blame.primaryOrigin?.excerpt ?? ""),
          ),
        ).toBe(true);
      }
      if (fixture.id === "secret-like-tool-output") {
        expect(JSON.stringify(result.anomalies)).not.toContain(
          "fixture_secret_value_1234567890",
        );
      }
    },
  );
});
