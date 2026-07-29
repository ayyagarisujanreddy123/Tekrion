import { createHash } from "node:crypto";

import {
  ContextReconstructor,
  type ContextEventOrigin,
  type ContextEvidenceSource,
} from "../src/index.js";
import {
  TekrionEventSchema,
  RawExchangeSchema,
  type TekrionEvent,
  type RawExchange,
  type RawExchangeProtocol,
} from "@tekrion/protocol";
import { describe, expect, it } from "vitest";

const TIME = "2026-07-16T12:00:00.000Z";
const SESSION = "session-context";

interface TurnInput {
  readonly id: string;
  readonly protocol: RawExchangeProtocol;
  readonly request: unknown;
  readonly responseId?: string;
  readonly outputEvents?: readonly {
    readonly type: string;
    readonly summary: Record<string, unknown>;
    readonly evidence?: TekrionEvent["evidence"];
  }[];
  readonly reportedInputTokens?: number;
  readonly requestComplete?: boolean;
  readonly responseComplete?: boolean;
}

class FixtureSource implements ContextEvidenceSource {
  private sequence = 1;
  private readonly events = new Map<string, TekrionEvent>();
  private readonly origins = new Map<string, ContextEventOrigin>();
  private readonly exchanges = new Map<string, RawExchange>();
  private readonly eventsByExchange = new Map<string, TekrionEvent[]>();
  private readonly payloads = new Map<string, Uint8Array>();

  addTurn(input: TurnInput): TekrionEvent {
    const exchangeId = `exchange-${input.id}`;
    const requestEventId = `request-${input.id}`;
    const bytes = new TextEncoder().encode(JSON.stringify(input.request));
    const payloadId = `payload-${input.id}`;
    this.payloads.set(payloadId, bytes);
    const exchange = RawExchangeSchema.parse({
      schemaVersion: 1,
      id: exchangeId,
      sessionId: SESSION,
      sequence: this.sequence,
      protocol: input.protocol,
      method: "POST",
      path:
        input.protocol === "openai.chat-completions"
          ? "/v1/chat/completions"
          : input.protocol === "anthropic.messages"
            ? "/v1/messages"
            : "/v1/responses",
      query: {},
      requestHeaders: { "content-type": ["application/json"] },
      requestBodyRef: {
        id: payloadId,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        codec: "identity",
        mediaType: "application/json",
        byteLength: bytes.byteLength,
        truncated: input.requestComplete === false,
      },
      responseStatus: 200,
      responseHeaders: { "content-type": ["application/json"] },
      startedAt: TIME,
      endedAt: TIME,
      outcome:
        input.responseComplete === false ? "capture-incomplete" : "completed",
      parseStatus: "parsed",
      capture: {
        requestComplete: input.requestComplete !== false,
        responseComplete: input.responseComplete !== false,
        droppedRequestBytes: input.requestComplete === false ? 1 : 0,
        droppedResponseBytes: input.responseComplete === false ? 1 : 0,
      },
    });
    this.exchanges.set(exchange.id, exchange);

    const turnEvents: TekrionEvent[] = [];
    const addEvent = (
      id: string,
      type: string,
      summary: Record<string, unknown>,
      evidence: TekrionEvent["evidence"] = "observed",
    ) => {
      const event = TekrionEventSchema.parse({
        schemaVersion: 1,
        id,
        sessionId: SESSION,
        sequence: this.sequence,
        occurredAt: TIME,
        observedAt: TIME,
        source: "proxy",
        type,
        evidence,
        summary,
        redaction: { applied: false, ruleIds: [] },
      });
      this.sequence += 1;
      this.events.set(event.id, event);
      this.origins.set(event.id, { rawExchangeId: exchange.id });
      turnEvents.push(event);
      return event;
    };

    const request = addEvent(requestEventId, "model.request", {
      endpoint: exchange.path,
    });
    for (const [index, output] of (input.outputEvents ?? []).entries()) {
      addEvent(
        `output-${input.id}-${index}`,
        output.type,
        output.summary,
        output.evidence,
      );
    }
    if (input.reportedInputTokens !== undefined) {
      addEvent(`usage-${input.id}`, "model.usage", {
        inputTokens: input.reportedInputTokens,
        outputTokens: 1,
        totalTokens: input.reportedInputTokens + 1,
      });
    }
    if (input.responseId !== undefined) {
      addEvent(`response-${input.id}`, "model.response.completed", {
        responseId: input.responseId,
      });
    }
    this.eventsByExchange.set(exchange.id, turnEvents);
    return request;
  }

  getEvent(eventId: string): TekrionEvent | undefined {
    return this.events.get(eventId);
  }

  getEventOrigin(eventId: string): ContextEventOrigin | undefined {
    return this.origins.get(eventId);
  }

  getExchange(exchangeId: string): RawExchange | undefined {
    return this.exchanges.get(exchangeId);
  }

  getEventsForExchange(exchangeId: string): readonly TekrionEvent[] {
    return this.eventsByExchange.get(exchangeId) ?? [];
  }

  findResponseEvent(
    sessionId: string,
    responseId: string,
  ): TekrionEvent | undefined {
    return [...this.events.values()].find(
      (event) =>
        event.sessionId === sessionId &&
        event.type === "model.response.completed" &&
        event.summary.responseId === responseId,
    );
  }

  getPayload(payloadId: string): Promise<Uint8Array> {
    const payload = this.payloads.get(payloadId);
    if (payload === undefined) {
      return Promise.reject(new Error(`Missing payload ${payloadId}.`));
    }
    return Promise.resolve(payload);
  }
}

describe("client-visible context reconstruction", () => {
  it("reconstructs an explicit Anthropic Messages request with tool results", async () => {
    const source = new FixtureSource();
    const request = source.addTurn({
      id: "anthropic",
      protocol: "anthropic.messages",
      request: {
        model: "claude-sonnet-4-6",
        system: "Stay within the repository.",
        messages: [
          { role: "user", content: "Inspect README.md." },
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "tool-read",
                name: "read_file",
                input: { path: "README.md" },
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "tool-read",
                content: "README contents",
              },
              { type: "text", text: "Continue." },
            ],
          },
        ],
        tools: [
          {
            name: "read_file",
            input_schema: { type: "object" },
          },
        ],
        max_tokens: 1024,
      },
      responseId: "msg-anthropic",
      reportedInputTokens: 42,
    });

    const result = await new ContextReconstructor(source).reconstruct(
      request.id,
    );

    expect(result.completeness).toBe("exact-client-request");
    expect(result.reportedInputTokens).toBe(42);
    expect(result.items.map((item) => item.kind)).toEqual([
      "instructions",
      "message",
      "tool-call",
      "message",
      "tool-result",
      "tool-definition",
      "settings",
    ]);
    expect(result.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "tool-call",
          summary: expect.objectContaining({
            callId: "tool-read",
            name: "read_file",
            arguments: { path: "README.md" },
          }),
        }),
        expect.objectContaining({
          kind: "tool-result",
          summary: expect.objectContaining({
            callId: "tool-read",
            output: "README contents",
          }),
        }),
      ]),
    );
  });

  it("labels an explicit Chat Completions history as the exact client request", async () => {
    const source = new FixtureSource();
    const request = source.addTurn({
      id: "chat",
      protocol: "openai.chat-completions",
      request: {
        model: "gpt-5.2",
        messages: [
          { role: "system", content: "Stay within the repository." },
          { role: "user", content: "Inspect README.md." },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call-read",
                type: "function",
                function: { name: "read_file", arguments: "{}" },
              },
            ],
          },
          {
            role: "tool",
            tool_call_id: "call-read",
            content: "README contents",
          },
        ],
        tools: [
          { type: "function", function: { name: "read_file", parameters: {} } },
        ],
        temperature: 0,
      },
      responseId: "chat-response",
      reportedInputTokens: 31,
    });

    const result = await new ContextReconstructor(source).reconstruct(
      request.id,
    );

    expect(result.completeness).toBe("exact-client-request");
    expect(result.reportedInputTokens).toBe(31);
    expect(result.estimatedInputTokens).toBeGreaterThan(0);
    expect(result.items.map((item) => item.kind)).toEqual([
      "message",
      "message",
      "tool-call",
      "tool-result",
      "tool-definition",
      "settings",
    ]);
    expect(result.items.slice(0, 2).map((item) => item.role)).toEqual([
      "system",
      "user",
    ]);
    expect(result.items[0]?.provenance).toMatchObject({
      eventId: request.id,
      exchangeId: "exchange-chat",
      payloadRef: { id: "payload-chat" },
    });
    expect(result.limitationReasons).toEqual([]);
  });

  it("reconstructs a complete Responses chain without carrying prior top-level instructions", async () => {
    const source = new FixtureSource();
    source.addTurn({
      id: "root",
      protocol: "openai.responses",
      request: {
        model: "gpt-5.2",
        instructions: "Old instructions must not carry to the child.",
        input: "First question",
        tools: [{ type: "function", name: "old_tool" }],
      },
      responseId: "resp-root",
      outputEvents: [
        {
          type: "message.assistant",
          summary: { text: "First answer" },
        },
      ],
    });
    const child = source.addTurn({
      id: "child",
      protocol: "openai.responses",
      request: {
        model: "gpt-5.2",
        instructions: "Use only the new instruction.",
        previous_response_id: "resp-root",
        input: [{ role: "user", content: "Follow up" }],
        tools: [{ type: "function", name: "new_tool" }],
      },
      responseId: "resp-child",
      reportedInputTokens: 42,
    });

    const result = await new ContextReconstructor(source).reconstruct(child.id);

    expect(result.completeness).toBe("reconstructed-client-chain");
    expect(result.items.map((item) => item.kind)).toEqual([
      "message",
      "message",
      "instructions",
      "message",
      "tool-definition",
      "settings",
    ]);
    expect(JSON.stringify(result.items)).not.toContain(
      "Old instructions must not carry",
    );
    expect(JSON.stringify(result.items)).not.toContain("old_tool");
    expect(JSON.stringify(result.items)).toContain("Use only the new");
    expect(result.ancestry.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: child.id, kind: "request" }),
        expect.objectContaining({
          id: "response:resp-root",
          kind: "response",
          locallyAvailable: true,
        }),
        expect.objectContaining({ id: "request-root", kind: "request" }),
      ]),
    );
    expect(result.ancestry.edges).toContainEqual({
      from: "response:resp-root",
      to: child.id,
      relation: "previous-response",
      evidence: "observed",
    });
    expect(result.reportedInputTokens).toBe(42);
  });

  it("labels a missing predecessor as partial and identifies its response ID", async () => {
    const source = new FixtureSource();
    const request = source.addTurn({
      id: "missing",
      protocol: "openai.responses",
      request: {
        model: "gpt-5.2",
        previous_response_id: "resp-not-local",
        input: "Continue",
      },
    });

    const result = await new ContextReconstructor(source).reconstruct(
      request.id,
    );

    expect(result.completeness).toBe("partial-client-chain");
    expect(result.limitationReasons).toContain(
      "Previous response resp-not-local is unavailable locally.",
    );
    expect(result.ancestry.nodes).toContainEqual({
      id: "response:resp-not-local",
      kind: "missing",
      locallyAvailable: false,
    });
  });

  it("never labels a provider-managed Conversation as exact", async () => {
    const source = new FixtureSource();
    const request = source.addTurn({
      id: "conversation",
      protocol: "openai.responses",
      request: {
        model: "gpt-5.2",
        conversation: "conv-provider",
        input: "New local input",
      },
    });

    const result = await new ContextReconstructor(source).reconstruct(
      request.id,
    );

    expect(result.completeness).toBe("provider-managed-context");
    expect(result.ancestry.nodes).toContainEqual({
      id: "conversation:conv-provider",
      kind: "conversation",
      locallyAvailable: false,
    });
    expect(result.limitationReasons[0]).toContain("provider-managed items");
  });

  it("treats an explicit null previous_response_id as no response chain", async () => {
    const source = new FixtureSource();
    const request = source.addTurn({
      id: "null-previous",
      protocol: "openai.responses",
      request: {
        model: "gpt-5.2",
        previous_response_id: null,
        input: "Start with explicit local context.",
      },
    });

    const result = await new ContextReconstructor(source).reconstruct(
      request.id,
    );

    expect(result.completeness).toBe("exact-client-request");
    expect(result.limitationReasons).toEqual([]);
  });

  it("does not label a provider-resolved reusable prompt as exact", async () => {
    const source = new FixtureSource();
    const request = source.addTurn({
      id: "reusable-prompt",
      protocol: "openai.responses",
      request: {
        model: "gpt-5.2",
        prompt: {
          id: "pmpt_repository-review",
          version: "3",
          variables: { target: "README.md" },
        },
        input: "Review the target.",
      },
    });

    const result = await new ContextReconstructor(source).reconstruct(
      request.id,
    );

    expect(result.completeness).toBe("provider-managed-context");
    expect(result.limitationReasons).toContain(
      "Reusable prompt content is provider-managed and unavailable locally; only its request reference and variables were captured.",
    );
    expect(JSON.stringify(result.items)).toContain("pmpt_repository-review");
  });

  it("rejects a future response event as request ancestry", async () => {
    const source = new FixtureSource();
    const request = source.addTurn({
      id: "child-before-parent",
      protocol: "openai.responses",
      request: {
        previous_response_id: "resp-future",
        input: "Do not use future evidence.",
      },
    });
    source.addTurn({
      id: "future-parent",
      protocol: "openai.responses",
      request: { input: "Recorded later." },
      responseId: "resp-future",
      outputEvents: [
        { type: "message.assistant", summary: { text: "Future response" } },
      ],
    });

    const result = await new ContextReconstructor(source).reconstruct(
      request.id,
    );

    expect(result.completeness).toBe("partial-client-chain");
    expect(result.limitationReasons).toContain(
      "Previous response resp-future does not precede request request-child-before-parent in the recorded sequence.",
    );
    expect(JSON.stringify(result.items)).not.toContain("Future response");
  });

  it("guards cyclic response ancestry and keeps reasoning text opaque", async () => {
    const source = new FixtureSource();
    source.addTurn({
      id: "a",
      protocol: "openai.responses",
      request: {
        previous_response_id: "resp-b",
        input: "Turn A",
      },
      responseId: "resp-a",
      outputEvents: [
        {
          type: "provider.item.unknown",
          evidence: "unknown",
          summary: {
            itemType: "reasoning",
            payload: {
              encrypted_content: "must-not-appear",
              summary: [{ text: "visible summary is still not raw reasoning" }],
            },
          },
        },
      ],
    });
    const target = source.addTurn({
      id: "b",
      protocol: "openai.responses",
      request: {
        previous_response_id: "resp-a",
        input: "Turn B",
      },
      responseId: "resp-b",
    });

    const result = await new ContextReconstructor(source).reconstruct(
      target.id,
    );

    expect(result.completeness).toBe("partial-client-chain");
    expect(result.limitationReasons).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Cycle detected"),
        expect.stringContaining("Reasoning state is opaque"),
      ]),
    );
    const reasoning = result.items.find(
      (item) => item.kind === "reasoning-opaque",
    );
    expect(reasoning).toBeDefined();
    expect(JSON.stringify(reasoning)).not.toContain("must-not-appear");
    expect(JSON.stringify(reasoning)).not.toContain("raw reasoning");
  });
});
