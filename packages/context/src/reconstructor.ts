import { createHash } from "node:crypto";

import {
  ContextResultSchema,
  CONTEXT_VISIBILITY_NOTICE,
  IdentifierSchema,
  type TekrionEvent,
  type ContextCompleteness,
  type ContextItem,
  type ContextResult,
  type EvidenceKind,
  type ProvenanceReference,
  type RawExchange,
} from "@tekrion/protocol";

type JsonRecord = Record<string, unknown>;
type ContextAncestryNode = ContextResult["ancestry"]["nodes"][number];
type ContextAncestryEdge = ContextResult["ancestry"]["edges"][number];
type ContextItemKind = ContextItem["kind"];
type ContextRole = NonNullable<ContextItem["role"]>;

export interface ContextEventOrigin {
  readonly rawExchangeId?: string;
  readonly normalizationVersion?: string;
}

export interface ContextEvidenceSource {
  getEvent(eventId: string): TekrionEvent | undefined;
  getEventOrigin(eventId: string): ContextEventOrigin | undefined;
  getExchange(exchangeId: string): RawExchange | undefined;
  getEventsForExchange(exchangeId: string): readonly TekrionEvent[];
  findResponseEvent(
    sessionId: string,
    responseId: string,
  ): TekrionEvent | undefined;
  getPayload(payloadId: string): Promise<Uint8Array>;
}

export interface ContextReconstructorOptions {
  readonly maximumChainDepth?: number;
}

export type ContextReconstructionErrorCode =
  | "event-not-found"
  | "not-model-request"
  | "missing-event-origin"
  | "missing-raw-exchange";

export class ContextReconstructionError extends Error {
  constructor(
    readonly code: ContextReconstructionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ContextReconstructionError";
  }
}

interface LoadedTurn {
  readonly requestEvent: TekrionEvent;
  readonly exchange: RawExchange;
  readonly events: readonly TekrionEvent[];
  readonly request?: JsonRecord;
  readonly limitations: readonly string[];
}

interface ReconstructionState {
  readonly turns: LoadedTurn[];
  readonly nodes: Map<string, ContextAncestryNode>;
  readonly edges: ContextAncestryEdge[];
  readonly limitations: Set<string>;
  chainRequested: boolean;
  chainIncomplete: boolean;
  providerManaged: boolean;
}

const SETTINGS = [
  "model",
  "temperature",
  "top_p",
  "max_tokens",
  "max_completion_tokens",
  "max_output_tokens",
  "seed",
  "stop",
  "stop_sequences",
  "tool_choice",
  "parallel_tool_calls",
  "response_format",
  "text",
  "reasoning",
  "truncation",
  "store",
  "service_tier",
  "prompt",
  "context_management",
  "metadata",
  "thinking",
] as const;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function role(value: unknown): ContextRole | undefined {
  return new Set<ContextRole>([
    "system",
    "developer",
    "user",
    "assistant",
    "tool",
  ]).has(value as ContextRole)
    ? (value as ContextRole)
    : undefined;
}

function textFromContent(content: unknown): string | undefined {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part === "string") {
      parts.push(part);
    } else if (isRecord(part)) {
      const text =
        typeof part.text === "string"
          ? part.text
          : typeof part.content === "string"
            ? part.content
            : undefined;
      if (text !== undefined) {
        parts.push(text);
      }
    }
  }
  return parts.length === 0 ? undefined : parts.join("");
}

function conversationId(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  if (isRecord(value) && typeof value.id === "string" && value.id.length > 0) {
    return value.id;
  }
  return undefined;
}

function boundedNodeId(prefix: string, value: string): string {
  const candidate = `${prefix}:${value}`;
  return candidate.length <= 512
    ? candidate
    : `${prefix}:sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function responseNodeId(responseId: string): string {
  return boundedNodeId("response", responseId);
}

function conversationNodeId(id: string): string {
  return boundedNodeId("conversation", id);
}

function requestProvenance(turn: LoadedTurn): ProvenanceReference {
  return {
    eventId: turn.requestEvent.id,
    exchangeId: turn.exchange.id,
    ...(turn.exchange.requestBodyRef === undefined
      ? {}
      : { payloadRef: turn.exchange.requestBodyRef }),
  };
}

function eventProvenance(
  event: TekrionEvent,
  exchangeId: string,
): ProvenanceReference {
  return {
    eventId: event.id,
    exchangeId,
    ...(event.payloadRef === undefined ? {} : { payloadRef: event.payloadRef }),
  };
}

class ContextItemBuilder {
  readonly items: ContextItem[] = [];
  sawOpaqueReasoning = false;

  add(
    kind: ContextItemKind,
    summary: JsonRecord,
    provenance: ProvenanceReference,
    options: {
      readonly role?: ContextRole;
      readonly evidence?: EvidenceKind;
    } = {},
  ): void {
    const position = this.items.length;
    this.items.push({
      id: `context-item-${position}`,
      position,
      kind,
      ...(options.role === undefined ? {} : { role: options.role }),
      evidence: options.evidence ?? "observed",
      summary,
      provenance,
    });
    if (kind === "reasoning-opaque") {
      this.sawOpaqueReasoning = true;
    }
  }
}

function addToolCalls(
  calls: unknown,
  builder: ContextItemBuilder,
  provenance: ProvenanceReference,
): void {
  if (!Array.isArray(calls)) {
    return;
  }
  for (const value of calls) {
    builder.add(
      "tool-call",
      isRecord(value) ? { call: value } : { call: value ?? null },
      provenance,
      { role: "assistant" },
    );
  }
}

function addMessage(
  value: JsonRecord,
  builder: ContextItemBuilder,
  provenance: ProvenanceReference,
): void {
  const messageRole = role(value.role);
  if (messageRole === "tool") {
    builder.add(
      "tool-result",
      {
        ...(typeof value.tool_call_id === "string"
          ? { callId: value.tool_call_id }
          : {}),
        ...(typeof value.name === "string" ? { name: value.name } : {}),
        content: value.content ?? null,
        ...(textFromContent(value.content) === undefined
          ? {}
          : { text: textFromContent(value.content) }),
      },
      provenance,
      { role: "tool" },
    );
    return;
  }

  const hasMessageContent =
    (value.content !== undefined && value.content !== null) ||
    value.name !== undefined ||
    value.refusal !== undefined;
  if (hasMessageContent) {
    builder.add(
      "message",
      {
        content: value.content ?? null,
        ...(textFromContent(value.content) === undefined
          ? {}
          : { text: textFromContent(value.content) }),
        ...(typeof value.name === "string" ? { name: value.name } : {}),
        ...(value.refusal === undefined ? {} : { refusal: value.refusal }),
      },
      provenance,
      messageRole === undefined ? {} : { role: messageRole },
    );
  }
  addToolCalls(value.tool_calls, builder, provenance);
  if (isRecord(value.function_call)) {
    builder.add(
      "tool-call",
      { call: value.function_call, legacy: true },
      provenance,
      { role: "assistant" },
    );
  }
}

function addAnthropicMessage(
  value: JsonRecord,
  builder: ContextItemBuilder,
  provenance: ProvenanceReference,
): void {
  const messageRole = role(value.role);
  const content = value.content;
  if (typeof content === "string") {
    builder.add(
      "message",
      { content, text: content },
      provenance,
      messageRole === undefined ? {} : { role: messageRole },
    );
    return;
  }
  if (!Array.isArray(content)) {
    builder.add(
      "unknown",
      { message: value },
      provenance,
      messageRole === undefined ? {} : { role: messageRole },
    );
    return;
  }

  const text = content
    .filter(isRecord)
    .filter((block) => block.type === "text")
    .map((block) => (typeof block.text === "string" ? block.text : ""))
    .join("");
  const hasGeneralContent = content.some(
    (block) =>
      !isRecord(block) ||
      !new Set([
        "tool_use",
        "tool_result",
        "thinking",
        "redacted_thinking",
      ]).has(typeof block.type === "string" ? block.type : ""),
  );
  if (text.length > 0 || hasGeneralContent) {
    builder.add(
      "message",
      {
        content,
        ...(text.length === 0 ? {} : { text }),
      },
      provenance,
      messageRole === undefined ? {} : { role: messageRole },
    );
  }

  for (const block of content) {
    if (!isRecord(block)) {
      continue;
    }
    const type = typeof block.type === "string" ? block.type : undefined;
    if (type === "tool_use" || type?.endsWith("_tool_use") === true) {
      builder.add(
        "tool-call",
        {
          ...(typeof block.id === "string" ? { callId: block.id } : {}),
          ...(typeof block.name === "string" ? { name: block.name } : {}),
          arguments: block.input ?? {},
          ...(type === "tool_use" ? {} : { providerType: type }),
        },
        provenance,
        { role: "assistant" },
      );
    } else if (
      type === "tool_result" ||
      type?.endsWith("_tool_result") === true
    ) {
      builder.add(
        "tool-result",
        {
          ...(typeof block.tool_use_id === "string"
            ? { callId: block.tool_use_id }
            : {}),
          output: block.content ?? block,
          ...(typeof block.is_error === "boolean"
            ? { isError: block.is_error }
            : {}),
          ...(type === "tool_result" ? {} : { providerType: type }),
        },
        provenance,
        { role: "tool" },
      );
    } else if (type === "thinking" || type === "redacted_thinking") {
      builder.add(
        "reasoning-opaque",
        {
          itemType: type,
          opaque: true,
          hasSignature: typeof block.signature === "string",
        },
        provenance,
        { role: "assistant", evidence: "unknown" },
      );
    }
  }
}

function addResponsesItem(
  value: unknown,
  builder: ContextItemBuilder,
  provenance: ProvenanceReference,
): void {
  if (typeof value === "string") {
    builder.add("message", { text: value, content: value }, provenance, {
      role: "user",
    });
    return;
  }
  if (!isRecord(value)) {
    builder.add("unknown", { value: value ?? null }, provenance);
    return;
  }
  const itemType = typeof value.type === "string" ? value.type : undefined;
  if (itemType === "message" || role(value.role) !== undefined) {
    addMessage(value, builder, provenance);
    return;
  }
  if (itemType === "function_call_output" || itemType?.endsWith("_output")) {
    builder.add(
      "tool-result",
      {
        itemType: itemType ?? "output",
        ...(typeof value.call_id === "string" ? { callId: value.call_id } : {}),
        output: value.output ?? value.content ?? null,
      },
      provenance,
      { role: "tool" },
    );
    return;
  }
  if (itemType === "function_call" || itemType?.endsWith("_call")) {
    builder.add(
      "tool-call",
      { itemType: itemType ?? "tool-call", call: value },
      provenance,
      { role: "assistant" },
    );
    return;
  }
  if (itemType === "reasoning") {
    builder.add(
      "reasoning-opaque",
      {
        itemType,
        opaque: true,
        hasEncryptedContent: typeof value.encrypted_content === "string",
        hasSummary: Array.isArray(value.summary) && value.summary.length > 0,
      },
      provenance,
      { role: "assistant" },
    );
    return;
  }
  builder.add(
    "unknown",
    { itemType: itemType ?? "unknown", item: value },
    provenance,
  );
}

function addInput(
  input: unknown,
  builder: ContextItemBuilder,
  provenance: ProvenanceReference,
): void {
  if (Array.isArray(input)) {
    for (const item of input) {
      addResponsesItem(item, builder, provenance);
    }
    return;
  }
  if (input !== undefined) {
    addResponsesItem(input, builder, provenance);
  }
}

function addTools(
  tools: unknown,
  builder: ContextItemBuilder,
  provenance: ProvenanceReference,
): void {
  if (!Array.isArray(tools)) {
    return;
  }
  for (const definition of tools) {
    builder.add(
      "tool-definition",
      isRecord(definition)
        ? { definition }
        : { definition: definition ?? null },
      provenance,
    );
  }
}

function addSettings(
  request: JsonRecord,
  builder: ContextItemBuilder,
  provenance: ProvenanceReference,
): void {
  const settings = Object.fromEntries(
    SETTINGS.flatMap((name) =>
      request[name] === undefined ? [] : ([[name, request[name]]] as const),
    ),
  );
  if (Object.keys(settings).length > 0) {
    builder.add("settings", { values: settings }, provenance);
  }
}

function addRequestItems(
  turn: LoadedTurn,
  builder: ContextItemBuilder,
  includeTopLevel: boolean,
): void {
  const request = turn.request;
  if (request === undefined) {
    return;
  }
  const provenance = requestProvenance(turn);
  if (turn.exchange.protocol === "anthropic.messages") {
    if (includeTopLevel && request.system !== undefined) {
      builder.add(
        "instructions",
        {
          value: request.system,
          ...(textFromContent(request.system) === undefined
            ? {}
            : { text: textFromContent(request.system) }),
        },
        provenance,
      );
    }
    const messages = Array.isArray(request.messages) ? request.messages : [];
    for (const message of messages) {
      if (isRecord(message)) {
        addAnthropicMessage(message, builder, provenance);
      } else {
        builder.add("unknown", { message: message ?? null }, provenance);
      }
    }
    if (includeTopLevel) {
      addTools(request.tools, builder, provenance);
      addSettings(request, builder, provenance);
    }
    return;
  }
  if (turn.exchange.protocol === "openai.chat-completions") {
    const messages = Array.isArray(request.messages) ? request.messages : [];
    for (const message of messages) {
      if (isRecord(message)) {
        addMessage(message, builder, provenance);
      } else {
        builder.add("unknown", { message: message ?? null }, provenance);
      }
    }
    if (includeTopLevel) {
      addTools(request.tools, builder, provenance);
      addSettings(request, builder, provenance);
    }
    return;
  }
  if (turn.exchange.protocol !== "openai.responses") {
    return;
  }
  if (includeTopLevel && request.instructions !== undefined) {
    builder.add(
      "instructions",
      {
        value: request.instructions,
        ...(textFromContent(request.instructions) === undefined
          ? {}
          : { text: textFromContent(request.instructions) }),
      },
      provenance,
    );
  }
  addInput(request.input, builder, provenance);
  if (includeTopLevel) {
    addTools(request.tools, builder, provenance);
    addSettings(request, builder, provenance);
  }
}

function addResponseItems(turn: LoadedTurn, builder: ContextItemBuilder): void {
  for (const event of turn.events) {
    const provenance = eventProvenance(event, turn.exchange.id);
    if (event.type === "message.assistant") {
      builder.add("message", event.summary, provenance, {
        role: "assistant",
        evidence: event.evidence,
      });
    } else if (event.type === "tool.call") {
      builder.add("tool-call", event.summary, provenance, {
        role: "assistant",
        evidence: event.evidence,
      });
    } else if (
      event.type === "provider.item.unknown" &&
      new Set(["reasoning", "thinking", "redacted_thinking"]).has(
        String(event.summary.itemType),
      )
    ) {
      const payload = isRecord(event.summary.payload)
        ? event.summary.payload
        : undefined;
      builder.add(
        "reasoning-opaque",
        {
          itemType: "reasoning",
          opaque: true,
          hasEncryptedContent: typeof payload?.encrypted_content === "string",
          hasSummary:
            Array.isArray(payload?.summary) && payload.summary.length > 0,
        },
        provenance,
        { role: "assistant", evidence: event.evidence },
      );
    } else if (event.type === "provider.item.unknown") {
      builder.add("unknown", event.summary, provenance, {
        evidence: event.evidence,
      });
    }
  }
}

function reportedInputTokens(events: readonly TekrionEvent[]): number | null {
  for (const event of [...events].reverse()) {
    if (
      event.type === "model.usage" &&
      typeof event.summary.inputTokens === "number" &&
      Number.isInteger(event.summary.inputTokens) &&
      event.summary.inputTokens >= 0
    ) {
      return event.summary.inputTokens;
    }
  }
  return null;
}

function estimateInputTokens(items: readonly ContextItem[]): number {
  const visible = items.map((item) => ({
    kind: item.kind,
    role: item.role,
    summary: item.summary,
  }));
  return Math.ceil(
    new TextEncoder().encode(JSON.stringify(visible)).length / 4,
  );
}

export class ContextReconstructor {
  private readonly maximumChainDepth: number;

  constructor(
    private readonly source: ContextEvidenceSource,
    options: ContextReconstructorOptions = {},
  ) {
    this.maximumChainDepth = options.maximumChainDepth ?? 64;
    if (
      !Number.isSafeInteger(this.maximumChainDepth) ||
      this.maximumChainDepth < 1 ||
      this.maximumChainDepth > 256
    ) {
      throw new RangeError(
        "Context chain depth must be an integer between 1 and 256.",
      );
    }
  }

  async reconstruct(requestEventId: string): Promise<ContextResult> {
    const id = IdentifierSchema.parse(requestEventId);
    const target = this.source.getEvent(id);
    if (target === undefined) {
      throw new ContextReconstructionError(
        "event-not-found",
        `Event ${id} was not found.`,
      );
    }
    if (target.type !== "model.request") {
      throw new ContextReconstructionError(
        "not-model-request",
        `Event ${id} is not a model.request event.`,
      );
    }

    const current = await this.loadTurn(target);
    const state: ReconstructionState = {
      turns: [current],
      nodes: new Map([
        [target.id, { id: target.id, kind: "request", locallyAvailable: true }],
      ]),
      edges: [],
      limitations: new Set(current.limitations),
      chainRequested: false,
      chainIncomplete: false,
      providerManaged: false,
    };

    if (current.request !== undefined) {
      if (current.exchange.protocol === "openai.responses") {
        await this.resolveResponsesAncestry(current, state);
      } else if (current.exchange.protocol === "anthropic.messages") {
        this.markProviderManagedRequestState(current.request, state);
      } else if (current.exchange.protocol !== "openai.chat-completions") {
        state.limitations.add(
          `Protocol ${current.exchange.protocol} has no context parser.`,
        );
      }
    }

    const builder = new ContextItemBuilder();
    for (const turn of [...state.turns].reverse()) {
      const isCurrent = turn.requestEvent.id === target.id;
      addRequestItems(turn, builder, isCurrent);
      if (!isCurrent) {
        addResponseItems(turn, builder);
      }
    }
    if (builder.sawOpaqueReasoning) {
      state.limitations.add(
        "Reasoning state is opaque in reconstructed context and is not used for causal claims.",
      );
    }

    const completeness = this.completeness(current, state);
    return ContextResultSchema.parse({
      schemaVersion: 1,
      requestEventId: target.id,
      completeness,
      items: builder.items,
      ancestry: {
        nodes: [...state.nodes.values()],
        edges: state.edges,
      },
      reportedInputTokens: reportedInputTokens(current.events),
      estimatedInputTokens: estimateInputTokens(builder.items),
      modelContextLimit: null,
      limitationReasons: [...state.limitations],
      visibilityNotice: CONTEXT_VISIBILITY_NOTICE,
    });
  }

  private completeness(
    current: LoadedTurn,
    state: ReconstructionState,
  ): ContextCompleteness {
    if (
      current.request === undefined ||
      current.exchange.protocol === "unknown-openai-compatible" ||
      current.limitations.length > 0
    ) {
      return "unknown-unsupported";
    }
    if (state.providerManaged) {
      return "provider-managed-context";
    }
    if (state.chainRequested) {
      return state.chainIncomplete
        ? "partial-client-chain"
        : "reconstructed-client-chain";
    }
    return "exact-client-request";
  }

  private async resolveResponsesAncestry(
    current: LoadedTurn,
    state: ReconstructionState,
  ): Promise<void> {
    const currentRequest = current.request;
    if (currentRequest === undefined) {
      return;
    }
    this.markProviderManagedRequestState(currentRequest, state);
    const currentConversation = conversationId(currentRequest.conversation);
    if (currentConversation !== undefined) {
      this.addConversation(currentConversation, current.requestEvent.id, state);
      return;
    }
    if (
      currentRequest.previous_response_id !== undefined &&
      currentRequest.previous_response_id !== null &&
      (typeof currentRequest.previous_response_id !== "string" ||
        currentRequest.previous_response_id.length === 0)
    ) {
      state.chainRequested = true;
      state.chainIncomplete = true;
      state.limitations.add("previous_response_id is not a string.");
      return;
    }

    let child = current;
    let previous =
      typeof currentRequest.previous_response_id === "string" &&
      currentRequest.previous_response_id.length > 0
        ? currentRequest.previous_response_id
        : undefined;
    const visited = new Set<string>();
    let depth = 0;
    if (previous !== undefined) {
      state.chainRequested = true;
    }

    while (previous !== undefined) {
      const nodeId = responseNodeId(previous);
      if (visited.has(previous)) {
        state.chainIncomplete = true;
        state.limitations.add(
          `Cycle detected at previous response ${previous}.`,
        );
        break;
      }
      if (depth >= this.maximumChainDepth) {
        state.chainIncomplete = true;
        state.limitations.add(
          `Context ancestry exceeded the ${this.maximumChainDepth}-response depth limit.`,
        );
        break;
      }
      visited.add(previous);
      depth += 1;

      const responseEvent = this.source.findResponseEvent(
        child.exchange.sessionId,
        previous,
      );
      if (responseEvent === undefined) {
        state.nodes.set(nodeId, {
          id: nodeId,
          kind: "missing",
          locallyAvailable: false,
        });
        state.edges.push({
          from: nodeId,
          to: child.requestEvent.id,
          relation: "previous-response",
          evidence: "observed",
        });
        state.chainIncomplete = true;
        state.limitations.add(
          `Previous response ${previous} is unavailable locally.`,
        );
        break;
      }

      state.nodes.set(nodeId, {
        id: nodeId,
        kind: "response",
        locallyAvailable: true,
      });
      state.edges.push({
        from: nodeId,
        to: child.requestEvent.id,
        relation: "previous-response",
        evidence: "observed",
      });
      const responseOrigin = this.source.getEventOrigin(responseEvent.id);
      const exchangeId = responseOrigin?.rawExchangeId;
      if (exchangeId === undefined) {
        state.chainIncomplete = true;
        state.limitations.add(
          `Previous response ${previous} has no raw exchange provenance.`,
        );
        break;
      }
      const events = this.source.getEventsForExchange(exchangeId);
      const requestEvent = events.find(
        (event) => event.type === "model.request",
      );
      if (requestEvent === undefined) {
        state.chainIncomplete = true;
        state.limitations.add(
          `Previous response ${previous} has no local model.request event.`,
        );
        break;
      }
      if (state.nodes.has(requestEvent.id)) {
        state.chainIncomplete = true;
        state.limitations.add(`Cycle detected at request ${requestEvent.id}.`);
        break;
      }
      if (responseEvent.sequence >= child.requestEvent.sequence) {
        state.chainIncomplete = true;
        state.limitations.add(
          `Previous response ${previous} does not precede request ${child.requestEvent.id} in the recorded sequence.`,
        );
        break;
      }
      const ancestor = await this.loadTurn(requestEvent);
      state.turns.push(ancestor);
      state.nodes.set(requestEvent.id, {
        id: requestEvent.id,
        kind: "request",
        locallyAvailable: true,
      });
      state.edges.push({
        from: requestEvent.id,
        to: nodeId,
        relation: "explicit-input",
        evidence: "observed",
      });
      for (const limitation of ancestor.limitations) {
        state.limitations.add(limitation);
      }
      if (ancestor.request !== undefined) {
        this.markProviderManagedRequestState(ancestor.request, state);
      }
      if (
        ancestor.limitations.length > 0 ||
        !ancestor.exchange.capture.responseComplete
      ) {
        state.chainIncomplete = true;
        if (!ancestor.exchange.capture.responseComplete) {
          state.limitations.add(
            `Response ${previous} was not captured completely.`,
          );
        }
      }
      const ancestorConversation = conversationId(
        ancestor.request?.conversation,
      );
      if (ancestorConversation !== undefined) {
        this.addConversation(
          ancestorConversation,
          ancestor.requestEvent.id,
          state,
        );
        break;
      }
      if (
        ancestor.request?.previous_response_id !== undefined &&
        ancestor.request.previous_response_id !== null &&
        (typeof ancestor.request.previous_response_id !== "string" ||
          ancestor.request.previous_response_id.length === 0)
      ) {
        state.chainIncomplete = true;
        state.limitations.add(
          `Request ${ancestor.requestEvent.id} has an invalid previous_response_id.`,
        );
        break;
      }
      child = ancestor;
      previous =
        typeof ancestor.request?.previous_response_id === "string" &&
        ancestor.request.previous_response_id.length > 0
          ? ancestor.request.previous_response_id
          : undefined;
    }
  }

  private markProviderManagedRequestState(
    request: JsonRecord,
    state: ReconstructionState,
  ): void {
    if (request.prompt !== undefined && request.prompt !== null) {
      state.providerManaged = true;
      state.limitations.add(
        "Reusable prompt content is provider-managed and unavailable locally; only its request reference and variables were captured.",
      );
    }
    if (
      request.context_management !== undefined &&
      request.context_management !== null
    ) {
      state.providerManaged = true;
      state.limitations.add(
        "Server context management may transform prior context outside the locally visible record.",
      );
    }
  }

  private addConversation(
    conversation: string,
    requestEventId: string,
    state: ReconstructionState,
  ): void {
    const nodeId = conversationNodeId(conversation);
    state.nodes.set(nodeId, {
      id: nodeId,
      kind: "conversation",
      locallyAvailable: false,
    });
    state.edges.push({
      from: nodeId,
      to: requestEventId,
      relation: "conversation-member",
      evidence: "observed",
    });
    state.providerManaged = true;
    state.limitations.add(
      `Conversation ${conversation} may contain provider-managed items unavailable locally.`,
    );
  }

  private async loadTurn(requestEvent: TekrionEvent): Promise<LoadedTurn> {
    const origin = this.source.getEventOrigin(requestEvent.id);
    if (origin?.rawExchangeId === undefined) {
      throw new ContextReconstructionError(
        "missing-event-origin",
        `Event ${requestEvent.id} has no raw exchange provenance.`,
      );
    }
    const exchange = this.source.getExchange(origin.rawExchangeId);
    if (exchange === undefined) {
      throw new ContextReconstructionError(
        "missing-raw-exchange",
        `Raw exchange ${origin.rawExchangeId} was not found.`,
      );
    }
    const limitations: string[] = [];
    let request: JsonRecord | undefined;
    if (exchange.requestBodyRef === undefined) {
      limitations.push(`Request ${requestEvent.id} has no retained body.`);
    } else {
      try {
        const decoded = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(
            await this.source.getPayload(exchange.requestBodyRef.id),
          ),
        ) as unknown;
        if (isRecord(decoded)) {
          request = decoded;
        } else {
          limitations.push(
            `Request ${requestEvent.id} body is not a JSON object.`,
          );
        }
      } catch (error: unknown) {
        limitations.push(
          `Request ${requestEvent.id} body could not be decoded as JSON: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (!exchange.capture.requestComplete) {
      limitations.push(`Request ${requestEvent.id} capture is incomplete.`);
    }
    return {
      requestEvent,
      exchange,
      events: this.source.getEventsForExchange(exchange.id),
      ...(request === undefined ? {} : { request }),
      limitations,
    };
  }
}
