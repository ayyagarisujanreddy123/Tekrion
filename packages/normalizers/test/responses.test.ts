import { Buffer } from "node:buffer";

import {
  protocolFixtures,
  type ProtocolFixture,
} from "@blackbox/test-fixtures";
import { describe, expect, it } from "vitest";

import {
  DefaultNormalizerRegistry,
  NormalizationExchangeSchema,
  RESPONSES_NORMALIZER_VERSION,
  ResponsesNormalizer,
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

describe("OpenAI Responses normalization", () => {
  const normalizer = new ResponsesNormalizer();
  const fixtures = protocolFixtures.filter(
    (fixture) => fixture.protocol === "openai.responses",
  );

  it.each(fixtures.map((fixture) => [fixture.id, fixture] as const))(
    "matches the %s canonical snapshot",
    (_id, fixture) => {
      const result = normalizer.normalize(exchangeFromFixture(fixture));

      expect(result.events).toEqual(fixture.expectedCanonicalEvents);
      expect(result.parserVersion).toBe(RESPONSES_NORMALIZER_VERSION);
      expect(result.parserId).toMatch(/^openai\.responses\.(json|sse)$/u);
    },
  );

  it("retains unknown output items as visible canonical evidence", () => {
    const request = Buffer.from('{"model":"gpt-future","input":"hello"}');
    const response = Buffer.from(
      JSON.stringify({
        id: "resp_future",
        status: "completed",
        output: [
          {
            type: "future_reasoning_artifact",
            id: "future_1",
            nested: { value: 42 },
          },
        ],
      }),
    );
    const exchange = NormalizationExchangeSchema.parse({
      ...exchangeFromFixture(fixtures[0] as ProtocolFixture),
      id: "responses-future-item",
      requestBody: request,
      responseBody: response,
      responseHeaders: { "content-type": "application/json" },
    });

    const result = normalizer.normalize(exchange);
    expect(result.events.map((event) => event.type)).toEqual([
      "model.request",
      "provider.item.unknown",
      "model.response.completed",
    ]);
    expect(result.events[1]).toMatchObject({
      evidence: "unknown",
      summary: {
        itemType: "future_reasoning_artifact",
        itemId: "future_1",
        payload: { nested: { value: 42 } },
        rawPayloadPreserved: true,
      },
    });
    expect(result.events[2]?.summary).toMatchObject({
      usage: "unknown",
      inputTokens: null,
      outputTokens: null,
    });
  });

  it("labels a recorded previous response as a complete client chain", () => {
    const fixture = protocolFixtures.find(
      (candidate) => candidate.id === "missing-previous-response",
    ) as ProtocolFixture;
    const result = normalizer.normalize(exchangeFromFixture(fixture), {
      knownResponseIds: new Set(["resp_not_recorded"]),
    });

    expect(result.events[0]?.summary).toEqual({
      previousResponseId: "resp_not_recorded",
      contextCompleteness: "complete-client-chain",
    });
  });

  it("assembles function arguments from deltas without relying on a done payload", () => {
    const fixture = fixtures.find(
      (candidate) => candidate.id === "responses-sse-text-function",
    ) as ProtocolFixture;
    const responseBody = Buffer.from(
      [
        'event: response.output_item.added\ndata: {"type":"response.output_item.added","item":{"type":"function_call","id":"item_delta","call_id":"call_delta","name":"read_file"}}\n\n',
        'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","item_id":"item_delta","delta":"{\\"path\\":\\"READ"}\n\n',
        'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","item_id":"item_delta","delta":"ME.md\\"}"}\n\n',
        'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_delta","status":"completed"}}\n\n',
      ].join(""),
    );
    const result = normalizer.normalize(
      NormalizationExchangeSchema.parse({
        ...exchangeFromFixture(fixture),
        id: "responses-delta-only",
        responseBody,
      }),
    );

    expect(
      result.events.find((event) => event.type === "tool.call")?.summary,
    ).toEqual({
      callId: "call_delta",
      name: "read_file",
      arguments: { path: "README.md" },
    });
  });

  it("returns unsupported without inventing events for another protocol", () => {
    const fixture = protocolFixtures.find(
      (candidate) => candidate.protocol === "openai.chat-completions",
    ) as ProtocolFixture;
    const result = normalizer.normalize(exchangeFromFixture(fixture));

    expect(result).toMatchObject({ status: "unsupported", events: [] });
  });

  it("recognizes an SSE response when an upstream omits content-type", () => {
    const fixture = fixtures.find(
      (candidate) => candidate.id === "responses-sse-text-function",
    ) as ProtocolFixture;
    const result = normalizer.normalize(
      NormalizationExchangeSchema.parse({
        ...exchangeFromFixture(fixture),
        id: "responses-sse-without-content-type",
        responseHeaders: {},
      }),
    );

    expect(result).toMatchObject({
      parserId: "openai.responses.sse",
      status: "parsed",
    });
    expect(result.events.map((event) => event.type)).not.toContain(
      "parser.error",
    );
    expect(
      result.events.find((event) => event.type === "message.assistant")
        ?.summary,
    ).toMatchObject({ text: "I will check." });
  });

  it("ignores identical identified SSE replays with visible evidence", () => {
    const fixture = fixtures.find(
      (candidate) => candidate.id === "responses-sse-text-function",
    ) as ProtocolFixture;
    const delta =
      'id: delta-1\nevent: response.output_text.delta\ndata: {"type":"response.output_text.delta","item_id":"msg_replay","delta":"first"}\n\n';
    const responseBody = Buffer.from(
      `${delta}${delta}id: terminal-1\nevent: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_replay","status":"completed"}}\n\n`,
    );
    const result = new DefaultNormalizerRegistry().normalize(
      NormalizationExchangeSchema.parse({
        ...exchangeFromFixture(fixture),
        id: "responses-identical-replay",
        responseBody,
      }),
    );

    expect(
      result.events.find((event) => event.type === "message.assistant")
        ?.summary,
    ).toEqual({ messageId: "msg_replay", text: "first" });
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ kind: "duplicate-replay", frameIndex: 2 }),
    );
    expect(result.events.map((event) => event.type)).toContain(
      "parser.replay_ignored",
    );
  });

  it("keeps the first identified SSE payload and exposes conflicts", () => {
    const fixture = fixtures.find(
      (candidate) => candidate.id === "responses-sse-text-function",
    ) as ProtocolFixture;
    const responseBody = Buffer.from(
      [
        'id: delta-1\nevent: response.output_text.delta\ndata: {"type":"response.output_text.delta","item_id":"msg_conflict","delta":"first"}\n\n',
        'id: delta-1\nevent: response.output_text.delta\ndata: {"type":"response.output_text.delta","item_id":"msg_conflict","delta":"second"}\n\n',
        'id: terminal-1\nevent: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_conflict","status":"completed"}}\n\n',
      ].join(""),
    );
    const result = new DefaultNormalizerRegistry().normalize(
      NormalizationExchangeSchema.parse({
        ...exchangeFromFixture(fixture),
        id: "responses-conflicting-replay",
        responseBody,
      }),
    );

    expect(result.status).toBe("malformed");
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ kind: "duplicate-conflict", frameIndex: 2 }),
    );
    expect(result.events.map((event) => event.type)).toContain("parser.error");
    expect(
      result.events.find((event) => event.type === "message.assistant")
        ?.summary,
    ).toEqual({ messageId: "msg_conflict", text: "first" });
  });
});
