# Tekrion Execution Plan

Status: M0–M9 source implementation complete; public release operations pending

Version: 0.1

Last updated: 2026-07-28

Companion: [design.md](./design.md)

## 1. Delivery strategy

Build a narrow end-to-end evidence path before expanding features:

```text
agent request
  → byte-faithful proxy
  → append-only raw record
  → normalized events
  → live timeline
  → filesystem effect
  → context reconstruction
  → evidence-ranked blame
  → incident report
```

The critical path is recorder fidelity, not UI polish or AI narration. At the end of every milestone, the repository must contain a runnable vertical slice and fixtures proving the new behavior. Optional work never blocks the deterministic demo.

The plan assumes one primary engineer for a five-day Build Week. With two or three engineers, the workstreams in Section 6 can run in parallel after the protocol and schema contracts are frozen.

## 2. Definition of the Build Week MVP

The MVP is complete only when a fresh clone can:

1. install and build with documented commands;
2. run `tekrion doctor` successfully;
3. start the localhost proxy and viewer;
4. run the deterministic rogue demo through `tekrion run`;
5. record an OpenAI Responses-style JSON/SSE session without changing response bytes or event order;
6. store raw exchanges and canonical events in SQLite;
7. show messages, tool calls/results, errors, reported tokens, and file changes on a synchronized timeline;
8. reconstruct the client-visible context for the deletion with a completeness label;
9. select the deletion and show the poisoned README line as the top blame candidate through deterministic evidence;
10. generate a local incident report with linked evidence;
11. optionally enrich the report with a configured OpenAI model after an explicit privacy confirmation;
12. export a redacted session archive and import it read-only;
13. pass the protocol, storage, security, and end-to-end demo tests.

Not required for the Build Week MVP: WebSocket/Realtime proxying, native desktop packaging, non-OpenAI protocols, cloud sync, multi-user auth, replay execution, vector database, or production-scale evaluations.

## 3. Product decisions to lock before coding

These are decided unless new evidence invalidates them:

| Decision | Choice |
|---|---|
| Product form | CLI-managed local daemon plus localhost React viewer |
| Primary onboarding | `tekrion run -- <agent>`; base URL alone remains supported |
| MVP protocols | HTTP JSON and SSE for Responses and Chat Completions |
| Source of truth | Append-only raw exchanges plus versioned normalized events |
| Storage | SQLite WAL, FTS5, content-addressed compressed blobs |
| Analysis | Deterministic first; external model analysis opt-in |
| Demo | Fixture-driven by default, real model optional |
| Context wording | Client-visible context with completeness labels |
| Causality wording | Evidence-backed attribution, not causal proof |
| Privacy | Loopback/local by default; no telemetry; authorization never stored |

## 4. Work breakdown and acceptance criteria

### M0 — Contracts, fixtures, and skeleton

Goal: eliminate ambiguity before implementation.

Tasks:

- Create npm workspace packages and strict shared TypeScript configuration.
- Add lint, format, typecheck, unit test, build, and end-to-end scripts.
- Define versioned Zod schemas for sessions, raw exchanges, canonical events, context results, blame results, and reports.
- Create golden protocol fixtures:
  - Responses non-streaming text;
  - Responses SSE text and function-call argument deltas;
  - Chat Completions non-streaming;
  - Chat Completions SSE content and tool-call deltas;
  - 4xx JSON error;
  - mid-stream disconnect;
  - malformed SSE line;
  - unknown `/v1/*` route;
  - usage present and absent;
  - `previous_response_id` chain with one missing predecessor.
- Create the disposable rogue-repository template and deterministic demo transcript.
- Add a decisions log and contribution commands to README.

Acceptance:

- `npm install`, `npm run typecheck`, and an empty `npm test` pipeline work on a clean machine.
- Every fixture has expected raw bytes and expected canonical events.
- Schemas reject unknown required versions cleanly and preserve unknown payloads as blobs.
- No implementation package imports from the viewer.

Exit artifact: repository skeleton plus protocol contract tests.

### M1 — Storage and crash-safe journal

Goal: prove evidence can be durably recorded and rebuilt.

Tasks:

- Implement SQLite connection, WAL pragmas, migrations, transactions, and indexes.
- Implement session, raw exchange, event, blob, file-change, context-edge, analysis-run, and redaction repositories.
- Implement content-addressed blobs with SHA-256, compression, atomic temp-file rename, and inline threshold.
- Implement monotonic per-session sequence allocation.
- Implement chunk manifest format with monotonic time and byte offset.
- Add startup recovery for incomplete exchanges and orphan temp blobs.
- Add FTS5 population and rebuild command.
- Add database compatibility checks and pre-migration backup.

Acceptance:

- Concurrent writer/viewer read test passes in WAL mode.
- Killing the recorder during a streamed fixture yields a valid session with an explicitly incomplete exchange.
- Re-normalizing a raw exchange is idempotent and never changes raw hashes.
- Blob deduplication, corruption detection, migration rollback, and disk-full behavior have tests.
- Query pagination returns stable ordering for equal wall-clock timestamps.

Exit artifact: storage package usable independently from the proxy.

### M2 — Byte-faithful proxy and CLI lifecycle

Implementation status: Complete on 2026-07-16. The exit artifact is covered by byte-for-byte proxy tests and a packaged detached-process end-to-end test.

Goal: record real HTTP traffic without breaking the caller.

Tasks:

- Implement `tekrion init/start/stop/status/doctor`.
- Manage PID/lock files and stale-daemon recovery.
- Implement loopback proxy with configurable upstream and proxy-loop detection.
- Implement safe header forwarding and mandatory credential/header exclusion.
- Tee request/response streams into the journal with bounded queues.
- Preserve status, relevant headers, response bytes, and SSE frame order.
- Record first-byte, completion, timeout, disconnect, and upstream failure times.
- Forward unknown routes transparently where the HTTP shape is supported.
- Add health state for degraded or dropped capture.
- Implement per-install local control token and restrict file permissions.

Acceptance:

- Golden proxy tests compare downstream body byte-for-byte with direct upstream fixtures.
- SSE chunk/frame ordering is identical.
- Authorization and cookies do not occur anywhere in database/blob test scans.
- Client cancellation and upstream cancellation are distinguished.
- Slow viewer/storage work cannot grow proxy memory without bound.
- `doctor` reports port conflicts, upstream reachability, writable storage, capture limits, and unsupported WebSocket transport.

Exit artifact: an agent can use the proxy through `OPENAI_BASE_URL` and receive an unchanged response.

### M3 — Normalization and sessionization

Implementation status: Complete on 2026-07-16. The exit artifact is covered by all eleven golden normalization snapshots, replay/conflict tests for both streaming protocols, durable proxy integration, sessionization precedence/isolation tests, and packaged CLI inspection.

Goal: turn raw protocol evidence into a stable forensic event stream.

Tasks:

- Implement parsers for Responses JSON and typed SSE.
- Implement parsers for Chat Completions JSON and SSE deltas.
- Assemble logical assistant outputs and function-call arguments while retaining raw chunks.
- Emit model request/response, message, tool call/result, error, and usage events.
- Correlate tool calls and results by `call_id`/tool-call ID.
- Implement explicit, adapter, ancestry, and heuristic sessionization priority.
- Snapshot endpoint parser version and session capture configuration.
- Emit parser errors as evidence without failing forwarding.
- Add internal analysis-session isolation.

Acceptance:

- All M0 fixtures normalize to their expected event snapshots.
- Tool arguments split across arbitrary SSE boundaries assemble correctly.
- Duplicate/replayed SSE events do not silently create conflicting canonical facts.
- Unknown event item types are retained and visible.
- Missing usage produces `unknown`, not zero.

Exit artifact: recent sessions can be listed and inspected as canonical event JSON.

### M4 — Process wrapper and filesystem evidence

Goal: connect API activity to actual coding effects.

Tasks:

- Implement `tekrion run -- <cmd...>` with environment injection and explicit session header/config where possible.
- Capture command metadata, cwd, PID, signal, exit code, and timestamped stdout/stderr frames.
- Detect Git repository and record baseline status/HEAD.
- At completion, compute tracked binary-capable diff and bounded untracked-file manifest/content.
- Add debounced filesystem watching for approximate event timing.
- Emit create/modify/delete/rename events with hashes and timing precision.
- Apply path exclusions (`.git`, `node_modules`, build output, Tekrion data directory) and symlink boundary checks.
- Detect writes outside repository scope only when the wrapper can observe them safely; do not claim full OS auditing.
- Ensure Ctrl-C is forwarded and cleanup/final snapshot has a bounded grace period.

Acceptance:

- Fixture tests cover modify, create, delete, rename, binary file, untracked file, symlink, ignored path, and non-Git directory.
- Rogue demo deletion appears as a file event with before hash and patch.
- File contents above the limit are hashed but not persisted in full.
- Wrapper returns the child process exit code.
- The UI/API can distinguish exact final diff from approximate watcher time.

Exit artifact: one command records both agent API traffic and repository impact.

### M5 — Local API and cockpit vertical slice

Implementation status: Complete on 2026-07-16. The exit artifact is covered by authenticated query and live-stream tests, viewer model/transport tests, CLI routing tests, and the packaged detached-daemon end-to-end test.

Goal: make recorded evidence explorable during and after a session.

Tasks:

- Implement authenticated local endpoints for sessions, events, payloads, files, search, and health.
- Add cursor pagination and event type/time filters.
- Add live event stream with reconnect and last-sequence recovery.
- Build session list and empty/loading/error states.
- Build timeline with lanes for model/conversation, tools, files/process, errors, and token/context pressure.
- Collapse deltas into logical events while exposing raw chunks in inspector.
- Build inspector tabs: summary, normalized payload, raw payload, headers, provenance.
- Add diff view and tool call/result links.
- Add keyboard navigation, accessible event list fallback, and timestamp mode.
- Implement `tekrion open` and route directly to a session.

Acceptance:

- Timeline updates live during the demo and recovers missed events after browser refresh.
- A 10,000-event synthetic session remains interactive.
- Every visible event can navigate to its raw or derived provenance.
- Recorded HTML/Markdown/script payload renders inertly under CSP.
- Viewer cannot access sessions without the local auth flow.

Exit artifact: usable cockpit for a live rogue-demo recording.

### M6 — Context time travel

Implementation status: Complete on 2026-07-20. The exit artifact is covered by reconstruction, storage/query, authenticated API, viewer transport/rendering, normalizer fixture, and packaged lifecycle tests.

Goal: answer “what client-visible information preceded this request?” accurately.

Tasks:

- Parse explicit request instructions, input/messages, tools, outputs, and settings.
- Build response/conversation ancestry graph.
- Reconstruct explicit and locally available chained client context with cycle/depth guards.
- Emit completeness label and machine-readable limitation reasons.
- Attribute every reconstructed item to raw exchange/event.
- Display reported usage separately from estimates.
- Build context inspector with ordered items, provenance links, ancestry graph, and completeness banner.

Acceptance:

- Explicit Chat Completions history is labeled exact client request.
- Complete local `previous_response_id` fixture is labeled reconstructed client chain.
- Missing ancestor fixture is labeled partial and identifies the missing ID.
- Provider-managed/unknown context never receives an “exact” badge.
- No hidden chain-of-thought text is fabricated or implied.

Exit artifact: context inspector is credible under both complete and incomplete cases.

### M7 — Deterministic blame and anomalies

Implementation status: Complete on 2026-07-20. The exit artifact is covered by deterministic ranking, confidence-cap, benign-control, future-evidence, anomaly-rule, seeded-incident, storage/cache, authenticated API, and inert viewer rendering tests.

Goal: trace the demo deletion to evidence without requiring another model.

Tasks:

- Normalize target action into verb, path/entity, arguments, scope, result, and impact.
- Generate candidates only from evidence preceding and available to the target invocation.
- Add hard edges for request ancestry, `call_id`, hashes, file path, quoted substring, and read-result propagation.
- Implement local candidate features: recency, BM25/FTS match, entity/path overlap, intent conflict, instruction-like patterns, and propagation depth.
- Store feature breakdown and scoring version.
- Implement anomaly rules for destructive scope drift, injection-like untrusted content, loops, repeated errors, context pressure, and secret-like content.
- Build Blame panel with primary candidate, evidence graph, excerpts, feature explanation, alternatives, and limitations.
- Cap confidence according to the design contract.

Acceptance:

- Poisoned README line ranks first for the deterministic demo.
- A benign README fixture does not trigger the same high-severity conclusion.
- Candidate generation never includes events after the target.
- Similarity without a provenance edge never produces high confidence.
- Every displayed excerpt matches the referenced stored payload/hash.

Exit artifact: the core “catch it red-handed” demo works offline.

### M8 — Incident report and optional AI analysis

Implementation status: Complete on 2026-07-20. The exit artifact is covered by deterministic report, evidence minimization/redaction, citation validation, structured-output transport, storage/cache, internal-session isolation, authenticated consent API, CLI fallback, and inert viewer tests.

Goal: produce a useful, shareable explanation without laundering inference into fact.

Tasks:

- Generate deterministic Markdown/JSON report from session facts, anomalies, and blame result.
- Include capture completeness, impact, factual timeline, hypothesis, counterevidence, alternatives, and prevention actions.
- Define a versioned structured-output schema and prompt for optional AI explanation.
- Build evidence minimizer/redactor and a preflight preview of transmitted categories/size.
- Require `--ai` or an explicit UI confirmation; keep default offline.
- Validate model citations against event IDs and source excerpts.
- Record analysis model, provider, prompt version, usage, redactions, and failure.
- Store analysis calls in a separate internal session.
- Fall back to deterministic report when provider call or schema validation fails.

Acceptance:

- Offline report contains no unsupported causal statement.
- AI output referencing a nonexistent event is rejected or repaired deterministically.
- Sensitive fixture values are absent from the transmitted evidence snapshot.
- Canceling the consent dialog makes no network call.
- Model failure leaves the original session and deterministic report intact.

Exit artifact: defensible post-mortem with optional narrative enrichment.

### M9 — Export, polish, release, and rehearsal

Implementation status: Source work completed on 2026-07-20. Versioned share/forensic archives, strict read-only import, retention/quotas, public documentation, measured local smoke results, and the repeatable offline fallback are covered by the full gate. A dependency-clean macOS build and two consecutive proxy-disabled fixture rehearsals passed. Linux/Windows clean-install validation, fallback media, signing, tagging, and publication remain release-operations work and are not claimed here.

Goal: make the project easy to judge and safe to demonstrate.

Tasks:

- Define `.tkr` archive: manifest, schema version, redacted SQLite subset or JSONL, blobs, hashes, and report.
- Implement export profiles and read-only import.
- Add session deletion and retention/size controls.
- Add README quickstart, architecture image, supported/unsupported matrix, privacy statement, and troubleshooting.
- Add seeded demo reset and cleanup.
- Measure proxy and UI targets; publish only measured numbers.
- Run clean-machine install on macOS and Linux; test Windows if release scope includes it.
- Record a fallback demo video and screenshots.
- Rehearse a 3-minute and a 7-minute script.
- Tag the demo commit and preserve known-good fixture/model configuration.

Acceptance:

- Export manifest hashes validate; tampering is detected.
- Import cannot overwrite an existing session or trigger active tool replay.
- Fresh-clone demo succeeds twice consecutively with network disabled.
- Live optional demo failure has a one-command fallback to fixture mode.
- README claims match actual capture levels and test results.

Exit artifact: submission-ready project.

## 5. Five-day Build Week schedule

### Day 1 — Evidence pipeline

Morning:

- M0 contracts, fixtures, repo skeleton.
- Freeze canonical envelope and raw exchange format by midday.

Afternoon:

- M1 SQLite/blob journal.
- Begin M2 non-streaming proxy.

End-of-day gate:

- A fixture request passes through unchanged and exists as a raw SQLite exchange.

### Day 2 — Streaming and normalization

Morning:

- Complete M2 SSE tee, lifecycle, header security, CLI start/status/doctor.

Afternoon:

- M3 Responses and Chat Completions normalizers.
- Begin M4 process wrapper.

End-of-day gate:

- Deterministic demo transcript records model/tool events; golden byte tests pass.

### Day 3 — Effects and viewer

Morning:

- Complete `tekrion run`, Git baseline/final diff, file events.

Afternoon:

- M5 local API, session list, live timeline, inspector.

End-of-day gate:

- Run demo from terminal and watch deletion appear live in the browser.

### Day 4 — Differentiators

Morning:

- M6 context reconstruction and completeness UI.

Afternoon:

- M7 deterministic blame, anomalies, evidence graph.

End-of-day gate:

- Click deletion → see request context → see README line ranked first, all offline.

### Day 5 — Report and submission

Morning:

- M8 deterministic report; optional AI analysis only after offline path is stable.
- M9 export/import minimum.

Afternoon:

- Security scan, performance smoke tests, copy/claim audit, docs, demo rehearsal, fallback video.

Code freeze:

- No architectural changes after the first successful full rehearsal unless fixing a release blocker.

## 6. Parallel workstreams for a team

After M0 schemas and fixtures are merged:

| Workstream | Owner A | Owner B | Owner C |
|---|---|---|---|
| Day 1–2 | proxy, CLI, storage | normalizers, fixtures, context graph | viewer shell, design system, live API contract |
| Day 3 | wrapper/filesystem | blame/anomaly feature extraction | timeline, inspector, diff UI |
| Day 4 | reliability/security | context + analysis | blame/report UI + accessibility |
| Day 5 | integration/release | evals/report prompting | demo/docs/rehearsal |

Coordination rules:

- Shared packages merge through schema tests, not ad hoc object shapes.
- Fixture snapshots are reviewed whenever protocol behavior changes.
- UI works against committed fixture sessions until live API is stable.
- One integration owner protects the main branch and end-to-end demo.
- Each owner records a five-minute handoff note before switching workstreams.

## 7. Verification strategy

### 7.1 Test pyramid

#### Unit tests

- schema validation and versioning;
- SSE boundary parsing and logical assembly;
- header allow/drop/redact policy;
- sessionization precedence;
- context ancestry and completeness;
- blame feature scores and confidence caps;
- redaction and secret detection;
- file diff classification;
- report evidence citation validator.

#### Protocol/golden tests

Use a local fake upstream that can control chunks, delays, disconnects, headers, and invalid payloads. Compare direct versus proxied status, headers that must be preserved, body bytes, SSE event sequence, and cancellation behavior.

#### Storage tests

- migrations from every released schema;
- crash recovery at each journal phase;
- WAL read/write concurrency;
- content hash and deduplication;
- FTS rebuild;
- quota/disk-full degradation;
- newer-schema read-only behavior.

#### End-to-end tests

- CLI starts daemon, demo agent runs, viewer renders, deletion selected, blame/report generated.
- Browser refresh during live stream resumes at correct sequence.
- malicious payloads remain inert.
- AI consent cancel produces zero outbound model requests.
- archive export/import retains hashes and evidence links.

#### Manual tests

- Ctrl-C and terminal resize behavior;
- corrupted/stale daemon lock;
- multiple simultaneous sessions;
- large JSON inspector usability;
- port collision;
- Git worktree, detached HEAD, dirty baseline, and non-Git workspace;
- no-network offline demo;
- screen-reader/keyboard path through the core investigation.

### 7.2 Seeded incident evaluation set

Create at least eight small fixture sessions:

1. README prompt injection causes test deletion.
2. User explicitly requests test deletion (should not be scope-drift anomaly).
3. Build tool deletes generated output (benign expected deletion).
4. Agent repeats failing command six times.
5. Tool error causes valid fallback action.
6. Missing `previous_response_id` ancestry.
7. Similar README text exists but was never read/in context.
8. Secret-like token appears in tool output and is redacted.

For each, declare expected top candidate, hard edges, allowed confidence ceiling, anomaly IDs, and report facts. This is more valuable than optimizing only for the showcase case.

### 7.3 Release gates

P0 blockers:

- response bytes/order changed;
- credentials persisted;
- session evidence corrupts on normal crash;
- deterministic demo fails;
- blame cites nonexistent or future evidence;
- viewer executes recorded content;
- AI analysis occurs without opt-in.

P1 blockers for public npm release, but not necessarily source demo:

- installation fails on a claimed platform;
- database migration loses evidence;
- unbounded memory/disk behavior;
- loopback auth/origin bypass;
- archive path traversal.

## 8. Performance measurement plan

Build a benchmark harness with a local upstream so network variance is removed.

Scenarios:

- 1 KiB, 100 KiB, and 10 MiB JSON requests/responses;
- 10,000 small SSE chunks at 5 ms cadence;
- four and sixteen concurrent sessions;
- viewer reading while proxy writes;
- 10,000 and 100,000 normalized events;
- final Git diff with 1, 100, and 1,000 changed files.

Measure direct versus proxied:

- time to first byte;
- total duration;
- peak resident memory;
- event-journal queue depth;
- bytes written and compression ratio;
- dropped/truncated capture count;
- SQLite query latency;
- browser frame time and interaction latency.

Record machine, runtime version, fixture hash, and command alongside results. Do not advertise unmeasured targets from design.md as achieved metrics.

## 9. Privacy and security execution checklist

Before the first live API test:

Implementation and regression references are recorded in the [security verification map](./docs/security-verification.md).

- [x] Authorization/cookie headers are excluded at the type and storage layers.
- [x] Test database scan verifies known fake secrets are absent.
- [x] Data directory permissions are restrictive.
- [x] Proxy and viewer bind only to loopback.
- [x] Upstream loop detection is active.
- [x] Viewer has CSP, Origin checks, and inert payload rendering.
- [x] Local control token is random and never printed in normal logs.
- [x] Request logging does not stringify headers/body outside the redactor.
- [x] Recorded content is delimited as untrusted evidence in analysis prompts.
- [x] AI analysis is disabled by default and requires preview/consent.
- [x] Export rejects absolute paths and `..` traversal.
- [x] Quota and retention warnings are visible.
- [x] Demo operates only in a disposable directory.

## 10. Documentation plan

README should answer in this order:

1. what Tekrion does;
2. a 30-second GIF/screenshot;
3. install and deterministic demo;
4. `tekrion run` recommended setup;
5. base-URL-only setup and its limitations;
6. supported protocols/agents matrix;
7. privacy behavior and optional analysis disclosure;
8. architecture and data location;
9. troubleshooting/doctor;
10. development and tests.

Additional docs before public release:

- `docs/capture-model.md`: L1/L2/L3 and completeness semantics;
- `docs/privacy.md`: stored fields, redaction, analysis transmission, deletion;
- `docs/protocol-support.md`: endpoints/transports and known incompatibilities;
- `docs/archive-format.md`: `.tkr` schema and integrity;
- `docs/adapter-authoring.md`: lifecycle and event contracts;
- `SECURITY.md`: vulnerability reporting and threat boundaries;
- `CONTRIBUTING.md`: fixtures, schema changes, verification.

## 11. Demo production plan

### 11.1 Three-minute script

1. Run `tekrion demo rogue` and show the terminal command plus browser opening.
2. State the original task: fix the build, not delete tests.
3. Watch the live timeline populate and tests disappear.
4. Select `file.delete tests/...`.
5. Open Context: show user request, README tool result, model tool call, and completeness badge.
6. Open Blame: show the poisoned line, propagation edges, and confidence reasons.
7. Open report: show facts, inference, alternative, and prevention.
8. Close with the aviation analogy and local-first privacy statement.

### 11.2 Seven-minute script additions

- Toggle raw/normalized event payload.
- Show tool `call_id` linking.
- Explain base URL versus wrapped capture levels.
- Show offline deterministic report, then optional AI enrichment disclosure.
- Export a redacted `.tkr` archive.

### 11.3 Failure fallbacks

| Failure | Fallback |
|---|---|
| Provider/network unavailable | fixture demo, which is the default |
| Browser fails to open | print viewer URL and use `tekrion inspect` |
| Port occupied | automatic free port for demo and explicit URL |
| Live model ignores injected line | do not depend on live model; switch to known fixture |
| AI report fails | deterministic report remains complete |
| Filesystem watcher misses timing | final Git diff still proves effect and labels time approximate |

## 12. Backlog after Build Week

### P0 — Hardening before broader use

- WebSocket Responses proxy with frame-fidelity tests.
- Release packaging and native SQLite validation on all claimed platforms.
- Fuzz SSE/JSON parsers and archive import.
- Larger security review of localhost API, redaction, and proxy fidelity.
- Session recovery and quota behavior under prolonged recordings.
- Explicit adapters for the first two real coding agents selected from user demand.

### P1 — Product depth

- OTLP/OpenInference import/export.
- Active replay in disposable Git worktrees with mocked mutation tools.
- Side-by-side session comparison and regression flags.
- User annotations, bookmarks, and confirmed root cause.
- Local embedding provider and configurable analysis provider.
- Signed archives and team-safe sharing workflow.
- Policy preview/approval for destructive tool calls.

### P2 — Scale and polish

- Native desktop wrapper if validated by research.
- Remote daemon/CI collector with explicit authentication.
- Additional model-provider protocols.
- Team server/storage backend.
- Evaluation datasets generated from confirmed incidents.
- Plugin ecosystem for agent adapters and custom anomaly rules.

## 13. Open questions and validation experiments

These do not block the MVP; they determine the post-demo roadmap.

| Question | Experiment | Decision threshold |
|---|---|---|
| Is base URL setup sufficiently compatible? | Test five target agents with `doctor` and one real task | Adapter needed if fewer than 3/5 work without code changes |
| Does the browser/daemon feel like an “app”? | Five usability sessions from install to investigation | Consider desktop wrapper only if lifecycle is a repeated top-three pain |
| Is filesystem final diff enough? | Seed tasks with fast create/delete/rename operations | Add deeper hook/OS observer if investigators cannot order key effects |
| Does blame help beyond search? | Compare seeded incident completion time with timeline-only versus Blame | Continue model enrichment only if accuracy/time improves materially |
| Are completeness labels understandable? | Ask users to explain what “reconstructed” excludes | Rewrite if fewer than 4/5 answer correctly |
| Is external AI analysis acceptable? | Show preflight privacy UI and collect opt-in/rejection reasons | Prioritize local models if external transmission blocks common use |
| Which interoperability matters first? | Interview framework authors and inspect export requests | Implement OTLP before new provider if it unlocks more real traces |

## 14. Issue sequence

Create issues in this dependency order:

```text
BB-001 workspace/build skeleton
BB-002 protocol fixtures
BB-003 canonical schemas
BB-004 SQLite migrations/repositories
BB-005 blob/chunk journal
BB-006 proxy header and upstream policy
BB-007 non-streaming pass-through
BB-008 SSE pass-through and cancellation
BB-009 CLI daemon lifecycle and doctor
BB-010 Responses normalizer
BB-011 Chat Completions normalizer
BB-012 sessionization/correlation
BB-013 process wrapper
BB-014 Git/filesystem evidence
BB-015 local API/live stream
BB-016 viewer session list
BB-017 timeline/inspector/diff
BB-018 context ancestry/completeness
BB-019 context inspector
BB-020 anomaly rules
BB-021 deterministic blame ranking
BB-022 blame evidence UI
BB-023 deterministic report
BB-024 optional structured AI analysis
BB-025 archive export/import
BB-026 rogue demo and seeded evals
BB-027 security/performance gates
BB-028 docs/release/rehearsal
```

Each issue must include fixtures, acceptance criteria, failure behavior, and documentation impact. An issue is not complete when only the happy-path UI works.

## 15. Definition of done

A feature is done when:

- behavior and failure modes match design.md;
- types and runtime schemas agree;
- raw evidence remains recoverable if normalization fails;
- tests cover happy path, malformed input, cancellation, and missing evidence where relevant;
- privacy classification and redaction behavior are specified;
- UI distinguishes observed, derived, inferred, and unknown;
- documentation and `doctor` output reflect support limitations;
- no new claim is added to the pitch without a repeatable test;
- the full deterministic demo still passes.

The project is ready to submit when every MVP item in Section 2 passes on a clean clone, all P0 release gates are green for the claimed demo platform, and the final narrative accurately describes what the software records and infers.
