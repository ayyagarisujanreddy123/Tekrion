import { isAbsolute, relative, resolve, sep } from "node:path";

import {
  AnomalyResultSchema,
  type AnomalyFinding,
  type AnomalyResult,
  type TekrionEvent,
  type BlameTarget,
} from "@tekrion/protocol";

import {
  eventArguments,
  eventPath,
  eventText,
  normalizedPath,
  stableJson,
} from "./text.js";
import type { AnalysisFacts } from "./types.js";

export const ANOMALY_ANALYZER_VERSION = "deterministic-anomalies-v1";

const DESTRUCTIVE_VERBS = new Set([
  "delete",
  "drop",
  "erase",
  "remove",
  "rm",
  "truncate",
  "unlink",
]);

const PROHIBITION_PATTERN =
  /\b(?:do\s+not|don['’]t|must\s+not|never|without\s+changing)\b/iu;
const DESTRUCTIVE_PATTERN =
  /\b(?:delete|drop|erase|remove|rm|truncate|unlink|destroy)\b/iu;

const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{20,}\b/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/u,
  /\b(?:api[_-]?key|access[_-]?token|secret|password)\s*[:=]\s*["']?[A-Za-z0-9_./+\-=]{12,}/iu,
] as const;

export interface UserIntentAssessment {
  readonly authorized: boolean;
  readonly prohibited: boolean;
  readonly evidenceIds: readonly string[];
}

function targetTerms(target: BlameTarget): string[] {
  const terms = [target.path, target.entity]
    .filter((value): value is string => value !== undefined)
    .flatMap((value) => {
      const normalized = normalizedPath(value);
      return [normalized, normalized.split("/").at(-1) ?? normalized];
    });
  if (target.path?.toLowerCase().includes("test") === true) {
    terms.push("test", "tests");
  }
  return [...new Set(terms.filter((term) => term.length > 1))];
}

export function assessUserIntent(
  events: readonly TekrionEvent[],
  target: BlameTarget,
): UserIntentAssessment {
  const terms = targetTerms(target);
  const relevant: string[] = [];
  let authorized = false;
  let prohibited = false;

  for (const event of events) {
    const text = eventText(event).toLowerCase();
    const mentionsTarget = terms.some((term) => text.includes(term));
    if (!mentionsTarget) {
      continue;
    }
    relevant.push(event.id);
    const mentionsDestructiveAction =
      DESTRUCTIVE_PATTERN.test(text) ||
      text.includes(target.verb.toLowerCase());
    if (mentionsDestructiveAction && PROHIBITION_PATTERN.test(text)) {
      prohibited = true;
    } else if (mentionsDestructiveAction) {
      authorized = true;
    }
  }

  return { authorized, prohibited, evidenceIds: relevant };
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function scopeOutsideRoot(facts: AnalysisFacts): boolean {
  const path = facts.target.path;
  const root = facts.session.repoRoot;
  if (path === undefined || root === undefined) {
    return false;
  }
  const absoluteRoot = resolve(root);
  const absoluteTarget = isAbsolute(path) ? resolve(path) : resolve(root, path);
  const relation = relative(absoluteRoot, absoluteTarget);
  return (
    relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)
  );
}

function destructiveScopeDrift(
  facts: AnalysisFacts,
): AnomalyFinding | undefined {
  if (!DESTRUCTIVE_VERBS.has(facts.target.verb.toLowerCase())) {
    return undefined;
  }
  const intent = assessUserIntent(facts.userEvents, facts.target);
  const outsideRoot = scopeOutsideRoot(facts);
  if (intent.authorized && !intent.prohibited && !outsideRoot) {
    return undefined;
  }
  const severity = intent.prohibited || outsideRoot ? "high" : "medium";
  return {
    id: `anomaly-scope-drift-${facts.targetEvent.id}`,
    ruleId: "scope-drift.destructive",
    severity,
    title: "Destructive action exceeds recorded user scope",
    explanation: outsideRoot
      ? "The destructive target is outside the recorded repository root."
      : intent.prohibited
        ? "The recorded user request explicitly prohibited this class of destructive action."
        : "No preceding user request names or implies this destructive action.",
    eventIds: unique([facts.targetEvent.id, ...intent.evidenceIds]),
    inputs: {
      verb: facts.target.verb,
      ...(facts.target.path === undefined ? {} : { path: facts.target.path }),
      userAuthorizationObserved: intent.authorized,
      explicitProhibitionObserved: intent.prohibited,
      outsideRepositoryRoot: outsideRoot,
    },
    threshold: {
      destructiveVerbRequired: true,
      authorizationRequired: true,
    },
  };
}

function injectionLikeContent(
  facts: AnalysisFacts,
): AnomalyFinding | undefined {
  const candidate = facts.candidates.find(
    (value) =>
      new Set([
        "tool.result",
        "file.read",
        "process.stdout",
        "process.stderr",
      ]).has(value.event.type) &&
      value.instructionLikelihood >= 0.7 &&
      value.entityPathOverlap >= 0.5 &&
      value.candidate.hardProvenanceEdge,
  );
  if (candidate === undefined) {
    return undefined;
  }
  return {
    id: `anomaly-untrusted-instruction-${facts.targetEvent.id}`,
    ruleId: "untrusted-content.instruction-like",
    severity: candidate.intentConflict >= 0.8 ? "high" : "medium",
    title: "Instruction-like text arrived through untrusted content",
    explanation:
      "A preceding file or tool result contains imperative text tied by stored provenance to the selected action.",
    eventIds: unique([
      candidate.event.id,
      facts.invocationEvent.id,
      facts.targetEvent.id,
    ]),
    inputs: {
      instructionLikelihood: candidate.instructionLikelihood,
      entityPathOverlap: candidate.entityPathOverlap,
      intentConflict: candidate.intentConflict,
      hardProvenanceEdge: candidate.candidate.hardProvenanceEdge,
    },
    threshold: {
      instructionLikelihood: 0.7,
      entityPathOverlap: 0.5,
      hardProvenanceEdge: true,
    },
  };
}

function repeatedToolCalls(facts: AnalysisFacts): AnomalyFinding | undefined {
  const groups = new Map<string, TekrionEvent[]>();
  for (const event of facts.events) {
    if (
      event.sequence > facts.invocationEvent.sequence ||
      event.type !== "tool.call"
    ) {
      continue;
    }
    const name =
      typeof event.summary.name === "string" ? event.summary.name : "unknown";
    const signature = `${name}:${stableJson(eventArguments(event))}`;
    const group = groups.get(signature) ?? [];
    group.push(event);
    groups.set(signature, group);
  }
  const repeated = [...groups.values()]
    .filter((events) => events.length >= 3)
    .sort((left, right) => right.length - left.length)[0];
  if (repeated === undefined) {
    return undefined;
  }
  return {
    id: `anomaly-tool-loop-${facts.targetEvent.id}`,
    ruleId: "loop.repeated-tool-call",
    severity: repeated.length >= 6 ? "high" : "medium",
    title: "Repeated identical tool invocation",
    explanation:
      "The same tool name and normalized arguments recur at least three times before the selected action.",
    eventIds: repeated.map((event) => event.id),
    inputs: {
      repetitions: repeated.length,
      toolName:
        typeof repeated[0]?.summary.name === "string"
          ? repeated[0].summary.name
          : "unknown",
    },
    threshold: { minimumRepetitions: 3 },
  };
}

function repeatedErrors(facts: AnalysisFacts): AnomalyFinding | undefined {
  const errors = facts.events.filter(
    (event) =>
      event.sequence <= facts.invocationEvent.sequence &&
      (event.type.endsWith(".error") || event.type === "session.crashed"),
  );
  if (errors.length < 3) {
    return undefined;
  }
  return {
    id: `anomaly-error-loop-${facts.targetEvent.id}`,
    ruleId: "loop.repeated-errors",
    severity: errors.length >= 6 ? "high" : "medium",
    title: "Repeated error-retry pattern",
    explanation:
      "At least three recorded errors precede the selected action, indicating a possible repair loop.",
    eventIds: errors.slice(-10).map((event) => event.id),
    inputs: { errorCount: errors.length },
    threshold: { minimumErrors: 3 },
  };
}

function pressureRatio(event: TekrionEvent): number | undefined {
  for (const key of ["ratio", "pressure", "contextUtilization"] as const) {
    const value = event.summary[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value > 1 ? value / 100 : value;
    }
  }
  return undefined;
}

function contextPressure(facts: AnalysisFacts): AnomalyFinding | undefined {
  const pressure = facts.events
    .filter((event) => event.sequence <= facts.invocationEvent.sequence)
    .find(
      (event) =>
        event.type === "context.pressure" || (pressureRatio(event) ?? 0) >= 0.8,
    );
  if (pressure === undefined) {
    return undefined;
  }
  return {
    id: `anomaly-context-pressure-${facts.targetEvent.id}`,
    ruleId: "context.pressure",
    severity: (pressureRatio(pressure) ?? 0.8) >= 0.95 ? "high" : "medium",
    title: "Action followed high or uncertain context pressure",
    explanation:
      "Recorded context pressure reached the rule threshold before the selected action.",
    eventIds: unique([pressure.id, facts.targetEvent.id]),
    inputs: { pressureRatio: pressureRatio(pressure) ?? null },
    threshold: { minimumPressureRatio: 0.8 },
  };
}

function secretLikeContent(facts: AnalysisFacts): AnomalyFinding | undefined {
  const matches = facts.events.filter((event) => {
    if (event.sequence > facts.invocationEvent.sequence) {
      return false;
    }
    const text = eventText(event);
    return (
      SECRET_PATTERNS.some((pattern) => pattern.test(text)) ||
      (event.redaction.applied &&
        event.redaction.ruleIds.some((ruleId) =>
          /(?:secret|credential|token|api-key)/iu.test(ruleId),
        ))
    );
  });
  if (matches.length === 0) {
    return undefined;
  }
  return {
    id: `anomaly-secret-like-${facts.targetEvent.id}`,
    ruleId: "content.secret-like",
    severity: "high",
    title: "Secret-like material appears in recorded context",
    explanation:
      "A local secret-pattern rule matched preceding evidence; matched values are not copied into this result.",
    eventIds: matches.map((event) => event.id),
    inputs: { matchingEventCount: matches.length },
    threshold: { minimumMatches: 1, excerptsRetained: false },
  };
}

export function detectAnomalies(facts: AnalysisFacts): AnomalyResult {
  const findings = [
    destructiveScopeDrift(facts),
    injectionLikeContent(facts),
    repeatedToolCalls(facts),
    repeatedErrors(facts),
    contextPressure(facts),
    secretLikeContent(facts),
  ].filter((finding): finding is AnomalyFinding => finding !== undefined);

  return AnomalyResultSchema.parse({
    schemaVersion: 1,
    analyzerVersion: ANOMALY_ANALYZER_VERSION,
    sessionId: facts.session.id,
    targetEventId: facts.targetEvent.id,
    findings,
    limitations: [
      "Rule findings are transparent signals, not calibrated probabilities or causal proof.",
    ],
  });
}

export function isDestructiveTarget(target: BlameTarget): boolean {
  return DESTRUCTIVE_VERBS.has(target.verb.toLowerCase());
}

export function targetPathForEvent(event: TekrionEvent): string | undefined {
  return eventPath(event);
}
