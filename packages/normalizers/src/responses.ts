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

export const RESPONSES_NORMALIZER_VERSION = "1.2.0";

type JsonRecord = Record<string, unknown>;

interface ReportedUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
}

interface FunctionAssembly {
  callId?: string;
  name?: string;
  argumentsDelta: string;
  argumentsDone?: string;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function tokenValue(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

function reportedUsage(value: unknown): ReportedUsage | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const inputTokens = tokenValue(value.input_tokens);
  const outputTokens = tokenValue(value.output_tokens);
  const totalTokens = tokenValue(value.total_tokens);
  if (inputTokens === null && outputTokens === null && totalTokens === null) {
    return undefined;
  }
  return { inputTokens, outputTokens, totalTokens };
}

function usageSummary(usage: ReportedUsage): JsonRecord {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
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

function looksLikeSse(bytes: Uint8Array | undefined): boolean {
  if (bytes === undefined || bytes.length === 0) {
    return false;
  }
  const prefix = new TextDecoder("utf-8").decode(bytes.subarray(0, 4096));
  const firstLine = prefix.trimStart().split(/\r?\n/u, 1)[0] ?? "";
  return (
    firstLine.startsWith(":") ||
    firstLine.startsWith("event:") ||
    firstLine.startsWith("data:") ||
    firstLine.startsWith("id:") ||
    firstLine.startsWith("retry:")
  );
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

function parseArguments(
  raw: string,
  diagnostics: ParserDiagnostic[],
  eventType: string,
): unknown {
  try {
    return JSON.parse(raw);
  } catch (error: unknown) {
    diagnostics.push(
      diagnostic(
        "invalid-payload",
        `Function arguments were not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        { eventType },
      ),
    );
    return raw;
  }
}

function requestObject(
  exchange: NormalizationExchange,
  diagnostics: ParserDiagnostic[],
): JsonRecord | undefined {
  try {
    const value = decodeJson(exchange.requestBody);
    if (value === undefined) {
      return undefined;
    }
    if (!isRecord(value)) {
      diagnostics.push(
        diagnostic("invalid-payload", "Responses request must be an object."),
      );
      return undefined;
    }
    return value;
  } catch (error: unknown) {
    diagnostics.push(
      diagnostic(
        "malformed-json",
        `Responses request JSON could not be decoded: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
    return undefined;
  }
}

function requestToolResultDrafts(request: JsonRecord | undefined) {
  const input = request?.input;
  if (!Array.isArray(input)) {
    return [];
  }
  const drafts: CanonicalEventDraft[] = [];
  for (const item of input) {
    if (!isRecord(item) || item.type !== "function_call_output") {
      continue;
    }
    const callId = stringValue(item.call_id);
    drafts.push({
      type: "tool.result",
      summary: {
        ...(callId === undefined ? {} : { callId }),
        output: item.output ?? null,
      },
    });
  }
  return drafts;
}

function requestEvidenceDrafts(
  exchange: NormalizationExchange,
  request: JsonRecord | undefined,
  options: NormalizationOptions,
): CanonicalEventDraft[] {
  const previousResponseId = stringValue(request?.previous_response_id);
  const summary =
    previousResponseId === undefined
      ? {
          endpoint: exchange.path,
          ...(stringValue(request?.model) === undefined
            ? {}
            : { model: stringValue(request?.model) }),
        }
      : {
          previousResponseId,
          contextCompleteness:
            options.knownResponseIds?.has(previousResponseId) === true
              ? "complete-client-chain"
              : "partial-client-chain",
          ...(options.knownResponseIds?.has(previousResponseId) === true
            ? {}
            : { missingAncestorIds: [previousResponseId] }),
        };
  return [
    ...requestToolResultDrafts(request),
    { type: "model.request", summary },
  ];
}

function outputItemDrafts(
  output: readonly unknown[],
  diagnostics: ParserDiagnostic[],
): CanonicalEventDraft[] {
  const drafts: CanonicalEventDraft[] = [];
  for (const itemValue of output) {
    if (!isRecord(itemValue)) {
      diagnostics.push(
        diagnostic(
          "invalid-payload",
          "Responses output item was not an object.",
        ),
      );
      continue;
    }
    const itemType = stringValue(itemValue.type);
    if (itemType === "message") {
      const content = Array.isArray(itemValue.content) ? itemValue.content : [];
      const text = content
        .filter(isRecord)
        .filter((part) => part.type === "output_text")
        .map((part) => stringValue(part.text) ?? "")
        .join("");
      drafts.push({
        type: "message.assistant",
        summary: {
          ...(stringValue(itemValue.id) === undefined
            ? {}
            : { messageId: stringValue(itemValue.id) }),
          text,
        },
      });
      continue;
    }
    if (itemType === "function_call") {
      const rawArguments = stringValue(itemValue.arguments) ?? "";
      const callId =
        stringValue(itemValue.call_id) ?? stringValue(itemValue.id);
      drafts.push({
        type: "tool.call",
        summary: {
          ...(callId === undefined ? {} : { callId }),
          ...(stringValue(itemValue.name) === undefined
            ? {}
            : { name: stringValue(itemValue.name) }),
          arguments: parseArguments(
            rawArguments,
            diagnostics,
            "response.output.function_call",
          ),
        },
      });
      continue;
    }
    drafts.push({
      type: "provider.item.unknown",
      evidence: "unknown",
      summary: {
        itemType: itemType ?? "unknown",
        ...(stringValue(itemValue.id) === undefined
          ? {}
          : { itemId: stringValue(itemValue.id) }),
        payload: itemValue,
        rawPayloadPreserved: true,
      },
    });
  }
  return drafts;
}

function errorDraft(
  responseStatus: number | undefined,
  value: JsonRecord,
): CanonicalEventDraft | undefined {
  const error = isRecord(value.error) ? value.error : undefined;
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
      ...(stringValue(error?.code) === undefined
        ? {}
        : { code: stringValue(error?.code) }),
      ...(stringValue(error?.message) === undefined
        ? {}
        : { message: stringValue(error?.message) }),
    },
  };
}

function normalizeJson(
  exchange: NormalizationExchange,
  options: NormalizationOptions,
): NormalizationResult {
  const parserId = "openai.responses.json";
  const diagnostics: ParserDiagnostic[] = [];
  const request = requestObject(exchange, diagnostics);
  let response: JsonRecord | undefined;
  try {
    const decoded = decodeJson(exchange.responseBody);
    if (isRecord(decoded)) {
      response = decoded;
    } else {
      diagnostics.push(
        diagnostic("invalid-payload", "Responses response must be an object.", {
          fatal: true,
        }),
      );
    }
  } catch (error: unknown) {
    diagnostics.push(
      diagnostic(
        "malformed-json",
        `Responses response JSON could not be decoded: ${error instanceof Error ? error.message : String(error)}`,
        { fatal: true },
      ),
    );
  }

  const drafts = requestEvidenceDrafts(exchange, request, options);
  if (response === undefined) {
    drafts.push(parserErrorDraft(parserId));
  } else {
    const apiError = errorDraft(exchange.responseStatus, response);
    if (apiError !== undefined) {
      drafts.push(apiError);
    } else {
      const output = Array.isArray(response.output) ? response.output : [];
      const previousResponseId = stringValue(request?.previous_response_id);
      drafts.push(...outputItemDrafts(output, diagnostics));

      const usage = reportedUsage(response.usage);
      const responseId = stringValue(response.id);
      const responseStatus = stringValue(response.status);
      if (usage !== undefined) {
        drafts.push({
          type: "model.usage",
          summary: {
            ...(output.length === 0 ? { status: "reported" } : {}),
            ...usageSummary(usage),
          },
        });
      }
      if (output.length > 0) {
        drafts.push({
          type: "model.response.completed",
          summary: {
            ...(responseId === undefined ? {} : { responseId }),
            ...(responseStatus === undefined ? {} : { status: responseStatus }),
            ...(usage === undefined
              ? {
                  usage: "unknown",
                  inputTokens: null,
                  outputTokens: null,
                }
              : {}),
          },
        });
      } else if (usage === undefined) {
        drafts.push({
          type: "model.response.completed",
          summary: {
            ...(responseId === undefined ? {} : { responseId }),
            usage: "unknown",
            ...(previousResponseId === undefined
              ? { inputTokens: null, outputTokens: null }
              : {}),
          },
        });
      }
    }
  }

  return NormalizationResultSchema.parse({
    parserId,
    parserVersion: RESPONSES_NORMALIZER_VERSION,
    status: diagnostics.some((entry) => entry.fatal) ? "malformed" : "parsed",
    events: materializeCanonicalEvents(exchange, drafts, options),
    diagnostics,
  });
}

function eventPayload(
  frame: SseFrame,
  diagnostics: ParserDiagnostic[],
): JsonRecord | undefined {
  if (frame.data === undefined || frame.data === "[DONE]") {
    return undefined;
  }
  try {
    const value = JSON.parse(frame.data);
    if (!isRecord(value)) {
      throw new TypeError("SSE data must decode to an object.");
    }
    return value;
  } catch (error: unknown) {
    diagnostics.push(
      diagnostic(
        "malformed-sse",
        `Responses SSE frame ${frame.index} was not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        { frameIndex: frame.index },
      ),
    );
    return undefined;
  }
}

function functionAssembly(
  functions: Map<string, FunctionAssembly>,
  itemId: string,
): FunctionAssembly {
  const existing = functions.get(itemId);
  if (existing !== undefined) {
    return existing;
  }
  const created: FunctionAssembly = { argumentsDelta: "" };
  functions.set(itemId, created);
  return created;
}

function applyOutputItem(
  item: JsonRecord,
  texts: Map<string, string>,
  functions: Map<string, FunctionAssembly>,
  finalized: boolean,
): boolean {
  const type = stringValue(item.type);
  const id = stringValue(item.id);
  if (type === "message" && id !== undefined) {
    const content = Array.isArray(item.content) ? item.content : [];
    const text = content
      .filter(isRecord)
      .filter((part) => part.type === "output_text")
      .map((part) => stringValue(part.text) ?? "")
      .join("");
    if (text.length > 0) {
      texts.set(id, text);
    }
    return true;
  }
  if (type === "function_call" && id !== undefined) {
    const assembly = functionAssembly(functions, id);
    assembly.callId = stringValue(item.call_id) ?? id;
    const name = stringValue(item.name);
    const argumentsDone = stringValue(item.arguments);
    if (name !== undefined) {
      assembly.name = name;
    }
    if (finalized && argumentsDone !== undefined) {
      assembly.argumentsDone = argumentsDone;
    }
    return true;
  }
  return false;
}

function normalizeSse(
  exchange: NormalizationExchange,
  options: NormalizationOptions,
): NormalizationResult {
  const parserId = "openai.responses.sse";
  const diagnostics: ParserDiagnostic[] = [];
  const parserErrors: CanonicalEventDraft[] = [];
  const duplicateErrors: CanonicalEventDraft[] = [];
  const started: CanonicalEventDraft[] = [];
  const terminal: CanonicalEventDraft[] = [];
  const unknown: CanonicalEventDraft[] = [];
  const request = requestObject(exchange, diagnostics);
  const requestEvidence = requestEvidenceDrafts(exchange, request, options);
  const texts = new Map<string, string>();
  const functions = new Map<string, FunctionAssembly>();
  let usage: ReportedUsage | undefined;
  const replayDetector = new SseReplayDetector();

  let frames: readonly SseFrame[] = [];
  let incompleteIndex: number | undefined;
  try {
    const decoded = decodeSseChunks(
      exchange.responseBody === undefined ? [] : [exchange.responseBody],
    );
    frames = decoded.frames;
    incompleteIndex = decoded.incomplete?.index;
    if (decoded.incomplete !== undefined) {
      diagnostics.push(
        diagnostic(
          "incomplete-sse",
          `Responses SSE frame ${decoded.incomplete.index} was not terminated.`,
          { frameIndex: decoded.incomplete.index },
        ),
      );
      if (exchange.outcome === "completed") {
        parserErrors.push(parserErrorDraft(parserId, decoded.incomplete.index));
      }
    }
  } catch (error: unknown) {
    diagnostics.push(
      diagnostic(
        "malformed-sse",
        `Responses SSE decoding failed: ${error instanceof Error ? error.message : String(error)}`,
        { fatal: true },
      ),
    );
    parserErrors.push(parserErrorDraft(parserId, 1));
  }

  for (const frame of frames) {
    const beforeDiagnostics = diagnostics.length;
    const payload = eventPayload(frame, diagnostics);
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
    if (type === undefined) {
      unknown.push({
        type: "provider.event.unknown",
        evidence: "unknown",
        summary: {
          eventType: "unknown",
          frameIndex: frame.index,
          payload,
          rawPayloadPreserved: true,
        },
      });
      continue;
    }

    switch (type) {
      case "response.created": {
        const response = isRecord(payload.response)
          ? payload.response
          : undefined;
        const responseId = stringValue(response?.id);
        if (responseId === undefined) {
          diagnostics.push(
            diagnostic(
              "invalid-payload",
              "response.created had no response ID.",
              {
                frameIndex: frame.index,
                eventType: type,
              },
            ),
          );
          parserErrors.push(parserErrorDraft(parserId, frame.index));
        } else {
          started.push({
            type: "model.response.started",
            summary: { responseId },
          });
        }
        break;
      }
      case "response.output_text.delta": {
        const itemId = stringValue(payload.item_id);
        const delta = stringValue(payload.delta);
        if (itemId !== undefined && delta !== undefined) {
          texts.set(itemId, `${texts.get(itemId) ?? ""}${delta}`);
        } else {
          diagnostics.push(
            diagnostic(
              "invalid-payload",
              "Text delta lacked item_id or delta.",
              {
                frameIndex: frame.index,
                eventType: type,
              },
            ),
          );
          parserErrors.push(parserErrorDraft(parserId, frame.index));
        }
        break;
      }
      case "response.output_text.done": {
        const itemId = stringValue(payload.item_id);
        const text = stringValue(payload.text);
        if (itemId !== undefined && text !== undefined) {
          texts.set(itemId, text);
        }
        break;
      }
      case "response.function_call_arguments.delta": {
        const itemId = stringValue(payload.item_id);
        const delta = stringValue(payload.delta);
        if (itemId !== undefined && delta !== undefined) {
          const assembly = functionAssembly(functions, itemId);
          assembly.argumentsDelta += delta;
        } else {
          diagnostics.push(
            diagnostic(
              "invalid-payload",
              "Function delta lacked item_id or delta.",
              {
                frameIndex: frame.index,
                eventType: type,
              },
            ),
          );
          parserErrors.push(parserErrorDraft(parserId, frame.index));
        }
        break;
      }
      case "response.function_call_arguments.done": {
        const itemId = stringValue(payload.item_id);
        if (itemId !== undefined) {
          const assembly = functionAssembly(functions, itemId);
          assembly.callId = stringValue(payload.call_id) ?? itemId;
          const name = stringValue(payload.name);
          const argumentsDone = stringValue(payload.arguments);
          if (name !== undefined) {
            assembly.name = name;
          }
          if (argumentsDone !== undefined) {
            assembly.argumentsDone = argumentsDone;
          }
        }
        break;
      }
      case "response.output_item.added":
      case "response.output_item.done": {
        if (
          !isRecord(payload.item) ||
          !applyOutputItem(
            payload.item,
            texts,
            functions,
            type === "response.output_item.done",
          )
        ) {
          unknown.push({
            type: "provider.item.unknown",
            evidence: "unknown",
            summary: {
              itemType: isRecord(payload.item)
                ? (stringValue(payload.item.type) ?? "unknown")
                : "unknown",
              frameIndex: frame.index,
              payload: payload.item ?? payload,
              rawPayloadPreserved: true,
            },
          });
        }
        break;
      }
      case "response.completed":
      case "response.failed":
      case "response.incomplete": {
        const response = isRecord(payload.response)
          ? payload.response
          : undefined;
        usage = reportedUsage(response?.usage) ?? usage;
        terminal.push({
          type: "model.response.completed",
          summary: {
            ...(stringValue(response?.id) === undefined
              ? {}
              : { responseId: stringValue(response?.id) }),
            ...(stringValue(response?.status) === undefined
              ? {}
              : { status: stringValue(response?.status) }),
          },
        });
        break;
      }
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
            ...(stringValue(error.code) === undefined
              ? {}
              : { code: stringValue(error.code) }),
            ...(stringValue(error.message) === undefined
              ? {}
              : { message: stringValue(error.message) }),
          },
        });
        break;
      }
      default:
        diagnostics.push(
          diagnostic("unsupported-event", `Unknown Responses event ${type}.`, {
            frameIndex: frame.index,
            eventType: type,
          }),
        );
        unknown.push({
          type: "provider.event.unknown",
          evidence: "unknown",
          summary: {
            eventType: type,
            frameIndex: frame.index,
            payload,
            rawPayloadPreserved: true,
          },
        });
    }
  }

  const semantic: CanonicalEventDraft[] = [
    ...started,
    ...Array.from(texts, ([messageId, text]) => ({
      type: "message.assistant",
      summary: { messageId, text },
    })),
    ...Array.from(functions, ([itemId, assembly]) => {
      const rawArguments = assembly.argumentsDone ?? assembly.argumentsDelta;
      return {
        type: "tool.call",
        summary: {
          callId: assembly.callId ?? itemId,
          ...(assembly.name === undefined ? {} : { name: assembly.name }),
          arguments: parseArguments(
            rawArguments,
            diagnostics,
            "response.function_call_arguments",
          ),
        },
      } satisfies CanonicalEventDraft;
    }),
    ...unknown,
    ...(usage === undefined
      ? []
      : [{ type: "model.usage", summary: usageSummary(usage) }]),
    ...terminal,
  ];

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

  const hasParserErrors = parserErrors.length > 0;
  const drafts = hasParserErrors
    ? [
        ...requestEvidence,
        ...parserErrors,
        ...duplicateErrors,
        ...semantic.filter(
          (draft) =>
            draft.type === "model.response.completed" ||
            draft.type === "transport.error",
        ),
      ]
    : [...requestEvidence, ...duplicateErrors, ...semantic];
  return NormalizationResultSchema.parse({
    parserId,
    parserVersion: RESPONSES_NORMALIZER_VERSION,
    status:
      diagnostics.some(
        (entry) =>
          entry.fatal ||
          entry.kind === "malformed-sse" ||
          entry.kind === "incomplete-sse" ||
          entry.kind === "invalid-payload",
      ) || incompleteIndex !== undefined
        ? "malformed"
        : "parsed",
    events: materializeCanonicalEvents(exchange, drafts, options),
    diagnostics,
  });
}

export class ResponsesNormalizer implements ExchangeNormalizer {
  readonly id = "openai.responses";
  readonly version = RESPONSES_NORMALIZER_VERSION;

  supports(exchange: NormalizationExchange): boolean {
    return exchange.protocol === "openai.responses";
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
    return contentType(exchange).toLowerCase().includes("text/event-stream") ||
      looksLikeSse(exchange.responseBody)
      ? normalizeSse(exchange, options)
      : normalizeJson(exchange, options);
  }
}
