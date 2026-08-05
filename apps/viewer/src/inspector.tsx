import { useEffect, useMemo, useState } from "react";

import type {
  TekrionEvent,
  BlameAnalysis,
  BlameCandidate,
  BlobReference,
  ContextCompleteness,
  ContextResult,
  EventDetail,
  IncidentReportResult,
  ReportPreflight,
} from "@tekrion/protocol";

import type { ViewerApiClient } from "./api.js";
import {
  decodeFileDelta,
  numberedLines,
  type DecodedFileState,
} from "./diff.js";
import {
  eventCategoryLabel,
  eventFieldValue,
  eventPreview,
  eventTitle,
  eventTypeLabel,
  humanizeIdentifier,
} from "./timeline.js";

type InspectorTab =
  | "summary"
  | "blame"
  | "report"
  | "context"
  | "normalized"
  | "raw"
  | "headers"
  | "provenance"
  | "diff";

const INSPECTOR_TAB_LABELS: Readonly<Record<InspectorTab, string>> = {
  summary: "Overview",
  blame: "Possible cause",
  report: "Report",
  context: "Model context",
  normalized: "Event JSON",
  raw: "Raw payload",
  headers: "HTTP headers",
  provenance: "Provenance",
  diff: "File change",
};

const TECHNICAL_TABS: readonly InspectorTab[] = [
  "normalized",
  "raw",
  "headers",
  "provenance",
];

interface PayloadChoice {
  readonly label: string;
  readonly reference: BlobReference;
}

export interface InspectorProps {
  readonly api: ViewerApiClient;
  readonly sessionId?: string | undefined;
  readonly detail?: EventDetail | undefined;
  readonly loading: boolean;
  readonly error?: string | undefined;
  readonly relatedEvents: readonly TekrionEvent[];
  readonly onSelectEvent: (eventId: string) => void;
}

export function JsonBlock(props: {
  readonly value: unknown;
}): React.JSX.Element {
  return (
    <pre className="json-block">{JSON.stringify(props.value, null, 2)}</pre>
  );
}

const CONTEXT_LABELS: Record<ContextCompleteness, string> = {
  "exact-client-request": "Exact client request",
  "reconstructed-client-chain": "Reconstructed client chain",
  "partial-client-chain": "Partial client chain",
  "provider-managed-context": "Provider-managed context",
  "unknown-unsupported": "Unknown or unsupported",
};

function tokenValue(value: number | null): string {
  return value === null ? "unavailable" : value.toLocaleString();
}

export function ContextView(props: {
  readonly context: ContextResult;
  readonly onSelectEvent?: (eventId: string) => void;
}): React.JSX.Element {
  const context = props.context;
  return (
    <div className="context-view">
      <section
        className={`context-completeness context-completeness--${context.completeness}`}
      >
        <span>Context completeness</span>
        <strong>{CONTEXT_LABELS[context.completeness]}</strong>
      </section>

      <dl className="context-metrics">
        <div>
          <dt>Reported input</dt>
          <dd>{tokenValue(context.reportedInputTokens)} tokens</dd>
        </div>
        <div>
          <dt>Visible estimate</dt>
          <dd>≈ {tokenValue(context.estimatedInputTokens)} tokens</dd>
        </div>
        <div>
          <dt>Model limit</dt>
          <dd>{tokenValue(context.modelContextLimit)} tokens</dd>
        </div>
      </dl>

      <p className="context-notice">{context.visibilityNotice}</p>

      {context.limitationReasons.length === 0 ? null : (
        <section className="context-limitations" aria-label="Limitations">
          <h3>Limitations</h3>
          <ul>
            {context.limitationReasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </section>
      )}

      <h3>Ordered visible context</h3>
      {context.items.length === 0 ? (
        <p className="inspector-note">
          No API-visible context item was recovered.
        </p>
      ) : (
        <ol className="context-items">
          {context.items.map((item) => (
            <li key={item.id}>
              <header>
                <span>#{item.position}</span>
                <strong>{item.kind}</strong>
                {item.role === undefined ? null : <em>{item.role}</em>}
                <small>{item.evidence}</small>
              </header>
              <JsonBlock value={item.summary} />
              <footer>
                {item.provenance.eventId === undefined ||
                props.onSelectEvent === undefined ? (
                  <code>event {item.provenance.eventId ?? "none"}</code>
                ) : (
                  <button
                    type="button"
                    className="context-provenance-link"
                    onClick={() => {
                      if (item.provenance.eventId !== undefined) {
                        props.onSelectEvent?.(item.provenance.eventId);
                      }
                    }}
                  >
                    event {item.provenance.eventId}
                  </button>
                )}
                <code>exchange {item.provenance.exchangeId ?? "none"}</code>
                {item.provenance.payloadRef === undefined ? null : (
                  <code>payload {item.provenance.payloadRef.id}</code>
                )}
              </footer>
            </li>
          ))}
        </ol>
      )}

      <h3>Ancestry</h3>
      <div className="context-ancestry">
        <ul>
          {context.ancestry.nodes.map((node) => (
            <li key={node.id}>
              <span>{node.kind}</span>
              <code>{node.id}</code>
              <small>{node.locallyAvailable ? "local" : "not local"}</small>
            </li>
          ))}
        </ul>
        {context.ancestry.edges.length === 0 ? null : (
          <ol>
            {context.ancestry.edges.map((edge, index) => (
              <li key={`${edge.from}-${edge.to}-${edge.relation}-${index}`}>
                <code>{edge.from}</code>
                <span>{edge.relation}</span>
                <code>{edge.to}</code>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}

export function ContextPanel(props: {
  readonly api: ViewerApiClient;
  readonly eventId: string;
  readonly onSelectEvent: (eventId: string) => void;
}): React.JSX.Element {
  const [context, setContext] = useState<ContextResult>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let current = true;
    setContext(undefined);
    setError(undefined);
    void props.api
      .getContext(props.eventId)
      .then((result) => current && setContext(result))
      .catch((cause: unknown) => {
        if (current) {
          setError(
            cause instanceof Error ? cause.message : "Context unavailable",
          );
        }
      });
    return () => {
      current = false;
    };
  }, [props.api, props.eventId]);

  if (error !== undefined) {
    return <p className="error-banner">{error}</p>;
  }
  if (context === undefined) {
    return <p className="inspector-note">Reconstructing visible context…</p>;
  }
  return <ContextView context={context} onSelectEvent={props.onSelectEvent} />;
}

function EventLink(props: {
  readonly eventId: string;
  readonly label?: string;
  readonly onSelectEvent: (eventId: string) => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      className="context-provenance-link"
      onClick={() => props.onSelectEvent(props.eventId)}
    >
      {props.label ?? props.eventId}
    </button>
  );
}

const FEATURE_LABELS: Readonly<Record<string, string>> = {
  provenance: "provenance",
  bm25Match: "BM25 / FTS",
  lexicalOverlap: "lexical overlap",
  lexicalOrSemanticSimilarity: "combined lexical",
  entityPathOverlap: "path / entity",
  intentConflict: "intent conflict",
  instructionLikelihood: "instruction-like",
  recencyDecay: "recency",
  propagationDepth: "propagation depth",
};

function CandidateFeatures(props: {
  readonly candidate: BlameCandidate;
}): React.JSX.Element {
  return (
    <dl className="blame-features">
      {Object.entries(props.candidate.features).map(([name, value]) => (
        <div key={name}>
          <dt>{FEATURE_LABELS[name] ?? name}</dt>
          <dd>
            <span
              style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%` }}
            />
            <code>{value.toFixed(2)}</code>
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function BlameView(props: {
  readonly analysis: BlameAnalysis;
  readonly onSelectEvent: (eventId: string) => void;
}): React.JSX.Element {
  const { blame, anomalies } = props.analysis;
  return (
    <div className="blame-view">
      <section className={`blame-verdict confidence-${blame.confidence}`}>
        <header>
          <span>Deterministic attribution</span>
          <strong>{blame.confidence} confidence</strong>
        </header>
        <p>{blame.conclusion}</p>
        <dl>
          <div>
            <dt>target</dt>
            <dd>
              {blame.target.path ?? blame.target.entity ?? blame.target.verb}
            </dd>
          </div>
          <div>
            <dt>action</dt>
            <dd>{blame.target.verb}</dd>
          </div>
          <div>
            <dt>context</dt>
            <dd>{CONTEXT_LABELS[blame.contextCompleteness]}</dd>
          </div>
          <div>
            <dt>scoring</dt>
            <dd>{blame.scoringVersion}</dd>
          </div>
        </dl>
      </section>

      <section>
        <h3>Why this confidence</h3>
        <ul className="blame-reasons">
          {blame.confidenceReasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      </section>

      {blame.primaryOrigin === undefined ? null : (
        <section>
          <h3>Primary origin</h3>
          <article className="blame-origin">
            <header>
              <EventLink
                eventId={blame.primaryOrigin.eventId}
                onSelectEvent={props.onSelectEvent}
              />
              {blame.primaryOrigin.location === undefined ? null : (
                <code>
                  {blame.primaryOrigin.location.path}:
                  {blame.primaryOrigin.location.startLine}
                </code>
              )}
            </header>
            <blockquote data-render-policy="inert-text-only">
              {blame.primaryOrigin.excerpt}
            </blockquote>
          </article>
        </section>
      )}

      <section>
        <h3>Ranked candidates</h3>
        {blame.candidates.length === 0 ? (
          <p className="inspector-note">No eligible preceding evidence.</p>
        ) : (
          <ol className="blame-candidates">
            {blame.candidates.slice(0, 8).map((candidate, index) => (
              <li key={candidate.eventId}>
                <header>
                  <span>#{index + 1}</span>
                  <EventLink
                    eventId={candidate.eventId}
                    onSelectEvent={props.onSelectEvent}
                  />
                  <strong>{candidate.score.toFixed(3)}</strong>
                  {candidate.hardProvenanceEdge ? <em>hard edge</em> : null}
                </header>
                <CandidateFeatures candidate={candidate} />
              </li>
            ))}
          </ol>
        )}
      </section>

      <section>
        <h3>Evidence propagation</h3>
        {blame.propagation.length === 0 ? (
          <p className="inspector-note">No hard propagation path recovered.</p>
        ) : (
          <ol className="blame-graph">
            {blame.propagation.map((edge, index) => (
              <li key={`${edge.from}-${edge.to}-${edge.relation}-${index}`}>
                <EventLink
                  eventId={edge.from}
                  label={edge.from}
                  onSelectEvent={props.onSelectEvent}
                />
                <span>{edge.relation}</span>
                <EventLink
                  eventId={edge.to}
                  label={edge.to}
                  onSelectEvent={props.onSelectEvent}
                />
              </li>
            ))}
          </ol>
        )}
      </section>

      <section>
        <h3>Anomaly signals</h3>
        {anomalies.findings.length === 0 ? (
          <p className="inspector-note">
            No configured deterministic anomaly rule fired.
          </p>
        ) : (
          <ul className="anomaly-findings">
            {anomalies.findings.map((finding) => (
              <li className={`severity-${finding.severity}`} key={finding.id}>
                <header>
                  <span>{finding.severity}</span>
                  <code>{finding.ruleId}</code>
                </header>
                <strong>{finding.title}</strong>
                <p>{finding.explanation}</p>
                <footer>
                  {finding.eventIds.map((eventId) => (
                    <EventLink
                      key={eventId}
                      eventId={eventId}
                      onSelectEvent={props.onSelectEvent}
                    />
                  ))}
                </footer>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="blame-support">
        <h3>Supporting evidence</h3>
        {blame.evidence.length === 0 ? (
          <p className="inspector-note">No additional supporting edge.</p>
        ) : (
          <ul>
            {blame.evidence.map((item, index) => (
              <li key={`${item.eventId}-${index}`}>
                <EventLink
                  eventId={item.eventId}
                  onSelectEvent={props.onSelectEvent}
                />
                <span>{item.supports}</span>
              </li>
            ))}
          </ul>
        )}
        <h3>Counterevidence</h3>
        {blame.counterevidence.length === 0 ? (
          <p className="inspector-note">No explicit counterevidence ranked.</p>
        ) : (
          <ul>
            {blame.counterevidence.map((item, index) => (
              <li key={`${item.eventId}-${index}`}>
                <EventLink
                  eventId={item.eventId}
                  onSelectEvent={props.onSelectEvent}
                />
                <span>{item.weakens}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h3>Alternatives</h3>
        <ul className="blame-alternatives">
          {blame.alternatives.map((alternative) => (
            <li key={alternative.explanation}>
              <span>{alternative.explanation}</span>
              <footer>
                {alternative.evidenceIds.map((eventId) => (
                  <EventLink
                    key={eventId}
                    eventId={eventId}
                    onSelectEvent={props.onSelectEvent}
                  />
                ))}
              </footer>
            </li>
          ))}
        </ul>
      </section>

      <section className="blame-limitations">
        <h3>Limitations</h3>
        <ul>
          {[...blame.limitations, ...anomalies.limitations].map(
            (limitation) => (
              <li key={limitation}>{limitation}</li>
            ),
          )}
        </ul>
      </section>
    </div>
  );
}

export function BlamePanel(props: {
  readonly api: ViewerApiClient;
  readonly eventId: string;
  readonly onSelectEvent: (eventId: string) => void;
}): React.JSX.Element {
  const [analysis, setAnalysis] = useState<BlameAnalysis>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let current = true;
    setAnalysis(undefined);
    setError(undefined);
    void props.api
      .getBlame(props.eventId)
      .then((result) => current && setAnalysis(result))
      .catch((cause: unknown) => {
        if (current) {
          setError(
            cause instanceof Error ? cause.message : "Blame unavailable",
          );
        }
      });
    return () => {
      current = false;
    };
  }, [props.api, props.eventId]);

  if (error !== undefined) {
    return <p className="error-banner">{error}</p>;
  }
  if (analysis === undefined) {
    return <p className="inspector-note">Ranking preceding evidence…</p>;
  }
  return <BlameView analysis={analysis} onSelectEvent={props.onSelectEvent} />;
}

export function blameAvailable(event: TekrionEvent): boolean {
  return (
    event.type === "tool.call" ||
    event.type.startsWith("file.") ||
    typeof event.summary.operation === "string"
  );
}

function ReportReferenceList(props: {
  readonly references: readonly {
    readonly eventId: string;
    readonly statement: string;
  }[];
  readonly empty: string;
  readonly onSelectEvent: (eventId: string) => void;
}): React.JSX.Element {
  if (props.references.length === 0) {
    return <p className="inspector-note">{props.empty}</p>;
  }
  return (
    <ul className="report-reference-list">
      {props.references.map((reference, index) => (
        <li key={`${reference.eventId}-${index}`}>
          <span>{reference.statement}</span>
          <EventLink
            eventId={reference.eventId}
            onSelectEvent={props.onSelectEvent}
          />
        </li>
      ))}
    </ul>
  );
}

export function ReportView(props: {
  readonly result: IncidentReportResult;
  readonly onSelectEvent: (eventId: string) => void;
}): React.JSX.Element {
  const report = props.result.report;
  return (
    <div className="report-view">
      <section className={`report-verdict report-mode-${report.analysis.mode}`}>
        <header>
          <span>Incident report</span>
          <strong>{report.analysis.mode}</strong>
        </header>
        <p>{report.impact}</p>
        <dl>
          <div>
            <dt>capture</dt>
            <dd>{report.capture.level}</dd>
          </div>
          <div>
            <dt>context</dt>
            <dd>{report.capture.contextCompleteness}</dd>
          </div>
          <div>
            <dt>generated</dt>
            <dd>{new Date(report.generatedAt).toLocaleString()}</dd>
          </div>
        </dl>
      </section>

      {report.capture.missingSignals.length === 0 ? null : (
        <>
          <h3>Capture limitations</h3>
          <ul className="report-limitations">
            {report.capture.missingSignals.map((signal) => (
              <li key={signal}>{signal}</li>
            ))}
          </ul>
        </>
      )}

      <h3>Factual timeline</h3>
      {report.factualTimeline.length === 0 ? (
        <p className="inspector-note">No factual timeline item was selected.</p>
      ) : (
        <ol className="report-timeline">
          {report.factualTimeline.map((item) => (
            <li key={item.eventId}>
              <header>
                <span>{item.evidence}</span>
                <time>{new Date(item.occurredAt).toLocaleTimeString()}</time>
              </header>
              <p>{item.statement}</p>
              <EventLink
                eventId={item.eventId}
                onSelectEvent={props.onSelectEvent}
              />
            </li>
          ))}
        </ol>
      )}

      <h3>Root-cause hypothesis</h3>
      <section className="report-hypothesis">
        <header>
          <strong>{report.rootCauseHypothesis.confidence} confidence</strong>
          <span>inferred — not causal proof</span>
        </header>
        <p>{report.rootCauseHypothesis.statement}</p>
      </section>
      <ReportReferenceList
        references={report.rootCauseHypothesis.supports}
        empty="No supporting evidence reference met the threshold."
        onSelectEvent={props.onSelectEvent}
      />

      <h3>Contributing conditions</h3>
      <ReportReferenceList
        references={report.contributingConditions}
        empty="None identified."
        onSelectEvent={props.onSelectEvent}
      />

      <h3>Counterevidence</h3>
      <ReportReferenceList
        references={report.counterevidence}
        empty="None identified."
        onSelectEvent={props.onSelectEvent}
      />

      <h3>Alternatives</h3>
      {report.alternatives.length === 0 ? (
        <p className="inspector-note">None identified.</p>
      ) : (
        <ul className="report-copy-list">
          {report.alternatives.map((alternative, index) => (
            <li key={`${alternative.explanation}-${index}`}>
              <span>{alternative.explanation}</span>
              <div>
                {alternative.evidenceIds.map((eventId) => (
                  <EventLink
                    key={eventId}
                    eventId={eventId}
                    onSelectEvent={props.onSelectEvent}
                  />
                ))}
              </div>
            </li>
          ))}
        </ul>
      )}

      <h3>Containment and recovery observations</h3>
      <ReportReferenceList
        references={report.containmentAndRecovery}
        empty="None observed."
        onSelectEvent={props.onSelectEvent}
      />

      <h3>Prevention actions</h3>
      <ul className="report-copy-list">
        {report.preventionActions.map((action, index) => (
          <li key={`${action.action}-${index}`}>
            <span>{action.action}</span>
            <div>
              {action.evidenceIds.map((eventId) => (
                <EventLink
                  key={eventId}
                  eventId={eventId}
                  onSelectEvent={props.onSelectEvent}
                />
              ))}
            </div>
          </li>
        ))}
      </ul>

      <h3>Limitations</h3>
      <ul className="report-limitations">
        {report.limitations.map((limitation) => (
          <li key={limitation}>{limitation}</li>
        ))}
      </ul>

      <section className="report-disclosure">
        <strong>Analysis and privacy</strong>
        <span>{report.analysis.analyzer}</span>
        <span>
          External evidence used in this report:{" "}
          {String(report.analysis.externalEvidenceSent)}
        </span>
        {report.analysis.mode === "ai-enriched" ? (
          <>
            <span>
              {report.analysis.provider} / {report.analysis.model}
            </span>
            <span>Prompt: {report.analysis.promptVersion}</span>
            <span>Analysis session: {report.analysis.analysisSessionId}</span>
            <span>Snapshot: {report.analysis.transmittedEvidenceSha256}</span>
            <span>
              Usage: input {report.analysis.usage.inputTokens ?? "unknown"} ·
              output {report.analysis.usage.outputTokens ?? "unknown"} · total{" "}
              {report.analysis.usage.totalTokens ?? "unknown"}
            </span>
            <span>
              Redactions:{" "}
              {report.analysis.redactionRuleIds.join(", ") || "none"}
            </span>
          </>
        ) : null}
      </section>
    </div>
  );
}

function ReportPreflightView(props: {
  readonly preflight: ReportPreflight;
  readonly enriching: boolean;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}): React.JSX.Element {
  return (
    <section
      className="report-preflight"
      role="dialog"
      aria-modal="false"
      aria-label="AI evidence transmission preview"
    >
      <span>EXTERNAL TRANSMISSION PREVIEW</span>
      <h3>Review the redacted evidence snapshot</h3>
      <p>
        Confirming sends only the categories below to {props.preflight.provider}
        {" / "}
        {props.preflight.model}. Canceling makes no provider call.
      </p>
      <dl>
        {props.preflight.categories.map((category) => (
          <div key={category.category}>
            <dt>{category.category}</dt>
            <dd>
              {category.itemCount.toLocaleString()} items ·{" "}
              {category.byteLength.toLocaleString()} bytes
            </dd>
          </div>
        ))}
      </dl>
      <p>
        Total {props.preflight.totalBytes.toLocaleString()} bytes ·{" "}
        {props.preflight.redactionCount.toLocaleString()} redactions
      </p>
      <p>
        Prompt {props.preflight.promptVersion} · rules{" "}
        {props.preflight.redactionRuleIds.join(", ") || "none"}
      </p>
      <code>snapshot sha256: {props.preflight.snapshotSha256}</code>
      <code>
        consent fingerprint: {props.preflight.consentFingerprintSha256}
      </code>
      <div className="report-consent-actions">
        <button
          type="button"
          onClick={props.onConfirm}
          disabled={props.enriching}
        >
          {props.enriching ? "SENDING…" : "SEND REDACTED EVIDENCE"}
        </button>
        <button
          type="button"
          className="quiet-button"
          onClick={props.onCancel}
          disabled={props.enriching}
        >
          CANCEL
        </button>
      </div>
    </section>
  );
}

export function ReportPanel(props: {
  readonly api: ViewerApiClient;
  readonly sessionId: string;
  readonly targetEventId?: string | undefined;
  readonly onSelectEvent: (eventId: string) => void;
}): React.JSX.Element {
  const [result, setResult] = useState<IncidentReportResult>();
  const [preflight, setPreflight] = useState<ReportPreflight>();
  const [error, setError] = useState<string>();
  const [previewing, setPreviewing] = useState(false);
  const [enriching, setEnriching] = useState(false);

  useEffect(() => {
    let current = true;
    setResult(undefined);
    setPreflight(undefined);
    setError(undefined);
    void props.api
      .getReport(props.sessionId, props.targetEventId)
      .then((value) => current && setResult(value))
      .catch((cause: unknown) => {
        if (current) {
          setError(
            cause instanceof Error
              ? cause.message
              : "Incident report unavailable",
          );
        }
      });
    return () => {
      current = false;
    };
  }, [props.api, props.sessionId, props.targetEventId]);

  async function previewAi(): Promise<void> {
    setPreviewing(true);
    setError(undefined);
    try {
      setPreflight(
        await props.api.getReportPreflight(
          props.sessionId,
          props.targetEventId,
        ),
      );
    } catch (cause: unknown) {
      setError(
        cause instanceof Error ? cause.message : "Preflight unavailable",
      );
    } finally {
      setPreviewing(false);
    }
  }

  async function confirmAi(): Promise<void> {
    const reviewedPreflight = preflight;
    if (reviewedPreflight === undefined) {
      setError("Review an AI transmission preview before confirming.");
      return;
    }
    setEnriching(true);
    setError(undefined);
    try {
      const enriched = await props.api.enrichReport(
        props.sessionId,
        reviewedPreflight.consentFingerprintSha256,
        props.targetEventId,
      );
      setResult(enriched);
      setPreflight(undefined);
    } catch (cause: unknown) {
      setPreflight(undefined);
      setError(
        cause instanceof Error ? cause.message : "AI enrichment unavailable",
      );
    } finally {
      setEnriching(false);
    }
  }

  if (error !== undefined && result === undefined) {
    return <p className="error-banner">{error}</p>;
  }
  if (result === undefined) {
    return <p className="inspector-note">Generating offline report…</p>;
  }
  return (
    <div>
      {error === undefined ? null : <p className="error-banner">{error}</p>}
      {result.aiAttempt.status === "failed" ? (
        <p className="error-banner">
          AI enrichment failed
          {result.aiAttempt.externalEvidenceSent
            ? " after the redacted evidence was sent"
            : " before external evidence was sent"}
          ; the deterministic report remains intact: {result.aiAttempt.error}
        </p>
      ) : null}
      <ReportView result={result} onSelectEvent={props.onSelectEvent} />
      {preflight === undefined ? (
        <section className="report-ai-opt-in">
          <strong>Optional AI explanation</strong>
          <p>
            Offline is the default. Preview the minimized, redacted evidence
            before deciding whether to send it.
          </p>
          <button
            type="button"
            onClick={() => void previewAi()}
            disabled={previewing || enriching}
          >
            {previewing ? "PREPARING…" : "PREVIEW AI TRANSMISSION"}
          </button>
        </section>
      ) : (
        <ReportPreflightView
          preflight={preflight}
          enriching={enriching}
          onConfirm={() => void confirmAi()}
          onCancel={() => setPreflight(undefined)}
        />
      )}
      <details className="report-markdown">
        <summary>Report Markdown handoff</summary>
        <pre data-render-policy="inert-text-only">{result.markdown}</pre>
      </details>
    </div>
  );
}

function payloadChoices(detail: EventDetail): PayloadChoice[] {
  const choices: PayloadChoice[] = [];
  if (detail.event.payloadRef !== undefined) {
    choices.push({
      label: "Event payload",
      reference: detail.event.payloadRef,
    });
  }
  const raw = detail.rawExchange;
  if (raw?.requestBodyRef !== undefined) {
    choices.push({ label: "Raw request", reference: raw.requestBodyRef });
  }
  if (raw?.responseBodyRef !== undefined) {
    choices.push({ label: "Raw response", reference: raw.responseBodyRef });
  }
  if (raw?.streamManifestRef !== undefined) {
    choices.push({
      label: "Stream manifest",
      reference: raw.streamManifestRef,
    });
  }
  return choices;
}

function renderPayload(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return [...bytes.slice(0, 512)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join(" ");
  }
}

export function RawPayload(props: {
  readonly api: ViewerApiClient;
  readonly detail: EventDetail;
}): React.JSX.Element {
  const choices = useMemo(() => payloadChoices(props.detail), [props.detail]);
  const [selectedId, setSelectedId] = useState(choices[0]?.reference.id);
  const [bytes, setBytes] = useState<Uint8Array>();
  const [error, setError] = useState<string>();
  const selected = choices.find((choice) => choice.reference.id === selectedId);

  useEffect(() => {
    setSelectedId(choices[0]?.reference.id);
  }, [choices]);

  useEffect(() => {
    if (selected === undefined) {
      setBytes(undefined);
      return;
    }
    let current = true;
    setBytes(undefined);
    setError(undefined);
    void props.api
      .getPayload(selected.reference.id)
      .then((payload) => {
        if (current) {
          setBytes(payload);
        }
      })
      .catch((cause: unknown) => {
        if (current) {
          setError(
            cause instanceof Error ? cause.message : "Payload unavailable",
          );
        }
      });
    return () => {
      current = false;
    };
  }, [props.api, selected]);

  if (choices.length === 0) {
    return (
      <p className="inspector-note">
        No raw payload reference is attached to this evidence.
      </p>
    );
  }
  return (
    <div className="payload-view">
      <label>
        Payload
        <select
          value={selectedId}
          onChange={(event) => setSelectedId(event.target.value)}
        >
          {choices.map((choice) => (
            <option
              key={`${choice.label}-${choice.reference.id}`}
              value={choice.reference.id}
            >
              {choice.label} · {choice.reference.byteLength.toLocaleString()}{" "}
              bytes
            </option>
          ))}
        </select>
      </label>
      {selected === undefined ? null : (
        <div className="payload-meta">
          <span>{selected.reference.mediaType}</span>
          <code>{selected.reference.sha256.slice(0, 16)}…</code>
          {selected.reference.truncated ? <strong>truncated</strong> : null}
        </div>
      )}
      {error === undefined ? null : <p className="error-banner">{error}</p>}
      {bytes === undefined && error === undefined ? (
        <p className="inspector-note">Loading verified payload bytes…</p>
      ) : null}
      {bytes === undefined ? null : (
        <pre className="raw-evidence" data-render-policy="inert-text-only">
          {renderPayload(bytes)}
        </pre>
      )}
    </div>
  );
}

function FileState(props: {
  readonly label: string;
  readonly state: DecodedFileState;
  readonly compare?: readonly string[];
}): React.JSX.Element {
  const lines = numberedLines(props.state.text);
  if (props.state.kind === "absent") {
    return <div className="diff-absent">{props.label}: file absent</div>;
  }
  if (props.state.kind === "binary") {
    return (
      <div className="diff-absent">
        {props.label}: binary · {props.state.byteLength.toLocaleString()} bytes
      </div>
    );
  }
  return (
    <section className="diff-side" aria-label={`${props.label} file content`}>
      <header>{props.label}</header>
      <pre>
        {lines.map((line, index) => (
          <span
            className={props.compare?.[index] === line ? "" : "is-changed"}
            key={`${index}-${line}`}
          >
            <em>{index + 1}</em>
            {line || " "}
            {"\n"}
          </span>
        ))}
      </pre>
    </section>
  );
}

function DiffPayload(props: {
  readonly api: ViewerApiClient;
  readonly detail: EventDetail;
}): React.JSX.Element {
  const reference = props.detail.event.payloadRef;
  const [bytes, setBytes] = useState<Uint8Array>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (reference === undefined) {
      return;
    }
    let current = true;
    setBytes(undefined);
    setError(undefined);
    void props.api
      .getPayload(reference.id)
      .then((payload) => current && setBytes(payload))
      .catch((cause: unknown) => {
        if (current) {
          setError(cause instanceof Error ? cause.message : "Diff unavailable");
        }
      });
    return () => {
      current = false;
    };
  }, [props.api, reference]);

  if (reference === undefined) {
    return (
      <p className="inspector-note">
        This change was hashed without retained content.
      </p>
    );
  }
  if (error !== undefined) {
    return <p className="error-banner">{error}</p>;
  }
  if (bytes === undefined) {
    return <p className="inspector-note">Loading diff evidence…</p>;
  }
  if (props.detail.fileChange?.payloadKind === "git-binary-patch") {
    return <pre className="raw-evidence">{renderPayload(bytes)}</pre>;
  }
  try {
    const delta = decodeFileDelta(bytes);
    const before = numberedLines(delta.before.text);
    const after = numberedLines(delta.after.text);
    return (
      <div className="diff-view">
        <div className="diff-path">
          <strong>{delta.payload.path}</strong>
          <span>{delta.payload.operation}</span>
        </div>
        <div className="diff-columns">
          <FileState label="before" state={delta.before} compare={after} />
          <FileState label="after" state={delta.after} compare={before} />
        </div>
      </div>
    );
  } catch (cause: unknown) {
    return (
      <div>
        <p className="error-banner">
          {cause instanceof Error ? cause.message : "Malformed diff evidence"}
        </p>
        <pre className="raw-evidence">{renderPayload(bytes)}</pre>
      </div>
    );
  }
}

function Summary(props: { readonly detail: EventDetail }): React.JSX.Element {
  const event = props.detail.event;
  return (
    <div className="summary-tab">
      <p className="event-overview">{eventPreview(event)}</p>
      <div className="evidence-stamps">
        <span>{eventCategoryLabel(event)}</span>
        <span>{humanizeIdentifier(event.evidence)} evidence</span>
        <span>Event #{event.sequence.toLocaleString()}</span>
      </div>
      <h3 className="summary-heading">Recorded details</h3>
      <dl className="summary-grid">
        {Object.entries(event.summary).map(([name, value]) => (
          <div key={name}>
            <dt>{humanizeIdentifier(name)}</dt>
            <dd>{eventFieldValue(name, value)}</dd>
          </div>
        ))}
      </dl>
      {event.redaction.applied ? (
        <p className="redaction-banner">
          Redaction applied: {event.redaction.ruleIds.join(", ")}
        </p>
      ) : null}
    </div>
  );
}

function Headers(props: { readonly detail: EventDetail }): React.JSX.Element {
  if (props.detail.rawExchange === undefined) {
    return (
      <p className="inspector-note">
        No HTTP exchange is associated with this event.
      </p>
    );
  }
  return (
    <div>
      <p className="inspector-note">
        Credential and cookie headers are excluded before persistence.
      </p>
      <h3>Request</h3>
      <JsonBlock value={props.detail.rawExchange.requestHeaders} />
      <h3>Response</h3>
      <JsonBlock value={props.detail.rawExchange.responseHeaders ?? {}} />
    </div>
  );
}

function Provenance(props: {
  readonly detail: EventDetail;
  readonly relatedEvents: readonly TekrionEvent[];
  readonly onSelectEvent: (eventId: string) => void;
}): React.JSX.Element {
  return (
    <div className="provenance-tab">
      <dl className="summary-grid">
        <div>
          <dt>Evidence</dt>
          <dd>{props.detail.event.evidence}</dd>
        </div>
        <div>
          <dt>Observed</dt>
          <dd>{props.detail.event.observedAt}</dd>
        </div>
        <div>
          <dt>Normalization</dt>
          <dd>{props.detail.normalizationVersion ?? "native observation"}</dd>
        </div>
        <div>
          <dt>Raw exchange</dt>
          <dd>{props.detail.rawExchange?.id ?? "none"}</dd>
        </div>
        <div>
          <dt>Correlation</dt>
          <dd>{props.detail.event.correlationId ?? "none"}</dd>
        </div>
        <div>
          <dt>Parent</dt>
          <dd>{props.detail.event.parentId ?? "none"}</dd>
        </div>
      </dl>
      <h3>Linked evidence</h3>
      {props.relatedEvents.length === 0 ? (
        <p className="inspector-note">
          No linked event is present in the loaded timeline.
        </p>
      ) : (
        <div className="related-events">
          {props.relatedEvents.map((event) => (
            <button
              type="button"
              key={event.id}
              onClick={() => props.onSelectEvent(event.id)}
            >
              <span>#{event.sequence}</span>
              {event.type}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function Inspector(props: InspectorProps): React.JSX.Element {
  const [tab, setTab] = useState<InspectorTab>("summary");
  const [technicalOpen, setTechnicalOpen] = useState(false);
  const detail = props.detail;
  const primaryTabs: InspectorTab[] = [
    "summary",
    ...(detail?.fileChange === undefined ? [] : (["diff"] as const)),
    ...(detail !== undefined && blameAvailable(detail.event)
      ? (["blame"] as const)
      : []),
    ...(detail?.event.type === "model.request" ? (["context"] as const) : []),
    ...(props.sessionId === undefined ? [] : (["report"] as const)),
  ];

  useEffect(() => {
    setTab("summary");
    setTechnicalOpen(false);
  }, [detail?.event.id]);

  if (props.loading) {
    return (
      <div className="inspector-state" role="status">
        Loading event evidence…
      </div>
    );
  }
  if (props.error !== undefined) {
    return <div className="inspector-state error-banner">{props.error}</div>;
  }
  if (detail === undefined) {
    return (
      <div className="inspector-state inspector-empty">
        <span aria-hidden="true">2</span>
        <strong>Select an event</strong>
        <p>
          Choose an activity item to understand what happened and inspect its
          evidence.
        </p>
      </div>
    );
  }

  return (
    <div className="inspector-content">
      <header className="inspector-heading">
        <span>
          Event #{detail.event.sequence.toLocaleString()} ·{" "}
          {eventCategoryLabel(detail.event)}
        </span>
        <h2>{eventTitle(detail.event)}</h2>
        {eventTypeLabel(detail.event) === eventTitle(detail.event) ? null : (
          <p>{eventTypeLabel(detail.event)}</p>
        )}
        <code>{detail.event.type}</code>
      </header>
      <div className="inspector-navigation">
        <div className="inspector-tabs" role="tablist" aria-label="Event views">
          {primaryTabs.map((candidate) => (
            <button
              type="button"
              role="tab"
              aria-selected={tab === candidate}
              key={candidate}
              onClick={() => setTab(candidate)}
            >
              {INSPECTOR_TAB_LABELS[candidate]}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="technical-toggle"
          aria-expanded={technicalOpen}
          onClick={() => {
            const next = !technicalOpen;
            setTechnicalOpen(next);
            if (!next && TECHNICAL_TABS.includes(tab)) {
              setTab("summary");
            }
          }}
        >
          Technical details
          <span aria-hidden="true">{technicalOpen ? "−" : "+"}</span>
        </button>
        {technicalOpen ? (
          <div
            className="inspector-tabs inspector-tabs--technical"
            role="tablist"
            aria-label="Technical event details"
          >
            {TECHNICAL_TABS.map((candidate) => (
              <button
                type="button"
                role="tab"
                aria-selected={tab === candidate}
                key={candidate}
                onClick={() => setTab(candidate)}
              >
                {INSPECTOR_TAB_LABELS[candidate]}
              </button>
            ))}
          </div>
        ) : null}
      </div>
      <div className="inspector-panel" role="tabpanel">
        {tab === "summary" ? <Summary detail={detail} /> : null}
        {tab === "blame" ? (
          <BlamePanel
            api={props.api}
            eventId={detail.event.id}
            onSelectEvent={props.onSelectEvent}
          />
        ) : null}
        {tab === "report" && props.sessionId !== undefined ? (
          <ReportPanel
            key={`${props.sessionId}:${blameAvailable(detail.event) ? detail.event.id : "session"}`}
            api={props.api}
            sessionId={props.sessionId}
            targetEventId={
              blameAvailable(detail.event) ? detail.event.id : undefined
            }
            onSelectEvent={props.onSelectEvent}
          />
        ) : null}
        {tab === "context" ? (
          <ContextPanel
            api={props.api}
            eventId={detail.event.id}
            onSelectEvent={props.onSelectEvent}
          />
        ) : null}
        {tab === "normalized" ? <JsonBlock value={detail.event} /> : null}
        {tab === "raw" ? <RawPayload api={props.api} detail={detail} /> : null}
        {tab === "headers" ? <Headers detail={detail} /> : null}
        {tab === "provenance" ? (
          <Provenance
            detail={detail}
            relatedEvents={props.relatedEvents}
            onSelectEvent={props.onSelectEvent}
          />
        ) : null}
        {tab === "diff" ? (
          <DiffPayload api={props.api} detail={detail} />
        ) : null}
      </div>
    </div>
  );
}
