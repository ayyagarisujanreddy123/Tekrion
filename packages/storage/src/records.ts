import {
  EvidenceKindSchema,
  IdentifierSchema,
  IsoTimestampSchema,
  JsonObjectSchema,
  SchemaVersionSchema,
} from "@tekrion/protocol";
import { z } from "zod";

export const FileChangeRecordSchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    eventId: IdentifierSchema,
    path: z.string().min(1),
    operation: z.enum(["create", "modify", "delete", "rename"]),
    previousPath: z.string().min(1).optional(),
    beforeHash: z
      .string()
      .regex(/^[a-f\d]{64}$/u)
      .optional(),
    afterHash: z
      .string()
      .regex(/^[a-f\d]{64}$/u)
      .optional(),
    patchBlobId: IdentifierSchema.optional(),
    timingPrecision: z.enum([
      "exact-adapter",
      "approximate-watcher",
      "exact-final-diff",
    ]),
    sensitivity: z.enum(["normal", "sensitive", "secret", "truncated"]),
  })
  .strict();

export const ContextEdgeRecordSchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    sessionId: IdentifierSchema,
    fromEventId: IdentifierSchema,
    toEventId: IdentifierSchema,
    edgeType: z.string().trim().min(1).max(128),
    evidence: EvidenceKindSchema,
    metadata: JsonObjectSchema,
  })
  .strict();

export const AnalysisRunRecordSchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    id: IdentifierSchema,
    sessionId: IdentifierSchema,
    kind: z.enum(["anomaly", "blame", "report", "ai-report"]),
    targetEventId: IdentifierSchema.optional(),
    status: z.enum(["pending", "running", "completed", "failed", "canceled"]),
    analyzer: z.string().trim().min(1),
    promptVersion: z.string().trim().min(1).optional(),
    startedAt: IsoTimestampSchema,
    endedAt: IsoTimestampSchema.optional(),
    resultBlobId: IdentifierSchema.optional(),
    error: z.string().min(1).optional(),
  })
  .strict();

export const RedactionRecordSchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    id: IdentifierSchema,
    sessionId: IdentifierSchema,
    location: z.string().trim().min(1),
    ruleId: IdentifierSchema,
    replacement: z.string(),
    hash: z.string().regex(/^[a-f\d]{64}$/u),
  })
  .strict();

export type AnalysisRunRecord = z.infer<typeof AnalysisRunRecordSchema>;
export type ContextEdgeRecord = z.infer<typeof ContextEdgeRecordSchema>;
export type FileChangeRecord = z.infer<typeof FileChangeRecordSchema>;
export type RedactionRecord = z.infer<typeof RedactionRecordSchema>;
