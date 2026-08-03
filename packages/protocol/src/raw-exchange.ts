import { z } from "zod";

import {
  BlobReferenceSchema,
  IdentifierSchema,
  IsoTimestampSchema,
  SchemaVersionSchema,
} from "./common.js";

const FORBIDDEN_PERSISTED_HEADERS = new Set([
  "anthropic-organization-id",
  "authorization",
  "chatgpt-account-id",
  "cookie",
  "proxy-authorization",
  "proxy-authenticate",
  "set-cookie",
  "x-api-key",
]);

function recordEntries(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return value;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null
    ? Object.entries(value)
    : value;
}

function stringArrayRecord(keySchema: z.ZodString) {
  return z
    .preprocess(
      recordEntries,
      z.array(z.tuple([keySchema, z.array(z.string())])),
    )
    .transform(
      (entries) => Object.fromEntries(entries) as Record<string, string[]>,
    );
}

const QueryParametersSchema = stringArrayRecord(z.string());

export const SafeHeadersSchema = stringArrayRecord(
  z.string().trim().min(1),
).superRefine((headers, context) => {
  for (const headerName of Object.keys(headers)) {
    if (FORBIDDEN_PERSISTED_HEADERS.has(headerName.toLowerCase())) {
      context.addIssue({
        code: "custom",
        message: `${headerName} must never be persisted`,
        path: [headerName],
      });
    }
  }
});

export const RawExchangeProtocolSchema = z.enum([
  "openai.responses",
  "openai.chat-completions",
  "anthropic.messages",
  "unknown-openai-compatible",
]);

export const RawExchangeOutcomeSchema = z.enum([
  "completed",
  "client-disconnected",
  "upstream-disconnected",
  "timeout",
  "upstream-error",
  "capture-incomplete",
]);

export const RawExchangeParseStatusSchema = z.enum([
  "pending",
  "parsed",
  "unsupported",
  "malformed",
  "skipped",
]);

export const RawExchangeSchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    id: IdentifierSchema,
    sessionId: IdentifierSchema,
    sequence: z.number().int().positive(),
    protocol: RawExchangeProtocolSchema,
    method: z.string().trim().min(1).max(32),
    path: z.string().startsWith("/"),
    query: QueryParametersSchema,
    requestHeaders: SafeHeadersSchema,
    requestBodyRef: BlobReferenceSchema.optional(),
    responseStatus: z.number().int().min(100).max(599).optional(),
    responseHeaders: SafeHeadersSchema.optional(),
    responseBodyRef: BlobReferenceSchema.optional(),
    streamManifestRef: BlobReferenceSchema.optional(),
    startedAt: IsoTimestampSchema,
    firstByteAt: IsoTimestampSchema.optional(),
    endedAt: IsoTimestampSchema.optional(),
    outcome: RawExchangeOutcomeSchema,
    parseStatus: RawExchangeParseStatusSchema,
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

export type RawExchange = z.infer<typeof RawExchangeSchema>;
export type RawExchangeOutcome = z.infer<typeof RawExchangeOutcomeSchema>;
export type RawExchangeParseStatus = z.infer<
  typeof RawExchangeParseStatusSchema
>;
export type RawExchangeProtocol = z.infer<typeof RawExchangeProtocolSchema>;
export type SafeHeaders = z.infer<typeof SafeHeadersSchema>;
