import { z } from "zod";

import {
  CaptureLevelSchema,
  IdentifierSchema,
  IsoTimestampSchema,
  JsonObjectSchema,
  NullableTokenCountSchema,
  SchemaVersionSchema,
} from "./common.js";

export const SessionStatusSchema = z.enum([
  "active",
  "completed",
  "crashed",
  "incomplete",
  "imported-readonly",
]);

export const SessionUpstreamRouteSchema = z.enum(["direct", "codex-auth"]);

export const SessionCommandSchema = z
  .object({
    executable: z.string().min(1),
    arguments: z.array(z.string()),
    cwd: z.string().min(1),
  })
  .strict();

export const SessionSchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    id: IdentifierSchema,
    startedAt: IsoTimestampSchema,
    endedAt: IsoTimestampSchema.optional(),
    status: SessionStatusSchema,
    captureLevel: CaptureLevelSchema,
    command: SessionCommandSchema.optional(),
    repoRoot: z.string().min(1).optional(),
    agentName: z.string().trim().min(1).optional(),
    models: z.array(z.string().trim().min(1)),
    upstreamOrigin: z.url().optional(),
    upstreamRoute: SessionUpstreamRouteSchema.optional(),
    tags: z.array(z.string().trim().min(1)),
    counts: z
      .object({
        events: z.number().int().nonnegative(),
        errors: z.number().int().nonnegative(),
        inputTokens: NullableTokenCountSchema,
        outputTokens: NullableTokenCountSchema,
      })
      .strict(),
    metadata: JsonObjectSchema,
  })
  .strict()
  .refine(
    (session) =>
      session.endedAt === undefined ||
      Date.parse(session.endedAt) >= Date.parse(session.startedAt),
    {
      message: "endedAt must not precede startedAt",
      path: ["endedAt"],
    },
  );

export type Session = z.infer<typeof SessionSchema>;
export type SessionCommand = z.infer<typeof SessionCommandSchema>;
export type SessionStatus = z.infer<typeof SessionStatusSchema>;
export type SessionUpstreamRoute = z.infer<typeof SessionUpstreamRouteSchema>;
