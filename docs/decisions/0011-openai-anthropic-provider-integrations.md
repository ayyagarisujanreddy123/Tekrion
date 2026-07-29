# ADR 0011: First-class OpenAI and Anthropic provider integrations

- Status: Accepted; authentication routing extended by
  [ADR 0012](0012-account-authenticated-agent-sessions.md)
- Date: 2026-07-23
- Milestone: Production provider interoperability

## Context

The original recorder normalized OpenAI Responses and Chat Completions and
injected `OPENAI_BASE_URL` into wrapped processes. That provided generic wrapper
evidence for Claude Code but not semantic evidence from its native Anthropic
Messages traffic. Current Codex configuration also exposes a one-run
`openai_base_url` override, so relying only on an environment variable is not a
complete launch integration.

A long-running local daemon must be able to serve both providers without sending
one session's request to another session's upstream. Anthropic commonly uses the
`x-api-key` credential header, which must never enter durable evidence.

## Decision

1. Treat direct `codex` and `claude` executables as first-class L2 launch
   integrations. Allow an explicit `--agent` selection when another launcher
   hides the executable.
2. Give Codex a session-scoped `OPENAI_BASE_URL` and one-run
   `openai_base_url` CLI override. Give Claude a session-scoped
   `ANTHROPIC_BASE_URL`. Do not edit either agent's global configuration.
3. Pin a validated upstream origin on every wrapped session. Resolve a
   session-scoped proxy route against that active session's upstream instead of
   the daemon's default, while retaining the configured default for standalone
   proxy traffic.
4. Normalize Anthropic `/v1/messages` JSON and SSE natively. Preserve raw bytes
   independently; map text, tool use/results, errors, stop state, and usage to
   canonical events; retain unknown blocks visibly; and treat thinking blocks as
   opaque in normalized context.
5. Reconstruct Anthropic Messages context from the explicit `system`, `messages`,
   tools, results, and settings present in the captured request. Apply the same
   completeness and provider-managed-context rules used by other protocols.
6. Forward `x-api-key` only in memory, forbid it in the durable header schema,
   and migrate active databases to scrub historically retained fields. Preserve
   normal migration-backup semantics and disclose that the backup can retain the
   pre-migration bytes.
7. Keep Bedrock, Vertex, OpenAI WebSocket/Realtime, and other provider-native
   transports outside this support claim until each has a dedicated transport
   and normalization contract.

## Consequences

- Codex and Claude Code can produce API, process, and workspace evidence through
  one wrapper and one daemon when they use the supported HTTP provider paths.
- Provider selection is explicit and testable instead of inferred from payload
  shape or a daemon-wide mutable upstream.
- Native Anthropic semantics remain intact; Tekrion does not translate Claude
  traffic into an OpenAI request shape.
- An older database may create a private migration backup containing an
  `x-api-key` value that the active store has scrubbed. Operators must protect or
  retire that backup and rotate affected credentials when appropriate.
- Account-authenticated local CLI routing is defined by ADR 0012. Unsupported
  cloud-provider protocols are still not implied by the Codex/Claude CLI
  integration labels.
