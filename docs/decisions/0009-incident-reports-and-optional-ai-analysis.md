# ADR 0009: Incident reports and explicit opt-in AI analysis

- Status: Accepted
- Date: 2026-07-20
- Milestone: M8

## Context

Tekrion needs a useful post-incident handoff without turning a heuristic attribution or model-written narrative into fact. The normal path must remain local and deterministic. Optional external analysis creates a separate privacy boundary: an investigator must know exactly what evidence would leave the machine, sensitive values must be removed first, generated claims must cite transmitted evidence, and any provider failure must leave the original report usable.

## Decision

1. Generate a versioned deterministic incident report as both JSON and escaped Markdown. Keep observed or derived timeline facts separate from the explicitly inferred root-cause hypothesis, and include capture completeness, impact, contributing conditions, counterevidence, alternatives, observed containment or recovery, prevention actions, and limitations.
2. Select the highest-impact exact filesystem or tool target when no target is requested, while allowing an explicit target event. Cache target-specific deterministic reports as content-addressed blobs referenced by immutable `report` analysis runs.
3. Keep report generation offline by default. AI analysis requires either the CLI's explicit `--ai` flag or a separate cockpit preview and confirmation action. A preflight request computes locally and makes no provider call; canceling it cannot transmit evidence. Bind consent to a fingerprint covering the snapshot SHA-256, provider, model, and prompt version, and require a new preview if any of them changes before transmission.
4. Minimize the external snapshot to declared session-metadata, factual-timeline, blame, anomaly, and counterevidence categories. Omit repository-root scope and unrelated session fields, redact recognized credentials before serialization, and disclose exact category counts, byte sizes, redaction count/rules, event count, provider, model, prompt version, and snapshot SHA-256.
5. Use a provider-independent analysis interface and an OpenAI-compatible Responses implementation with `store: false` and strict JSON Schema structured output. Only dedicated `TEKRION_ANALYSIS_*` configuration enables it; general agent credentials are never implicitly reused.
6. Delimit every snapshot field as untrusted recorded evidence. Validate the returned versioned object locally, require cited event IDs to exist in the transmitted snapshot, and require each citation excerpt to occur exactly in that event's transmitted excerpt. Reject the whole enrichment when any required claim lacks valid evidence.
7. Allow the optional model to edit inferred narrative only. Preserve deterministic impact, factual timeline, containment/recovery, and report identity; retain deterministic sections when the model omits replacements; never let model confidence exceed the deterministic confidence ceiling.
8. Record each consented attempt as an `ai-report` analysis run plus a separate hidden internal-analysis session. Persist the provider, model, prompt version, usage, minimized snapshot reference, output reference, redaction metadata, citation result, and terminal failure or completion state without mixing analysis events into the investigated session.
9. Return the deterministic report unchanged when configuration, provider transport, refusal, structured output, citation validation, or analysis bookkeeping fails. The result discloses the failed attempt without claiming that external evidence was used in the retained report.
10. Expose deterministic report and preflight reads through authenticated `GET` routes. Reserve authenticated `POST /v1/sessions/:id/report/ai` with a literal `consent: true` body for the only network-capable report route.

## Consequences

- A complete incident report is available with no network or model dependency, and unsupported causal claims remain visibly separated from recorded facts.
- Investigators can inspect the exact transmission envelope before consent, while recognized secret values and unnecessary absolute repository scope stay out of the serialized snapshot.
- Model prose cannot invent provenance, cite an untransmitted event, silently alter the deterministic timeline, or inflate confidence.
- Optional analysis is auditable and isolated from the source session, including failures, usage, prompt/model identity, redactions, and the transmitted snapshot hash.
- Supporting another structured-output provider requires a new provider implementation, but it cannot bypass minimization, consent, citation validation, confidence caps, or deterministic fallback.
