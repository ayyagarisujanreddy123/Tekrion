import {
  TekrionEventSchema,
  IsoTimestampSchema,
  RawExchangeOutcomeSchema,
  RawExchangeProtocolSchema,
  type TekrionEvent,
  type EvidenceKind,
  type EvidenceSource,
  type JsonObjectSchema,
  type Redaction,
} from "@tekrion/protocol";
import { z } from "zod";

const HeaderValueSchema = z.union([z.string(), z.array(z.string())]);

export const NormalizationExchangeSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().trim().min(1).max(512),
    sessionId: z.string().trim().min(1).max(512),
    rawSequence: z.number().int().positive(),
    protocol: RawExchangeProtocolSchema,
    method: z.string().trim().min(1).max(32),
    path: z.string().startsWith("/"),
    query: z.record(z.string(), z.array(z.string())),
    requestHeaders: z.record(z.string(), HeaderValueSchema),
    requestBody: z.instanceof(Uint8Array).optional(),
    responseStatus: z.number().int().min(100).max(599).optional(),
    responseHeaders: z.record(z.string(), HeaderValueSchema).optional(),
    responseBody: z.instanceof(Uint8Array).optional(),
    startedAt: IsoTimestampSchema,
    firstByteAt: IsoTimestampSchema.optional(),
    endedAt: IsoTimestampSchema.optional(),
    outcome: RawExchangeOutcomeSchema,
    capture: z
      .object({
        requestComplete: z.boolean(),
        responseComplete: z.boolean(),
        droppedRequestBytes: z.number().int().nonnegative(),
        droppedResponseBytes: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();

export const ParserDiagnosticSchema = z
  .object({
    kind: z.enum([
      "malformed-json",
      "malformed-sse",
      "incomplete-sse",
      "invalid-payload",
      "duplicate-replay",
      "duplicate-conflict",
      "unsupported-event",
      "capture-incomplete",
    ]),
    message: z.string().min(1).max(4096),
    frameIndex: z.number().int().positive().optional(),
    eventType: z.string().min(1).max(256).optional(),
    fatal: z.boolean(),
  })
  .strict();

export const NormalizationResultSchema = z
  .object({
    parserId: z.string().min(1).max(256),
    parserVersion: z.string().min(1).max(128),
    status: z.enum(["parsed", "malformed", "unsupported", "skipped"]),
    events: z.array(TekrionEventSchema),
    diagnostics: z.array(ParserDiagnosticSchema),
  })
  .strict();

export type NormalizationExchange = z.infer<typeof NormalizationExchangeSchema>;
export type NormalizationResult = z.infer<typeof NormalizationResultSchema>;
export type ParserDiagnostic = z.infer<typeof ParserDiagnosticSchema>;

export interface CanonicalEventDraft {
  readonly type: string;
  readonly summary: z.input<typeof JsonObjectSchema>;
  readonly evidence?: EvidenceKind;
  readonly source?: EvidenceSource;
  readonly correlationId?: string;
  readonly parentDraftIndex?: number;
  readonly occurredAt?: string;
  readonly durationMs?: number;
  readonly redaction?: Redaction;
}

export interface NormalizationOptions {
  readonly firstSequence?: number;
  readonly observedAt?: string;
  readonly maxDecodedResponseBodyBytes?: number;
  readonly eventId?: (
    exchange: NormalizationExchange,
    ordinal: number,
  ) => string;
  readonly knownResponseIds?: ReadonlySet<string>;
}

export interface ExchangeNormalizer {
  readonly id: string;
  readonly version: string;
  supports(exchange: NormalizationExchange): boolean;
  normalize(
    exchange: NormalizationExchange,
    options?: NormalizationOptions,
  ): NormalizationResult;
}

export type CanonicalEvents = readonly TekrionEvent[];
