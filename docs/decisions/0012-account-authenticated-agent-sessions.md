# ADR 0012: Account-authenticated Codex and Claude sessions

- Status: Accepted
- Date: 2026-07-27
- Milestone: Production local-agent authentication interoperability

## Context

Codex and Claude Code can authenticate with either usage-billed API credentials
or a signed-in subscription account. Requiring a separate provider API key for
Black Box would break the native account experience and unnecessarily duplicate
credentials. Codex also prefers the Responses WebSocket transport when its
provider advertises support, while the recorder currently guarantees fidelity
only for HTTP JSON and SSE.

Codex sends both API-key and ChatGPT-account requests with an authorization
header. ChatGPT-account requests additionally carry a `ChatGPT-Account-ID`
header and use the `/backend-api/codex` provider path. Neither the authorization
value nor the account identifier belongs in durable evidence.

## Decision

1. Launch Codex with a temporary `blackbox_recorder` model provider supplied
   only through command-line configuration. The provider uses the
   session-scoped recorder URL, the Responses wire API,
   `requires_openai_auth = true`, and `supports_websockets = false`. Codex
   therefore reuses its active ChatGPT or API-key login and sends recordable
   HTTP traffic without changing the user's global configuration.
2. Mark default Codex wrapper sessions with the `codex-auth` upstream route.
   Classify each request in memory by the presence of a non-empty
   `ChatGPT-Account-ID` header. Route account traffic to
   `https://chatgpt.com/backend-api/codex/*`; route API-key traffic to
   `https://api.openai.com/v1/*`.
3. Keep an explicit `--upstream` or `BLACKBOX_UPSTREAM_URL` authoritative.
   Such a session uses direct routing and is never silently redirected to a
   first-party backend.
4. Continue launching Claude Code with a session-scoped `ANTHROPIC_BASE_URL`.
   Claude selects its credential according to its native precedence, so API
   keys, bearer tokens, CI OAuth tokens, and saved subscription OAuth remain in
   Claude's credential store and are forwarded only in memory.
5. Forbid `authorization`, `x-api-key`, `ChatGPT-Account-ID`, cookies, and proxy
   credentials at both the proxy filtering and durable protocol-schema
   boundaries. Add a forward migration that removes historically retained
   ChatGPT account identifiers from active raw-exchange records.
6. Limit the support statement to local CLI sessions launched through
   `blackbox run` and first-party OpenAI/Anthropic HTTP transports. Hosted web
   or cloud sessions do not traverse the localhost recorder. Bedrock, Vertex
   AI, Microsoft Foundry, Realtime, and other provider-native transports still
   require dedicated integrations.

## Consequences

- Interactive, non-interactive, resumed, and forked local Codex sessions work
  with either a ChatGPT plan or an API key without a Black Box credential.
- Local Claude Code sessions retain Claude's selected API-key or subscription
  authentication without a Black Box credential.
- The Codex wrapper deliberately uses HTTP even when the native provider can use
  WebSockets. Standalone WebSocket and Realtime clients remain unsupported.
- The account identifier is used transiently only as a routing signal and is
  absent from new durable evidence. A private pre-migration backup may retain a
  historical identifier and must be protected or retired under the operator's
  privacy policy.
- An explicit custom upstream remains compatible, but the operator is
  responsible for that gateway's path and authentication contract.
