import { z } from "zod";

import {
  BlobReferenceSchema,
  EvidenceKindSchema,
  EvidenceSourceSchema,
  IdentifierSchema,
  IsoTimestampSchema,
  JsonObjectSchema,
  RedactionSchema,
  SchemaVersionSchema,
} from "./common.js";

export const TekrionEventSchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    id: IdentifierSchema,
    sessionId: IdentifierSchema,
    parentId: IdentifierSchema.optional(),
    correlationId: IdentifierSchema.optional(),
    sequence: z.number().int().positive(),
    occurredAt: IsoTimestampSchema,
    observedAt: IsoTimestampSchema,
    durationMs: z.number().nonnegative().finite().optional(),
    source: EvidenceSourceSchema,
    type: z.string().trim().min(1).max(256),
    evidence: EvidenceKindSchema,
    payloadRef: BlobReferenceSchema.optional(),
    summary: JsonObjectSchema,
    redaction: RedactionSchema,
  })
  .strict();

export type TekrionEvent = z.infer<typeof TekrionEventSchema>;
