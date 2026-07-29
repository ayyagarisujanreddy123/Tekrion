import { Buffer } from "node:buffer";

import { protocolFixtures, type ProtocolFixture } from "@tekrion/test-fixtures";
import { describe, expect, it } from "vitest";

import {
  CHAT_COMPLETIONS_NORMALIZER_VERSION,
  ChatCompletionsNormalizer,
  DefaultNormalizerRegistry,
  NormalizationExchangeSchema,
  type NormalizationExchange,
} from "../src/index.js";

const FIXTURE_TIME = "2026-07-15T12:00:00.000Z";

function exchangeFromFixture(fixture: ProtocolFixture): NormalizationExchange {
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

describe("OpenAI Chat Completions normalization", () => {
  const normalizer = new ChatCompletionsNormalizer();
  const fixtures = protocolFixtures.filter(
    (fixture) => fixture.protocol === "openai.chat-completions",
  );

  it.each(fixtures.map((fixture) => [fixture.id, fixture] as const))(
    "matches the %s canonical snapshot",
    (_id, fixture) => {
      const result = normalizer.normalize(exchangeFromFixture(fixture));

      expect(result.events).toEqual(fixture.expectedCanonicalEvents);
      expect(result.parserVersion).toBe(CHAT_COMPLETIONS_NORMALIZER_VERSION);
      expect(result.parserId).toMatch(
        /^openai\.chat-completions\.(json|sse)$/u,
      );
    },
  );

  it("emits correlated tool results and non-streaming calls", () => {
    const fixture = fixtures.find(
      (candidate) => candidate.id === "chat-json",
    ) as ProtocolFixture;
    const requestBody = Buffer.from(
      JSON.stringify({
        model: "gpt-tools",
        messages: [
          {
            role: "tool",
            tool_call_id: "tool_previous",
            content: "previous output",
          },
        ],
      }),
    );
    const responseBody = Buffer.from(
      JSON.stringify({
        id: "chatcmpl_tools",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "tool_next",
                  type: "function",
                  function: {
                    name: "write_file",
                    arguments: '{"path":"out.txt","text":"hello"}',
                  },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      }),
    );
    const result = normalizer.normalize(
      NormalizationExchangeSchema.parse({
        ...exchangeFromFixture(fixture),
        id: "chat-tools-json",
        requestBody,
        responseBody,
      }),
    );

    expect(result.events.map((event) => event.type)).toEqual([
      "tool.result",
      "model.request",
      "tool.call",
      "model.response.completed",
    ]);
    expect(result.events[0]?.summary).toEqual({
      callId: "tool_previous",
      output: "previous output",
    });
    expect(result.events[2]?.summary).toEqual({
      callId: "tool_next",
      name: "write_file",
      arguments: { path: "out.txt", text: "hello" },
    });
    expect(result.events[3]?.summary).toMatchObject({
      usage: "unknown",
      inputTokens: null,
      outputTokens: null,
    });
  });

  it("keeps interleaved choices and tool indexes separate", () => {
    const fixture = fixtures.find(
      (candidate) => candidate.id === "chat-sse-content-tools",
    ) as ProtocolFixture;
    const frames = [
      {
        id: "chatcmpl_multi",
        choices: [
          {
            index: 1,
            delta: {
              content: "choice one",
              tool_calls: [
                {
                  index: 1,
                  id: "tool_choice_1",
                  function: { name: "one", arguments: '{"value":' },
                },
              ],
            },
            finish_reason: null,
          },
          {
            index: 0,
            delta: {
              content: "choice zero",
              tool_calls: [
                {
                  index: 0,
                  id: "tool_choice_0",
                  function: { name: "zero", arguments: '{"value":' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        id: "chatcmpl_multi",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 0, function: { arguments: "0}" } }],
            },
            finish_reason: "tool_calls",
          },
          {
            index: 1,
            delta: {
              tool_calls: [{ index: 1, function: { arguments: "1}" } }],
            },
            finish_reason: "tool_calls",
          },
        ],
      },
    ];
    const responseBody = Buffer.from(
      `${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("")}data: [DONE]\n\n`,
    );
    const result = normalizer.normalize(
      NormalizationExchangeSchema.parse({
        ...exchangeFromFixture(fixture),
        id: "chat-interleaved",
        responseBody,
      }),
    );

    const messages = result.events.filter(
      (event) => event.type === "message.assistant",
    );
    const calls = result.events.filter((event) => event.type === "tool.call");
    expect(messages.map((event) => event.summary)).toEqual([
      { text: "choice zero" },
      { choiceIndex: 1, text: "choice one" },
    ]);
    expect(calls.map((event) => event.summary)).toEqual([
      {
        callId: "tool_choice_0",
        name: "zero",
        arguments: { value: 0 },
      },
      {
        callId: "tool_choice_1",
        name: "one",
        arguments: { value: 1 },
        choiceIndex: 1,
      },
    ]);
  });

  it("retains future delta fields as unknown evidence", () => {
    const fixture = fixtures.find(
      (candidate) => candidate.id === "chat-sse-content-tools",
    ) as ProtocolFixture;
    const responseBody = Buffer.from(
      'data: {"id":"chat_future","choices":[{"index":0,"delta":{"future_audio":{"id":"audio_1"}},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
    );
    const result = normalizer.normalize(
      NormalizationExchangeSchema.parse({
        ...exchangeFromFixture(fixture),
        id: "chat-future-delta",
        responseBody,
      }),
    );

    expect(
      result.events.find((event) => event.type === "provider.delta.unknown"),
    ).toMatchObject({
      evidence: "unknown",
      summary: {
        choiceIndex: 0,
        payload: { future_audio: { id: "audio_1" } },
        rawPayloadPreserved: true,
      },
    });
  });

  it("does not confuse repeated response IDs with replays", () => {
    const fixture = fixtures.find(
      (candidate) => candidate.id === "chat-sse-content-tools",
    ) as ProtocolFixture;
    const responseBody = Buffer.from(
      [
        'data: {"id":"chatcmpl_same","choices":[{"index":0,"delta":{"content":"one"},"finish_reason":null}]}\n\n',
        'data: {"id":"chatcmpl_same","choices":[{"index":0,"delta":{"content":" two"},"finish_reason":"stop"}]}\n\n',
        "data: [DONE]\n\n",
      ].join(""),
    );
    const result = normalizer.normalize(
      NormalizationExchangeSchema.parse({
        ...exchangeFromFixture(fixture),
        id: "chat-repeated-response-id",
        responseBody,
      }),
    );

    expect(
      result.events.find((event) => event.type === "message.assistant")
        ?.summary,
    ).toEqual({ text: "one two" });
    expect(result.diagnostics).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "duplicate-replay" }),
      ]),
    );
  });

  it("handles identified Chat SSE replays and conflicts explicitly", () => {
    const fixture = fixtures.find(
      (candidate) => candidate.id === "chat-sse-content-tools",
    ) as ProtocolFixture;
    const first =
      'id: chunk-1\ndata: {"id":"chatcmpl_replay","choices":[{"index":0,"delta":{"content":"first"},"finish_reason":null}]}\n\n';
    const terminal =
      'id: chunk-2\ndata: {"id":"chatcmpl_replay","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n';
    const replayed = new DefaultNormalizerRegistry().normalize(
      NormalizationExchangeSchema.parse({
        ...exchangeFromFixture(fixture),
        id: "chat-identical-replay",
        responseBody: Buffer.from(`${first}${first}${terminal}`),
      }),
    );
    const conflicting = new DefaultNormalizerRegistry().normalize(
      NormalizationExchangeSchema.parse({
        ...exchangeFromFixture(fixture),
        id: "chat-conflicting-replay",
        responseBody: Buffer.from(
          `${first}id: chunk-1\ndata: {"id":"chatcmpl_replay","choices":[{"index":0,"delta":{"content":"second"},"finish_reason":null}]}\n\n${terminal}`,
        ),
      }),
    );

    expect(
      replayed.events.find((event) => event.type === "message.assistant")
        ?.summary,
    ).toEqual({ text: "first" });
    expect(replayed.events.map((event) => event.type)).toContain(
      "parser.replay_ignored",
    );
    expect(conflicting.status).toBe("malformed");
    expect(conflicting.events.map((event) => event.type)).toContain(
      "parser.error",
    );
    expect(
      conflicting.events.find((event) => event.type === "message.assistant")
        ?.summary,
    ).toEqual({ text: "first" });
  });
});
