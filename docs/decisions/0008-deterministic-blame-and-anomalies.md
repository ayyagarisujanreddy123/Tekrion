# ADR 0008: Deterministic blame and transparent anomalies

- Status: Accepted
- Date: 2026-07-20
- Milestone: M7

## Context

Tekrion needs to explain why a selected tool or filesystem action is suspicious without sending recorded source, prompts, or tool output to another model. A useful attribution must rank only evidence that could precede the target invocation, preserve hard provenance separately from similarity, expose its feature calculation, and remain appropriately uncertain when client-visible context is incomplete. Anomaly signals must also remain inspectable rules rather than opaque pseudo-probabilities.

## Decision

1. Normalize each selected tool/file target into an action verb, path or entity, arguments, scope, result, and impact. For a filesystem effect, resolve the preceding tool invocation through parent, correlation, and exact-path evidence before defining the candidate cutoff.
2. Admit candidates only from eligible evidence strictly preceding the resolved invocation. When reconstructed request context is available, retain a prior event only when its provenance ID or stored text appears in that visible context; never admit a future event.
3. Rank candidates with a versioned deterministic score over hard provenance, BM25/lexical match, entity/path overlap, intent conflict, instruction-like language, and recency. Store every component in the result. Embedding or model similarity is not required.
4. Treat parent/call correlation, content hashes, exact stored paths, reconstructed request membership, explicit context edges, and read-result propagation as auditable hard edges. Similarity without a hard edge can never yield high confidence.
5. Require complete relevant client context plus a hard edge and an instruction/conflict or direct-user-authorization signal for high confidence. Partial, provider-managed, unknown, or unsupported context caps the result below high.
6. Run transparent local rules for destructive scope drift, instruction-like untrusted content, repeated tool calls, repeated errors, context pressure, and secret-like content. Persist rule IDs, bounded event references, inputs, and thresholds; never copy a matched secret into an anomaly finding.
7. Cache the combined versioned blame/anomaly result as a content-addressed blob referenced by an immutable analysis run. Imported read-only sessions may compute the result in memory without mutating their evidence store.
8. Serve analysis through the authenticated event API and render it in a Blame tab with inert excerpts, ranked features, propagation, anomalies, evidence, counterevidence, alternatives, limitations, and event navigation.

## Consequences

- The deterministic rogue fixture ranks the poisoned README line first entirely offline, while a benign path mention does not receive the same high-confidence injection conclusion.
- Stored evidence after the target cannot influence ranking, and similar text excluded from reconstructed client context is not a candidate.
- An investigator can audit every score and rule from event IDs and retained excerpts; the UI does not launder a heuristic score into a probability or causal claim.
- Repeating the same analysis reuses a content-addressed result and versioned analyzer identity.
- Future semantic ranking or optional model narrative may improve recall or prose, but cannot create hard provenance, cite nonexistent/future evidence, or raise confidence beyond the deterministic context/provenance cap.
