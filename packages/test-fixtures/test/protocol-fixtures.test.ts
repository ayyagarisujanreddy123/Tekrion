import { describe, expect, it } from "vitest";

import { TekrionEventSchema } from "../../protocol/src/index.js";
import {
  concatenateBytes,
  getProtocolFixture,
  protocolFixtures,
  REQUIRED_PROTOCOL_COVERAGE,
} from "../src/index.js";

describe("golden protocol fixtures", () => {
  it("covers every protocol and failure contract required by M0", () => {
    const coverage = new Set(
      protocolFixtures.flatMap((fixture) => fixture.covers),
    );

    expect([...coverage].sort()).toEqual(
      [...REQUIRED_PROTOCOL_COVERAGE].sort(),
    );
  });

  it.each(protocolFixtures)("$id preserves exact request bytes", (fixture) => {
    expect(concatenateBytes(fixture.request.chunks)).toEqual(
      fixture.expectedRawBytes.request,
    );
  });

  it.each(protocolFixtures)(
    "$id preserves exact response bytes and chunk order",
    (fixture) => {
      expect(concatenateBytes(fixture.response.chunks)).toEqual(
        fixture.expectedRawBytes.response,
      );
    },
  );

  it.each(protocolFixtures)(
    "$id declares valid canonical event snapshots",
    (fixture) => {
      expect(fixture.expectedCanonicalEvents.length).toBeGreaterThan(0);

      for (const event of fixture.expectedCanonicalEvents) {
        expect(TekrionEventSchema.safeParse(event).success).toBe(true);
      }
    },
  );

  it("contains a transport boundary inside a Responses SSE data line", () => {
    const fixture = getProtocolFixture("responses-sse-text-function");

    expect(fixture.response.chunks[1]).toBeDefined();
    expect(
      new TextDecoder()
        .decode(fixture.response.chunks[1])
        .endsWith("response.output_"),
    ).toBe(true);
  });

  it("keeps every non-error SSE data line valid JSON", () => {
    const decoder = new TextDecoder();
    const fixtures = protocolFixtures.filter(
      (fixture) =>
        fixture.response.headers["content-type"] === "text/event-stream" &&
        fixture.id !== "malformed-sse-line" &&
        fixture.id !== "mid-stream-disconnect",
    );

    for (const fixture of fixtures) {
      const body = decoder.decode(concatenateBytes(fixture.response.chunks));
      const dataLines = body
        .split("\n")
        .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]");

      for (const line of dataLines) {
        expect(() => JSON.parse(line.slice("data: ".length))).not.toThrow();
      }
    }
  });

  it("uses unknown rather than zero when usage is absent", () => {
    const fixture = getProtocolFixture("usage-absent");
    const event = TekrionEventSchema.parse(
      fixture.expectedCanonicalEvents.find((candidate) => {
        const parsed = TekrionEventSchema.safeParse(candidate);
        return (
          parsed.success && parsed.data.type === "model.response.completed"
        );
      }),
    );

    expect(event.summary).toMatchObject({
      usage: "unknown",
      inputTokens: null,
      outputTokens: null,
    });
  });

  it("marks the missing predecessor fixture as a partial client chain", () => {
    const fixture = getProtocolFixture("missing-previous-response");
    const event = TekrionEventSchema.parse(fixture.expectedCanonicalEvents[0]);

    expect(event.summary).toMatchObject({
      contextCompleteness: "partial-client-chain",
      missingAncestorIds: ["resp_not_recorded"],
    });
  });
});
