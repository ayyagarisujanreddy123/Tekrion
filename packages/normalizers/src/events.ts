import { createHash } from "node:crypto";

import { TekrionEventSchema, type TekrionEvent } from "@tekrion/protocol";

import type {
  CanonicalEventDraft,
  NormalizationExchange,
  NormalizationOptions,
} from "./contracts.js";

const DEFAULT_REDACTION = { applied: false, ruleIds: [] } as const;

export function canonicalEventId(
  exchange: NormalizationExchange,
  ordinal: number,
): string {
  const candidate = `event-${exchange.id}-${ordinal}`;
  if (candidate.length <= 512) {
    return candidate;
  }
  const digest = createHash("sha256").update(exchange.id).digest("hex");
  return `event-${digest}-${ordinal}`;
}

export function materializeCanonicalEvents(
  exchange: NormalizationExchange,
  drafts: readonly CanonicalEventDraft[],
  options: NormalizationOptions = {},
): TekrionEvent[] {
  const firstSequence = options.firstSequence ?? 1;
  if (!Number.isInteger(firstSequence) || firstSequence < 1) {
    throw new RangeError("First canonical event sequence must be positive.");
  }
  const observedAt =
    options.observedAt ?? exchange.endedAt ?? exchange.startedAt;
  const identifiers = drafts.map((_, index) =>
    (options.eventId ?? canonicalEventId)(exchange, index + 1),
  );

  return drafts.map((draft, index) => {
    if (
      draft.parentDraftIndex !== undefined &&
      (!Number.isInteger(draft.parentDraftIndex) ||
        draft.parentDraftIndex < 0 ||
        draft.parentDraftIndex >= index)
    ) {
      throw new RangeError(
        "A canonical event parent must refer to an earlier draft.",
      );
    }
    return TekrionEventSchema.parse({
      schemaVersion: 1,
      id: identifiers[index],
      sessionId: exchange.sessionId,
      ...(draft.parentDraftIndex === undefined
        ? {}
        : { parentId: identifiers[draft.parentDraftIndex] }),
      ...(draft.correlationId === undefined
        ? {}
        : { correlationId: draft.correlationId }),
      sequence: firstSequence + index,
      occurredAt: draft.occurredAt ?? exchange.startedAt,
      observedAt,
      ...(draft.durationMs === undefined
        ? {}
        : { durationMs: draft.durationMs }),
      source: draft.source ?? "proxy",
      type: draft.type,
      evidence: draft.evidence ?? "observed",
      summary: draft.summary,
      redaction: draft.redaction ?? DEFAULT_REDACTION,
    });
  });
}
