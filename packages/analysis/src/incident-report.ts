import { createHash } from "node:crypto";

import {
  IncidentReportResultSchema,
  IncidentReportSchema,
  type TekrionEvent,
  type BlameAnalysis,
  type ContextCompleteness,
  type IncidentReport,
  type IncidentReportResult,
  type ReportEvidenceReference,
  type Session,
} from "@tekrion/protocol";

import {
  isAnalyzableTarget,
  normalizedTargetForEvent,
} from "./deterministic-blame.js";
import { eventExcerpt, eventPath, normalizedPath, stableJson } from "./text.js";

export const DETERMINISTIC_REPORT_VERSION = "deterministic-report-v1";

export interface DeterministicReportInput {
  readonly session: Session;
  readonly events: readonly TekrionEvent[];
  readonly blame?: BlameAnalysis;
  readonly generatedAt?: string;
  readonly limitations?: readonly string[];
}

const SEVERITY_WEIGHT = { low: 1, medium: 2, high: 3 } as const;

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function targetPriority(event: TekrionEvent): number {
  if (!isAnalyzableTarget(event)) {
    return -1;
  }
  const target = normalizedTargetForEvent(event);
  const exactFinal = event.summary.timingPrecision === "exact-final-diff";
  const operation = target.verb;
  let score = event.type.startsWith("file.") ? 50 : 20;
  if (
    new Set(["delete", "drop", "erase", "remove", "rm", "unlink"]).has(
      operation,
    )
  ) {
    score += 100;
  } else if (operation === "rename") {
    score += 60;
  } else if (new Set(["modify", "write", "create"]).has(operation)) {
    score += 40;
  }
  if (exactFinal) {
    score += 25;
  }
  return score;
}

export function selectIncidentTarget(
  events: readonly TekrionEvent[],
  requestedEventId?: string,
): TekrionEvent | undefined {
  if (requestedEventId !== undefined) {
    const requested = events.find((event) => event.id === requestedEventId);
    if (requested === undefined) {
      throw new RangeError(
        `Report target event ${requestedEventId} is not present in the session.`,
      );
    }
    if (!isAnalyzableTarget(requested)) {
      throw new RangeError(
        `Report target event ${requestedEventId} is not an analyzable action.`,
      );
    }
    return requested;
  }
  return [...events]
    .filter(isAnalyzableTarget)
    .sort(
      (left, right) =>
        targetPriority(right) - targetPriority(left) ||
        right.sequence - left.sequence ||
        right.id.localeCompare(left.id),
    )[0];
}

function factualStatement(event: TekrionEvent): string {
  const excerpt = eventExcerpt(event, 260);
  const path = eventPath(event);
  const operation =
    typeof event.summary.operation === "string"
      ? event.summary.operation
      : event.type.startsWith("file.")
        ? event.type.slice("file.".length)
        : undefined;
  if (event.type === "message.user") {
    return excerpt === undefined
      ? "A user message was recorded."
      : `The recorded user message stated: “${excerpt}”`;
  }
  if (event.type === "message.developer" || event.type === "message.system") {
    return excerpt === undefined
      ? `A recorded ${event.type} instruction was present.`
      : `The recorded ${event.type} instruction stated: “${excerpt}”`;
  }
  if (event.type === "tool.call") {
    const name =
      typeof event.summary.name === "string"
        ? event.summary.name
        : "unnamed tool";
    return `The agent emitted the recorded ${name} tool call${path === undefined ? "." : ` for ${path}.`}`;
  }
  if (event.type === "tool.result") {
    return excerpt === undefined
      ? "A tool result was recorded."
      : `The recorded tool result contained: “${excerpt}”`;
  }
  if (event.type.startsWith("file.")) {
    const precision =
      typeof event.summary.timingPrecision === "string"
        ? ` (${event.summary.timingPrecision})`
        : "";
    return `Filesystem evidence${precision} records ${operation ?? "a change"}${path === undefined ? "." : ` of ${path}.`}`;
  }
  if (event.type === "process.exited") {
    const exitCode = event.summary.exitCode;
    return `The wrapped process exited with ${typeof exitCode === "number" ? `code ${exitCode}` : "an unreported code"}.`;
  }
  if (event.type.endsWith(".error")) {
    return excerpt === undefined
      ? `${event.type} was recorded.`
      : `${event.type} was recorded: “${excerpt}”`;
  }
  return excerpt === undefined
    ? `${event.type} was recorded.`
    : `${event.type} was recorded with summary: “${excerpt}”`;
}

function relevantTimelineEvents(
  events: readonly TekrionEvent[],
  blame: BlameAnalysis | undefined,
): TekrionEvent[] {
  if (blame === undefined) {
    return events
      .filter((event) => new Set(["observed", "derived"]).has(event.evidence))
      .filter(
        (event) =>
          event.type === "message.user" ||
          event.type === "process.exited" ||
          event.type.startsWith("file.") ||
          event.type.endsWith(".error"),
      )
      .slice(-12);
  }
  const ids = new Set<string>([
    blame.blame.target.eventId,
    ...blame.blame.evidence.map((item) => item.eventId),
    ...blame.blame.counterevidence.map((item) => item.eventId),
    ...blame.anomalies.findings.flatMap((finding) => finding.eventIds),
    ...(blame.blame.primaryOrigin === undefined
      ? []
      : [blame.blame.primaryOrigin.eventId]),
  ]);
  const target = events.find(
    (event) => event.id === blame.blame.target.eventId,
  );
  const earliestUser = events.find(
    (event) =>
      event.type === "message.user" &&
      (target === undefined || event.sequence < target.sequence),
  );
  if (earliestUser !== undefined) {
    ids.add(earliestUser.id);
  }
  if (target?.parentId !== undefined) {
    ids.add(target.parentId);
  }
  const selected = events
    .filter(
      (event) =>
        ids.has(event.id) &&
        (event.evidence === "observed" || event.evidence === "derived"),
    )
    .sort(
      (left, right) =>
        left.sequence - right.sequence || left.id.localeCompare(right.id),
    );
  if (selected.length <= 16) {
    return selected;
  }
  const mandatoryIds = new Set(
    [
      earliestUser?.id,
      blame.blame.primaryOrigin?.eventId,
      blame.blame.target.eventId,
    ].filter((id): id is string => id !== undefined),
  );
  const mandatory = selected.filter((event) => mandatoryIds.has(event.id));
  const remaining = selected
    .filter((event) => !mandatoryIds.has(event.id))
    .slice(-(16 - mandatory.length));
  return [...mandatory, ...remaining].sort(
    (left, right) =>
      left.sequence - right.sequence || left.id.localeCompare(right.id),
  );
}

function captureMissingSignals(
  session: Session,
  completeness: ContextCompleteness,
): string[] {
  const missing: string[] = [];
  if (session.captureLevel === "api") {
    missing.push(
      "API-only capture may not include process output or authoritative filesystem effects.",
    );
  }
  if (
    completeness !== "exact-client-request" &&
    completeness !== "reconstructed-client-chain"
  ) {
    missing.push(`Relevant client-visible context is labeled ${completeness}.`);
  }
  if (session.status === "active") {
    missing.push(
      "The session was still active when this report was generated.",
    );
  }
  return missing;
}

function reportImpact(blame: BlameAnalysis | undefined): string {
  if (blame === undefined) {
    return "The recording contains no analyzable tool or filesystem action from which to derive a specific impact statement.";
  }
  const target = blame.blame.target;
  if (target.impact !== undefined) {
    return target.impact;
  }
  const entity = target.path ?? target.entity ?? "the recorded target";
  const result =
    target.result === undefined ? "" : ` The result was ${target.result}.`;
  return `The recorded ${target.verb} action targeted ${entity}.${result}`;
}

function rootCause(
  blame: BlameAnalysis | undefined,
): IncidentReport["rootCauseHypothesis"] {
  const primary = blame?.blame.primaryOrigin;
  if (blame === undefined || primary === undefined) {
    return {
      statement:
        "The available evidence does not establish a specific origin for the recorded action.",
      evidence: "inferred",
      confidence: "low",
      supports: [],
    };
  }
  const supports =
    blame.blame.evidence.length > 0
      ? blame.blame.evidence.map((item) => ({
          eventId: item.eventId,
          statement: item.supports,
        }))
      : [
          {
            eventId: primary.eventId,
            statement:
              "Deterministic ranking identified this preceding evidence as the strongest linked candidate.",
          },
        ];
  return {
    statement: `The evidence is consistent with preceding content in event ${primary.eventId} influencing the recorded ${blame.blame.target.verb} action; this remains an inference, not causal proof.`,
    evidence: "inferred",
    confidence: blame.blame.confidence,
    supports,
  };
}

function contributingConditions(
  blame: BlameAnalysis | undefined,
): ReportEvidenceReference[] {
  if (blame === undefined) {
    return [];
  }
  return blame.anomalies.findings.flatMap((finding) => {
    const eventId = finding.eventIds[0];
    return eventId === undefined
      ? []
      : [
          {
            eventId,
            statement: `${finding.title}: ${finding.explanation}`,
          },
        ];
  });
}

function preventionActions(
  blame: BlameAnalysis | undefined,
): IncidentReport["preventionActions"] {
  if (blame === undefined) {
    return [
      {
        action:
          "Record process and filesystem evidence with the wrapper before investigating a future incident.",
        evidenceIds: [],
      },
    ];
  }
  const targetId = blame.blame.target.eventId;
  const actions: IncidentReport["preventionActions"] = [
    {
      action:
        "Check every write or destructive action against the recorded user request and repository scope before execution.",
      evidenceIds: [targetId],
    },
  ];
  const ruleIds = new Set(
    blame.anomalies.findings.map((finding) => finding.ruleId),
  );
  if (
    ruleIds.has("scope-drift.destructive") ||
    blame.blame.target.verb === "delete"
  ) {
    actions.push({
      action:
        "Require explicit approval before deleting tests, configuration, lockfiles, or other high-impact paths.",
      evidenceIds: [targetId],
    });
  }
  if (ruleIds.has("untrusted-content.instruction-like")) {
    actions.push({
      action:
        "Treat instructions found in files and tool output as untrusted data unless the user explicitly authorizes them.",
      evidenceIds: blame.anomalies.findings
        .filter(
          (finding) => finding.ruleId === "untrusted-content.instruction-like",
        )
        .flatMap((finding) => finding.eventIds),
    });
  }
  if (
    [...ruleIds].some((ruleId) =>
      new Set(["loop.repeated-tool-call", "loop.repeated-error"]).has(ruleId),
    )
  ) {
    actions.push({
      action:
        "Bound identical retries and require a new observation before repeating a failed action.",
      evidenceIds: blame.anomalies.findings
        .filter((finding) => finding.ruleId.startsWith("loop."))
        .flatMap((finding) => finding.eventIds),
    });
  }
  if (
    blame.blame.contextCompleteness !== "exact-client-request" &&
    blame.blame.contextCompleteness !== "reconstructed-client-chain"
  ) {
    actions.push({
      action:
        "Require complete request ancestry or an explicit user confirmation before high-impact actions.",
      evidenceIds: [targetId],
    });
  }
  return actions.map((action) => ({
    ...action,
    evidenceIds: unique(action.evidenceIds),
  }));
}

function containmentAndRecovery(
  events: readonly TekrionEvent[],
  blame: BlameAnalysis | undefined,
): ReportEvidenceReference[] {
  if (blame === undefined || blame.blame.target.path === undefined) {
    return [];
  }
  const target = events.find(
    (event) => event.id === blame.blame.target.eventId,
  );
  if (target === undefined) {
    return [];
  }
  const path = normalizedPath(blame.blame.target.path);
  return events
    .filter(
      (event) =>
        event.sequence > target.sequence &&
        event.type.startsWith("file.") &&
        eventPath(event) !== undefined &&
        normalizedPath(eventPath(event) as string) === path &&
        new Set(["file.create", "file.modify"]).has(event.type),
    )
    .slice(0, 5)
    .map((event) => ({
      eventId: event.id,
      statement: `Later filesystem evidence records ${event.type.slice("file.".length)} of ${blame.blame.target.path}; this establishes later activity, not successful recovery.`,
    }));
}

function reportId(
  sessionId: string,
  targetEventId: string | undefined,
): string {
  const digest = createHash("sha256")
    .update(
      stableJson({
        version: DETERMINISTIC_REPORT_VERSION,
        sessionId,
        targetEventId: targetEventId ?? null,
      }),
    )
    .digest("hex");
  return `report-${digest}`;
}

export function generateDeterministicReport(
  input: DeterministicReportInput,
): IncidentReport {
  const session = input.session;
  const events = [...input.events].sort(
    (left, right) =>
      left.sequence - right.sequence || left.id.localeCompare(right.id),
  );
  if (events.some((event) => event.sessionId !== session.id)) {
    throw new RangeError("Every report event must belong to the session.");
  }
  const blame = input.blame;
  if (blame !== undefined && blame.anomalies.sessionId !== session.id) {
    throw new RangeError("The blame analysis belongs to a different session.");
  }
  const contextCompleteness =
    blame?.blame.contextCompleteness ?? "unknown-unsupported";
  const recovery = containmentAndRecovery(events, blame);
  const limitations = unique([
    ...(blame?.blame.limitations ?? []),
    ...(blame?.anomalies.limitations ?? []),
    ...(recovery.length === 0 && blame !== undefined
      ? [
          "No containment or recovery action for the target was identified in the recorded evidence.",
        ]
      : []),
    "Provider-hidden instructions and internal reasoning are outside the API-visible record.",
    "Deterministic attribution ranks recorded evidence; it does not establish intent or causal proof.",
    ...(input.limitations ?? []),
  ]);
  return IncidentReportSchema.parse({
    schemaVersion: 1,
    id: reportId(session.id, blame?.blame.target.eventId),
    sessionId: session.id,
    ...(blame === undefined
      ? {}
      : { targetEventId: blame.blame.target.eventId }),
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    capture: {
      level: session.captureLevel,
      contextCompleteness,
      missingSignals: captureMissingSignals(session, contextCompleteness),
    },
    impact: reportImpact(blame),
    factualTimeline: relevantTimelineEvents(events, blame).map((event) => ({
      eventId: event.id,
      occurredAt: event.occurredAt,
      statement: factualStatement(event),
      evidence: event.evidence,
    })),
    rootCauseHypothesis: rootCause(blame),
    contributingConditions: contributingConditions(blame),
    counterevidence:
      blame?.blame.counterevidence.map((item) => ({
        eventId: item.eventId,
        statement: item.weakens,
      })) ?? [],
    alternatives: blame?.blame.alternatives ?? [],
    preventionActions: preventionActions(blame),
    containmentAndRecovery: recovery,
    limitations,
    analysis: {
      mode: "deterministic",
      analyzer: DETERMINISTIC_REPORT_VERSION,
      promptVersion: null,
      model: null,
      externalEvidenceSent: false,
      redactionRuleIds: [],
    },
  });
}

function escapeMarkdown(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replace(/([\\`*_{}[\]()#+.!|~-])/gu, "\\$1")
    .replace(/\s+/gu, " ")
    .trim();
}

function eventLink(eventId: string): string {
  return `[\`${escapeMarkdown(eventId)}\`](tekrion://event/${encodeURIComponent(eventId)})`;
}

function referenceList(
  references: readonly ReportEvidenceReference[],
  empty: string,
): string[] {
  return references.length === 0
    ? [`- ${empty}`]
    : references.map(
        (reference) =>
          `- ${escapeMarkdown(reference.statement)} — ${eventLink(reference.eventId)}`,
      );
}

export function renderIncidentReportMarkdown(report: IncidentReport): string {
  const lines = [
    "# Tekrion Incident Report",
    "",
    `> Session \`${escapeMarkdown(report.sessionId)}\` · generated ${escapeMarkdown(report.generatedAt)}`,
    "",
    "## Scope and capture",
    "",
    `- Capture level: **${escapeMarkdown(report.capture.level)}**`,
    `- Context completeness: **${escapeMarkdown(report.capture.contextCompleteness)}**`,
    ...(report.capture.missingSignals.length === 0
      ? ["- Missing signals: none identified"]
      : report.capture.missingSignals.map(
          (signal) => `- Missing signal: ${escapeMarkdown(signal)}`,
        )),
    "",
    "## Impact",
    "",
    escapeMarkdown(report.impact),
    "",
    "## Factual timeline",
    "",
    ...(report.factualTimeline.length === 0
      ? [
          "- No observed or deterministically derived timeline fact was selected.",
        ]
      : report.factualTimeline.map(
          (item) =>
            `- ${escapeMarkdown(item.occurredAt)} · **${item.evidence}** · ${escapeMarkdown(item.statement)} — ${eventLink(item.eventId)}`,
        )),
    "",
    "## Root-cause hypothesis",
    "",
    `**${report.rootCauseHypothesis.confidence} confidence · inferred:** ${escapeMarkdown(report.rootCauseHypothesis.statement)}`,
    "",
    ...referenceList(
      report.rootCauseHypothesis.supports,
      "No supporting evidence reference met the deterministic threshold.",
    ),
    "",
    "## Contributing conditions",
    "",
    ...referenceList(report.contributingConditions, "None identified."),
    "",
    "## Counterevidence",
    "",
    ...referenceList(report.counterevidence, "None identified."),
    "",
    "## Alternative explanations",
    "",
    ...(report.alternatives.length === 0
      ? ["- None identified."]
      : report.alternatives.map(
          (alternative) =>
            `- ${escapeMarkdown(alternative.explanation)}${alternative.evidenceIds.length === 0 ? "" : ` — ${alternative.evidenceIds.map(eventLink).join(", ")}`}`,
        )),
    "",
    "## Containment and recovery observations",
    "",
    ...referenceList(report.containmentAndRecovery, "None observed."),
    "",
    "## Prevention actions",
    "",
    ...report.preventionActions.map(
      (action) =>
        `- ${escapeMarkdown(action.action)}${action.evidenceIds.length === 0 ? "" : ` — ${action.evidenceIds.map(eventLink).join(", ")}`}`,
    ),
    "",
    "## Limitations",
    "",
    ...report.limitations.map(
      (limitation) => `- ${escapeMarkdown(limitation)}`,
    ),
    "",
    "## Analysis and privacy",
    "",
    `- Mode: **${report.analysis.mode}**`,
    `- Analyzer: \`${escapeMarkdown(report.analysis.analyzer)}\``,
    `- External evidence used in this report: **${String(report.analysis.externalEvidenceSent)}**`,
    ...(report.analysis.mode === "ai-enriched"
      ? [
          `- Provider: \`${escapeMarkdown(report.analysis.provider)}\``,
          `- Model: \`${escapeMarkdown(report.analysis.model)}\``,
          `- Prompt version: \`${escapeMarkdown(report.analysis.promptVersion)}\``,
          `- Analysis session: \`${escapeMarkdown(report.analysis.analysisSessionId)}\``,
          `- Transmitted snapshot SHA-256: \`${escapeMarkdown(report.analysis.transmittedEvidenceSha256)}\``,
          `- Usage: input ${report.analysis.usage.inputTokens ?? "unknown"}, output ${report.analysis.usage.outputTokens ?? "unknown"}, total ${report.analysis.usage.totalTokens ?? "unknown"} tokens`,
          `- Redaction rules: ${report.analysis.redactionRuleIds.length === 0 ? "none" : report.analysis.redactionRuleIds.map((id) => `\`${escapeMarkdown(id)}\``).join(", ")}`,
        ]
      : []),
    "",
  ];
  return `${lines.join("\n")}\n`;
}

export function deterministicReportResult(
  input: DeterministicReportInput,
): IncidentReportResult {
  const report = generateDeterministicReport(input);
  return IncidentReportResultSchema.parse({
    schemaVersion: 1,
    requestedMode: "deterministic",
    report,
    markdown: renderIncidentReportMarkdown(report),
    aiAttempt: { status: "not-requested" },
  });
}

export function strongestAnomalySeverity(
  analysis: BlameAnalysis | undefined,
): number {
  return Math.max(
    0,
    ...(analysis?.anomalies.findings.map(
      (finding) => SEVERITY_WEIGHT[finding.severity],
    ) ?? []),
  );
}
