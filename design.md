# Tekrion: Product and Technical Design

Status: implementation-ready design

Version: 0.1

Last updated: 2026-07-28

Target: OpenAI Build Week 2026, Developer Tools track

## 1. Executive decision

Tekrion will be a **terminal-first local application with a browser-based cockpit**, not a hosted SaaS product and not a native desktop application for the first release.

The user installs one CLI and uses it in either of two ways:

```bash
# Lowest-friction API recording
tekrion start
export OPENAI_BASE_URL=http://127.0.0.1:4141/v1
my-agent

# Recommended: API recording plus process and filesystem evidence
tekrion run -- my-agent
```

The CLI starts a local recorder daemon, stores recordings in SQLite, and serves a React viewer on localhost. `tekrion open` opens that viewer. This form fits a developer workflow better than a desktop shell, avoids Electron/Tauri packaging work during Build Week, works in local terminals and CI, and still permits a rich timeline UI. A native wrapper can be added later without changing the recorder, data model, or UI.

The product's wedge is not generic LLM observability. Existing products already trace model calls, tools, evaluations, and prompt experiments. Tekrion is specifically an **investigation tool for coding-agent incidents**:

- capture with minimal integration;
- preserve raw, replayable evidence locally;
- reconstruct what client-visible context preceded an action;
- connect model requests to tool outputs and filesystem changes;
- explain a suspicious action with cited evidence and uncertainty;
- produce a post-mortem that distinguishes fact from inference.

## 2. Product thesis

### 2.1 Problem

Coding agents operate across long, stateful loops. A developer may see the final diff but not the sequence of inputs, tool calls, errors, retries, and context changes that produced it. Ordinary logs are fragmented across an agent, model provider, terminal, and filesystem. When a destructive or surprising change occurs, the investigator needs a synchronized record rather than another speculative model answer.

### 2.2 Product promise

> Tekrion records the client-visible decisions and effects of an AI coding session, then lets a developer replay the evidence and build an attributable explanation of a bad action.

This wording is intentionally narrower than “records the model's reasoning.” Hidden chain-of-thought and provider-internal instructions are neither exposed by the API nor required for a useful audit. Tekrion records observable inputs, outputs, actions, results, timings, and state changes.

### 2.3 Primary user

The initial user is a developer running an OpenAI-compatible coding agent locally who has permission to inspect the repository and API traffic. Secondary users are agent-framework authors and teams debugging an incident from an exported recording.

### 2.4 Jobs to be done

1. “Show me exactly what was sent and returned before this file was deleted.”
2. “Tell me whether this action followed my request, a repository instruction, a tool result, or an error-recovery loop.”
3. “Let me replay the session without rerunning the destructive commands.”
4. “Give me an evidence-linked incident summary I can share with my team.”
5. “Do all recording locally, with explicit control over anything sent for AI analysis.”

### 2.5 Non-goals for v0.1

- Capturing private chain-of-thought or provider-hidden system instructions.
- Preventing an agent from taking actions. Tekrion is initially a recorder, not a policy enforcement gateway.
- Perfect causal proof. Blame is an evidence-backed hypothesis with confidence and alternatives.
- Supporting every model provider and every agent protocol during Build Week.
- Re-executing arbitrary tool calls during replay.
- Multi-user cloud hosting, authentication, billing, or enterprise retention.
- Replacing general-purpose observability suites, prompt-management systems, or evaluation platforms.

## 3. Research findings and implications

### 3.1 API shape is event-oriented and state may be remote

OpenAI's Responses API streams typed semantic events, while Chat Completions streams incremental `delta` chunks. Function calls also have argument-delta and completion events. The normalizer therefore needs endpoint-specific streaming parsers while the proxy must preserve the original byte stream. [OpenAI streaming guide](https://developers.openai.com/api/docs/guides/streaming-responses) and [Responses migration guide](https://developers.openai.com/api/docs/guides/migrate-to-responses).

Responses can carry state through `previous_response_id` or durable Conversation objects rather than resending the full history. A proxy can record IDs and observed predecessor responses, but it cannot claim to know provider-side compaction or hidden state. [OpenAI conversation-state guide](https://developers.openai.com/api/docs/guides/conversation-state).

The OpenAI Agents SDK already provides traces for generations, tool calls, handoffs, guardrails, and custom events. That validates the need, but also means Tekrion must differentiate on local capture, coding-specific filesystem evidence, context time travel, and incident attribution rather than “we show traces.” [OpenAI Agents SDK tracing guide](https://openai.github.io/openai-agents-js/guides/tracing/).

### 3.2 The observability category is crowded

Arize Phoenix, LangSmith, and related tools already provide broad LLM tracing and evaluation. Phoenix accepts OpenTelemetry traces and covers model calls, retrieval, tools, prompt iteration, and experiments. Tekrion should adopt interoperable concepts but remain optimized for a local forensic workflow. [Phoenix documentation](https://arize.com/docs/phoenix) and [LangSmith product overview](https://www.langchain.com/langsmith-platform).

OpenTelemetry defines shared semantic naming, including GenAI operation, conversation, tool, and usage attributes, but GenAI conventions are still evolving. Tekrion should keep its own versioned canonical event schema and offer OpenTelemetry import/export at the boundary instead of making an unstable convention its database schema. [OpenTelemetry semantic conventions](https://opentelemetry.io/docs/specs/semconv/) and [GenAI attribute registry](https://opentelemetry.io/docs/specs/semconv/registry/attributes/gen-ai/).

### 3.3 Prompt injection is a credible demo, not a solved classifier problem

OWASP explicitly identifies code comments and documentation as indirect prompt-injection carriers. It also recommends comparing proposed actions with original user intent and warns that pattern matching alone is insufficient. That supports the README demo and the planned combination of deterministic provenance with a model-based judge. [OWASP prompt-injection prevention](https://cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html).

Tekrion must not imply that its blame output proves an injection caused an action. It should show the suspicious source, the propagation path, the action, competing explanations, and confidence.

### 3.4 SQLite fits the local write/read workload

SQLite WAL mode allows readers to continue while commits are appended, which matches a recorder writing while a viewer reads. FTS5 provides local full-text search, and current SQLite builds include JSON functions by default. [SQLite WAL](https://www.sqlite.org/wal.html), [SQLite FTS5](https://sqlite.org/fts5.html), and [SQLite JSON](https://www.sqlite.org/json1.html).

## 4. Honesty contract: what Tekrion can and cannot know

Trust requires precise labels in both documentation and UI.

### 4.1 Capture levels

| Level | Setup | Reliably captured | Not guaranteed |
|---|---|---|---|
| L1: API | `tekrion start` + configurable base URL | HTTP request/response bytes, supported SSE events, model output items, proposed function calls, later-submitted function results, provider errors, usage reported by provider | Tool execution timing, out-of-band tool calls, file mutations, terminal subprocesses |
| L2: Wrapped process | `tekrion run -- <agent>` | L1 plus command metadata, exit state, stdout/stderr timing, repository baseline/final diff, filesystem observations | Rich semantic name/result for agent-internal tools unless visible in API or process adapter |
| L3: Adapter/hook | agent-specific opt-in | L2 plus tool lifecycle, cwd, command, file paths, approval events, agent session IDs, exact file-read provenance when the agent exposes it | Provider-hidden prompt and private model reasoning |

The viewer displays the active capture level and missing signals. It never silently presents an inferred event as observed.

### 4.2 Context completeness labels

Each model invocation receives one of these labels:

- **Exact client request**: full request body was captured and all context was sent explicitly in that request.
- **Reconstructed client chain**: request used `previous_response_id` or a conversation ID and all referenced predecessors are available locally; reconstruction follows documented client-visible semantics.
- **Partial client chain**: one or more referenced predecessors are absent.
- **Provider-managed context**: server compaction, hosted tools, or other remote state makes the complete effective context unavailable.
- **Unknown/unsupported**: endpoint or payload was not understood; raw evidence remains available.

Every context view includes the permanent note: “Provider-hidden instructions and internal reasoning are outside the API-visible record.”

### 4.3 Observed versus inferred

All facts in the UI and reports carry provenance:

- `observed`: directly present in captured bytes, process events, or filesystem snapshots;
- `derived`: deterministic transformation, such as duration, diff, request ancestry, or loop count;
- `inferred`: semantic match or model judgment;
- `unknown`: missing or contradictory evidence.

## 5. Experience design

### 5.1 CLI commands

```text
tekrion init                 create config and verify local prerequisites
tekrion start               start recorder/viewer daemon
tekrion stop                stop the daemon cleanly
tekrion status              show ports, database, active sessions, capture health
tekrion run -- <cmd...>      start daemon if needed, inject config, monitor command
tekrion open [session-id]    open local cockpit
tekrion sessions            list recent recordings
tekrion inspect <session>    terminal summary for headless use
tekrion report <session>     run deterministic report; --ai opts into model analysis
tekrion export <session>     create portable redacted .tkr archive
tekrion import <archive>     import an archive as read-only evidence
tekrion doctor               test endpoint, streaming, storage, permissions, redaction
tekrion demo rogue           run the deterministic showcase fixture
```

Default bind addresses are `127.0.0.1:4141` for the OpenAI-compatible proxy and `127.0.0.1:4142` for the viewer/API. LAN binding requires an explicit flag and a warning.

`tekrion run` is the recommended onboarding path because it avoids persistent shell mutation:

```bash
tekrion run --env OPENAI_BASE_URL=http://127.0.0.1:4141/v1 -- npm run agent
```

For known agents, adapters can supply the appropriate environment variable or config flag. Unknown commands receive the standard OpenAI base URL and a clear compatibility result from `doctor`.

### 5.2 Cockpit information architecture

1. **Session list**: status, start time, duration, agent/command, model, event count, file-change count, errors, anomaly score.
2. **Timeline**: synchronized lanes for conversation/model calls, tools, filesystem/process effects, errors, and token/context pressure.
3. **Inspector**: raw payload, normalized representation, timestamps, source, redaction state, correlation IDs.
4. **Context**: ordered client-visible items for a selected invocation, ancestry graph, completeness label, token usage and estimated pressure.
5. **Blame**: target action, ranked candidate origins, propagation graph, evidence excerpts, alternative hypotheses, confidence.
6. **Incident report**: timeline summary, impact, root-cause hypothesis, contributing conditions, evidence links, prevention steps.

### 5.3 Timeline behavior

- Horizontal time scale with zoom, pan, keyboard navigation, and “fit session.”
- Virtualized event rendering; do not render thousands of DOM nodes at once.
- Live mode follows new events until the user manually scrubs backward.
- Dense model deltas are collapsed into one logical output event; raw chunks remain inspectable.
- Tool call and matching result are visually connected by `call_id` when available.
- File changes link to before/after snippets and the nearest preceding action.
- Errors and retries remain separate events rather than being overwritten by a final success.
- Context pressure is based on provider-reported input tokens when present; estimates are visually marked and never combined with exact counts without labeling.

### 5.4 Demo story

The demo must be deterministic, short, and safe:

1. A disposable fixture repository contains a test suite and a README line instructing agents to remove “outdated” tests.
2. The user asks a small demo agent to fix a build error.
3. The agent reads the README, issues a file-deletion tool call, and receives a successful tool result.
4. Tekrion shows the live event sequence and resulting diff.
5. Selecting the deletion opens Blame, where a deterministic content-overlap/provenance path ranks the README line first.
6. Optional AI analysis turns that evidence into a structured explanation while explicitly marking it inferred.
7. The incident report recommends instruction/data separation, action approval for deletion, and scope checks against the original request.

The demo agent should use fixture responses by default, with a `--live` mode for a real API. This avoids a stage demo depending on model nondeterminism or network availability.

## 6. System architecture

```text
                         localhost only
┌─────────────┐   HTTP/SSE   ┌───────────────────────────────────────┐
│ Coding agent├─────────────►│ Tekrion daemon                      │
└──────┬──────┘              │                                       │
       │ tool/process         │  proxy ─► raw journal ─► normalizer   │
       ▼                      │    │                         │          │
┌─────────────┐              │    └────────► upstream API  ▼          │
│ Workspace   │◄─ monitor ───│                      SQLite + blobs    │
└─────────────┘              │                              │          │
                             │  local API / live event stream│         │
┌─────────────┐   HTTP/WS    │                              ▼          │
│ React UI    │◄─────────────┤                        analysis engine  │
└─────────────┘              └───────────────────────────────────────┘
```

### 6.1 Components

#### CLI

Owns lifecycle, configuration, process wrapping, adapter selection, export/import, and terminal summaries. It communicates with the daemon through a localhost control API and a per-user auth token stored with restrictive permissions.

#### Recorder proxy

An OpenAI-compatible reverse proxy that:

1. accepts the incoming request;
2. assigns a request and session correlation ID;
3. strips hop-by-hop headers and never persists authorization/cookies;
4. journals request metadata/body after redaction policy is applied;
5. forwards method, path, query, supported headers, and body upstream;
6. streams response bytes to the caller with minimal buffering;
7. tees bounded chunks to an asynchronous journal;
8. records completion, disconnect, timeout, and upstream error states;
9. schedules normalization off the response critical path.

Raw pass-through fidelity is the priority. Parser failure must not corrupt or delay a valid upstream exchange. Unsupported `/v1/*` routes are transparently forwarded and recorded as `unknown_api_exchange` where feasible.

#### Process/filesystem observer

`tekrion run` records command, arguments (with configurable redaction), cwd, repository root, PID, start/end, exit code, signals, and timestamped stdout/stderr frames. It takes a Git-aware baseline and final state:

- tracked changes: `git diff --binary` plus metadata;
- untracked files: path, size, hash, and content only below configured size/sensitivity limits;
- non-Git directory: manifest of paths, sizes, mtimes, and hashes with bounded content capture.

The Build Week version may compute the authoritative diff at session end and use a debounced filesystem watcher only for approximate change timing. Later adapters or OS-level observation can increase timing precision. The UI must distinguish `observed_at` from an exact mutation timestamp.

#### Normalizer

Consumes raw exchanges and emits canonical events. Endpoint parsers are plugins:

- `/v1/responses` JSON and typed SSE;
- `/v1/chat/completions` JSON and SSE deltas;
- unknown route fallback;
- later: WebSocket Responses, Realtime, Anthropic-compatible APIs, and OTLP ingestion.

The normalizer is idempotent. Reprocessing the same raw exchange with a newer parser writes a new normalization version without altering original evidence.

#### Local query API

Provides paginated session/event queries, payload retrieval, full-text search, context reconstruction, blame/report jobs, health, and a live event channel. It is never exposed outside loopback by default. Mutating endpoints require the control token and origin checks.

#### Viewer

A React/Vite single-page application bundled into the CLI package and served by the daemon. It never talks directly to SQLite or the upstream provider.

#### Analysis engine

Runs deterministic detectors locally and optional model-based analyses. It uses a provider interface so analysis can target OpenAI or, later, a local model. Model calls are themselves recorded in a separate internal analysis session to avoid contaminating the investigated session.

### 6.2 Recommended stack

| Layer | Choice | Reason |
|---|---|---|
| Runtime | Node.js 22+ and TypeScript | Shared language across CLI, proxy, schemas, and UI; strong streaming ecosystem |
| Monorepo | npm workspaces | Matches the advertised `npm install`; no extra package-manager requirement |
| CLI | Commander or Citty | Small, testable command surface |
| Proxy | Node HTTP server + Undici | Direct stream control and low transformation risk |
| Local API | Fastify | Schema validation, plugin boundaries, good TypeScript support |
| Storage | SQLite via `better-sqlite3` | Reliable local database and simple transactions; native builds must be tested in release packaging |
| Validation | Zod + JSON Schema export | One canonical runtime/type contract |
| UI | React, Vite, TanStack Query, Zustand | Fast local development and separable server/client state |
| Timeline | Canvas for marks + DOM inspector | Performance for dense sessions without sacrificing accessible detail panels |
| Tests | Vitest, Playwright, Node test fixtures | Unit, protocol, and end-to-end coverage |
| Logging | Pino structured logs | Low overhead and machine-readable diagnostics |

Avoid Electron/Tauri, Redis, Postgres, Docker, Kafka, and a vector database in v0.1. Each adds operational cost without helping the local single-user demo.

### 6.3 Repository layout

```text
tekrion/
  apps/
    cli/                 command entry point and process wrapper
    daemon/              proxy, local API, lifecycle
    viewer/              React cockpit
    demo-agent/          deterministic and live rogue demo
  packages/
    protocol/            versioned event types and Zod schemas
    storage/             migrations, repositories, blob codec
    normalizers/         Responses and Chat Completions parsers
    context/             ancestry and context reconstruction
    analysis/            detectors, blame, report schemas
    adapters/            agent-specific hooks/config
    test-fixtures/       golden requests, SSE streams, corrupt cases
  demo/
    rogue-repo-template/
  docs/
  design.md
  plan.md
```

## 7. Data design

### 7.1 Principles

- Append-only evidence; derived views may be rebuilt.
- Raw and normalized representations are separate.
- Monotonic sequence numbers establish local order; wall-clock timestamps support display.
- Large payloads are content-addressed and compressed outside hot query rows.
- Redaction happens before durable storage when configured; authorization secrets are never stored.
- Every schema and normalization carries a version.
- A malformed or future event can be preserved without being understood.

### 7.2 Canonical event envelope

```ts
type EvidenceKind = "observed" | "derived" | "inferred" | "unknown";

interface TekrionEvent<T = unknown> {
  id: string;                 // UUIDv7
  sessionId: string;
  parentId?: string;
  correlationId?: string;    // request ID, call_id, process ID, etc.
  sequence: number;           // strict per-session ordering
  occurredAt: string;         // source/wall time
  observedAt: string;         // recorder time
  durationMs?: number;
  source: "proxy" | "process" | "filesystem" | "adapter" | "analysis";
  type: string;               // e.g. model.request, tool.call, file.change
  evidence: EvidenceKind;
  schemaVersion: number;
  payloadRef?: string;
  summary: Record<string, unknown>;
  redaction: { applied: boolean; ruleIds: string[] };
}
```

### 7.3 Core tables

```text
sessions
  id, started_at, ended_at, status, capture_level, command, cwd,
  repo_root, agent_name, models_json, upstream_origin, tags_json,
  event_count, error_count, input_tokens, output_tokens, metadata_json

raw_exchanges
  id, session_id, sequence, protocol, method, path, query_json,
  request_headers_json, request_blob_id, response_status,
  response_headers_json, response_blob_id, stream_manifest_blob_id,
  started_at, first_byte_at, ended_at, outcome, parse_status

events
  id, session_id, parent_id, correlation_id, sequence, occurred_at,
  observed_at, duration_ms, source, type, evidence, schema_version,
  payload_blob_id, summary_json, redaction_json

blobs
  id, sha256, codec, media_type, byte_length, stored_length,
  inline_data_or_path, created_at

context_edges
  session_id, from_event_id, to_event_id, edge_type, evidence,
  metadata_json

file_changes
  event_id, path, operation, before_hash, after_hash, patch_blob_id,
  timing_precision, sensitivity

analysis_runs
  id, session_id, kind, target_event_id, status, analyzer,
  prompt_version, started_at, ended_at, result_blob_id, error

redactions
  id, session_id, location, rule_id, replacement, hash

event_search (FTS5)
  event_id, session_id, type, text

schema_migrations
  version, applied_at, checksum
```

### 7.4 Event taxonomy

Initial canonical types:

- `session.started`, `session.ended`, `session.crashed`;
- `process.started`, `process.stdout`, `process.stderr`, `process.exited`;
- `model.request`, `model.response.started`, `model.output.delta`, `model.response.completed`, `model.usage`;
- `message.user`, `message.developer`, `message.system`, `message.assistant`;
- `tool.call`, `tool.result`, `tool.error`;
- `file.read`, `file.change`, `file.delete`, `workspace.snapshot`;
- `api.error`, `transport.error`, `parser.error`;
- `context.compacted`, `context.pressure`;
- `approval.requested`, `approval.resolved`;
- `analysis.anomaly`, `analysis.blame`, `analysis.report`.

Internal multi-agent or hosted-tool events are preserved by concrete subtype in `summary` rather than flattened into a misleading “message.”

### 7.5 Sessionization

Priority order:

1. explicit `X-Tekrion-Session` injected by `tekrion run` or an adapter;
2. adapter-provided agent session ID;
3. OpenAI conversation or response ancestry identifiers;
4. short idle-window heuristic keyed by process/client fingerprint;
5. manually assigned session.

Heuristic grouping is visibly marked and can be corrected without rewriting raw exchanges.

### 7.6 Payload and stream storage

The proxy writes an ordered chunk journal containing direction, monotonic offset, byte offset, and arrival time. It also assembles the final response body for parsing. Small blobs may be stored inline; large blobs are zstd-compressed content-addressed files below the data directory. Atomic rename prevents partially written final blobs.

Defaults:

- 16 MiB maximum JSON body recorded in full;
- 64 MiB maximum assembled stream, with chunk manifest retained if truncation occurs;
- 256 KiB maximum individual stdout/stderr frame;
- 1 MiB maximum untracked file content;
- configurable session and total-disk limits;
- no silent deletion: retention jobs create an audit entry.

## 8. Proxy and protocol behavior

### 8.1 Upstream configuration

Tekrion must not reuse `OPENAI_BASE_URL` as its upstream because the CLI sets that variable to the proxy. Use a separate value:

```toml
[proxy]
listen = "127.0.0.1:4141"
upstream = "https://api.openai.com"
```

Precedence: CLI flag, `TEKRION_UPSTREAM_URL`, project config, user config, default OpenAI origin.

### 8.2 Header policy

- Forward authorization in memory but never persist it.
- Drop hop-by-hop headers (`connection`, `transfer-encoding`, etc.) and let the HTTP stack regenerate them.
- Preserve provider request IDs, rate-limit headers, content type, cache metadata, and relevant organization/project response headers.
- Redact cookies and configured sensitive headers.
- Add `X-Tekrion-Request-Id` upstream only if it cannot break signature/auth schemes; otherwise retain correlation locally.

### 8.3 Failure policy

- **Fail open for recording failures** by default: if SQLite normalization fails after safe journaling, forward valid provider traffic and surface a health error.
- **Fail closed for unsafe configuration**: invalid upstream URL, attempted proxy loop, non-loopback bind without explicit consent, or unavailable required redaction policy.
- Client disconnect cancels upstream work unless configured otherwise and records who disconnected first.
- Timeouts are configurable but default to upstream/client behavior rather than an arbitrary short proxy timeout.
- Recorder backpressure has bounded memory. If the journal cannot keep up, mark payload capture incomplete rather than exhaust memory.

### 8.4 Compatibility boundary

Build Week v0.1 supports HTTP JSON and SSE for `/v1/responses` and `/v1/chat/completions`. Responses WebSocket mode and Realtime are explicit post-MVP items. `tekrion doctor` probes the selected client and reports unsupported transport before a real session.

The marketing phrase “any agent” should be replaced for v0.1 with “OpenAI-compatible agents that allow a custom base URL.” Agent-specific adapters can expand that boundary.

## 9. Context reconstruction

### 9.1 Algorithm

For each `model.request`:

1. Parse explicit instructions, messages/items, tool definitions, tool outputs, model settings, and context-management fields.
2. Resolve `previous_response_id`, conversation ID, and locally observed response ancestry.
3. Walk backward with cycle detection and a maximum depth.
4. Apply documented ordering semantics without inventing missing items.
5. Preserve reasoning items as opaque observable items when returned; never manufacture reasoning text.
6. Annotate each item with source exchange/event and evidence kind.
7. calculate reported input tokens and a separate estimate only when needed.
8. assign a context completeness label and list reasons.

### 9.2 Context pressure

Use provider-reported usage as authoritative when present. An estimated tokenizer count is model/version-dependent and may diverge, so the UI shows:

```text
Reported input: 82,140 tokens
Known model limit: 114,688 tokens (metadata snapshot date shown)
Pressure: 71.6%
```

If the model limit is unknown or pricing/model metadata is stale, show token count without a percentage. No live pricing lookup is required for v0.1.

## 10. Blame and incident analysis

### 10.1 Definition

Blame is a ranked, auditable explanation of which prior evidence most plausibly influenced a selected target action. It is not a mind-reading feature and does not expose chain-of-thought.

### 10.2 Pipeline

1. **Target normalization**: derive action verb, resource/path, arguments, scope, timestamp, result, and impact.
2. **Candidate window**: collect preceding user/developer/system messages, tool results, file reads, errors, assistant plans, and context transitions actually available to the target invocation.
3. **Hard provenance edges**: match request ancestry, `call_id`, content hashes, path references, quoted substrings, file-read line ranges, and tool-result inclusion.
4. **Local ranking**: score recency, lexical overlap, path/entity overlap, instruction-like language, contradiction with original request, and propagation depth.
5. **Optional semantic ranking**: embeddings improve recall but cannot establish causation. Cache vectors locally and make the endpoint/model explicit.
6. **Optional structured judge**: send only a redacted evidence bundle and require JSON containing hypothesis, evidence IDs, counterevidence, alternatives, confidence, and uncertainty.
7. **Verification**: reject citations to nonexistent events, future events, or text not present in evidence. Cap confidence when the context is incomplete.
8. **Presentation**: show deterministic paths first, model narrative second.

Example score (tunable, not presented as probability):

```text
score = 0.30 * provenance
      + 0.20 * lexical_or_semantic_similarity
      + 0.15 * entity_and_path_overlap
      + 0.15 * intent_conflict
      + 0.10 * instruction_likelihood
      + 0.10 * recency_decay
```

### 10.3 Blame result schema

```ts
interface BlameResult {
  targetEventId: string;
  conclusion: string;
  confidence: "low" | "medium" | "high";
  confidenceReasons: string[];
  primaryOrigin?: {
    eventId: string;
    excerpt: string;
    location?: { path: string; startLine: number; endLine: number };
  };
  propagation: Array<{ from: string; to: string; relation: string }>;
  evidence: Array<{ eventId: string; supports: string }>;
  counterevidence: Array<{ eventId: string; weakens: string }>;
  alternatives: Array<{ explanation: string; evidenceIds: string[] }>;
  limitations: string[];
}
```

“High” confidence requires at least one hard provenance edge and complete relevant client context. Semantic similarity alone can never exceed “medium.”

### 10.4 Anomaly detectors

Start with transparent local rules:

- destructive operation not named or implied by the user request;
- write/delete outside repository root or configured scope;
- unexpected test/config/lockfile deletion;
- repeated identical or near-identical tool calls;
- repeated error-retry loops;
- abrupt spike in errors, latency, output, or context size;
- action after instruction-like text arrived through untrusted file/tool content;
- tool call after context compaction or missing ancestry;
- successful command followed by continued repair attempts;
- secret-like material in prompts or tool output.

Each detector emits its rule ID, inputs, threshold, and explanation. The incident report groups signals; it does not add anomaly scores as though they were calibrated probabilities.

### 10.5 Incident report

The report contains:

1. scope and capture completeness;
2. concise impact statement;
3. factual timeline with event links;
4. primary root-cause hypothesis;
5. contributing conditions;
6. counterevidence and alternative explanations;
7. containment/recovery already observed;
8. prevention recommendations mapped to evidence;
9. analysis method, model/prompt version if used, and privacy disclosure.

Deterministic mode works entirely offline. `--ai` is opt-in and previews exactly what redacted evidence categories will be transmitted.

## 11. Privacy, security, and integrity

### 11.1 Threat model

Tekrion handles source code, prompts, tool output, file paths, environment-derived data, and API credentials. Relevant threats include:

- another local process reading the database or control API;
- browser cross-site requests against localhost;
- authorization or secrets accidentally persisted in payloads;
- malicious recorded content attacking the viewer through HTML/Markdown;
- prompt injection inside evidence manipulating the report analyzer;
- tampering with an exported incident;
- a proxy bug changing production API behavior;
- unbounded recordings filling disk.

### 11.2 Controls

- Bind only to loopback by default.
- Store data beneath the user data directory with `0700` directories and `0600` sensitive files.
- Use a random per-install control token, SameSite cookies or bearer auth, strict Origin validation, and a restrictive CSP.
- Render payloads as inert text; sanitize Markdown; never execute recorded HTML/scripts.
- Never persist `Authorization`, cookies, or proxy credentials.
- Apply built-in secret detectors for common key/token shapes and user-configurable JSONPath/header/path rules.
- Show redaction coverage and allow `strict`, `balanced`, or `raw-local` capture profiles.
- Treat all recorded text as untrusted data in analysis prompts, use structured outputs, and verify evidence citations after generation.
- Add per-session limits, disk quota, retention, and a visible degraded-capture state.
- Hash blobs and include a manifest of hashes in exports; optional signing is post-MVP.
- Disable telemetry by default. Tekrion must not phone home.

### 11.3 Privacy language

Approved claim:

> Recordings stay on your machine by default. Optional AI analysis sends only the redacted evidence you approve to the configured model provider.

Do not claim “nothing leaves your machine” while AI analysis is enabled.

### 11.4 Replay safety

v0.1 replay is visualization-only. If active replay is added later, it must default to a sandbox, replace mutation tools with mocks, require confirmation for network access, and clearly separate original evidence from replay-generated evidence.

## 12. Performance and reliability targets

Build Week acceptance targets on a developer laptop:

- proxy time-to-first-byte overhead: p95 under 20 ms excluding upstream latency;
- non-streaming proxy overhead: p95 under 5% for requests lasting at least 500 ms;
- no changed response body bytes in golden pass-through fixtures;
- no reordered SSE frames;
- viewer usable while recording 10,000 canonical events;
- session list loads under 500 ms for 1,000 local sessions;
- event page query under 200 ms for a 100,000-event session with indexes warm;
- crash leaves either committed raw evidence or an explicitly incomplete exchange;
- disk-full and database-lock errors do not deadlock the client request;
- secrets in headers have zero persistence in automated tests.

These are engineering objectives, not claims to publish until measured.

## 13. Configuration

Precedence: command flags > environment > nearest `.tekrion/config.toml` > user config > defaults.

```toml
version = 1

[proxy]
listen = "127.0.0.1:4141"
upstream = "https://api.openai.com"
http = true
websocket = false

[viewer]
listen = "127.0.0.1:4142"
open_browser = true

[capture]
profile = "balanced"          # strict | balanced | raw-local
stdout = true
filesystem = true
max_body_mib = 16
max_stream_mib = 64

[redaction]
enabled = true
replacement = "[REDACTED]"
env_name_patterns = ["*_TOKEN", "*_SECRET", "*_PASSWORD"]
json_paths = ["$.metadata.customer_email"]

[retention]
max_disk_gib = 5
max_age_days = 30

[analysis]
ai_enabled = false
provider = "openai"
model = ""                    # require explicit supported choice or documented default
send_raw_payloads = false
```

Configuration loaded for a session is snapshotted, with secret values removed, so later investigators can reproduce recorder behavior.

## 14. Accessibility and usability

- Full keyboard navigation for timeline selection and inspector tabs.
- Visible focus, semantic controls, and screen-reader summaries for canvas timeline events.
- Color is never the only distinction among event lanes or anomaly severity.
- Timestamps can toggle between relative, local absolute, and UTC.
- Large JSON has search, folding, copy-path, and bounded rendering.
- Redacted values are visibly marked rather than disappearing.
- Empty, incomplete, unsupported, and error states explain what evidence is missing and how to capture it next time.

## 15. Distribution and operation

### 15.1 Build Week

Run from source with Node and npm:

```bash
npm install
npm run build
npm run tekrion -- doctor
```

### 15.2 Public release

- Publish a signed npm package with a `tekrion` binary.
- Prebuild native SQLite bindings for supported Node/platform combinations or validate a fallback driver before release.
- Build the viewer into static assets included in the package.
- Add macOS, Linux, and Windows CI matrices.
- Offer `npx @tekrion/cli` for evaluation, while recommending a pinned installation for routine use.
- Do not require Docker.

Data directory defaults follow OS conventions and are shown by `tekrion status`. Database upgrades are backed up before migration. A newer database is opened read-only by an older CLI.

## 16. Metrics of success

### 16.1 Build Week demo

- Fresh setup to first recorded session in under three minutes.
- Demo reliably captures request, tool call, result, and file deletion.
- A viewer can select the deletion and reach the poisoned README line in no more than three interactions.
- Blame cites only real evidence and visibly states limitations.
- Incident report is understandable without reading raw JSON.
- Network can be disabled after fixture setup and deterministic analysis still works.

### 16.2 Early product validation

- At least 80% of invited users complete first recording without assistance.
- At least 70% correctly identify the cause in seeded incident tasks faster with Tekrion than with terminal logs and `git diff` alone.
- No critical proxy-fidelity or credential-persistence defect.
- Median recorder overhead stays below the stated internal target.
- Users report the completeness/evidence labels as understandable, not obstructive.

No usage analytics are collected by default. Research sessions use explicit consent and manually gathered results.

## 17. Risks and decisions

| Risk | Impact | Decision/mitigation |
|---|---|---|
| Proxy alone cannot see file effects | Core promise becomes misleading | Recommend `tekrion run`; show capture level; add adapters |
| Server-managed state prevents exact reconstruction | Context claim loses credibility | Completeness labels; capture explicit-context demo; never claim provider internals |
| Streaming proxy changes latency/bytes | Breaks the agent | Byte-fidelity golden tests; async normalization; bounded tee |
| Sensitive code is recorded | Security/privacy harm | Local-only default, restrictive permissions, redaction before storage, quotas |
| AI report exfiltrates evidence | Contradicts local promise | Offline default, opt-in preview, redacted minimal evidence |
| Blame sounds more certain than evidence | False accusation | Hard evidence graph, counterevidence, confidence caps, wording review |
| Native SQLite packaging fails | Installation friction | CI prebuild validation; evaluate fallback before public release |
| Viewer scope consumes the week | Recorder remains unfinished | Build vertical slice before polish; use simple canvas/DOM timeline |
| Live model demo is nondeterministic | Stage failure | Deterministic fixture mode; live mode optional |
| Competitors already trace agents | Weak differentiation | Focus on coding effects, time-travel context, local forensics, and evidence-linked reports |

## 18. Future architecture, in order

1. Responses WebSocket proxy and hosted multi-agent event visualization.
2. Agent adapters/hooks for Codex and other base-URL-compatible coding agents.
3. OTLP/OpenInference import and export.
4. Active replay in disposable Git worktrees/containers.
5. Session comparison and regression evaluation.
6. Team-safe signed/redacted `.tkr` sharing.
7. Optional policy gate for approval of destructive actions.
8. Native desktop wrapper only if user research shows browser/daemon lifecycle is a real barrier.
9. Additional providers behind explicit protocol adapters.

## 19. Final product wording

Recommended short pitch:

> Tekrion is a local flight recorder for OpenAI-compatible coding agents. Run your agent through its proxy—or launch it with `tekrion run` for filesystem evidence—and inspect every API-visible message, tool call, result, error, and code change on a synchronized timeline. When an action goes wrong, Tekrion traces the available evidence backward, shows what is observed versus inferred, and generates an auditable incident report.

This remains ambitious, differentiated, and demonstrable without promising inaccessible reasoning or universal capture.
