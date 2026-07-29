# Adapter authoring for Tekrion 0.1

Tekrion 0.1 includes a small, protocol-level adapter foundation for clients that can configure an OpenAI-compatible or Anthropic Messages base URL and attach stable session identity. It does not yet expose a public custom-event ingestion API, and the repository does not bundle an L3 agent-event adapter.

This distinction matters: an adapter can make API exchanges belong to the correct investigation and label that observation boundary accurately, but it must not claim that Tekrion observed an agent-internal tool event unless that event also crossed a supported API, process, or filesystem boundary.

## When an adapter is useful

Use an adapter when an agent or framework:

- supports OpenAI Responses, OpenAI Chat Completions, or Anthropic Messages
  over HTTP JSON or SSE;
- allows its provider base URL to point at the Tekrion proxy;
- has its own stable run, thread, or conversation identifier;
- cannot be launched through `tekrion run`, or benefits from more reliable session grouping than the idle-window heuristic.

Prefer `tekrion run -- <command>` when Tekrion should also capture process and workspace evidence. The built-in wrapper provides the richest supported 0.1 experience without requiring agent-specific code.

## Supported integration boundary

An adapter performs three jobs:

1. ensure the local Tekrion daemon is running;
2. point the client at the printed proxy base URL;
3. attach a stable Tekrion session signal to every supported provider request.

The proxy removes Tekrion control headers before forwarding traffic upstream and excludes them from persisted request headers. The provider therefore does not receive Tekrion session metadata, while the raw exchange remains correlated to the selected local session.

The adapter must preserve the caller's request and response behavior. It must not parse and re-emit SSE, rewrite request bodies, consume response streams, or retry requests on Tekrion's behalf.

## Session signals

Header names are case-insensitive. Their precedence is deliberate and tested.

| Priority | Header                        | Intended producer                                                      | Behavior                                                                                                                                              |
| -------- | ----------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1        | `X-Tekrion-Session`           | `tekrion run` or a controller that already owns the Tekrion session ID | Uses that validated ID directly. It overrides adapter and ancestry signals.                                                                           |
| 2        | `X-Tekrion-Agent-Session`     | Agent-specific adapter                                                 | Maps a stable external run/thread key to a deterministic local session and creates an `adapter` capture-level session when it is the deciding signal. |
| 3        | `X-Tekrion-Response-Ancestor` | Adapter with known response ancestry                                   | Continues a session previously associated with one of the comma-separated response IDs.                                                               |
| 4        | `X-Tekrion-Client-Id`         | Client integration                                                     | Improves bounded idle-window grouping when no stronger signal is present.                                                                             |

If no explicit, adapter, or known-ancestry signal resolves, Tekrion falls back to a short client idle window and finally to a manual session.

`X-Tekrion-Analysis-Session` and `X-Tekrion-Analysis-Target` are reserved for Tekrion's isolated optional-analysis traffic. Third-party adapters must not set them.

### Choosing an identifier

Use an opaque, stable identifier that is unique within the integration's real scope, for example `agent-name:workspace-id:run-id`. Do not include API keys, cookies, access tokens, prompt text, source code, personal data, or provider credentials.

`X-Tekrion-Session` values must be between 1 and 512 characters. Adapter mapping keys must contain between 1 and 4,096 characters, but short identifiers are strongly preferred. A repeated adapter key maps to the same deterministic Tekrion session, including after daemon restart.

## Header-based example

The following example assumes the daemon reported `http://127.0.0.1:4141` as its proxy origin:

```js
const proxyOrigin = "http://127.0.0.1:4141";
const agentSessionId = "example-agent:workspace-42:run-7";

const response = await fetch(`${proxyOrigin}/v1/responses`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    "content-type": "application/json",
    "x-tekrion-agent-session": agentSessionId,
  },
  body: JSON.stringify({
    model: "configured-model",
    input: "Inspect the failing test.",
  }),
});
```

Authorization, `x-api-key`, `ChatGPT-Account-ID`, and cookie headers are
forwarded in memory so the provider request still works, but Tekrion's
protocol schema and persistence boundary reject them from stored header
evidence.

## Session-scoped base URL

Some clients accept a base URL but cannot attach a custom header. For a controller-owned Tekrion session ID, use the session-scoped proxy route:

```text
http://127.0.0.1:4141/.tekrion/session/<base64url-utf8-session-id>/v1
```

For example:

```js
const sessionId = "session-controller-run-7";
const encoded = Buffer.from(sessionId, "utf8").toString("base64url");
const baseURL = `http://127.0.0.1:4141/.tekrion/session/${encoded}/v1`;
```

Tekrion decodes the route locally, validates the session ID, removes the private prefix, and forwards the request to the ordinary upstream `/v1/...` path. A request that supplies both this route and a conflicting `X-Tekrion-Session` header is rejected.

Anthropic clients expect a base URL before `/v1`, so use the same route without
the final `/v1`:

```text
http://127.0.0.1:4141/.tekrion/session/<base64url-utf8-session-id>
```

## Capture-level and evidence rules

An adapter integration must follow these semantics:

- use `X-Tekrion-Agent-Session` when the adapter's identity is the strongest available grouping signal;
- describe the resulting session as capture level `adapter`, not as a confidence score;
- treat API-derived canonical events as observed only at the proxy boundary;
- use `exact-adapter` timing only in a future supported event-ingestion contract for an event the adapter directly observed;
- never claim access to provider-hidden prompts, remote tool state, private reasoning, or chain of thought;
- keep inferred conclusions separate from raw and deterministically derived evidence.

Tekrion 0.1 does not accept arbitrary adapter-emitted canonical events. Do not write directly to its SQLite database or blob directory. Those are private storage implementation details protected by schema, migration, provenance, and sequence invariants.

## Lifecycle guidance

An adapter should:

1. run `tekrion doctor` during setup and report unsupported transports clearly;
2. start or reuse the daemon through the CLI rather than spawning internal package files;
3. read the proxy origin from normal CLI/status output, never the private control token;
4. configure only the agent's provider base URL—do not replace Tekrion's
   upstream with `OPENAI_BASE_URL` or `ANTHROPIC_BASE_URL`;
5. attach the same session signal to every request in one agent run;
6. let provider errors, cancellation, and streaming pass through unchanged;
7. stop attaching the signal when that agent run ends;
8. use `tekrion sessions`, `inspect`, `open`, or `report` to locate and verify the captured investigation.

The daemon and cockpit are loopback-only by default. An adapter must not expose either listener remotely, copy the control token into logs, or place it in a query string.

## Compatibility checklist

Before describing an integration as supported, test all applicable items:

- non-streaming Responses request and response;
- streaming Responses SSE without changed bytes or event order;
- Chat Completions JSON and SSE if the agent uses them;
- Anthropic Messages JSON and SSE if the agent uses them;
- provider 4xx/5xx responses;
- client cancellation and upstream disconnect behavior;
- repeated requests with one stable adapter session key;
- two concurrent runs with different keys and no cross-session evidence;
- a daemon restart followed by another request with the same stable key;
- confirmation that every `X-Tekrion-*` session header is absent upstream and from persisted raw headers;
- confirmation that credentials are absent from the database and blob store;
- accurate documentation of signals the adapter cannot observe.

Use local fake upstreams and deterministic fixtures for these checks. A live provider test may supplement them, but should not replace byte-level regression coverage.

## Current package status

`@tekrion/adapters` is intentionally a foundation marker in 0.1. It does not yet offer a stable adapter SDK. Consumers should integrate through the documented proxy/session protocol and avoid importing unpublished internals.

A future adapter SDK can add typed lifecycle helpers and explicit event ingestion only after its authentication, provenance, ordering, versioning, bounded-payload, and failure-isolation contracts are designed and tested.

## Related documentation

- [Capture model](capture-model.md)
- [Protocol support](protocol-support.md)
- [Privacy and data handling](privacy.md)
- [ADR 0003: byte-faithful proxy and local control](decisions/0003-byte-faithful-proxy-and-local-control.md)
- [ADR 0004: normalization and sessionization](decisions/0004-normalization-and-sessionization.md)
- [Contribution guide](../CONTRIBUTING.md)
