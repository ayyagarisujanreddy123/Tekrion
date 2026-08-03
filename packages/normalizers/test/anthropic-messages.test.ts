import { Buffer } from "node:buffer";
import { gzipSync } from "node:zlib";

import { protocolFixtures, type ProtocolFixture } from "@tekrion/test-fixtures";
import { describe, expect, it } from "vitest";

import {
  ANTHROPIC_MESSAGES_NORMALIZER_VERSION,
  AnthropicMessagesNormalizer,
  NormalizationExchangeSchema,
  type NormalizationExchange,
} from "../src/index.js";

const FIXTURE_TIME = "2026-07-15T12:00:00.000Z";
const FIXTURE_SESSION = "session-golden-protocol";

function exchangeFromFixture(fixture: ProtocolFixture): NormalizationExchange {
  return NormalizationExchangeSchema.parse({
    schemaVersion: 1,
    id: fixture.id,
    sessionId: FIXTURE_SESSION,
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

describe("Anthropic Messages normalization", () => {
  const normalizer = new AnthropicMessagesNormalizer();
  const fixtures = protocolFixtures.filter(
    (fixture) => fixture.protocol === "anthropic.messages",
  );

  it.each(fixtures.map((fixture) => [fixture.id, fixture] as const))(
    "matches the %s canonical snapshot",
    (_id, fixture) => {
      const result = normalizer.normalize(exchangeFromFixture(fixture));

      expect(result.events).toEqual(fixture.expectedCanonicalEvents);
      expect(result.parserVersion).toBe(ANTHROPIC_MESSAGES_NORMALIZER_VERSION);
      expect(result.parserId).toMatch(/^anthropic\.messages\.(json|sse)$/u);
    },
  );

  it.each(fixtures.map((fixture) => [fixture.id, fixture] as const))(
    "normalizes gzip-compressed %s responses without changing raw bytes",
    (_id, fixture) => {
      const uncompressed = exchangeFromFixture(fixture);
      const compressed = gzipSync(
        Buffer.from(uncompressed.responseBody as Uint8Array),
      );
      const retainedSnapshot = Buffer.from(compressed);
      const exchange = NormalizationExchangeSchema.parse({
        ...uncompressed,
        responseHeaders: {
          ...uncompressed.responseHeaders,
          "Content-Encoding": ["GZip"],
        },
        responseBody: compressed,
      });

      const result = normalizer.normalize(exchange);

      expect(result.status).toBe("parsed");
      expect(result.diagnostics).toEqual([]);
      expect(result.events).toEqual(fixture.expectedCanonicalEvents);
      expect(exchange.responseBody).toEqual(retainedSnapshot);
      expect(compressed).toEqual(retainedSnapshot);
    },
  );

  it("records corrupt gzip as malformed normalization evidence", () => {
    const fixture = fixtures.find(
      (candidate) => candidate.id === "anthropic-messages-sse",
    ) as ProtocolFixture;
    const result = normalizer.normalize(
      NormalizationExchangeSchema.parse({
        ...exchangeFromFixture(fixture),
        responseHeaders: {
          ...fixture.response.headers,
          "content-encoding": ["gzip"],
        },
        responseBody: Buffer.from("not-a-valid-gzip-stream"),
      }),
    );

    expect(result.status).toBe("malformed");
    expect(result.events.map((event) => event.type)).toEqual([
      "model.request",
      "parser.error",
    ]);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        kind: "invalid-payload",
        eventType: "content-encoding",
        fatal: true,
        message: "Anthropic gzip response could not be decoded.",
      }),
    );
  });

  it("bounds gzip decompression before Anthropic JSON parsing", () => {
    const fixture = fixtures.find(
      (candidate) => candidate.id === "anthropic-messages-json",
    ) as ProtocolFixture;
    const uncompressed = exchangeFromFixture(fixture);
    const responseBody = Buffer.from(uncompressed.responseBody as Uint8Array);
    const result = normalizer.normalize(
      NormalizationExchangeSchema.parse({
        ...uncompressed,
        responseHeaders: {
          ...uncompressed.responseHeaders,
          "content-encoding": ["gzip"],
        },
        responseBody: gzipSync(responseBody),
      }),
      { maxDecodedResponseBodyBytes: responseBody.length - 1 },
    );

    expect(result.status).toBe("malformed");
    expect(result.events.map((event) => event.type)).toContain("parser.error");
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        kind: "invalid-payload",
        fatal: true,
        message: `Anthropic gzip response exceeded the ${responseBody.length - 1}-byte decoded-body limit.`,
      }),
    );
  });

  it.each([
    ["br", "br"],
    ["an oversized token", "x".repeat(8_192)],
  ] as const)(
    "rejects unsupported response content encoding %s explicitly",
    (_case, encoding) => {
      const fixture = fixtures.find(
        (candidate) => candidate.id === "anthropic-messages-json",
      ) as ProtocolFixture;
      const uncompressed = exchangeFromFixture(fixture);
      const result = normalizer.normalize(
        NormalizationExchangeSchema.parse({
          ...uncompressed,
          responseHeaders: {
            ...uncompressed.responseHeaders,
            "content-encoding": [encoding],
          },
        }),
      );

      expect(result.status).toBe("malformed");
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({
          kind: "invalid-payload",
          eventType: "content-encoding",
          fatal: true,
          message: "Anthropic response uses an unsupported content encoding.",
        }),
      );
    },
  );

  it("retains provider-specific blocks while keeping thinking opaque", () => {
    const fixture = fixtures.find(
      (candidate) => candidate.id === "anthropic-messages-json",
    ) as ProtocolFixture;
    const responseBody = Buffer.from(
      JSON.stringify({
        id: "msg_provider_blocks",
        type: "message",
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "private visible reasoning fixture",
            signature: "signature-fixture",
          },
          { type: "future_block", nested: { value: 42 } },
        ],
        stop_reason: "end_turn",
      }),
    );

    const result = normalizer.normalize(
      NormalizationExchangeSchema.parse({
        ...exchangeFromFixture(fixture),
        id: "anthropic-provider-blocks",
        responseBody,
      }),
    );
    const unknown = result.events.filter(
      (event) => event.type === "provider.item.unknown",
    );

    expect(unknown).toHaveLength(2);
    expect(unknown[0]?.summary).toEqual({
      itemType: "thinking",
      opaque: true,
      rawPayloadPreserved: true,
    });
    expect(JSON.stringify(unknown[0]?.summary)).not.toContain(
      "private visible reasoning fixture",
    );
    expect(unknown[1]?.summary).toMatchObject({
      itemType: "future_block",
      rawPayloadPreserved: true,
    });
  });

  it("normalizes Anthropic JSON API errors", () => {
    const fixture = fixtures.find(
      (candidate) => candidate.id === "anthropic-messages-json",
    ) as ProtocolFixture;
    const result = normalizer.normalize(
      NormalizationExchangeSchema.parse({
        ...exchangeFromFixture(fixture),
        id: "anthropic-api-error",
        responseStatus: 429,
        responseBody: Buffer.from(
          JSON.stringify({
            type: "error",
            error: {
              type: "rate_limit_error",
              message: "Rate limit reached.",
            },
            request_id: "req_fixture",
          }),
        ),
      }),
    );

    expect(
      result.events.find((event) => event.type === "api.error")?.summary,
    ).toEqual({
      status: 429,
      type: "rate_limit_error",
      message: "Rate limit reached.",
      requestId: "req_fixture",
    });
  });

  it("returns unsupported without inventing events for OpenAI traffic", () => {
    const fixture = protocolFixtures.find(
      (candidate) => candidate.protocol === "openai.responses",
    ) as ProtocolFixture;

    expect(normalizer.normalize(exchangeFromFixture(fixture))).toMatchObject({
      status: "unsupported",
      events: [],
    });
  });
});
