# Protocol and transport support

Tekrion is an HTTP reverse proxy for OpenAI-compatible and Anthropic Messages clients. The proxy preserves response bytes while normalization creates a separate derived evidence layer; a parser failure does not rewrite a valid upstream response.

| Surface                                  | Forwarding  | Normalized evidence | Notes                                                        |
| ---------------------------------------- | ----------- | ------------------- | ------------------------------------------------------------ |
| `/v1/responses` JSON                     | Yes         | Yes                 | Request, output items, tool calls/results, errors and usage  |
| `/v1/responses` SSE                      | Yes         | Yes                 | Ordered chunks retained with byte-fidelity fixture coverage  |
| `/v1/chat/completions` JSON              | Yes         | Yes                 | Messages, choices, tool calls, errors and usage              |
| `/v1/chat/completions` SSE               | Yes         | Yes                 | Ordered streaming normalization                              |
| `/v1/messages` JSON                      | Yes         | Yes                 | Anthropic text, tool use/results, errors, stop reason, usage |
| `/v1/messages` SSE                       | Yes         | Yes                 | Anthropic message/content deltas and mid-stream errors       |
| Other HTTP `/v1/*` routes                | Yes         | Raw/unknown         | Forwarded when possible; no unsupported semantic claim       |
| Wrapped Codex Responses transport        | Yes         | Yes                 | Wrapper forces HTTP JSON/SSE for recorder fidelity           |
| Standalone WebSocket / Realtime          | No          | No                  | Upgrade requests are rejected explicitly                     |
| Bedrock, Vertex, or other native schemas | Not claimed | No                  | Require a dedicated protocol integration                     |

## Client setup

`tekrion run -- <command>` auto-detects direct `codex` and `claude` executables. Codex receives a temporary `tekrion_recorder` model provider and a session-scoped `OPENAI_BASE_URL` ending in `/v1`. The provider requires OpenAI authentication and disables WebSockets, so Codex reuses either its ChatGPT login or API-key login while sending recordable HTTP traffic. Claude receives a session-scoped `ANTHROPIC_BASE_URL` without the `/v1` suffix expected to be added by Anthropic clients, and continues using its native credential precedence. Use `--agent` when a common npm, pnpm, Yarn, or Bun package runner hides the real executable; opaque shell command strings cannot be rewritten safely.

Default Codex sessions select `https://api.openai.com/v1/*` for API-key requests and `https://chatgpt.com/backend-api/codex/*` for ChatGPT-account requests. Selection uses the account header in memory; the value is never persisted. Claude defaults to `https://api.anthropic.com`, and generic OpenAI-compatible clients use the daemon's configured upstream. `--upstream` and `TEKRION_UPSTREAM_URL` override automatic selection with a credential-free HTTP(S) origin. Each wrapped session stores its validated routing mode so differently configured clients can reuse one daemon without cross-provider routing.

For a separately managed client, run `tekrion start --upstream <provider-origin>` and configure the client with the printed base URL. This is L1/API capture: Tekrion cannot see out-of-band tool execution or file effects without the wrapper or an adapter.

Native Claude support covers the Anthropic Messages HTTP API with Claude-selected API-key, bearer-token, or subscription OAuth authentication. Claude Code configurations that use Bedrock, Vertex AI, Foundry, or another provider-native protocol are outside this boundary. Hosted web/cloud sessions and IDE sessions not launched through the wrapper cannot traverse a localhost CLI proxy. OpenAI Responses WebSocket/Realtime remains unsupported outside the HTTP-forced Codex wrapper.

## Fidelity and bounds

Hop-by-hop headers are removed as required for proxying. `authorization`, `x-api-key`, `ChatGPT-Account-ID`, cookies, proxy credentials, and configured sensitive headers are forwarded in memory when needed but excluded from persisted header evidence. Existing stores are migrated to scrub historically retained `x-api-key` and ChatGPT account-identifier fields. The upstream response body is passed through unchanged. Capture queues, request/response body sizes and stream-manifest entries are bounded. If a bound, disconnect, crash or storage failure prevents a complete recording, the raw exchange is retained as incomplete rather than represented as complete.

Run `tekrion doctor` to inspect the selected upstream, listeners, storage, quota and known WebSocket limitation before a live capture.
