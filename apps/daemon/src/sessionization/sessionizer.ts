import { createHash, randomUUID } from "node:crypto";

import { IdentifierSchema } from "@tekrion/protocol";

export const SESSION_SIGNAL_HEADERS = {
  explicit: "x-tekrion-session",
  adapter: "x-tekrion-agent-session",
  ancestry: "x-tekrion-response-ancestor",
  analysis: "x-tekrion-analysis-session",
  analysisTarget: "x-tekrion-analysis-target",
  client: "x-tekrion-client-id",
} as const;

export const LEGACY_SESSION_SIGNAL_HEADERS = {
  explicit: "x-blackbox-session",
  adapter: "x-blackbox-agent-session",
  ancestry: "x-blackbox-response-ancestor",
  analysis: "x-blackbox-analysis-session",
  analysisTarget: "x-blackbox-analysis-target",
  client: "x-blackbox-client-id",
} as const;

export const SESSION_SIGNAL_HEADER_NAMES = [
  ...Object.values(SESSION_SIGNAL_HEADERS),
  ...Object.values(LEGACY_SESSION_SIGNAL_HEADERS),
] as const;

export type SessionizationSource =
  "analysis" | "explicit" | "adapter" | "ancestry" | "heuristic" | "manual";

export interface SessionizationSignals {
  readonly analysisSessionId?: string;
  readonly analysisTargetSessionId?: string;
  readonly explicitSessionId?: string;
  readonly adapterSessionId?: string;
  readonly ancestorResponseIds?: readonly string[];
  readonly clientFingerprint?: string;
  readonly manualSessionId?: string;
}

export interface SessionizationDecision {
  readonly sessionId: string;
  readonly source: SessionizationSource;
  readonly internalAnalysis: boolean;
  readonly analysisTargetSessionId?: string;
  readonly matchedAncestorResponseId?: string;
}

export interface SessionizerOptions {
  readonly idleWindowMilliseconds?: number;
  readonly createSessionId?: (
    source: Exclude<SessionizationSource, "explicit" | "ancestry" | "manual">,
    key: string,
  ) => string;
}

interface HeuristicSession {
  readonly sessionId: string;
  lastSeenAt: number;
}

function stableSessionId(prefix: string, key: string): string {
  const digest = createHash("sha256").update(key).digest("hex");
  return `session-${prefix}-${digest}`;
}

function optionalIdentifier(value: string | undefined): string | undefined {
  if (value === undefined || value.trim().length === 0) {
    return undefined;
  }
  return IdentifierSchema.parse(value);
}

function requiredKey(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 4096) {
    throw new RangeError(
      "Sessionization keys must contain 1 to 4096 characters.",
    );
  }
  return trimmed;
}

export class Sessionizer {
  readonly idleWindowMilliseconds: number;
  private readonly createSessionId: NonNullable<
    SessionizerOptions["createSessionId"]
  >;
  private readonly adapterSessions = new Map<string, string>();
  private readonly analysisSessions = new Map<string, string>();
  private readonly responseSessions = new Map<string, string>();
  private readonly heuristicSessions = new Map<string, HeuristicSession>();

  constructor(options: SessionizerOptions = {}) {
    this.idleWindowMilliseconds = options.idleWindowMilliseconds ?? 5 * 60_000;
    if (
      !Number.isInteger(this.idleWindowMilliseconds) ||
      this.idleWindowMilliseconds < 1 ||
      this.idleWindowMilliseconds > 24 * 60 * 60_000
    ) {
      throw new RangeError(
        "The sessionization idle window must be between 1 ms and 24 hours.",
      );
    }
    this.createSessionId =
      options.createSessionId ??
      ((source, key) =>
        source === "heuristic"
          ? `session-heuristic-${randomUUID()}`
          : stableSessionId(source, key));
  }

  resolve(
    signals: SessionizationSignals,
    observedAt: number = Date.now(),
  ): SessionizationDecision {
    if (!Number.isFinite(observedAt)) {
      throw new RangeError("Sessionization time must be finite.");
    }

    const analysisKey = signals.analysisSessionId;
    if (analysisKey !== undefined) {
      const key = requiredKey(analysisKey);
      const sessionId = this.mappedSession(
        this.analysisSessions,
        key,
        "analysis",
      );
      const analysisTargetSessionId = optionalIdentifier(
        signals.analysisTargetSessionId,
      );
      return {
        sessionId,
        source: "analysis",
        internalAnalysis: true,
        ...(analysisTargetSessionId === undefined
          ? {}
          : { analysisTargetSessionId }),
      };
    }

    const explicitSessionId = optionalIdentifier(signals.explicitSessionId);
    if (explicitSessionId !== undefined) {
      return {
        sessionId: explicitSessionId,
        source: "explicit",
        internalAnalysis: false,
      };
    }

    if (signals.adapterSessionId !== undefined) {
      const key = requiredKey(signals.adapterSessionId);
      return {
        sessionId: this.mappedSession(this.adapterSessions, key, "adapter"),
        source: "adapter",
        internalAnalysis: false,
      };
    }

    for (const candidate of signals.ancestorResponseIds ?? []) {
      const responseId = requiredKey(candidate);
      const sessionId = this.responseSessions.get(responseId);
      if (sessionId !== undefined) {
        return {
          sessionId,
          source: "ancestry",
          internalAnalysis: false,
          matchedAncestorResponseId: responseId,
        };
      }
    }

    if (signals.clientFingerprint !== undefined) {
      const fingerprint = requiredKey(signals.clientFingerprint);
      this.expireHeuristics(observedAt);
      const existing = this.heuristicSessions.get(fingerprint);
      if (existing !== undefined) {
        existing.lastSeenAt = observedAt;
        return {
          sessionId: existing.sessionId,
          source: "heuristic",
          internalAnalysis: false,
        };
      }
      const sessionId = IdentifierSchema.parse(
        this.createSessionId("heuristic", fingerprint),
      );
      this.heuristicSessions.set(fingerprint, {
        sessionId,
        lastSeenAt: observedAt,
      });
      return {
        sessionId,
        source: "heuristic",
        internalAnalysis: false,
      };
    }

    const manualSessionId = optionalIdentifier(signals.manualSessionId);
    return {
      sessionId: manualSessionId ?? `session-manual-${randomUUID()}`,
      source: "manual",
      internalAnalysis: false,
    };
  }

  registerResponse(responseId: string, sessionId: string): void {
    const responseKey = requiredKey(responseId);
    const validatedSessionId = IdentifierSchema.parse(sessionId);
    const existing = this.responseSessions.get(responseKey);
    if (existing !== undefined && existing !== validatedSessionId) {
      throw new Error(
        `Response ${responseKey} is already assigned to session ${existing}.`,
      );
    }
    this.responseSessions.set(responseKey, validatedSessionId);
  }

  knownResponseIds(): ReadonlySet<string> {
    return new Set(this.responseSessions.keys());
  }

  private mappedSession(
    sessions: Map<string, string>,
    key: string,
    source: "adapter" | "analysis",
  ): string {
    const existing = sessions.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const created = IdentifierSchema.parse(this.createSessionId(source, key));
    sessions.set(key, created);
    return created;
  }

  private expireHeuristics(observedAt: number): void {
    for (const [fingerprint, session] of this.heuristicSessions) {
      if (observedAt - session.lastSeenAt > this.idleWindowMilliseconds) {
        this.heuristicSessions.delete(fingerprint);
      }
    }
  }
}
