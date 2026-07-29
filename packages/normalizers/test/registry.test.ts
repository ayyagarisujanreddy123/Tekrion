import { protocolFixtures, type ProtocolFixture } from "@tekrion/test-fixtures";
import { describe, expect, it } from "vitest";

import {
  DefaultNormalizerRegistry,
  NormalizationExchangeSchema,
} from "../src/index.js";

const FIXTURE_TIME = "2026-07-15T12:00:00.000Z";

function exchangeFromFixture(fixture: ProtocolFixture) {
  return NormalizationExchangeSchema.parse({
    schemaVersion: 1,
    id: fixture.id,
    sessionId: "session-golden-protocol",
    rawSequence: 1,
    protocol: fixture.protocol,
    method: fixture.request.method,
    path: fixture.request.path,
    query: {},
    requestHeaders: fixture.request.headers,
    requestBody: fixture.expectedRawBytes.request,
    responseStatus: fixture.response.status,
    responseHeaders: fixture.response.headers,
    responseBody: fixture.expectedRawBytes.response,
    startedAt: FIXTURE_TIME,
    firstByteAt: FIXTURE_TIME,
    endedAt: FIXTURE_TIME,
    outcome: fixture.response.outcome,
    capture: {
      requestComplete: true,
      responseComplete: fixture.response.outcome === "completed",
      droppedRequestBytes: 0,
      droppedResponseBytes: 0,
    },
  });
}

describe("default normalizer registry", () => {
  it.each(protocolFixtures.map((fixture) => [fixture.id, fixture] as const))(
    "routes %s to its parser and matches the canonical snapshot",
    (_id, fixture) => {
      const result = new DefaultNormalizerRegistry().normalize(
        exchangeFromFixture(fixture),
      );

      expect(result.events).toEqual(fixture.expectedCanonicalEvents);
    },
  );
});
