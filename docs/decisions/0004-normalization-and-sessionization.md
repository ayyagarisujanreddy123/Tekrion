# ADR 0004: Durable normalization and session isolation

- Status: Accepted
- Date: 2026-07-16
- Milestone: M3

## Context

Raw provider traffic is authoritative evidence, but investigators need stable logical messages, tool calls, errors, and usage records. Parsing must remain outside the forwarding path, parser upgrades must not rewrite capture, and replayed stream frames must not create contradictory facts. Requests also need predictable session grouping without allowing Tekrion's own optional analysis traffic to contaminate the session under investigation.

## Decision

1. Keep endpoint parsers pure and versioned. Support Responses JSON/typed SSE, Chat Completions JSON/SSE deltas, and an opaque unknown-route fallback. Decode SSE incrementally across arbitrary transport boundaries while retaining unknown provider items as visible evidence.
2. Normalize only after the raw exchange is finalized. Load the immutable captured blobs, reserve canonical sequences, and atomically insert the normalization run and events. A run key includes the concrete parser ID and version; an idempotent rerun must reproduce complete canonical event content, not only event IDs.
3. Persist parser diagnostics as derived canonical evidence without throwing malformed provider input onto the caller's response path. Infrastructure failures degrade recorder health while leaving finalized raw bytes available for a later retry.
4. Treat an identified replay with identical payload as ignored-but-visible evidence. For an identified replay with different payload, keep the first payload authoritative, emit a parser error, and mark the parse malformed. Chat response IDs are not stream-event identities.
5. Resolve ordinary sessions in this order: explicit Tekrion session, adapter agent session, known response ancestry, bounded client idle-window heuristic, then manual fallback. Adapter and analysis keys map to safe deterministic session IDs; response ancestry is rebuilt from canonical evidence when the proxy starts.
6. Give `X-Tekrion-Analysis-Session` safety precedence over ordinary session signals and tag the resulting session `internal-analysis`. Optionally retain the investigated session ID as metadata. Hide internal analysis sessions from normal CLI listings unless explicitly requested.
7. Strip all Tekrion grouping headers before forwarding or raw-header persistence. Snapshot capture bounds, supported transports, and endpoint normalizer versions in session metadata without secret values.
8. Provide `tekrion sessions` and `tekrion inspect <session>` as the M3 headless inspection surface. They read the WAL-backed local store safely and emit the stored canonical event contracts; authenticated browser query endpoints remain an M5 concern.

## Consequences

- Provider responses remain byte-faithful even when parsing fails, and every canonical event can be regenerated from immutable raw evidence.
- All M0 protocol fixtures share one default routing path, including malformed, incomplete, unknown, and missing-usage cases.
- Duplicate policy is explicit and testable instead of depending on accidental map or string-append behavior.
- Analysis calls cannot inflate or alter the investigated session's event stream when the reserved analysis signal is used.
- Heuristic grouping is visibly labeled in the session snapshot. Exact ancestry grouping requires a known response identifier, supplied by an adapter/control header; request-body ancestry is still normalized and labeled for later context reconstruction.
- The terminal inspection surface is intentionally bounded and read-only. Pagination/live browser APIs follow in M5.
