import { z } from "zod";

import {
  EvidenceSourceSchema,
  IdentifierSchema,
  IsoTimestampSchema,
  SchemaVersionSchema,
} from "./common.js";
import { TekrionEventSchema } from "./event.js";
import { WorkspaceFileChangeSummarySchema } from "./process.js";
import { RawExchangeSchema } from "./raw-exchange.js";
import { SessionSchema } from "./session.js";

export const QueryCursorSchema = z.string().min(1).max(4096);
export const QueryLimitSchema = z.number().int().min(1).max(1000);
export const LiveEventCursorSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);

export const SessionListQuerySchema = z
  .object({
    limit: QueryLimitSchema.default(100),
    cursor: QueryCursorSchema.optional(),
    includeInternal: z.boolean().default(false),
  })
  .strict();

export const SessionPageSchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    sessions: z.array(SessionSchema),
    nextCursor: QueryCursorSchema.optional(),
  })
  .strict();

export const SessionDetailSchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    session: SessionSchema,
  })
  .strict();

export const EventListQuerySchema = z
  .object({
    limit: QueryLimitSchema.default(100),
    cursor: QueryCursorSchema.optional(),
    type: z.string().trim().min(1).max(256).optional(),
    source: EvidenceSourceSchema.optional(),
    occurredAfter: IsoTimestampSchema.optional(),
    occurredBefore: IsoTimestampSchema.optional(),
  })
  .strict()
  .refine(
    (query) =>
      query.occurredAfter === undefined ||
      query.occurredBefore === undefined ||
      Date.parse(query.occurredAfter) <= Date.parse(query.occurredBefore),
    {
      message: "occurredAfter must not follow occurredBefore",
      path: ["occurredAfter"],
    },
  );

export const EventPageSchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    sessionId: IdentifierSchema,
    events: z.array(TekrionEventSchema),
    nextCursor: QueryCursorSchema.optional(),
  })
  .strict();

export const EventDetailSchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    event: TekrionEventSchema,
    fileChange: WorkspaceFileChangeSummarySchema.optional(),
    rawExchange: RawExchangeSchema.optional(),
    normalizationVersion: z.string().trim().min(1).max(256).optional(),
  })
  .strict();

export const FileChangeListQuerySchema = z
  .object({
    limit: QueryLimitSchema.default(100),
    cursor: QueryCursorSchema.optional(),
  })
  .strict();

export const FileChangeItemSchema = z
  .object({
    event: TekrionEventSchema,
    change: WorkspaceFileChangeSummarySchema.nullable(),
  })
  .strict();

export const FileChangePageSchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    sessionId: IdentifierSchema,
    changes: z.array(FileChangeItemSchema),
    nextCursor: QueryCursorSchema.optional(),
  })
  .strict();

export const LiveEventResumeQuerySchema = z
  .object({
    afterSequence: LiveEventCursorSchema.default(0),
  })
  .strict();

export const LiveEventReadySchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    sessionId: IdentifierSchema,
    afterSequence: LiveEventCursorSchema,
  })
  .strict();

export const EventSearchQuerySchema = z
  .object({
    query: z.string().trim().min(1).max(1024),
    limit: z.number().int().min(1).max(200).default(50),
  })
  .strict();

export const EventSearchResultSchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    sessionId: IdentifierSchema,
    query: z.string().min(1),
    events: z.array(TekrionEventSchema),
  })
  .strict();

export const QueryErrorSchema = z
  .object({
    error: z.enum([
      "bad_request",
      "unauthorized",
      "forbidden_origin",
      "not_found",
      "method_not_allowed",
      "payload_unavailable",
      "stream_capacity_exceeded",
      "internal_query_error",
    ]),
    message: z.string().min(1).max(4096).optional(),
  })
  .strict();

export type EventListQuery = z.infer<typeof EventListQuerySchema>;
export type EventListQueryInput = z.input<typeof EventListQuerySchema>;
export type EventDetail = z.infer<typeof EventDetailSchema>;
export type EventPage = z.infer<typeof EventPageSchema>;
export type EventSearchQuery = z.infer<typeof EventSearchQuerySchema>;
export type EventSearchQueryInput = z.input<typeof EventSearchQuerySchema>;
export type EventSearchResult = z.infer<typeof EventSearchResultSchema>;
export type FileChangeListQuery = z.infer<typeof FileChangeListQuerySchema>;
export type FileChangeListQueryInput = z.input<
  typeof FileChangeListQuerySchema
>;
export type FileChangePage = z.infer<typeof FileChangePageSchema>;
export type LiveEventCursor = z.infer<typeof LiveEventCursorSchema>;
export type LiveEventReady = z.infer<typeof LiveEventReadySchema>;
export type LiveEventResumeQuery = z.infer<typeof LiveEventResumeQuerySchema>;
export type LiveEventResumeQueryInput = z.input<
  typeof LiveEventResumeQuerySchema
>;
export type QueryError = z.infer<typeof QueryErrorSchema>;
export type SessionDetail = z.infer<typeof SessionDetailSchema>;
export type SessionListQuery = z.infer<typeof SessionListQuerySchema>;
export type SessionListQueryInput = z.input<typeof SessionListQuerySchema>;
export type SessionPage = z.infer<typeof SessionPageSchema>;
