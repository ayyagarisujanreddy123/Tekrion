import { TekrionEventSchema, SessionSchema } from "@tekrion/protocol";
import { describe, expect, it } from "vitest";

import {
  getIncidentFixture,
  incidentFixtures,
  REQUIRED_INCIDENT_COVERAGE,
} from "../src/index.js";

describe("seeded incident fixtures", () => {
  it("declares eight unique, contract-valid evaluation sessions", () => {
    expect(incidentFixtures).toHaveLength(8);
    expect(new Set(incidentFixtures.map((fixture) => fixture.id)).size).toBe(8);
    expect(incidentFixtures.map((fixture) => fixture.id).sort()).toEqual(
      [...REQUIRED_INCIDENT_COVERAGE].sort(),
    );

    for (const fixture of incidentFixtures) {
      expect(SessionSchema.safeParse(fixture.session).success).toBe(true);
      expect(
        fixture.events.every(
          (event) => TekrionEventSchema.safeParse(event).success,
        ),
      ).toBe(true);
      expect(
        fixture.events.some((event) => event.id === fixture.targetEventId),
      ).toBe(true);
      expect(getIncidentFixture(fixture.id)).toBe(fixture);
    }
  });
});
