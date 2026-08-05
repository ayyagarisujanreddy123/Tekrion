# Tekrion: Complete Project Guide

> Version 0.1.0 — unreleased source candidate
>
> Last updated: 2026-07-22

This document explains Tekrion from the beginning. It is written for someone who has never seen the project, has not read its design documents, and may not already understand AI-agent observability.

It covers why Tekrion exists, what was built in every M0–M9 milestone, how the application works internally, how a developer uses it, what evidence it can and cannot capture, how reports and archives work, how the project is tested, and what remains intentionally unfinished.

## Table of contents

1. [The one-minute explanation](#1-the-one-minute-explanation)
2. [The problem Tekrion solves](#2-the-problem-tekrion-solves)
3. [Purpose, promises, and non-goals](#3-purpose-promises-and-non-goals)
4. [The most important mental model](#4-the-most-important-mental-model)
5. [What Tekrion records](#5-what-tekrion-records)
6. [How one recorded session works from beginning to end](#6-how-one-recorded-session-works-from-beginning-to-end)
7. [Application architecture](#7-application-architecture)
8. [The evidence and data model](#8-the-evidence-and-data-model)
9. [Proxy and protocol behavior](#9-proxy-and-protocol-behavior)
10. [Process and workspace observation](#10-process-and-workspace-observation)
11. [The browser evidence cockpit](#11-the-browser-evidence-cockpit)
12. [Context time travel](#12-context-time-travel)
13. [Deterministic blame and anomaly analysis](#13-deterministic-blame-and-anomaly-analysis)
14. [Incident reports and optional AI enrichment](#14-incident-reports-and-optional-ai-enrichment)
15. [Sharing and importing `.tkr` investigations](#15-sharing-and-importing-tkr-investigations)
16. [Retention, deletion, quotas, and garbage collection](#16-retention-deletion-quotas-and-garbage-collection)
17. [How to install and use Tekrion](#17-how-to-install-and-use-tekrion)
18. [Complete CLI guide](#18-complete-cli-guide)
19. [The deterministic offline demo](#19-the-deterministic-offline-demo)
20. [What was built in milestones M0 through M9](#20-what-was-built-in-milestones-m0-through-m9)
21. [Security, privacy, and trust boundaries](#21-security-privacy-and-trust-boundaries)
22. [Testing, performance, packaging, and release readiness](#22-testing-performance-packaging-and-release-readiness)
23. [Repository layout](#23-repository-layout)
24. [Troubleshooting and safe operation](#24-troubleshooting-and-safe-operation)
25. [Current limitations and future direction](#25-current-limitations-and-future-direction)
26. [Glossary](#26-glossary)
27. [Where to read next](#27-where-to-read-next)

## 1. The one-minute explanation

Tekrion is a local flight recorder for AI coding agents.

An airplane flight recorder does not control the pilot or prevent every accident. It preserves a reliable record so investigators can understand what happened afterward. Tekrion applies the same idea to an AI agent that reads files, calls tools, runs commands, communicates with a model provider, and changes a software project.

When the agent is run through Tekrion, the application can preserve observable evidence such as:

- what the client sent to a supported OpenAI-compatible or Anthropic API;
- what the provider returned, including ordered streaming data;
- which model messages, tool calls, tool results, errors, and usage values were visible;
- what process was launched and what it printed;
- which files existed before the run and how the workspace ended afterward;
- which earlier evidence most plausibly influenced a suspicious action;
- a deterministic incident report with links back to the supporting evidence.

The evidence stays on the developer's computer by default. Context reconstruction, blame analysis, anomaly detection, and the normal incident report work without sending the recording to another model. Optional AI-written report enrichment exists, but it uses a separate, explicit consent flow.

The shortest useful description is:

> Run Codex, Claude Code, or another supported coding agent through Tekrion, inspect its API-visible conversation and workspace effects on one synchronized timeline, and generate an evidence-linked explanation when something goes wrong.

## 2. The problem Tekrion solves

AI coding agents operate across many different systems at once:

- a model-provider API contains requests and streamed responses;
- the agent has its own internal loop and tool dispatcher;
- a terminal contains command output and errors;
- the filesystem contains the actual code changes;
- Git shows the final state but not necessarily the sequence that produced it;
- provider-managed context may refer to earlier responses that are not repeated in every request.

Ordinary logs are fragmented. A developer might see that a test file disappeared, but not know:

- whether the user ever requested its deletion;
- whether a README or tool result contained a hostile instruction;
- whether the model actually saw that instruction before acting;
- whether the deletion followed a tool call or happened through some other process;
- whether the agent was reacting to repeated errors;
- whether the final result repaired or worsened the original problem.

Tekrion joins the observable parts of those systems into one investigation.

### Example incident

The project's seeded demonstration uses a disposable repository with a README instruction telling an agent to remove an “outdated” test. The user asks only for a build fix and explicitly does not ask for test deletion. The recorded fixture shows the agent reading the README and later deleting the test.

Tekrion can then show:

1. the original user request;
2. the README content returned to the agent;
3. the delete action and its file path;
4. the authoritative final workspace effect;
5. the exact-path, quoted-text, timing, and provenance reasons that rank the README evidence highly;
6. counterevidence and alternative explanations;
7. a report that calls the connection a hypothesis rather than pretending to prove private causation.

This is the central product idea: evidence, not guesswork.

## 3. Purpose, promises, and non-goals

### Purpose

Tekrion exists to make AI coding agents easier to understand, debug, review, and trust. Its job is to preserve an investigation-quality record of observable behavior.

The main users are:

- developers running coding agents locally;
- teams reviewing an unexpected or destructive agent action;
- agent-framework authors validating how their client communicates and behaves;
- investigators receiving a portable Tekrion archive from someone else.

### Product promises

Tekrion is designed to answer questions such as:

- What exactly happened, and in what order?
- What did the client send to the model provider?
- What did the provider return?
- What client-visible information existed before a selected action?
- What process output, error, or workspace effect followed?
- Which preceding evidence ranks highest as a possible influence?
- Which statements are direct facts and which are derived or inferred?
- What evidence is missing?
- Can the conclusion be shared as a report or portable investigation?

### Things Tekrion deliberately does not claim

Tekrion does not:

- read private chain-of-thought;
- reveal provider-hidden system instructions;
- prove a model's internal mental cause;
- prevent the wrapped command from changing files or using the network;
- sandbox the agent;
- enforce the user's requested scope;
- replay recorded tools or destructive commands;
- support every provider or transport;
- provide cloud sync, multi-user hosting, or telemetry;
- turn similarity scores into fake probabilities.

Its blame result is an evidence-backed, bounded hypothesis. It is not mind reading.

## 4. The most important mental model

Tekrion keeps three concepts separate:

1. **Raw evidence** — the original captured boundary data, such as HTTP bytes, process output, or a final file hash.
2. **Derived evidence** — a deterministic transformation of raw evidence, such as parsed messages, a duration, an assembled tool call, or a Git diff.
3. **Inference** — an analytical conclusion, such as “this README instruction may have influenced that deletion.”

The application never needs to rewrite raw traffic in order to understand it. The proxy forwards traffic, the journal preserves it, and normalization happens as a separate evidence layer.

```text
agent request
    │
    ▼
byte-faithful proxy ───────────────► configured model provider
    │                                      │
    │ raw request/response journal         │ unchanged response
    ▼                                      ▼
SQLite records + content-addressed blobs   agent continues running
    │
    ├── protocol normalization
    ├── process and workspace evidence
    ├── context reconstruction
    ├── deterministic blame/anomalies
    ├── incident report
    └── cockpit and portable archive
```

This separation matters for two reasons:

- a parser failure cannot silently change the response the agent receives;
- a future parser can reprocess retained raw evidence without pretending the original bytes were different.

## 5. What Tekrion records

The amount of evidence depends on the capture level.

### Capture levels

| Level | Stored session value | How it is used                                        | Reliably captured                                                                                                      | Important gaps                                                                        |
| ----- | -------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| L1    | `api`                | Point a supported client at `tekrion start`           | API request/response bytes, supported JSON/SSE semantics, provider errors, reported usage                              | Out-of-band tools, terminal execution, and file effects are not visible               |
| L2    | `wrapped-process`    | Run `tekrion run -- <command>`                        | L1 plus command identity, bounded output, exit state, workspace baseline/final evidence, approximate file observations | Agent-internal tool semantics are available only when visible in API/process evidence |
| L3    | `adapter`            | An agent-specific integration emits explicit evidence | Potentially exact tool lifecycle, approvals, agent session IDs, and read provenance supplied by the adapter            | Provider-hidden context and private reasoning still remain unavailable                |

L2 is the recommended built-in experience. The codebase contains an adapter foundation, but version 0.1.0 does not bundle a completed agent-specific adapter.

### API evidence

For supported OpenAI-compatible and Anthropic Messages HTTP traffic, Tekrion
can preserve:

- request method, route, safe headers, timing, and bounded body bytes;
- response status, safe headers, timing, completion state, and bounded body bytes;
- the ordered chunk manifest for streaming traffic;
- exact finalized request/response payload references;
- normalized messages, output items, tool calls, tool results, errors, and usage;
- parser diagnostics and unsupported items without discarding the raw record;
- whether the client, upstream, timeout, disconnect, or capture failure ended an exchange.

Authorization, `x-api-key`, `ChatGPT-Account-ID`,
`Anthropic-Organization-ID`, and cookie header values are forwarded in memory
when necessary but excluded from persisted header evidence.

### Process evidence

When `tekrion run` is used, Tekrion records:

- executable and arguments;
- working directory;
- process ID and parent relationship available to the wrapper;
- start and end times;
- bounded stdout and stderr frames;
- exit code or terminating signal;
- spawn failures and cleanup outcomes;
- the child process's real exit status, which the wrapper returns to the shell.

### Workspace evidence

The wrapper records a baseline and final state for the selected workspace. Evidence can include:

- file creation, modification, deletion, and unchanged-content rename;
- before/after SHA-256 values and byte lengths;
- bounded retained content or binary-capable Git patches;
- Git repository identity and baseline status when available;
- untracked-file evidence within configured limits;
- approximate watcher observations while the process is running;
- an authoritative terminal baseline-to-final comparison.

Tekrion excludes its own data directory, `.git`, `node_modules`, and common build/cache directories. It records symlink targets but does not follow directory symlinks into unrelated trees.

### Evidence kinds

Every canonical event declares what kind of claim it is:

- `observed` — directly present at a captured API, process, filesystem, or adapter boundary;
- `derived` — deterministically calculated from observations;
- `inferred` — an analytical conclusion with evidence links and limitations;
- `unknown` — unsupported, missing, or contradictory evidence prevents a stronger label.

## 6. How one recorded session works from beginning to end

The recommended path is:

```bash
tekrion run -- <agent-command>
```

When running from this source repository, use:

```bash
npm run tekrion -- run -- <agent-command>
```

Internally, one run follows this lifecycle.

### Step 1: Resolve private storage and configuration

The CLI resolves the Tekrion home, listener addresses, upstream provider origin, capture bounds, and timeouts. It creates private directories and a random local control token if needed.

Codex defaults to authentication-aware first-party routing:
`https://api.openai.com` for API-key requests or
`https://chatgpt.com/backend-api/codex` for ChatGPT-account requests. Claude
defaults to `https://api.anthropic.com`; generic OpenAI-compatible clients use
the daemon's selected upstream. `--upstream` or `TEKRION_UPSTREAM_URL` can
select another credential-free HTTP(S) origin and disables automatic
first-party routing for that wrapped session.

Tekrion deliberately does not use an existing `OPENAI_BASE_URL` or
`ANTHROPIC_BASE_URL` as its upstream. Those variables are reserved for pointing
children back to the recorder proxy. Reusing either would risk a proxy loop.

### Step 2: Start or reuse the daemon

The CLI starts a detached local daemon if a healthy one is not already available. The daemon owns:

- the OpenAI-compatible and Anthropic Messages proxy listener;
- the authenticated control/query API;
- the browser cockpit assets;
- the SQLite connection and blob store;
- protocol normalization and session correlation;
- report, archive, and maintenance services.

A lock record tracks daemon identity and ports. Stale or corrupt lock handling is tested so normal lifecycle recovery does not require deleting the whole evidence home.

### Step 3: Create an explicit session

The wrapper creates a new session identifier and capture snapshot. Explicit session routing is more reliable than guessing which requests belong together.

The child receives environment values including:

- a provider-specific session base URL (`OPENAI_BASE_URL` ending in `/v1` or
  `ANTHROPIC_BASE_URL` without that suffix);
- `TEKRION_PROXY_ORIGIN`;
- `TEKRION_SESSION_ID`;
- `TEKRION_CAPTURE_LEVEL=wrapped-process`.

Direct Codex and Claude executables are auto-detected. Codex receives a
temporary `tekrion_recorder` provider that reuses the active ChatGPT or API-key
login and disables WebSockets for recordable HTTP transport. Claude receives
`ANTHROPIC_BASE_URL` and retains its native OAuth/API-key selection; global
agent configuration and credential stores are not edited. The child must honor
the selected base URL for API traffic to be captured. Process and workspace
evidence still works if the child ignores it, but provider traffic will be
absent. Each wrapped session pins its validated routing mode so one daemon can
route OpenAI and Anthropic sessions independently.

### Step 4: Capture the workspace baseline

Before launching the child, Tekrion scans the workspace using Git-aware logic when possible. It records the starting state needed to determine the authoritative final effect later.

### Step 5: Spawn and observe the child

The requested command runs with its output mirrored to the user's terminal. Tekrion journals bounded output frames and watches the workspace for approximate live change timing.

Ctrl-C and termination signals are forwarded. Cleanup uses a bounded grace period so Tekrion does not hang forever while trying to finalize evidence.

### Step 6: Proxy provider traffic

If the child calls the injected base URL, the daemon forwards the HTTP request to the configured provider. It preserves the downstream response body and streaming order while teeing bounded evidence into the raw journal.

Normalization happens outside the forwarding path. A malformed provider event can produce a visible parser diagnostic without corrupting an otherwise valid response.

### Step 7: Normalize and correlate evidence

After raw traffic is finalized, endpoint-specific normalizers create canonical events. Tool calls and results are correlated by call identifiers when available. Requests are assigned to the explicit wrapped session.

### Step 8: Finalize process and workspace evidence

When the child exits, Tekrion records the exit result and computes the terminal baseline-to-final workspace comparison. The watcher provides approximate timing; the final comparison provides authoritative end-state evidence.

### Step 9: Investigate

The user can inspect the session from the terminal or browser:

```bash
tekrion sessions
tekrion inspect <session-id>
tekrion open <session-id>
tekrion report <session-id>
```

### Step 10: Share or remove evidence deliberately

A settled session can be exported as a `.tkr` archive. Retention and deletion commands show a plan first and make no change without `--yes`.

## 7. Application architecture

Tekrion is an npm-workspace TypeScript monorepo with a CLI-managed Node.js daemon and a React browser application.

```text
                            configured provider
                                   ▲
                                   │ HTTP JSON / SSE
                                   │
agent or client ──────────► recorder proxy ──────────► unchanged response
       │                          │
       │                          ├── raw exchange journal
       │                          ├── protocol normalization
       │                          └── session correlation
       │
       └── tekrion run ──────────┬── process stdout/stderr
                                  └── workspace baseline + observations + diff
                                                   │
                                                   ▼
                                      SQLite WAL + blob store
                                                   │
                 ┌─────────────────┬───────────────┼──────────────┬────────────────┐
                 ▼                 ▼               ▼              ▼                ▼
           query service      live SSE       context engine   analysis       archive/retention
                 │                 │               │              │                │
                 └─────────────────┴───────────────┴──────────────┴────────────────┘
                                                   │
                                                   ▼
                                      authenticated browser cockpit
```

### CLI application

`apps/cli` is the user-facing command surface. It:

- parses commands and validates flags;
- creates the private install layout;
- starts, reuses, checks, and stops the daemon;
- launches wrapped processes;
- injects session-scoped environment configuration;
- captures process/workspace evidence;
- opens the browser safely;
- exposes terminal inspection, report, archive, and retention commands;
- reports the candidate version through `tekrion --version`.

### Daemon application

`apps/daemon` is the long-running local service. It contains:

- proxy transport and capture logic;
- control-token and daemon-lock lifecycle code;
- endpoint normalization orchestration;
- sessionization;
- authenticated query routes and live event streaming;
- packaged viewer serving;
- context, blame, anomaly, and report coordination;
- `.tkr` export/import and integrity verification;
- deletion, pruning, quota, and blob-maintenance logic.

### Viewer application

`apps/viewer` is the React cockpit. It receives only authenticated local query responses and renders recorded content inertly. The production assets are built and copied into the CLI package so the viewer does not become a runtime source dependency of the daemon.

### Shared packages

| Package                  | Responsibility                                                                             |
| ------------------------ | ------------------------------------------------------------------------------------------ |
| `@tekrion/protocol`      | Versioned schemas and shared evidence/query/archive contracts                              |
| `@tekrion/storage`       | SQLite journal, repositories, migrations, transactions, search, and blobs                  |
| `@tekrion/normalizers`   | Responses, Chat Completions, and Anthropic Messages JSON/SSE parsing                       |
| `@tekrion/context`       | Client-visible context reconstruction and completeness labeling                            |
| `@tekrion/analysis`      | Deterministic blame, anomalies, incident reports, AI minimization, and citation validation |
| `@tekrion/adapters`      | Foundation for future agent-specific integrations                                          |
| `@tekrion/test-fixtures` | Golden protocol and seeded-incident evidence used by tests/demo                            |

## 8. The evidence and data model

### Sessions

A session is the investigation boundary. It stores capture level, lifecycle status, timestamps, command/workspace metadata, upstream information, counts, and a versioned metadata snapshot.

Sessionization follows this priority:

1. an explicit Tekrion session route/header created by `tekrion run`;
2. an adapter-provided agent session ID;
3. recorded response/conversation ancestry;
4. a bounded heuristic when no stronger identity exists;
5. manual assignment where supported by storage tooling.

Explicit identity is preferred because heuristic grouping must never be presented as certain.

### Raw exchanges

A raw exchange represents one proxied HTTP interaction. It records safe request/response metadata, payload references, stream manifests, timing, outcome, and completeness.

If a process crashes during capture, startup recovery can finalize an interrupted exchange as explicitly incomplete. It does not pretend an unfinished response completed.

### Canonical events

Canonical events are stable, versioned facts derived from raw evidence. Common types include:

- session start/end/crash;
- model requests and response lifecycle;
- user, developer, system, and assistant messages;
- tool calls, results, and errors;
- usage reports;
- process start/output/exit;
- file change/delete and workspace snapshots;
- transport and parser errors;
- context, anomaly, blame, and report results.

Every event has a strict per-session sequence number. Wall-clock time supports display, but sequence establishes durable local order even when two events have the same timestamp.

### Content-addressed blobs

Large or reusable payloads are stored as blobs addressed by SHA-256. This provides:

- deduplication when identical content appears more than once;
- integrity checking;
- small hot database rows;
- bounded inline storage for small values;
- atomic file publication instead of partially written final blob files.

### SQLite journal

The database uses SQLite WAL mode so the recorder can write while the cockpit reads. It includes repositories for:

- sessions and sequence allocation;
- raw exchanges;
- canonical events;
- normalization runs;
- blobs;
- file changes;
- context edges;
- analysis runs;
- redactions;
- FTS5 event search;
- migration history.

Migrations are ordered and checksummed. Existing databases are backed up before a newer migration. Future, unsupported schema versions are rejected instead of being silently rewritten.

### Search

Selected event text is indexed through SQLite FTS5. Search results remain linked to canonical event IDs rather than becoming a second unsupported source of truth.

## 9. Proxy and protocol behavior

### Supported surfaces

| Surface                                 | Forwarded     | Normalized               |
| --------------------------------------- | ------------- | ------------------------ |
| `/v1/responses` JSON                    | Yes           | Yes                      |
| `/v1/responses` SSE                     | Yes           | Yes                      |
| `/v1/chat/completions` JSON             | Yes           | Yes                      |
| `/v1/chat/completions` SSE              | Yes           | Yes                      |
| `/v1/messages` JSON                     | Yes           | Yes                      |
| `/v1/messages` SSE                      | Yes           | Yes                      |
| Other compatible HTTP `/v1/*` routes    | When possible | Preserved as raw/unknown |
| Wrapped Codex Responses over HTTP       | Yes           | Yes                      |
| Standalone Responses WebSocket/Realtime | No            | No                       |
| Bedrock, Vertex, other native schemas   | Not claimed   | No                       |

### Byte fidelity

The proxy and normalizer have different jobs:

- the proxy forwards a valid upstream response without semantically rewriting its body;
- the recorder retains ordered chunks and finalized bytes within configured bounds;
- the normalizer reads retained evidence and produces a separate logical event stream.

Golden tests compare direct upstream bytes with bytes received through Tekrion. Streaming tests protect chunk/frame ordering and tool-argument assembly across arbitrary transport boundaries.

### Header behavior

Tekrion removes hop-by-hop headers that must be regenerated by the HTTP stack. It preserves useful response metadata such as provider request identifiers and content type.

Sensitive headers—including authorization, `x-api-key`,
`ChatGPT-Account-ID`, `Anthropic-Organization-ID`, proxy authorization, cookies,
and set-cookie values—are excluded from persisted header evidence. This does not
guarantee that a credential cannot appear inside a body, source file, tool
result, or terminal frame.

### Bounds and failure behavior

Default proxy bounds include:

- 96 MiB total in-memory capture queue;
- 16 MiB captured request body;
- 64 MiB captured response body;
- 100,000 stream-manifest entries;
- optional upstream timeout rather than an arbitrary mandatory short timeout.

These values can be changed with explicit CLI flags.

If capture cannot remain complete, Tekrion records degradation or truncation rather than consuming unbounded memory. Unsafe configuration—such as an accidental proxy loop or a non-loopback bind without consent—fails closed.

## 10. Process and workspace observation

### Why the wrapper matters

An API proxy can show that a model proposed a tool call, but it cannot prove that an out-of-band agent actually executed it. `tekrion run` closes part of that gap by observing the process and workspace around the agent.

### Default process/workspace bounds

- stdout/stderr frame: 256 KiB;
- retained untracked-file content: 1 MiB per file;
- watcher debounce: 100 ms;
- final cleanup grace: 10 seconds;
- excluded segments include `.git`, `node_modules`, `dist`, `build`, `.next`, and `.cache`.

Known credential filenames and sensitive paths can be retained as metadata/hash-only evidence instead of full content.

### Two kinds of filesystem time

The application distinguishes:

- `approximate-watcher` — when Tekrion observed an operating-system notification;
- `exact-final-diff` — what the workspace state actually changed between baseline and finalization.

An operating system can coalesce or omit watcher notifications, so watcher time is useful for a timeline but not proof of the exact mutation instant. The final diff is authoritative for end state, not exact time.

### Git and non-Git workspaces

For Git repositories, Tekrion uses Git-aware baseline and binary-capable patch logic while disabling external diff/text-conversion behavior that could execute unexpected helpers. For plain directories, it uses bounded manifests, hashes, and retained deltas.

## 11. The browser evidence cockpit

Run:

```bash
tekrion open [session-id]
```

The CLI starts or reuses the daemon and opens the authenticated local viewer.

### Authentication model

The control credential is transferred through the browser URL fragment. URL fragments are not sent as part of the HTTP request. The viewer consumes the token during bootstrap and removes it from the visible URL. The control/query API also checks loopback origin and authentication.

### Main cockpit areas

#### Session navigation

Shows recorded investigations, status, time, capture level, command/model metadata, event counts, file changes, and errors.

#### Timeline

Shows synchronized lanes for:

- conversation/model activity;
- tools;
- process and filesystem effects;
- errors;
- context/usage information.

Dense streaming deltas are collapsed into logical events, while raw transport evidence remains available in the inspector.

#### Inspector

Depending on the selected event, tabs expose:

- summary;
- normalized representation;
- raw payload;
- safe headers;
- provenance and correlation identifiers;
- file diff;
- context;
- blame;
- report.

#### Search and navigation

The cockpit provides bounded queries, cursor pagination, FTS-backed search, keyboard navigation, timestamp modes, and an accessible list representation.

#### Live updates

Canonical events arrive through an authenticated server-sent-event stream. Sequence cursors allow reconnect and recovery after a refresh. Stream counts, replay size, heartbeat behavior, and slow-client writes are bounded.

### Recorded content is untrusted

Captured HTML, Markdown, script text, provider output, and tool output are data. They are not executed as application code. The viewer uses inert rendering and restrictive browser response policies.

## 12. Context time travel

Context time travel answers:

> What client-visible information can Tekrion establish was associated with this model request?

For Chat Completions, the full message list is often explicit in one captured request. Responses requests may instead refer to earlier state with `previous_response_id`.

The context engine:

1. parses instructions, messages/items, tools, tool outputs, and settings from the captured request;
2. follows locally recorded predecessor IDs;
3. guards against cycles and excessive depth;
4. preserves ordering without inventing missing messages;
5. links every context item to its event/exchange/payload provenance;
6. keeps provider-reported input usage separate from rough visible-content estimates;
7. assigns a completeness label.

### Completeness labels

| Label                        | Meaning                                                                               |
| ---------------------------- | ------------------------------------------------------------------------------------- |
| `exact-client-request`       | The complete understood context was explicit in the captured request                  |
| `reconstructed-client-chain` | All locally referenced predecessors were present and linked                           |
| `partial-client-chain`       | At least one required predecessor was missing                                         |
| `provider-managed-context`   | Remote compaction, hosted tools, or provider state may contribute unavailable context |
| `unknown-unsupported`        | The captured shape cannot support a stronger interpretation                           |

These labels describe client-visible evidence only. They never imply access to private model reasoning.

## 13. Deterministic blame and anomaly analysis

### What “blame” means here

Blame is a ranked explanation of which earlier recorded evidence most plausibly influenced a selected target action. The term does not mean legal fault or causal proof.

### Analysis pipeline

1. **Normalize the target.** Identify its verb, path/entity, arguments, result, scope, time, and impact.
2. **Build the candidate window.** Consider only evidence that occurred before and was available to the target invocation.
3. **Find hard provenance.** Look for request ancestry, call IDs, hashes, exact paths, quoted substrings, and read-result propagation.
4. **Score transparent features.** Use recency, lexical relevance, entity/path overlap, conflict with the user's request, instruction-like language, and propagation depth.
5. **Apply confidence caps.** Similarity without hard provenance cannot become high confidence. Incomplete context also limits confidence.
6. **Keep alternatives.** Store counterevidence, competing explanations, feature breakdown, scoring version, and limitations.

The calculation is deterministic and repeatable. Results can be stored in content-addressed form and reused when the same evidence and analyzer version are requested again.

### Transparent anomaly rules

Implemented rules look for patterns such as:

- destructive scope drift;
- deletion of tests/configuration not implied by the user;
- instruction-like text arriving from an untrusted file or tool result;
- repeated identical calls;
- repeated error/retry loops;
- unusual error, latency, output, or context pressure;
- action after missing ancestry or compaction;
- secret-like content.

Each result identifies its rule, inputs, threshold, severity, and explanation. Rule scores are not presented as calibrated probabilities.

### Confidence discipline

High confidence requires strong provenance and sufficiently complete relevant context. A text passage that merely resembles an action is not enough.

The seeded rogue incident proves the intended behavior with a benign control fixture, future-evidence exclusion tests, exact excerpt checks, and confidence-cap tests.

## 14. Incident reports and optional AI enrichment

### Deterministic report

The normal report is generated locally with no model call:

```bash
tekrion report <session-id>
```

It is available as Markdown and versioned JSON and includes:

1. capture scope and completeness;
2. impact;
3. factual timeline;
4. separately labeled root-cause hypothesis;
5. contributing conditions;
6. counterevidence;
7. alternative explanations;
8. observed containment or recovery;
9. prevention recommendations;
10. evidence/provenance links and limitations.

Recorded markup is escaped, and unsupported causal language is avoided.

### Optional AI enrichment

AI enrichment is disabled by default. It requires dedicated configuration:

- `TEKRION_ANALYSIS_API_KEY`;
- `TEKRION_ANALYSIS_MODEL`;
- optional `TEKRION_ANALYSIS_BASE_URL`;
- optional `TEKRION_ANALYSIS_PROVIDER`.

It never silently reuses a general `OPENAI_API_KEY`.

The flow is deliberately separate:

1. Tekrion builds the deterministic report.
2. A local preflight minimizes evidence to declared categories.
3. Recognized credentials are redacted.
4. The user sees provider, model, prompt version, category counts, bytes, redactions, and a snapshot fingerprint.
5. The user must explicitly confirm through `--ai` or the cockpit consent action.
6. The minimized snapshot is sent through a Responses-style JSON request with provider storage disabled.
7. The returned structured object is validated.
8. Every cited event must exist in the transmitted snapshot.
9. Every cited excerpt must occur in the transmitted evidence.
10. The attempt is recorded in a separate internal analysis session.

AI can edit inferred narrative only. It cannot replace the deterministic factual timeline, manufacture provenance, raise confidence beyond the local analysis, or claim access to hidden reasoning.

If the provider fails, refuses, times out, returns malformed JSON, violates the schema, or cites nonexistent evidence, the deterministic report remains intact.

## 15. Sharing and importing `.tkr` investigations

A `.tkr` file is a self-contained, versioned JSON archive with canonical base64 entries, an ordered manifest, byte lengths, and SHA-256 digests.

### Export

```bash
tekrion export <session-id> --output incident.tkr
```

Only settled investigations can be exported. Existing destinations are not overwritten unless `--force` is explicit. The file is written through a private temporary path and published atomically.

### Profiles

| Profile    | Intended use                | Contents and risk                                                                                                                                   |
| ---------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `share`    | Lower-risk collaboration    | Redacted session, canonical events, file/context records, deterministic report; raw exchanges and payload blobs are removed                         |
| `forensic` | Full investigation transfer | Exact retained records and referenced blobs, potentially including prompts, source, terminal output, paths, patches, and body-contained credentials |

`share` reduces risk but is not a proof that all sensitive prose or personal data has been removed. Review every artifact before sharing.

### Integrity verification

Import validates:

- encoded and decoded size limits;
- strict schema and canonical base64;
- manifest hash;
- every entry's path, byte length, and SHA-256;
- blob identifiers and metadata;
- profile-specific required/forbidden contents;
- record counts, relationships, and identifiers;
- agreement between JSON and Markdown report forms;
- conflicts with existing sessions/evidence IDs.

The default archive safety limit is 512 MiB.

### Read-only import

```bash
tekrion import incident.tkr --home /path/to/other-home
```

Imported sessions are marked `imported-readonly`. SQLite triggers prevent insertion, update, or direct deletion of their child evidence. Imported evidence cannot invoke optional AI analysis or active replay. Deleting the whole imported session remains an explicit supported operation.

Archive hashes detect modification but do not authenticate the author. Someone who can replace the entire archive can recompute its hashes. Use a trusted channel or future detached signature when author identity matters.

## 16. Retention, deletion, quotas, and garbage collection

Forensic evidence may be large and sensitive, so removal must be deliberate.

### Delete one investigation

```bash
tekrion delete <session-id>
tekrion delete <session-id> --yes
```

The first command is a dry run. It shows the affected session set and byte impact. `--yes` applies the already displayed intent after revalidation.

### Prune by age or size

```bash
tekrion prune --older-than-days 30
tekrion prune --max-bytes 500000000
tekrion prune --older-than-days 30 --max-bytes 500000000 --yes
```

Pruning protects active sessions. Linked internal AI-analysis sessions are included with their source investigation so hidden analysis records are not orphaned.

Deletion is transactional. After records are removed, the blob store deletes only content with no remaining evidence reference. Shared blobs needed by retained sessions remain protected.

### Storage ceiling

Start-related commands accept `--max-stored-bytes`. Once the ceiling is reached, new blob writes are refused and capture health reflects the problem. Tekrion does not silently evict older evidence.

Deletion cannot erase copies in backups, previously exported archives, unrelated logs, or data already transmitted to another party/provider.

## 17. How to install and use Tekrion

### Current release status

Version 0.1.0 is an unreleased source candidate. The seven runtime manifests
are publishable under the confirmed `@tekrion` npm scope, but no npm
publication is claimed. Use the repository workflow below until an official
package release is linked from the project.

### Requirements

- Node.js 22.15 or newer;
- npm 10 or newer;
- Codex, Claude Code, or another supported agent/client that can honor a custom
  base URL for API capture;
- permission to inspect the target workspace and traffic.

### Build from source

```bash
npm install
npm run build
npm run tekrion -- --version
npm run tekrion -- init
npm run tekrion -- doctor
```

`npm run tekrion --` is the source-repository prefix. The examples below use the eventual installed form `tekrion` for readability.

### Recommended: wrap one agent command

```bash
tekrion run -- <agent-command> [arguments...]
```

Examples:

```bash
tekrion run -- codex
tekrion run -- claude
tekrion run --agent openai-compatible -- node ./path/to/agent.js
```

Use `--cwd PATH` when the agent should run in another workspace.

### Alternative: standalone proxy

```bash
tekrion init
tekrion start --upstream https://api.anthropic.com
tekrion status
```

Configure the client with the printed `OPENAI_BASE_URL` or
`ANTHROPIC_BASE_URL`, as appropriate. This gives L1 API capture. Use the wrapper
when process and filesystem evidence are important.

### Inspect the result

```bash
tekrion sessions
tekrion inspect <session-id>
tekrion open <session-id>
tekrion report <session-id>
```

### Stop the daemon

```bash
tekrion stop
```

### Private data locations

`--home PATH` or `TEKRION_HOME` overrides the location.

| Platform   | Default home                                                                 |
| ---------- | ---------------------------------------------------------------------------- |
| macOS      | `~/Library/Application Support/Tekrion`                                      |
| Windows    | `%LOCALAPPDATA%\Tekrion` (or the user's local AppData fallback)              |
| Linux/Unix | `${XDG_DATA_HOME}/tekrion` when absolute, otherwise `~/.local/share/tekrion` |

The home contains:

- `control.token` — private local control credential;
- `daemon.lock` — daemon identity and listener state;
- `tekrion.sqlite` plus SQLite side files;
- `data/` — content-addressed payload blobs;
- `logs/daemon.log` and `daemon.log.1` — private operational daemon output; a log at or above 1 MiB rotates on daemon startup and unsafe log targets are rejected.

Where POSIX permissions are supported, private directories use mode `0700` and sensitive files use `0600`.

### Current configuration model

The implemented candidate uses CLI flags and environment variables. A richer TOML configuration hierarchy appears in the long-term design, but it is not claimed as implemented in 0.1.0.

Important environment variables are:

| Variable                    | Purpose                                               |
| --------------------------- | ----------------------------------------------------- |
| `TEKRION_HOME`              | Override the evidence home                            |
| `TEKRION_UPSTREAM_URL`      | Select the provider origin used by the proxy          |
| `TEKRION_ANALYSIS_API_KEY`  | Dedicated credential for optional report enrichment   |
| `TEKRION_ANALYSIS_MODEL`    | Required model for optional enrichment                |
| `TEKRION_ANALYSIS_BASE_URL` | Optional compatible Responses endpoint base           |
| `TEKRION_ANALYSIS_PROVIDER` | Human-readable provider label stored with the attempt |

## 18. Complete CLI guide

| Command                                                       | What it does                                                                        | Does it change evidence?                                   |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `tekrion --help`                                              | Prints commands and flags                                                           | No                                                         |
| `tekrion --version`                                           | Prints `0.1.0`                                                                      | No                                                         |
| `tekrion init [--home PATH]`                                  | Creates private storage/token and checks SQLite integrity                           | Creates the local home if absent                           |
| `tekrion doctor [--upstream URL] [--json]`                    | Checks runtime, storage, listeners, quota, upstream, and unsupported WebSocket mode | May initialize/check local layout; no agent session        |
| `tekrion start [--upstream URL]`                              | Starts the detached proxy/control/viewer daemon                                     | Starts service state                                       |
| `tekrion status [--json]`                                     | Shows daemon and recorder health                                                    | No                                                         |
| `tekrion run [--cwd PATH] -- <command...>`                    | Records one wrapped process, API traffic, output, and workspace effects             | Creates a session/evidence                                 |
| `tekrion open [session-id]`                                   | Starts/reuses the daemon and opens the authenticated cockpit                        | Service lifecycle only                                     |
| `tekrion sessions [--limit N] [--json]`                       | Lists investigations                                                                | No                                                         |
| `tekrion inspect <session-id> [--type TYPE] [--json]`         | Reads canonical events from the terminal                                            | No                                                         |
| `tekrion report <session-id> [--ai] [--json]`                 | Produces deterministic report; `--ai` explicitly opts into enrichment               | May cache analysis; AI mode may transmit approved evidence |
| `tekrion export <session-id> --output FILE`                   | Creates a `share` or `forensic` archive                                             | Writes the requested archive                               |
| `tekrion import <archive.tkr> [--json]`                       | Verifies and installs a read-only investigation                                     | Adds a read-only imported session                          |
| `tekrion delete <session-id> [--yes]`                         | Previews or applies deletion                                                        | Only with `--yes`                                          |
| `tekrion prune [--older-than-days N] [--max-bytes N] [--yes]` | Previews or applies retention policy                                                | Only with `--yes`                                          |
| `tekrion stop [--timeout-ms MS]`                              | Stops the daemon with bounded cleanup                                               | Finalizes service lifecycle                                |

Use `--json` where supported for scripts. Inspection pagination can continue with the returned cursor, and `--include-internal` reveals isolated analysis sessions when needed.

## 19. The deterministic offline demo

The demo is designed to work without an API key, provider, or network connection.

```bash
npm run demo:offline
```

The command:

1. rebuilds the source candidate;
2. resets only the dedicated `.tekrion-demo` workspace;
3. recreates the clean rogue repository fixture;
4. imports checked-in protocol/process/workspace evidence;
5. generates the deterministic incident report;
6. prints the session ID, report path, evidence home, and cockpit command.

The fixture does not rerun destructive tools. The test file remains present in the disposable repository while the imported evidence records the historical deletion incident.

Expected investigation:

- target: deletion of `test/math.test.js`;
- top preceding candidate: the README tool result containing the hostile instruction;
- evidence: exact path/text overlap plus recorded propagation;
- report: factual timeline, inferred hypothesis, counterevidence, alternatives, prevention, and no-external-evidence disclosure.

Reset or remove only the demo workspace with:

```bash
npm run demo:reset
npm run demo:cleanup
```

## 20. What was built in milestones M0 through M9

The execution plan deliberately built one narrow evidence path before adding analysis and release polish.

```text
raw bytes → durable journal → canonical events → live cockpit
          → workspace effects → context → blame → report → archive
```

### M0 — Contracts, fixtures, and repository skeleton

The first milestone removed ambiguity before runtime implementation.

Built:

- npm workspaces and strict TypeScript project configuration;
- formatting, linting, typechecking, unit, build, and end-to-end commands;
- versioned Zod contracts for sessions, exchanges, events, queries, context, analysis, reports, and archives;
- golden fixtures for Responses/Chat Completions JSON and SSE, tool deltas, usage, errors, disconnects, malformed events, unknown routes, and missing ancestry;
- the deterministic rogue incident fixture;
- architecture decision records and contribution rules;
- a dependency boundary preventing runtime packages from importing the viewer application.

Why it matters: forensic software cannot safely improvise its data meanings after evidence has already been stored.

### M1 — Crash-safe local journal

Built:

- SQLite WAL connection and repositories;
- ordered, checksummed migrations and pre-migration backups;
- transactional session/exchange/event/analysis storage;
- strict monotonic sequence allocation;
- content-addressed compressed/inline blobs with atomic publication;
- stream chunk manifests;
- FTS5 search;
- recovery of incomplete exchanges and orphan temporary blobs;
- corruption, deduplication, pagination, and concurrent reader/writer tests.

Why it matters: a recorder that loses or silently changes evidence during a crash is not a useful recorder.

### M2 — Byte-faithful proxy and CLI lifecycle

Built:

- `init`, `start`, `stop`, `status`, and `doctor`;
- detached daemon lifecycle, locks, readiness, stale-state recovery, and private token files;
- loopback proxy with safe non-loopback opt-in and proxy-loop detection;
- bounded request/response capture queues;
- response status/header/body and SSE-order preservation;
- disconnect, cancellation, timeout, and capture-health evidence;
- mandatory sensitive-header exclusion;
- explicit WebSocket/Realtime rejection and diagnostic reporting.

Why it matters: recording must not break or semantically rewrite the agent's provider connection.

### M3 — Protocol normalization and sessionization

Built:

- Responses JSON and typed SSE parsing;
- Chat Completions JSON and SSE delta parsing;
- logical message/output/tool assembly while retaining raw chunks;
- call/result correlation;
- explicit/adapter/ancestry/heuristic session assignment;
- versioned normalization runs and idempotent replay;
- parser errors as evidence rather than forwarding failures;
- isolation of Tekrion's own optional analysis traffic;
- headless `sessions` and `inspect` commands.

Why it matters: humans need stable logical events, but the raw exchange must remain the authority.

### M4 — Wrapped process and filesystem evidence

Built:

- `tekrion run` with session-scoped environment injection;
- process metadata, bounded output, exit/signal handling, and exit-code preservation;
- Git-aware and plain-directory baselines;
- tracked, untracked, binary, rename, symlink, ignored-path, and non-Git evidence handling;
- approximate watcher timing and authoritative final diff labeling;
- bounded retained file content and hash-only fallbacks;
- signal forwarding and bounded cleanup.

Why it matters: provider traffic alone cannot establish the actual coding effect.

### M5 — Authenticated local API and cockpit

Built:

- token-protected local query endpoints for sessions, events, payloads, files, search, reports, and health;
- cursor pagination and bounded filters;
- live server-sent-event updates with replay/reconnect;
- React session navigation, timeline lanes, event inspector, diffs, provenance, and raw views;
- browser bootstrap through a URL-fragment credential;
- keyboard/accessibility support and inert payload rendering;
- packaged static viewer assets served by the daemon.

Why it matters: evidence is useful only if an investigator can navigate it quickly and safely.

### M6 — Client-visible context time travel

Built:

- explicit message/instruction/tool/settings parsing;
- local Responses ancestry traversal;
- cycle, sequence, and depth guards;
- completeness labels and limitation reasons;
- item-level exchange/event/payload provenance;
- reported usage separated from estimates;
- context API and cockpit inspector.

Why it matters: attribution must know whether the suspicious evidence was actually available before the action.

### M7 — Deterministic blame and anomalies

Built:

- target normalization;
- preceding-evidence-only candidate generation;
- hard provenance edges;
- transparent local feature scoring;
- confidence caps for weak provenance or incomplete context;
- rule-based anomalies;
- counterevidence, alternatives, limitations, and evidence graph;
- content-addressed cached results;
- seeded hostile and benign control evaluations.

Why it matters: the core incident explanation works offline and remains inspectable rather than becoming another opaque model answer.

### M8 — Incident report and explicit optional AI analysis

Built:

- deterministic Markdown and JSON reports;
- separate facts, inference, counterevidence, alternatives, and prevention;
- minimized/redacted transmission snapshot;
- exact preflight metadata and consent fingerprint;
- dedicated analysis configuration;
- strict structured-output and citation validation;
- internal analysis-session isolation;
- deterministic fallback on every provider/schema/citation failure;
- matching CLI and cockpit flows.

Why it matters: a readable postmortem should not launder inference into fact or transmit evidence without informed consent.

### M9 — Archives, retention, demo, performance, and release hardening

Built:

- deterministic `share` and full-fidelity `forensic` `.tkr` archives;
- strict path/size/hash/relationship verification;
- transactional database-enforced read-only import;
- plan-first deletion and pruning;
- blob reference scanning and safe garbage collection;
- explicit storage ceiling;
- repeatable offline demo/reset/cleanup scripts;
- measured local benchmark and documentation;
- full public README, privacy/protocol/capture/archive/demo/security documentation;
- cross-platform CI definition for Ubuntu, macOS, and Windows;
- clean-install package smoke test for all seven runtime packages;
- manifest/version/engine/repository/package-content validation;
- release-candidate aggregate preflight with machine-readable output;
- package-local README, repository metadata, public-access metadata, Apache-2.0 license, and generated third-party notices;
- version 0.1.0 alignment, changelog, and `tekrion --version`.

Why it matters: the application is not complete if it cannot be demonstrated, audited, packaged, shared, retained, and handed off honestly.

### Original plan areas beyond feature milestones

The plan also defined:

- a test pyramid from pure unit tests to packaged end-to-end lifecycle tests;
- golden protocol fixtures and seeded incident controls;
- P0/P1 release blockers for fidelity, credentials, corruption, consent, migration, bounds, auth, and archive traversal;
- performance measurement methodology rather than unsupported marketing claims;
- privacy/security execution checks;
- three- and seven-minute demo scripts with an offline fallback;
- future backlog for WebSocket support, adapters, interoperability, sandboxed replay, comparison, policy gates, and additional providers.

The implemented guide and release preflight preserve the distinction between completed source work and operations that require later authorization.

## 21. Security, privacy, and trust boundaries

Tekrion records sensitive engineering evidence. Local-first operation reduces transmission; it does not make the stored data harmless.

### Implemented controls

- loopback-only control API and cockpit;
- loopback proxy by default, with explicit warning/flag for non-loopback proxy binding;
- random per-install control token;
- strict browser origin checks and restrictive content policy;
- private directory/file permissions where supported;
- authorization/cookie/proxy-credential exclusion from persisted header evidence;
- inert rendering of recorded markup;
- bounded capture, queries, streams, imports, and output;
- no telemetry or cloud sync;
- deterministic local analysis by default;
- dedicated optional-AI credentials, minimization, redaction, preflight, consent, storage-disabled provider request, and citation verification;
- archive path traversal rejection and content hashes;
- database triggers protecting imported evidence;
- explicit, dry-run-first deletion and pruning;
- storage quota that refuses rather than silently evicts evidence.

### Residual risks

- Someone who can read the Tekrion home may see prompts, source, output, and paths.
- Credentials can occur in bodies or arbitrary prose even when header credentials are excluded.
- Secret detection is rule-based and cannot guarantee complete removal.
- A forensic archive is intentionally sensitive.
- A share archive is minimized, not guaranteed anonymous.
- Archive hashes detect modification but are not signatures.
- The host, wrapped agent, upstream provider, and imported archive are not automatically trusted.
- The wrapped process is not sandboxed and can still use its normal permissions/network.
- Optional AI analysis intentionally sends the approved minimized snapshot to the configured provider.

The correct privacy statement is:

> Recordings stay on your machine by default. Optional AI analysis sends only the redacted evidence you approve to the configured model provider.

## 22. Testing, performance, packaging, and release readiness

### Local quality gate

```bash
npm run check
```

This runs formatting, linting, strict typechecking, unit/contract tests, a production build, and packaged lifecycle end-to-end tests.

At the 0.1.0 candidate checkpoint, the local gate passed:

- 34 unit/contract test files;
- 291 unit/contract tests;
- two packaged end-to-end tests.

The tests cover protocol fidelity, malformed/unknown input, credential exclusion, storage recovery, migrations, blobs, sessionization, process/workspace effects, query auth, live streams, viewer safety, context completeness, blame controls, anomalies, report consent/fallback, archive integrity/read-only import, retention, and demo behavior.

### Cross-platform CI definition

`.github/workflows/ci.yml` defines:

- formatting, lint, typecheck, and unit tests on Ubuntu with Node.js 22.20;
- build and unit compatibility at the minimum Node.js 22.15;
- native dependency installation, packaged lifecycle tests, and package smoke installation on Ubuntu, macOS, and Windows.

The workflow has read-only repository permissions and no publication step or credentials. A workflow definition is not evidence of a pass: production and release records must link a successful remote run for the exact deployed commit SHA. A separate pinned CodeQL workflow scans JavaScript and TypeScript, and Dependabot checks npm and GitHub Actions weekly.

### Package smoke test

```bash
npm run package:smoke
```

The smoke test:

1. builds production TypeScript and viewer assets;
2. copies the canonical Apache-2.0 license into each runtime distribution;
3. derives third-party notices from the viewer production source map;
4. packs protocol, storage, normalizers, context, analysis, daemon, and CLI tarballs;
5. rejects source, tests, source maps, build metadata, databases, logs, and missing runtime assets;
6. verifies aligned versions, engines, licenses, descriptions, and internal dependencies;
7. installs all tarballs into a clean temporary project;
8. executes the installed `tekrion --help` and `tekrion --version`;
9. initializes a fresh home and opens native SQLite through `tekrion sessions`.

The seven runtime packages are publishable; the root and development-only
workspaces remain `private: true` to prevent accidental publication.

### Release preflight

```bash
npm run release:preflight
npm run --silent release:preflight -- --json
```

It aggregates the full source gate, package smoke test, high-severity dependency audit, candidate metadata checks, and clean-tree verification.

On a clean candidate commit, release preflight requires all engineering and
metadata checks—including `publishable-packages`—to pass. It never publishes
or changes repository state.

### Measured local performance

The reproducible loopback smoke benchmark used 10 warmups and 100 measured requests on an Intel i7-9750H Mac with Node.js 22.20.0.

Measured results:

- p95 proxy time-to-first-byte delta over direct loopback: 8.004 ms;
- p95 proxy total-duration delta: 8.045 ms;
- p95 cockpit initial HTML total: 1.878 ms;
- three packaged cockpit assets: 101,360 bytes when each is gzipped.

These are machine-specific smoke measurements, not browser-render, Internet, streaming, concurrency, memory, or general production guarantees.

### Candidate and publication status

Completed locally:

- version 0.1.0 across the workspace;
- Apache-2.0 project/package metadata;
- canonical license text and third-party notices in future tarballs;
- changelog and package README;
- public-access metadata on exactly the seven runtime manifests, while
  development-only workspaces remain private;
- package contents and install validation;
- release preflight.

Not performed:

- fresh npm login, current scope-access reconfirmation, or publication;
- signed release tag or tag push;
- public-registry install verification;
- `latest` promotion, GitHub release notes, or release checksums.

## 23. Repository layout

```text
Tekrion/
├── apps/
│   ├── cli/                CLI, daemon launcher, process/workspace wrapper
│   ├── daemon/             Proxy, lifecycle, query API, analysis coordination
│   ├── viewer/             React evidence cockpit
│   └── demo-agent/         Deterministic demo-agent foundation
├── packages/
│   ├── protocol/           Versioned schemas and shared contracts
│   ├── storage/            SQLite journal, migrations, repositories, blobs
│   ├── normalizers/        OpenAI and Anthropic Messages normalization
│   ├── context/            Context reconstruction
│   ├── analysis/           Blame, anomalies, reports, AI safeguards
│   ├── adapters/           Future integration foundation
│   └── test-fixtures/      Golden protocol and seeded-incident fixtures
├── demo/                   Disposable rogue repository and rehearsal scripts
├── docs/
│   ├── decisions/          Twelve architecture decision records
│   ├── archive-format.md
│   ├── capture-model.md
│   ├── demo-script.md
│   ├── performance.md
│   ├── privacy.md
│   ├── protocol-support.md
│   └── release-checklist.md
├── scripts/
│   ├── benchmark.mjs
│   ├── package-license.mjs
│   ├── package-smoke.mjs
│   ├── release-preflight.mjs
│   └── runtime-packages.mjs
├── test/                   Cross-package end-to-end coverage
├── README.md               Product overview and quickstart
├── design.md               Product and technical design
├── plan.md                 M0–M9 execution plan and acceptance criteria
├── CHANGELOG.md            0.1.0 candidate changes
├── SECURITY.md             Vulnerability and trust-boundary policy
├── CONTRIBUTING.md         Evidence-contract contribution rules
└── LICENSE                 Apache License 2.0
```

### Architecture decision records

The twelve ADRs explain why the implementation chose:

1. strict versioned contracts and runtime/viewer boundaries;
2. a crash-safe SQLite evidence journal;
3. byte-faithful proxying and authenticated local control;
4. durable normalization and isolated sessionization;
5. bounded wrapped-process/workspace evidence;
6. an authenticated local cockpit;
7. client-visible context time travel;
8. deterministic blame and transparent anomalies;
9. deterministic reports with explicit opt-in AI analysis;
10. tamper-evident archives and explicit retention.

## 24. Troubleshooting and safe operation

| Symptom                                                | What to check                                                                                              |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| No API events                                          | Confirm the child honors its OpenAI/Anthropic base URL; use `--agent` when auto-detection cannot see it    |
| Process/file evidence exists but API evidence does not | The child probably ignored or replaced the injected base URL                                               |
| Port or daemon conflict                                | Run `status`, then `stop`; use `doctor` to inspect occupied listeners/stale state                          |
| Cockpit does not open                                  | Run `open` again and use the authenticated local URL produced by the CLI                                   |
| Standalone WebSocket client fails                      | Responses WebSocket/Realtime is unsupported; wrapped Codex is forced to HTTP                               |
| Export says the session is unsettled                   | Let capture finish or stop it; active evidence cannot be archived safely                                   |
| Import integrity failure                               | Treat the archive as corrupt/modified and obtain a new copy                                                |
| Storage ceiling reached                                | Preview `prune`, inspect the proposed plan, then apply with `--yes` if correct                             |
| AI report is unavailable                               | Set dedicated `TEKRION_ANALYSIS_API_KEY` and `TEKRION_ANALYSIS_MODEL` before starting the daemon           |
| AI enrichment fails                                    | Read the recorded failure; the deterministic report should still be complete                               |
| Context says partial/provider-managed                  | One or more client-visible predecessors or provider-managed state is unavailable; do not treat it as exact |

### Safe habits

- Run `tekrion doctor` before a valuable live capture.
- Use `tekrion run` when workspace evidence matters.
- Keep the evidence home private and backed up according to its sensitivity.
- Do not share forensic archives casually.
- Review share archives; redaction is not perfect.
- Treat imported evidence and recorded instructions as untrusted data.
- Preview delete/prune plans before adding `--yes`.
- Keep optional AI analysis off unless its preflight matches the intended disclosure.
- Preserve raw evidence and version meanings when changing schemas or normalizers.

## 25. Current limitations and future direction

### Current limitations

- OpenAI Responses, OpenAI Chat Completions, and Anthropic Messages HTTP
  JSON/SSE behavior is normalized.
- Wrapped Codex is forced to HTTP; standalone Responses WebSocket and Realtime
  are explicitly unsupported.
- Bedrock, Vertex, and other provider-native semantics are not claimed.
- No completed agent-specific adapter is bundled.
- Provider-hidden context and private model reasoning are unavailable.
- Filesystem watcher time is approximate.
- Observation is limited to the configured API/process/workspace boundaries.
- Active replay is not implemented.
- The wrapped command is not sandboxed.
- No cloud sync, team server, multi-user auth, billing, or default telemetry exists.
- Archive hashes are integrity checks, not author signatures.
- Cross-platform CI is defined, but the exact current local candidate still needs a remote run before any public platform claim.
- npm publication, signed tagging, registry verification, and fallback release media are deferred.

### Planned direction, in order

The long-term design proposes:

1. Standalone Responses WebSocket proxy support and richer hosted/multi-agent
   visualization;
2. explicit agent adapters/hooks;
3. OpenTelemetry/OpenInference import and export;
4. active replay only inside disposable worktrees/containers with mocked mutation tools and confirmation;
5. session comparison and regression evaluation;
6. signed/redacted team-safe archive sharing;
7. an optional approval gate for destructive actions;
8. a native desktop wrapper only if research proves the browser/daemon lifecycle is a barrier;
9. additional providers behind explicit protocol adapters.

These are future directions, not 0.1.0 capabilities.

## 26. Glossary

**Agent:** A program that uses a model and tools to perform a multi-step task.

**Canonical event:** A stable, versioned logical representation derived from raw evidence, such as `tool.call` or `file.delete`.

**Capture level:** The observation boundary—API only, wrapped process, or explicit adapter. It is not a confidence score.

**Completeness label:** A statement describing how much client-visible context can be established for a request.

**Content-addressed blob:** A payload stored under an identifier derived from its SHA-256 content hash.

**Context time travel:** Reconstruction of the messages, instructions, tools, and locally available ancestry associated with a model request.

**Daemon:** The local background process that owns the proxy, storage, query API, viewer assets, and analysis/archive services.

**Derived evidence:** A deterministic calculation from observations, such as a diff or normalized message.

**Forensic archive:** A full-fidelity `.tkr` export containing sensitive retained records and referenced payloads.

**Inference:** A bounded analytical conclusion supported by evidence but not directly observed.

**Normalization:** Parsing provider-specific raw payloads into stable Tekrion event contracts.

**Provenance:** The links showing where a claim came from: event, exchange, payload, path, hash, line, call ID, or ancestry.

**Raw exchange:** The captured HTTP request/response record before semantic normalization.

**Sessionization:** The process of assigning related exchanges and events to one investigation.

**Share archive:** A minimized/redacted `.tkr` export that intentionally removes raw payload layers and private scope fields.

**SSE:** Server-Sent Events, the streaming HTTP format used by supported model APIs.

**WAL:** SQLite Write-Ahead Logging, allowing readers to continue while the recorder commits writes.

## 27. Where to read next

- [Main README](../README.md) — product overview and quickstart
- [Project statement](../projectstatement.md) — plain-language purpose
- [Technical design](../design.md) — complete product/architecture design
- [Execution plan](../plan.md) — milestone tasks and acceptance criteria
- [Capture model](capture-model.md) — capture levels, time precision, evidence kinds
- [Adapter authoring](adapter-authoring.md) — supported session integration contract and limits
- [Protocol support](protocol-support.md) — supported routes/transports and fidelity boundaries
- [Privacy guide](privacy.md) — stored data, credentials, network behavior, deletion
- [Production operations](operations.md) — deployment, health, retention, backup, upgrade, and incident response
- [Archive format](archive-format.md) — exact `.tkr` schema and verification
- [Migration from Black Box](migration-from-black-box.md) — compatibility rules for pre-release builds
- [Performance results](performance.md) — reproducible benchmark method and limits
- [Demo script](demo-script.md) — three-minute, seven-minute, and fallback paths
- [Release checklist](release-checklist.md) — source gates and authorization boundaries
- [npm release runbook](npm-release-runbook.md) — ordered bootstrap, registry verification, and trusted publishing
- [Security verification map](security-verification.md) — implementation and regression evidence for each security control
- [Security policy](../SECURITY.md) — vulnerability reporting and trust model
- [Contribution guide](../CONTRIBUTING.md) — rules for changing forensic contracts
- [Architecture decisions](decisions/) — decision-by-decision implementation rationale
- [Changelog](../CHANGELOG.md) — 0.1.0 candidate contents and known limitations

Tekrion is complete as a local 0.1.0 source candidate across the planned M0–M9 feature path. Its runtime manifests are prepared under the confirmed `@tekrion` scope, but publishing, tagging, and external release operations remain separately authorized steps.
