import { gunzipSync } from "node:zlib";

import {
  NormalizationExchangeSchema,
  NormalizationResultSchema,
  type CanonicalEventDraft,
  type ExchangeNormalizer,
  type NormalizationExchange,
  type NormalizationOptions,
  type NormalizationResult,
  type ParserDiagnostic,
} from "./contracts.js";
import { SseReplayDetector } from "./duplicates.js";
import { materializeCanonicalEvents } from "./events.js";
import { decodeSseChunks, type SseFrame } from "./sse.js";

export const ANTHROPIC_MESSAGES_NORMALIZER_VERSION = "1.1.0";
export const DEFAULT_MAX_DECODED_ANTHROPIC_RESPONSE_BYTES = 64 * 1024 * 1024;

const MAX_CONFIGURED_DECODED_RESPONSE_BYTES = 1024 * 1024 * 1024;

class AnthropicContentDecodingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnthropicContentDecodingError";
  }
}

type JsonRecord = Record<string, unknown>;

interface AnthropicUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheCreationInputTokens: number | null;
  readonly cacheReadInputTokens: number | null;
}

interface ContentBlockAssembly {
  readonly index: number;
  type?: string;
  id?: string;
  name?: string;
  text: string;
  partialJson: string;
  input?: unknown;
  initial?: JsonRecord;
  opaqueReasoning: boolean;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function integerValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value)
    ? value
    : undefined;
}

function tokenValue(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

function usage(value: unknown): AnthropicUsage | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const result = {
    inputTokens: tokenValue(value.input_tokens),
    outputTokens: tokenValue(value.output_tokens),
    cacheCreationInputTokens: tokenValue(value.cache_creation_input_tokens),
    cacheReadInputTokens: tokenValue(value.cache_read_input_tokens),
  };
  return Object.values(result).every((entry) => entry === null)
    ? undefined
    : result;
}

function mergeUsage(
  current: AnthropicUsage | undefined,
  next: AnthropicUsage | undefined,
): AnthropicUsage | undefined {
  if (next === undefined) {
    return current;
  }
  if (current === undefined) {
    return next;
  }
  return {
    inputTokens: next.inputTokens ?? current.inputTokens,
    outputTokens: next.outputTokens ?? current.outputTokens,
    cacheCreationInputTokens:
      next.cacheCreationInputTokens ?? current.cacheCreationInputTokens,
    cacheReadInputTokens:
      next.cacheReadInputTokens ?? current.cacheReadInputTokens,
  };
}

function usageSummary(value: AnthropicUsage): JsonRecord {
  return {
    inputTokens: value.inputTokens,
    outputTokens: value.outputTokens,
    totalTokens:
      value.inputTokens === null || value.outputTokens === null
        ? null
        : value.inputTokens + value.outputTokens,
    ...(value.cacheCreationInputTokens === null
      ? {}
      : { cacheCreationInputTokens: value.cacheCreationInputTokens }),
    ...(value.cacheReadInputTokens === null
      ? {}
      : { cacheReadInputTokens: value.cacheReadInputTokens }),
  };
}

function diagnostic(
  kind: ParserDiagnostic["kind"],
  message: string,
  options: {
    readonly frameIndex?: number;
    readonly eventType?: string;
    readonly fatal?: boolean;
  } = {},
): ParserDiagnostic {
  return {
    kind,
    message,
    ...(options.frameIndex === undefined
      ? {}
      : { frameIndex: options.frameIndex }),
    ...(options.eventType === undefined
      ? {}
      : { eventType: options.eventType }),
    fatal: options.fatal === true,
  };
}

function parserErrorDraft(
  parser: string,
  frameIndex?: number,
): CanonicalEventDraft {
  return {
    type: "parser.error",
    evidence: "derived",
    summary: {
      parser,
      ...(frameIndex === undefined ? {} : { frameIndex }),
    },
  };
}

function decodeJson(bytes: Uint8Array | undefined): unknown {
  if (bytes === undefined) {
    return undefined;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

function contentType(exchange: NormalizationExchange): string {
  for (const [name, value] of Object.entries(exchange.responseHeaders ?? {})) {
    if (name.toLowerCase() === "content-type") {
      return (Array.isArray(value) ? value[0] : value) ?? "";
    }
  }
  return "";
}

function responseHeaderValues(
  exchange: NormalizationExchange,
  expectedName: string,
): readonly string[] {
  for (const [name, value] of Object.entries(exchange.responseHeaders ?? {})) {
    if (name.toLowerCase() === expectedName) {
      return Array.isArray(value) ? value : [value];
    }
  }
  return [];
}

function responseContentEncodings(
  exchange: NormalizationExchange,
): readonly string[] {
  return responseHeaderValues(exchange, "content-encoding")
    .flatMap((value) => value.split(","))
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length > 0);
}

function decodedResponseLimit(options: NormalizationOptions): number {
  const limit =
    options.maxDecodedResponseBodyBytes ??
    DEFAULT_MAX_DECODED_ANTHROPIC_RESPONSE_BYTES;
  if (
    !Number.isInteger(limit) ||
    limit <= 0 ||
    limit > MAX_CONFIGURED_DECODED_RESPONSE_BYTES
  ) {
    throw new RangeError(
      `Decoded Anthropic response limit must be an integer between 1 and ${MAX_CONFIGURED_DECODED_RESPONSE_BYTES}.`,
    );
  }
  return limit;
}

function decodeResponseBody(
  exchange: NormalizationExchange,
  options: NormalizationOptions,
): Uint8Array | undefined {
  const encodings = responseContentEncodings(exchange);
  if (encodings.length === 0) {
    return exchange.responseBody;
  }

  const limit = decodedResponseLimit(options);
  let decoded = exchange.responseBody;
  for (const encoding of [...encodings].reverse()) {
    if (encoding === "identity") {
      continue;
    }
    if (encoding !== "gzip" && encoding !== "x-gzip") {
      throw new AnthropicContentDecodingError(
        "Anthropic response uses an unsupported content encoding.",
      );
    }
    if (decoded === undefined) {
      throw new AnthropicContentDecodingError(
        "Anthropic gzip response had no retained response body.",
      );
    }
    try {
      decoded = gunzipSync(decoded, { maxOutputLength: limit });
    } catch (error: unknown) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ERR_BUFFER_TOO_LARGE"
      ) {
        throw new AnthropicContentDecodingError(
          `Anthropic gzip response exceeded the ${limit}-byte decoded-body limit.`,
        );
      }
      throw new AnthropicContentDecodingError(
        "Anthropic gzip response could not be decoded.",
      );
    }
  }
  return decoded;
}

function requestObject(
  exchange: NormalizationExchange,
  diagnostics: ParserDiagnostic[],
): JsonRecord | undefined {
  try {
    const decoded = decodeJson(exchange.requestBody);
    if (decoded === undefined) {
      return undefined;
    }
    if (!isRecord(decoded)) {
      diagnostics.push(
        diagnostic("invalid-payload", "Anthropic request must be an object."),
      );
      return undefined;
    }
    return decoded;
  } catch (error: unknown) {
    diagnostics.push(
      diagnostic(
        "malformed-json",
        `Anthropic request JSON could not be decoded: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
    return undefined;
  }
}

function requestToolResultDrafts(
  request: JsonRecord | undefined,
): CanonicalEventDraft[] {
  const messages = Array.isArray(request?.messages) ? request.messages : [];
  const drafts: CanonicalEventDraft[] = [];
  for (const messageValue of messages) {
    if (!isRecord(messageValue) || !Array.isArray(messageValue.content)) {
      continue;
    }
    for (const blockValue of messageValue.content) {
      if (!isRecord(blockValue) || blockValue.type !== "tool_result") {
        continue;
      }
      drafts.push({
        type: "tool.result",
        summary: {
          ...(stringValue(blockValue.tool_use_id) === undefined
            ? {}
            : { callId: stringValue(blockValue.tool_use_id) }),
          output: blockValue.content ?? null,
          ...(typeof blockValue.is_error === "boolean"
            ? { isError: blockValue.is_error }
            : {}),
        },
      });
    }
  }
  return drafts;
}

function requestEvidenceDrafts(
  exchange: NormalizationExchange,
  request: JsonRecord | undefined,
): CanonicalEventDraft[] {
  return [
    ...requestToolResultDrafts(request),
    {
      type: "model.request",
      summary: {
        endpoint: exchange.path,
        ...(stringValue(request?.model) === undefined
          ? {}
          : { model: stringValue(request?.model) }),
      },
    },
  ];
}

function isToolUseType(type: string | undefined): boolean {
  return type === "tool_use" || type?.endsWith("_tool_use") === true;
}

function isToolResultType(type: string | undefined): boolean {
  return type === "tool_result" || type?.endsWith("_tool_result") === true;
}

function parsePartialJson(
  raw: string,
  diagnostics: ParserDiagnostic[],
  context: string,
): unknown {
  try {
    return JSON.parse(raw);
  } catch (error: unknown) {
    diagnostics.push(
      diagnostic(
        "invalid-payload",
        `${context} was not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        { eventType: context },
      ),
    );
    return raw;
  }
}

function contentBlockDrafts(
  content: unknown,
  diagnostics: ParserDiagnostic[],
  responseId?: string,
): CanonicalEventDraft[] {
  if (!Array.isArray(content)) {
    return [];
  }
  const drafts: CanonicalEventDraft[] = [];
  const text: string[] = [];
  for (const blockValue of content) {
    if (!isRecord(blockValue)) {
      diagnostics.push(
        diagnostic(
          "invalid-payload",
          "Anthropic content block was not an object.",
        ),
      );
      continue;
    }
    const type = stringValue(blockValue.type);
    if (type === "text") {
      text.push(stringValue(blockValue.text) ?? "");
      continue;
    }
    if (isToolUseType(type)) {
      drafts.push({
        type: "tool.call",
        summary: {
          ...(stringValue(blockValue.id) === undefined
            ? {}
            : { callId: stringValue(blockValue.id) }),
          ...(stringValue(blockValue.name) === undefined
            ? {}
            : { name: stringValue(blockValue.name) }),
          arguments: blockValue.input ?? {},
          ...(type === "tool_use" ? {} : { providerType: type }),
        },
      });
      continue;
    }
    if (isToolResultType(type)) {
      drafts.push({
        type: "tool.result",
        summary: {
          ...(stringValue(blockValue.tool_use_id) === undefined
            ? {}
            : { callId: stringValue(blockValue.tool_use_id) }),
          output: blockValue.content ?? blockValue,
          ...(type === "tool_result" ? {} : { providerType: type }),
        },
      });
      continue;
    }
    if (type === "thinking" || type === "redacted_thinking") {
      drafts.push({
        type: "provider.item.unknown",
        evidence: "unknown",
        summary: {
          itemType: type,
          opaque: true,
          rawPayloadPreserved: true,
        },
      });
      continue;
    }
    drafts.push({
      type: "provider.item.unknown",
      evidence: "unknown",
      summary: {
        itemType: type ?? "unknown",
        payload: blockValue,
        rawPayloadPreserved: true,
      },
    });
  }
  if (text.length > 0) {
    drafts.unshift({
      type: "message.assistant",
      summary: {
        ...(responseId === undefined ? {} : { messageId: responseId }),
        text: text.join(""),
      },
    });
  }
  return drafts;
}

function apiErrorDraft(
  responseStatus: number | undefined,
  response: JsonRecord,
): CanonicalEventDraft | undefined {
  const error = isRecord(response.error) ? response.error : undefined;
  if (error === undefined && (responseStatus ?? 200) < 400) {
    return undefined;
  }
  return {
    type: "api.error",
    summary: {
      ...(responseStatus === undefined ? {} : { status: responseStatus }),
      ...(stringValue(error?.type) === undefined
        ? {}
        : { type: stringValue(error?.type) }),
      ...(stringValue(error?.message) === undefined
        ? {}
        : { message: stringValue(error?.message) }),
      ...(stringValue(response.request_id) === undefined
        ? {}
        : { requestId: stringValue(response.request_id) }),
    },
  };
}

function normalizeJson(
  exchange: NormalizationExchange,
  options: NormalizationOptions,
): NormalizationResult {
  const parserId = "anthropic.messages.json";
  const diagnostics: ParserDiagnostic[] = [];
  const request = requestObject(exchange, diagnostics);
  let response: JsonRecord | undefined;
  try {
    const decoded = decodeJson(exchange.responseBody);
    if (isRecord(decoded)) {
      response = decoded;
    } else {
      diagnostics.push(
        diagnostic("invalid-payload", "Anthropic response must be an object.", {
          fatal: true,
        }),
      );
    }
  } catch (error: unknown) {
    diagnostics.push(
      diagnostic(
        "malformed-json",
        `Anthropic response JSON could not be decoded: ${error instanceof Error ? error.message : String(error)}`,
        { fatal: true },
      ),
    );
  }

  const drafts = requestEvidenceDrafts(exchange, request);
  if (response === undefined) {
    drafts.push(parserErrorDraft(parserId));
  } else {
    const apiError = apiErrorDraft(exchange.responseStatus, response);
    if (apiError !== undefined) {
      drafts.push(apiError);
    } else {
      const responseId = stringValue(response.id);
      drafts.push(
        ...contentBlockDrafts(response.content, diagnostics, responseId),
      );
      const reported = usage(response.usage);
      if (reported !== undefined) {
        drafts.push({
          type: "model.usage",
          summary: usageSummary(reported),
        });
      }
      drafts.push({
        type: "model.response.completed",
        summary: {
          ...(responseId === undefined ? {} : { responseId }),
          ...(stringValue(response.stop_reason) === undefined
            ? {}
            : { stopReason: stringValue(response.stop_reason) }),
          ...(stringValue(response.stop_sequence) === undefined
            ? {}
            : { stopSequence: stringValue(response.stop_sequence) }),
          ...(reported === undefined
            ? {
                usage: "unknown",
                inputTokens: null,
                outputTokens: null,
              }
            : {}),
        },
      });
    }
  }

  return NormalizationResultSchema.parse({
    parserId,
    parserVersion: ANTHROPIC_MESSAGES_NORMALIZER_VERSION,
    status: diagnostics.some((entry) => entry.fatal) ? "malformed" : "parsed",
    events: materializeCanonicalEvents(exchange, drafts, options),
    diagnostics,
  });
}

function framePayload(
  frame: SseFrame,
  diagnostics: ParserDiagnostic[],
): JsonRecord | undefined {
  if (frame.data === undefined) {
    return undefined;
  }
  try {
    const decoded = JSON.parse(frame.data);
    if (!isRecord(decoded)) {
      throw new TypeError("SSE data must decode to an object.");
    }
    return decoded;
  } catch (error: unknown) {
    diagnostics.push(
      diagnostic(
        "malformed-sse",
        `Anthropic SSE frame ${frame.index} was not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        { frameIndex: frame.index },
      ),
    );
    return undefined;
  }
}

function blockAssembly(
  blocks: Map<number, ContentBlockAssembly>,
  index: number,
): ContentBlockAssembly {
  const existing = blocks.get(index);
  if (existing !== undefined) {
    return existing;
  }
  const created: ContentBlockAssembly = {
    index,
    text: "",
    partialJson: "",
    opaqueReasoning: false,
  };
  blocks.set(index, created);
  return created;
}

function applyContentBlockStart(
  payload: JsonRecord,
  blocks: Map<number, ContentBlockAssembly>,
  diagnostics: ParserDiagnostic[],
  frameIndex: number,
): void {
  const index = integerValue(payload.index);
  const block = isRecord(payload.content_block)
    ? payload.content_block
    : undefined;
  if (index === undefined || block === undefined) {
    diagnostics.push(
      diagnostic(
        "invalid-payload",
        "content_block_start lacked an index or content block.",
        { frameIndex, eventType: "content_block_start" },
      ),
    );
    return;
  }
  const assembly = blockAssembly(blocks, index);
  const type = stringValue(block.type);
  const id = stringValue(block.id);
  const name = stringValue(block.name);
  if (type !== undefined) {
    assembly.type = type;
  }
  if (id !== undefined) {
    assembly.id = id;
  }
  if (name !== undefined) {
    assembly.name = name;
  }
  assembly.text = stringValue(block.text) ?? "";
  assembly.input = block.input;
  assembly.initial = block;
  assembly.opaqueReasoning =
    assembly.type === "thinking" || assembly.type === "redacted_thinking";
}

function applyContentBlockDelta(
  payload: JsonRecord,
  blocks: Map<number, ContentBlockAssembly>,
  diagnostics: ParserDiagnostic[],
  unknown: CanonicalEventDraft[],
  frameIndex: number,
): void {
  const index = integerValue(payload.index);
  const delta = isRecord(payload.delta) ? payload.delta : undefined;
  if (index === undefined || delta === undefined) {
    diagnostics.push(
      diagnostic(
        "invalid-payload",
        "content_block_delta lacked an index or delta.",
        { frameIndex, eventType: "content_block_delta" },
      ),
    );
    return;
  }
  const assembly = blockAssembly(blocks, index);
  const type = stringValue(delta.type);
  if (type === "text_delta") {
    assembly.text += stringValue(delta.text) ?? "";
    return;
  }
  if (type === "input_json_delta") {
    assembly.partialJson += stringValue(delta.partial_json) ?? "";
    return;
  }
  if (type === "thinking_delta" || type === "signature_delta") {
    assembly.opaqueReasoning = true;
    return;
  }
  diagnostics.push(
    diagnostic(
      "unsupported-event",
      `Unknown Anthropic content delta ${type ?? "unknown"}.`,
      { frameIndex, eventType: type ?? "content_block_delta" },
    ),
  );
  unknown.push({
    type: "provider.event.unknown",
    evidence: "unknown",
    summary: {
      eventType: type ?? "content_block_delta",
      frameIndex,
      payload,
      rawPayloadPreserved: true,
    },
  });
}

function assembledBlockDrafts(
  blocks: ReadonlyMap<number, ContentBlockAssembly>,
  diagnostics: ParserDiagnostic[],
  responseId?: string,
): CanonicalEventDraft[] {
  const drafts: CanonicalEventDraft[] = [];
  const text: string[] = [];
  for (const assembly of [...blocks.values()].sort(
    (left, right) => left.index - right.index,
  )) {
    if (assembly.type === "text") {
      text.push(assembly.text);
      continue;
    }
    if (isToolUseType(assembly.type)) {
      drafts.push({
        type: "tool.call",
        summary: {
          ...(assembly.id === undefined ? {} : { callId: assembly.id }),
          ...(assembly.name === undefined ? {} : { name: assembly.name }),
          arguments:
            assembly.partialJson.length > 0
              ? parsePartialJson(
                  assembly.partialJson,
                  diagnostics,
                  "anthropic.tool_use.input",
                )
              : (assembly.input ?? {}),
          ...(assembly.type === "tool_use"
            ? {}
            : { providerType: assembly.type }),
        },
      });
      continue;
    }
    if (assembly.opaqueReasoning) {
      drafts.push({
        type: "provider.item.unknown",
        evidence: "unknown",
        summary: {
          itemType: assembly.type ?? "thinking",
          opaque: true,
          rawPayloadPreserved: true,
        },
      });
      continue;
    }
    drafts.push({
      type: "provider.item.unknown",
      evidence: "unknown",
      summary: {
        itemType: assembly.type ?? "unknown",
        ...(assembly.initial === undefined
          ? {}
          : { payload: assembly.initial }),
        rawPayloadPreserved: true,
      },
    });
  }
  if (text.length > 0) {
    drafts.unshift({
      type: "message.assistant",
      summary: {
        ...(responseId === undefined ? {} : { messageId: responseId }),
        text: text.join(""),
      },
    });
  }
  return drafts;
}

function normalizeSse(
  exchange: NormalizationExchange,
  options: NormalizationOptions,
): NormalizationResult {
  const parserId = "anthropic.messages.sse";
  const diagnostics: ParserDiagnostic[] = [];
  const parserErrors: CanonicalEventDraft[] = [];
  const duplicateErrors: CanonicalEventDraft[] = [];
  const started: CanonicalEventDraft[] = [];
  const unknown: CanonicalEventDraft[] = [];
  const terminal: CanonicalEventDraft[] = [];
  const blocks = new Map<number, ContentBlockAssembly>();
  const request = requestObject(exchange, diagnostics);
  const replayDetector = new SseReplayDetector();
  let responseId: string | undefined;
  let stopReason: string | undefined;
  let stopSequence: string | undefined;
  let reportedUsage: AnthropicUsage | undefined;
  let messageStopped = false;
  let incomplete = false;

  let frames: readonly SseFrame[] = [];
  try {
    const decoded = decodeSseChunks(
      exchange.responseBody === undefined ? [] : [exchange.responseBody],
    );
    frames = decoded.frames;
    if (decoded.incomplete !== undefined) {
      incomplete = true;
      diagnostics.push(
        diagnostic(
          "incomplete-sse",
          `Anthropic SSE frame ${decoded.incomplete.index} was not terminated.`,
          { frameIndex: decoded.incomplete.index },
        ),
      );
      if (exchange.outcome === "completed") {
        parserErrors.push(parserErrorDraft(parserId, decoded.incomplete.index));
      }
    }
  } catch (error: unknown) {
    incomplete = true;
    diagnostics.push(
      diagnostic(
        "malformed-sse",
        `Anthropic SSE decoding failed: ${error instanceof Error ? error.message : String(error)}`,
        { fatal: true },
      ),
    );
    parserErrors.push(parserErrorDraft(parserId, 1));
  }

  for (const frame of frames) {
    const beforeDiagnostics = diagnostics.length;
    const payload = framePayload(frame, diagnostics);
    if (payload === undefined) {
      if (diagnostics.length > beforeDiagnostics) {
        parserErrors.push(parserErrorDraft(parserId, frame.index));
      }
      continue;
    }
    const type = stringValue(payload.type) ?? frame.event;
    const replay = replayDetector.observe(frame, payload, type);
    if (replay.kind !== "accept") {
      diagnostics.push(replay.diagnostic);
      if (replay.kind === "conflict") {
        duplicateErrors.push(parserErrorDraft(parserId, frame.index));
      }
      continue;
    }

    switch (type) {
      case "message_start": {
        const message = isRecord(payload.message) ? payload.message : undefined;
        responseId = stringValue(message?.id) ?? responseId;
        reportedUsage = mergeUsage(reportedUsage, usage(message?.usage));
        if (responseId !== undefined) {
          started.push({
            type: "model.response.started",
            summary: { responseId },
          });
        }
        break;
      }
      case "content_block_start":
        applyContentBlockStart(payload, blocks, diagnostics, frame.index);
        break;
      case "content_block_delta":
        applyContentBlockDelta(
          payload,
          blocks,
          diagnostics,
          unknown,
          frame.index,
        );
        break;
      case "content_block_stop":
      case "ping":
        break;
      case "message_delta": {
        const delta = isRecord(payload.delta) ? payload.delta : undefined;
        stopReason = stringValue(delta?.stop_reason) ?? stopReason;
        stopSequence = stringValue(delta?.stop_sequence) ?? stopSequence;
        reportedUsage = mergeUsage(reportedUsage, usage(payload.usage));
        break;
      }
      case "message_stop":
        messageStopped = true;
        break;
      case "error": {
        const error = isRecord(payload.error) ? payload.error : payload;
        terminal.push({
          type: "api.error",
          summary: {
            ...(exchange.responseStatus === undefined
              ? {}
              : { status: exchange.responseStatus }),
            ...(stringValue(error.type) === undefined
              ? {}
              : { type: stringValue(error.type) }),
            ...(stringValue(error.message) === undefined
              ? {}
              : { message: stringValue(error.message) }),
          },
        });
        break;
      }
      default:
        diagnostics.push(
          diagnostic(
            "unsupported-event",
            `Unknown Anthropic event ${type ?? "unknown"}.`,
            {
              frameIndex: frame.index,
              eventType: type ?? "unknown",
            },
          ),
        );
        unknown.push({
          type: "provider.event.unknown",
          evidence: "unknown",
          summary: {
            eventType: type ?? "unknown",
            frameIndex: frame.index,
            payload,
            rawPayloadPreserved: true,
          },
        });
    }
  }

  const semantic: CanonicalEventDraft[] = [
    ...started,
    ...assembledBlockDrafts(blocks, diagnostics, responseId),
    ...unknown,
    ...(reportedUsage === undefined
      ? []
      : [
          {
            type: "model.usage",
            summary: usageSummary(reportedUsage),
          } satisfies CanonicalEventDraft,
        ]),
    ...terminal,
  ];
  if (messageStopped) {
    semantic.push({
      type: "model.response.completed",
      summary: {
        ...(responseId === undefined ? {} : { responseId }),
        ...(stopReason === undefined ? {} : { stopReason }),
        ...(stopSequence === undefined ? {} : { stopSequence }),
        ...(reportedUsage === undefined ? { usage: "unknown" } : {}),
      },
    });
  }
  if (exchange.outcome !== "completed" || !exchange.capture.responseComplete) {
    semantic.push({
      type: "transport.error",
      evidence: "derived",
      summary: {
        outcome: exchange.outcome,
        responseComplete: exchange.capture.responseComplete,
      },
    });
  }
  if (exchange.capture.droppedResponseBytes > 0) {
    diagnostics.push(
      diagnostic(
        "capture-incomplete",
        `${exchange.capture.droppedResponseBytes} response bytes were not retained.`,
      ),
    );
  }

  return NormalizationResultSchema.parse({
    parserId,
    parserVersion: ANTHROPIC_MESSAGES_NORMALIZER_VERSION,
    status:
      incomplete ||
      duplicateErrors.length > 0 ||
      diagnostics.some(
        (entry) =>
          entry.fatal ||
          entry.kind === "malformed-sse" ||
          entry.kind === "invalid-payload",
      )
        ? "malformed"
        : "parsed",
    events: materializeCanonicalEvents(
      exchange,
      [
        ...requestEvidenceDrafts(exchange, request),
        ...parserErrors,
        ...duplicateErrors,
        ...semantic,
      ],
      options,
    ),
    diagnostics,
  });
}

function normalizeContentDecodingFailure(
  exchange: NormalizationExchange,
  options: NormalizationOptions,
  error: AnthropicContentDecodingError,
): NormalizationResult {
  const parserId = contentType(exchange)
    .toLowerCase()
    .includes("text/event-stream")
    ? "anthropic.messages.sse"
    : "anthropic.messages.json";
  const diagnostics: ParserDiagnostic[] = [];
  const request = requestObject(exchange, diagnostics);
  diagnostics.push(
    diagnostic("invalid-payload", error.message, {
      eventType: "content-encoding",
      fatal: true,
    }),
  );
  return NormalizationResultSchema.parse({
    parserId,
    parserVersion: ANTHROPIC_MESSAGES_NORMALIZER_VERSION,
    status: "malformed",
    events: materializeCanonicalEvents(
      exchange,
      [...requestEvidenceDrafts(exchange, request), parserErrorDraft(parserId)],
      options,
    ),
    diagnostics,
  });
}

export class AnthropicMessagesNormalizer implements ExchangeNormalizer {
  readonly id = "anthropic.messages";
  readonly version = ANTHROPIC_MESSAGES_NORMALIZER_VERSION;

  supports(exchange: NormalizationExchange): boolean {
    return exchange.protocol === "anthropic.messages";
  }

  normalize(
    input: NormalizationExchange,
    options: NormalizationOptions = {},
  ): NormalizationResult {
    const exchange = NormalizationExchangeSchema.parse(input);
    if (!this.supports(exchange)) {
      return NormalizationResultSchema.parse({
        parserId: this.id,
        parserVersion: this.version,
        status: "unsupported",
        events: [],
        diagnostics: [],
      });
    }
    let decodedResponseBody: Uint8Array | undefined;
    try {
      decodedResponseBody = decodeResponseBody(exchange, options);
    } catch (error: unknown) {
      if (!(error instanceof AnthropicContentDecodingError)) {
        throw error;
      }
      return normalizeContentDecodingFailure(exchange, options, error);
    }
    const decodedExchange =
      decodedResponseBody === exchange.responseBody
        ? exchange
        : NormalizationExchangeSchema.parse({
            ...exchange,
            responseBody: decodedResponseBody,
          });
    return contentType(decodedExchange)
      .toLowerCase()
      .includes("text/event-stream")
      ? normalizeSse(decodedExchange, options)
      : normalizeJson(decodedExchange, options);
  }
}
