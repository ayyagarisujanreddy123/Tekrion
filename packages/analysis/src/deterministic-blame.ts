import {
  TekrionEventSchema,
  BlameAnalysisSchema,
  BlameResultSchema,
  SessionSchema,
  type TekrionEvent,
  type BlameAnalysis,
  type BlameConfidence,
  type BlameResult,
  type BlameTarget,
  type ContextCompleteness,
  type FileLocation,
} from "@tekrion/protocol";

import {
  assessUserIntent,
  detectAnomalies,
  isDestructiveTarget,
} from "./anomaly-detector.js";
import {
  eventArguments,
  eventExcerpt,
  eventHashes,
  eventPath,
  eventText,
  isRecord,
  lexicalCoverage,
  normalizedPath,
  roundScore,
  sharedValue,
  stableJson,
  stringsContainPath,
  stringsIn,
  tokenize,
} from "./text.js";
import type {
  AnalysisFacts,
  CandidateAssessment,
  DeterministicAnalysisInput,
  ProvenanceEdgeInput,
} from "./types.js";

export const DETERMINISTIC_SCORING_VERSION = "deterministic-blame-v1";

const COMPLETE_CONTEXT = new Set<ContextCompleteness>([
  "exact-client-request",
  "reconstructed-client-chain",
]);

const ELIGIBLE_CANDIDATE_TYPES = new Set([
  "message.user",
  "message.developer",
  "message.system",
  "message.assistant",
  "tool.result",
  "tool.error",
  "file.read",
  "api.error",
  "transport.error",
  "parser.error",
  "context.compacted",
  "context.pressure",
  "process.stdout",
  "process.stderr",
]);

const UNTRUSTED_CONTENT_TYPES = new Set([
  "tool.result",
  "file.read",
  "process.stdout",
  "process.stderr",
]);

const STRONG_INSTRUCTION_PATTERN =
  /\b(?:agent\s+override|ignore\s+(?:all\s+)?previous|system\s+(?:message|instruction)|developer\s+instruction|do\s+not\s+tell|you\s+must)\b/iu;
const IMPERATIVE_PATTERN =
  /\b(?:delete|remove|drop|erase|unlink|truncate|edit|modify|write|rename|run|execute|fix|replace|ignore|override|before|must|always|never|do\s+not)\b/iu;
const DESTRUCTIVE_PATTERN =
  /\b(?:delete|remove|drop|erase|unlink|truncate|destroy|rm)\b/iu;

export type DeterministicAnalysisErrorCode =
  "target-not-found" | "session-mismatch" | "invalid-candidate-limit";

export class DeterministicAnalysisError extends Error {
  constructor(
    readonly code: DeterministicAnalysisErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DeterministicAnalysisError";
  }
}

interface CandidateDocument {
  readonly event: TekrionEvent;
  readonly excerpt: string;
  readonly text: string;
  readonly tokens: readonly string[];
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function normalizedVerb(event: TekrionEvent): string {
  const operation = event.summary.operation;
  if (typeof operation === "string" && operation.trim().length > 0) {
    return operation.trim().toLowerCase();
  }
  const name =
    typeof event.summary.name === "string"
      ? event.summary.name.toLowerCase()
      : "";
  if (
    /\b(?:delete|remove|rm|unlink|erase)\b/u.test(name.replaceAll("_", " "))
  ) {
    return "delete";
  }
  if (/\b(?:write|create|add)\b/u.test(name.replaceAll("_", " "))) {
    return "create";
  }
  if (
    /\b(?:edit|modify|patch|update|replace)\b/u.test(name.replaceAll("_", " "))
  ) {
    return "modify";
  }
  if (/\b(?:move|rename)\b/u.test(name.replaceAll("_", " "))) {
    return "rename";
  }
  const suffix = event.type.split(".").at(-1);
  return suffix === undefined || suffix.length === 0 ? "act" : suffix;
}

function targetResult(event: TekrionEvent): string | undefined {
  if (typeof event.summary.success === "boolean") {
    return event.summary.success ? "succeeded" : "failed";
  }
  for (const key of ["result", "status", "outcome"] as const) {
    const value = event.summary[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function normalizeTarget(
  event: TekrionEvent,
  scope: string | undefined,
): BlameTarget {
  const verb = normalizedVerb(event);
  const path = eventPath(event);
  const name =
    typeof event.summary.name === "string" ? event.summary.name : undefined;
  const entity = path?.split(/[\\/]/u).filter(Boolean).at(-1) ?? name;
  const result = targetResult(event);
  const destructive = new Set([
    "delete",
    "drop",
    "erase",
    "remove",
    "rm",
    "truncate",
    "unlink",
  ]).has(verb);
  return {
    eventId: event.id,
    verb,
    ...(entity === undefined ? {} : { entity }),
    ...(path === undefined ? {} : { path }),
    arguments: eventArguments(event),
    ...(scope === undefined ? {} : { scope }),
    ...(result === undefined ? {} : { result }),
    ...(destructive && path !== undefined
      ? { impact: `Removed or attempted to remove ${path}.` }
      : {}),
  };
}

function matchingInvocationScore(
  call: TekrionEvent,
  target: TekrionEvent,
  targetPath: string | undefined,
  parent: TekrionEvent | undefined,
): number {
  let score = 0;
  if (
    target.correlationId !== undefined &&
    call.correlationId === target.correlationId
  ) {
    score += 8;
  }
  if (target.parentId === call.id || parent?.parentId === call.id) {
    score += 10;
  }
  const callPath = eventPath(call);
  if (
    targetPath !== undefined &&
    callPath !== undefined &&
    normalizedPath(callPath) === normalizedPath(targetPath)
  ) {
    score += 6;
  }
  if (score === 0) {
    return 0;
  }
  return score + 1 / Math.max(1, target.sequence - call.sequence);
}

function findInvocation(
  events: readonly TekrionEvent[],
  target: TekrionEvent,
): TekrionEvent {
  if (target.type === "tool.call") {
    return target;
  }
  const targetPath = eventPath(target);
  const parent =
    target.parentId === undefined
      ? undefined
      : events.find((event) => event.id === target.parentId);
  const calls = events
    .filter(
      (event) => event.type === "tool.call" && event.sequence < target.sequence,
    )
    .map((event) => ({
      event,
      score: matchingInvocationScore(event, target, targetPath, parent),
    }))
    .filter((value) => value.score > 0)
    .sort(
      (left, right) =>
        right.score - left.score || right.event.sequence - left.event.sequence,
    );
  return calls[0]?.event ?? target;
}

function isEligibleCandidate(event: TekrionEvent): boolean {
  return (
    ELIGIBLE_CANDIDATE_TYPES.has(event.type) ||
    event.type.startsWith("message.") ||
    event.type.endsWith(".error")
  );
}

function candidateAvailable(
  event: TekrionEvent,
  excerpt: string,
  input: DeterministicAnalysisInput,
  events: readonly TekrionEvent[],
): boolean {
  const context = input.context;
  if (
    context === undefined ||
    (context.availableEventIds === undefined &&
      context.visibleTexts === undefined)
  ) {
    return true;
  }
  if (context.availableEventIds?.includes(event.id) === true) {
    return true;
  }
  const normalizedExcerpt = excerpt.trim().toLowerCase();
  if (
    normalizedExcerpt.length >= 8 &&
    context.visibleTexts?.some((text) =>
      text.toLowerCase().includes(normalizedExcerpt),
    ) === true
  ) {
    return true;
  }
  const requestSequence = events.find(
    (candidate) => candidate.id === context.requestEventId,
  )?.sequence;
  return (
    requestSequence !== undefined &&
    event.sequence >= requestSequence &&
    new Set(["message.assistant", "tool.result", "tool.error"]).has(event.type)
  );
}

function bm25Matches(
  documents: readonly CandidateDocument[],
  queryTokens: readonly string[],
): Map<string, number> {
  if (documents.length === 0 || queryTokens.length === 0) {
    return new Map();
  }
  const terms = unique(queryTokens);
  const averageLength =
    documents.reduce((sum, document) => sum + document.tokens.length, 0) /
    documents.length;
  const documentFrequency = new Map<string, number>();
  for (const term of terms) {
    documentFrequency.set(
      term,
      documents.filter((document) => document.tokens.includes(term)).length,
    );
  }
  const raw = new Map<string, number>();
  const k1 = 1.2;
  const b = 0.75;
  for (const document of documents) {
    const frequencies = new Map<string, number>();
    for (const token of document.tokens) {
      frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
    }
    let score = 0;
    for (const term of terms) {
      const frequency = frequencies.get(term) ?? 0;
      if (frequency === 0) {
        continue;
      }
      const matchingDocuments = documentFrequency.get(term) ?? 0;
      const inverseFrequency = Math.log(
        1 +
          (documents.length - matchingDocuments + 0.5) /
            (matchingDocuments + 0.5),
      );
      const lengthNormalization =
        frequency +
        k1 *
          (1 - b + b * (document.tokens.length / Math.max(1, averageLength)));
      score +=
        inverseFrequency * ((frequency * (k1 + 1)) / lengthNormalization);
    }
    raw.set(document.event.id, score);
  }
  const maximum = Math.max(...raw.values(), 0);
  return new Map(
    [...raw].map(([eventId, score]) => [
      eventId,
      maximum === 0 ? 0 : roundScore(score / maximum),
    ]),
  );
}

function instructionLikelihood(text: string, target: BlameTarget): number {
  if (STRONG_INSTRUCTION_PATTERN.test(text)) {
    return 1;
  }
  const namesTarget =
    target.path !== undefined && stringsContainPath(text, target.path);
  if (IMPERATIVE_PATTERN.test(text) && namesTarget) {
    return 0.9;
  }
  if (IMPERATIVE_PATTERN.test(text)) {
    return 0.7;
  }
  if (text.toLowerCase().includes(target.verb.toLowerCase())) {
    return 0.45;
  }
  return 0;
}

function entityPathOverlap(
  text: string,
  event: TekrionEvent,
  target: BlameTarget,
): number {
  const candidatePath = eventPath(event);
  if (target.path !== undefined) {
    const targetPath = normalizedPath(target.path);
    if (
      candidatePath !== undefined &&
      normalizedPath(candidatePath) === targetPath
    ) {
      return 1;
    }
    const normalizedText = normalizedPath(text);
    if (normalizedText.includes(targetPath)) {
      return 1;
    }
    const basename = targetPath.split("/").at(-1);
    if (basename !== undefined && normalizedText.includes(basename)) {
      return 0.75;
    }
  }
  if (
    target.entity !== undefined &&
    text.toLowerCase().includes(target.entity.toLowerCase())
  ) {
    return 0.5;
  }
  return 0;
}

function hardRelations(
  event: TekrionEvent,
  targetEvent: TekrionEvent,
  invocation: TekrionEvent,
  target: BlameTarget,
  contextIds: ReadonlySet<string>,
  suppliedEdges: readonly ProvenanceEdgeInput[],
): string[] {
  const relations: string[] = [];
  if (
    event.parentId === invocation.id ||
    invocation.parentId === event.id ||
    event.parentId === targetEvent.id ||
    targetEvent.parentId === event.id
  ) {
    relations.push("parent-child");
  }
  if (
    event.correlationId !== undefined &&
    (event.correlationId === invocation.correlationId ||
      event.correlationId === targetEvent.correlationId)
  ) {
    relations.push("call-id-correlation");
  }
  if (
    sharedValue(
      eventHashes(event),
      new Set([...eventHashes(invocation), ...eventHashes(targetEvent)]),
    )
  ) {
    relations.push("content-hash");
  }
  const text = eventText(event);
  const candidatePath = eventPath(event);
  const exactPathReference =
    target.path !== undefined &&
    ((candidatePath !== undefined &&
      normalizedPath(candidatePath) === normalizedPath(target.path)) ||
      normalizedPath(text).includes(normalizedPath(target.path)));
  if (exactPathReference) {
    relations.push("exact-path-reference");
  }
  const quotedSubstring = [
    ...stringsIn(invocation.summary),
    ...stringsIn(targetEvent.summary),
  ]
    .map((value) => value.trim())
    .filter((value) => value.length >= 8)
    .some((value) => text.includes(value));
  if (quotedSubstring) {
    relations.push("quoted-substring");
  }
  if (
    UNTRUSTED_CONTENT_TYPES.has(event.type) &&
    exactPathReference &&
    (DESTRUCTIVE_PATTERN.test(text) ||
      text.toLowerCase().includes(target.verb.toLowerCase()))
  ) {
    relations.push("read-result-propagation");
  }
  if (contextIds.has(event.id)) {
    relations.push("request-context");
  }
  for (const edge of suppliedEdges) {
    if (
      edge.from === event.id &&
      (edge.to === invocation.id || edge.to === targetEvent.id)
    ) {
      relations.push(edge.relation);
    }
  }
  return unique(relations);
}

function provenanceScore(relations: readonly string[]): number {
  if (relations.includes("read-result-propagation")) {
    return 1;
  }
  if (
    relations.some((relation) =>
      new Set([
        "parent-child",
        "call-id-correlation",
        "content-hash",
        "request-context",
      ]).has(relation),
    )
  ) {
    return 0.9;
  }
  if (relations.length > 0) {
    return 0.8;
  }
  return 0;
}

function candidateIntentConflict(
  event: TekrionEvent,
  text: string,
  target: BlameTarget,
  userIntent: ReturnType<typeof assessUserIntent>,
  instruction: number,
): number {
  if (
    !UNTRUSTED_CONTENT_TYPES.has(event.type) &&
    event.type !== "message.assistant"
  ) {
    return 0;
  }
  const candidateIsDestructive =
    DESTRUCTIVE_PATTERN.test(text) ||
    text.toLowerCase().includes(target.verb.toLowerCase());
  if (userIntent.prohibited && candidateIsDestructive) {
    return 1;
  }
  if (
    isDestructiveTarget(target) &&
    !userIntent.authorized &&
    candidateIsDestructive &&
    instruction >= 0.7
  ) {
    return 0.7;
  }
  return 0;
}

function targetQuery(target: BlameTarget): string {
  return [target.verb, target.path, target.entity, stableJson(target.arguments)]
    .filter((value): value is string => value !== undefined)
    .join(" ");
}

function assessCandidates(
  documents: readonly CandidateDocument[],
  targetEvent: TekrionEvent,
  invocation: TekrionEvent,
  target: BlameTarget,
  userEvents: readonly TekrionEvent[],
  input: DeterministicAnalysisInput,
): CandidateAssessment[] {
  const queryTokens = tokenize(targetQuery(target));
  const bm25 = bm25Matches(documents, queryTokens);
  const userIntent = assessUserIntent(userEvents, target);
  const contextIds = new Set(input.context?.availableEventIds ?? []);
  const suppliedEdges = input.provenanceEdges ?? [];
  return documents
    .map((document): CandidateAssessment => {
      const lexical = roundScore(lexicalCoverage(document.tokens, queryTokens));
      const bm25Match = bm25.get(document.event.id) ?? 0;
      const lexicalSimilarity = roundScore(
        Math.max(lexical, bm25Match * Math.min(1, lexical * 2)),
      );
      const overlap = roundScore(
        entityPathOverlap(document.text, document.event, target),
      );
      const instruction = roundScore(
        instructionLikelihood(document.text, target),
      );
      const conflict = roundScore(
        candidateIntentConflict(
          document.event,
          document.text,
          target,
          userIntent,
          instruction,
        ),
      );
      const relations = hardRelations(
        document.event,
        targetEvent,
        invocation,
        target,
        contextIds,
        suppliedEdges,
      );
      const provenance = provenanceScore(relations);
      const distance = Math.max(
        1,
        invocation.sequence - document.event.sequence,
      );
      const recency = roundScore(Math.exp(-distance / 8));
      const propagationDepth =
        relations.length === 0 ? 0 : invocation.id === targetEvent.id ? 1 : 0.5;
      const score = roundScore(
        0.3 * provenance +
          0.2 * lexicalSimilarity +
          0.15 * overlap +
          0.15 * conflict +
          0.1 * instruction +
          0.1 * recency,
      );
      return {
        event: document.event,
        excerpt: document.excerpt,
        relations,
        instructionLikelihood: instruction,
        intentConflict: conflict,
        entityPathOverlap: overlap,
        candidate: {
          eventId: document.event.id,
          score,
          features: {
            provenance,
            bm25Match,
            lexicalOverlap: lexical,
            lexicalOrSemanticSimilarity: lexicalSimilarity,
            entityPathOverlap: overlap,
            intentConflict: conflict,
            instructionLikelihood: instruction,
            recencyDecay: recency,
            propagationDepth,
          },
          hardProvenanceEdge: relations.length > 0,
        },
      };
    })
    .sort(
      (left, right) =>
        right.candidate.score - left.candidate.score ||
        right.event.sequence - left.event.sequence ||
        left.event.id.localeCompare(right.event.id),
    );
}

function candidateLocation(event: TekrionEvent): FileLocation | undefined {
  const path = eventPath(event);
  const startLine = event.summary.startLine;
  const endLine = event.summary.endLine;
  if (
    path === undefined ||
    typeof startLine !== "number" ||
    !Number.isInteger(startLine) ||
    startLine < 1
  ) {
    return undefined;
  }
  const normalizedEnd =
    typeof endLine === "number" &&
    Number.isInteger(endLine) &&
    endLine >= startLine
      ? endLine
      : startLine;
  return { path, startLine, endLine: normalizedEnd };
}

function inferredContextCompleteness(
  input: DeterministicAnalysisInput,
  invocation: TekrionEvent,
  candidates: readonly CandidateAssessment[],
): ContextCompleteness {
  if (input.context !== undefined) {
    return input.context.completeness;
  }
  const hasDirectAdapterTrace =
    invocation.source === "adapter" &&
    candidates.some(
      (candidate) =>
        candidate.event.source === "adapter" &&
        (candidate.relations.includes("read-result-propagation") ||
          (candidate.event.type === "message.user" &&
            candidate.candidate.hardProvenanceEdge)),
    );
  return hasDirectAdapterTrace ? "exact-client-request" : "unknown-unsupported";
}

function confidenceFor(
  top: CandidateAssessment | undefined,
  completeness: ContextCompleteness,
  directUserAuthorization: boolean,
): BlameConfidence {
  if (top === undefined) {
    return "low";
  }
  if (
    top.candidate.score >= 0.72 &&
    top.candidate.hardProvenanceEdge &&
    COMPLETE_CONTEXT.has(completeness) &&
    top.instructionLikelihood >= 0.7 &&
    (top.intentConflict >= 0.7 ||
      top.relations.includes("read-result-propagation") ||
      (top.event.type === "message.user" && directUserAuthorization))
  ) {
    return "high";
  }
  return top.candidate.score >= 0.4 || top.candidate.hardProvenanceEdge
    ? "medium"
    : "low";
}

function confidenceReasons(
  top: CandidateAssessment | undefined,
  completeness: ContextCompleteness,
  confidence: BlameConfidence,
): string[] {
  if (top === undefined) {
    return ["No eligible preceding evidence was available to rank."];
  }
  const reasons = [
    `The top deterministic candidate scored ${top.candidate.score.toFixed(3)} under ${DETERMINISTIC_SCORING_VERSION}.`,
  ];
  if (top.candidate.hardProvenanceEdge) {
    reasons.push(`Stored provenance includes ${top.relations.join(", ")}.`);
  } else {
    reasons.push("No hard provenance edge connects the top candidate.");
  }
  if (top.instructionLikelihood >= 0.7) {
    reasons.push(
      "The candidate contains locally detected instruction-like language.",
    );
  }
  if (top.intentConflict >= 0.7) {
    reasons.push("The candidate conflicts with recorded user intent.");
  }
  if (!COMPLETE_CONTEXT.has(completeness)) {
    reasons.push(
      `Relevant context is labeled ${completeness}, which caps confidence.`,
    );
  } else if (confidence === "high") {
    reasons.push(
      "Relevant client-visible context is complete under the recorded evidence.",
    );
  }
  return reasons;
}

function invocationToTargetRelation(
  invocation: TekrionEvent,
  target: TekrionEvent,
  events: readonly TekrionEvent[],
): string {
  const parent =
    target.parentId === undefined
      ? undefined
      : events.find((event) => event.id === target.parentId);
  if (target.parentId === invocation.id || parent?.parentId === invocation.id) {
    return "call-result-filesystem-effect";
  }
  if (
    invocation.correlationId !== undefined &&
    invocation.correlationId === target.correlationId
  ) {
    return "call-id-filesystem-effect";
  }
  return "path-matched-filesystem-effect";
}

function propagationFor(
  top: CandidateAssessment | undefined,
  invocation: TekrionEvent,
  target: TekrionEvent,
  events: readonly TekrionEvent[],
  suppliedEdges: readonly ProvenanceEdgeInput[],
): BlameResult["propagation"] {
  const propagation = suppliedEdges
    .filter((edge) => {
      const from = events.find((event) => event.id === edge.from);
      const to = events.find((event) => event.id === edge.to);
      return (
        from !== undefined &&
        to !== undefined &&
        from.sequence <= target.sequence &&
        to.sequence <= target.sequence
      );
    })
    .map((edge) => ({ ...edge }));
  if (top !== undefined && top.candidate.hardProvenanceEdge) {
    propagation.push({
      from: top.event.id,
      to: invocation.id,
      relation: top.relations.includes("read-result-propagation")
        ? "client-visible-content-before-tool-call"
        : (top.relations[0] ?? "preceding-evidence"),
    });
  }
  if (invocation.id !== target.id) {
    propagation.push({
      from: invocation.id,
      to: target.id,
      relation: invocationToTargetRelation(invocation, target, events),
    });
  }
  const seen = new Set<string>();
  return propagation.filter((edge) => {
    const key = `${edge.from}\u0000${edge.to}\u0000${edge.relation}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function conclusionFor(
  top: CandidateAssessment | undefined,
  target: BlameTarget,
  confidence: BlameConfidence,
): string {
  const targetDescription =
    target.path ?? target.entity ?? "the selected action";
  if (top === undefined) {
    return `No eligible preceding evidence could be ranked for ${targetDescription}.`;
  }
  if (confidence === "high") {
    return `Stored evidence strongly links preceding instruction-like content to the ${target.verb} action on ${targetDescription}; this is an evidence-backed attribution, not proof of hidden reasoning.`;
  }
  if (confidence === "medium") {
    return `Preceding evidence is plausibly linked to the ${target.verb} action on ${targetDescription}, with material limitations.`;
  }
  return `The available record is insufficient to attribute the ${target.verb} action on ${targetDescription} beyond a low-confidence candidate.`;
}

function buildBlameResult(
  input: DeterministicAnalysisInput,
  events: readonly TekrionEvent[],
  targetEvent: TekrionEvent,
  target: BlameTarget,
  invocation: TekrionEvent,
  candidates: readonly CandidateAssessment[],
  userEvents: readonly TekrionEvent[],
  candidateWindowTruncated: boolean,
): BlameResult {
  const top = candidates[0];
  const completeness = inferredContextCompleteness(
    input,
    invocation,
    candidates,
  );
  const userIntent = assessUserIntent(userEvents, target);
  const confidence = confidenceFor(top, completeness, userIntent.authorized);
  const limitations = unique([
    "Deterministic ranking exposes stored evidence links; it does not reveal hidden reasoning or prove causation.",
    ...(input.limitations ?? []),
    ...(input.context?.limitationReasons ?? []),
    ...(input.context === undefined && completeness === "exact-client-request"
      ? [
          "No model-request context was reconstructed; completeness relies on the explicit adapter action trace.",
        ]
      : []),
    ...(candidateWindowTruncated
      ? ["The preceding candidate window reached its configured bound."]
      : []),
    ...(top?.candidate.hardProvenanceEdge === false
      ? ["The top candidate has no hard provenance edge."]
      : []),
  ]);
  const primaryLocation =
    top === undefined ? undefined : candidateLocation(top.event);
  const evidence: BlameResult["evidence"] = [];
  if (top !== undefined) {
    evidence.push({
      eventId: top.event.id,
      supports: top.candidate.hardProvenanceEdge
        ? `Top-ranked preceding evidence carries ${top.relations.join(", ")}.`
        : "Top-ranked preceding evidence has the strongest local feature score.",
    });
  }
  if (invocation.id !== targetEvent.id) {
    evidence.push({
      eventId: invocation.id,
      supports:
        "The recorded invocation links the candidate window to the selected effect.",
    });
  }
  if (userIntent.prohibited) {
    for (const eventId of userIntent.evidenceIds.slice(0, 2)) {
      evidence.push({
        eventId,
        supports:
          "Recorded user intent explicitly conflicts with the selected destructive action.",
      });
    }
  }
  const counterevidence: BlameResult["counterevidence"] = [];
  if (userIntent.authorized && !userIntent.prohibited) {
    for (const eventId of userIntent.evidenceIds.slice(0, 2)) {
      counterevidence.push({
        eventId,
        weakens:
          "A recorded user request may independently authorize the selected action.",
      });
    }
  }
  if (
    top !== undefined &&
    !top.relations.includes("request-context") &&
    top.relations.includes("read-result-propagation")
  ) {
    counterevidence.push({
      eventId: invocation.id,
      weakens:
        "The invocation does not explicitly cite the preceding content as its source.",
    });
  }
  const alternatives: BlameResult["alternatives"] = [
    {
      explanation:
        "The agent may have selected the action independently while troubleshooting.",
      evidenceIds: [invocation.id],
    },
  ];
  if (userIntent.authorized && userIntent.evidenceIds.length > 0) {
    alternatives.push({
      explanation: "The action may directly follow recorded user intent.",
      evidenceIds: [...userIntent.evidenceIds],
    });
  }

  return BlameResultSchema.parse({
    schemaVersion: 1,
    scoringVersion: DETERMINISTIC_SCORING_VERSION,
    target,
    contextCompleteness: completeness,
    conclusion: conclusionFor(top, target, confidence),
    confidence,
    confidenceReasons: confidenceReasons(top, completeness, confidence),
    ...(top === undefined
      ? {}
      : {
          primaryOrigin: {
            eventId: top.event.id,
            excerpt: top.excerpt,
            ...(primaryLocation === undefined
              ? {}
              : { location: primaryLocation }),
          },
        }),
    candidates: candidates.map((candidate) => candidate.candidate),
    propagation: propagationFor(
      top,
      invocation,
      targetEvent,
      events,
      input.provenanceEdges ?? [],
    ),
    evidence,
    counterevidence,
    alternatives,
    limitations,
  });
}

export class DeterministicAnalyzer {
  analyze(input: DeterministicAnalysisInput): BlameAnalysis {
    const session = SessionSchema.parse(input.session);
    const events = input.events
      .map((event) => TekrionEventSchema.parse(event))
      .filter((event) => event.sessionId === session.id)
      .sort(
        (left, right) =>
          left.sequence - right.sequence || left.id.localeCompare(right.id),
      );
    if (events.length !== input.events.length) {
      throw new DeterministicAnalysisError(
        "session-mismatch",
        "Every analysis event must belong to the selected session.",
      );
    }
    const targetEvent = events.find(
      (event) => event.id === input.targetEventId,
    );
    if (targetEvent === undefined) {
      throw new DeterministicAnalysisError(
        "target-not-found",
        `Target event ${input.targetEventId} was not found in session ${session.id}.`,
      );
    }
    const maximumCandidates = input.maximumCandidates ?? 500;
    if (
      !Number.isSafeInteger(maximumCandidates) ||
      maximumCandidates < 1 ||
      maximumCandidates > 5_000
    ) {
      throw new DeterministicAnalysisError(
        "invalid-candidate-limit",
        "The deterministic candidate limit must be between 1 and 5000.",
      );
    }
    const target = normalizeTarget(targetEvent, session.repoRoot);
    const invocation = findInvocation(events, targetEvent);
    const rawDocuments = events
      .filter(
        (event) =>
          event.sequence < invocation.sequence && isEligibleCandidate(event),
      )
      .map((event): CandidateDocument | undefined => {
        const excerpt = eventExcerpt(event);
        if (
          excerpt === undefined ||
          !candidateAvailable(event, excerpt, input, events)
        ) {
          return undefined;
        }
        const text = eventText(event);
        return { event, excerpt, text, tokens: tokenize(text) };
      })
      .filter(
        (document): document is CandidateDocument => document !== undefined,
      );
    const candidateWindowTruncated = rawDocuments.length > maximumCandidates;
    const documents = rawDocuments.slice(-maximumCandidates);
    const userEvents = events.filter(
      (event) =>
        event.sequence < invocation.sequence && event.type === "message.user",
    );
    const candidates = assessCandidates(
      documents,
      targetEvent,
      invocation,
      target,
      userEvents,
      input,
    );
    const blame = buildBlameResult(
      input,
      events,
      targetEvent,
      target,
      invocation,
      candidates,
      userEvents,
      candidateWindowTruncated,
    );
    const facts: AnalysisFacts = {
      session,
      events,
      targetEvent,
      target,
      invocationEvent: invocation,
      candidates,
      userEvents,
      contextCompleteness: blame.contextCompleteness,
    };
    return BlameAnalysisSchema.parse({
      schemaVersion: 1,
      blame,
      anomalies: detectAnomalies(facts),
    });
  }
}

export function analyzeDeterministically(
  input: DeterministicAnalysisInput,
): BlameAnalysis {
  return new DeterministicAnalyzer().analyze(input);
}

export function isAnalyzableTarget(event: TekrionEvent): boolean {
  if (event.type === "tool.call" || event.type.startsWith("file.")) {
    return true;
  }
  const operation = event.summary.operation;
  return typeof operation === "string" && operation.trim().length > 0;
}

export function normalizedTargetForEvent(
  event: TekrionEvent,
  scope?: string,
): BlameTarget {
  return normalizeTarget(TekrionEventSchema.parse(event), scope);
}

export function eventContainsStructuredArguments(event: TekrionEvent): boolean {
  return isRecord(event.summary.arguments) || isRecord(event.summary.args);
}
