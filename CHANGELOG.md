# Changelog

This file records user-visible changes to Black Box. Version 0.1.0 remains an unreleased source candidate until an official tag and package publication are completed.

## 0.1.0 — Unreleased

### Added

- Byte-faithful localhost proxy capture for supported OpenAI Responses, OpenAI
  Chat Completions, and Anthropic Messages JSON/SSE traffic.
- Native `blackbox run` launch integration for Codex and Claude Code, including
  auto-detection, explicit `--agent` selection, one-run client configuration,
  and validated per-session upstream routing through a shared daemon.
- Account-aware local sessions: Codex reuses ChatGPT or API-key authentication
  through an HTTP-only recorder provider, while Claude reuses its native
  OAuth/API-key selection without a separate Black Box credential.
- Crash-safe SQLite evidence journal, content-addressed blob storage, recovery, migrations, quotas, retention, and explicit garbage collection.
- `blackbox run` process capture with bounded output, signal forwarding, workspace baselines, live observations, and authoritative final file evidence.
- Authenticated local browser cockpit with session navigation, virtualized timeline, evidence inspection, context reconstruction, search, and live updates.
- Deterministic blame ranking, anomaly detection, incident reports, and explicit opt-in AI narrative enrichment with evidence minimization and consent binding.
- Tamper-evident share and forensic `.bbx` archives with strict verification and database-enforced read-only imports.
- Repeatable offline incident demo, measured local performance harness, cross-platform CI definition, clean-install package smoke testing, and release-candidate preflight.
- A production operations runbook covering local deployment, health, capacity, backup/restore, upgrades, logs, and incident handling.
- CodeQL scanning and weekly Dependabot update configuration, with third-party GitHub Actions pinned to immutable revisions.

### Security and privacy

- Sensitive authorization, `x-api-key`, ChatGPT account-routing, and cookie
  headers are excluded from persisted evidence; existing stores are migrated to
  scrub historically retained Anthropic API-key and ChatGPT account-identifier
  fields.
- Control and cockpit services default to loopback with token and origin checks.
- Recorded markup remains inert, optional external analysis is disabled by default, and imported evidence cannot trigger analysis or replay.
- Apache-2.0 licensing and generated third-party notices are included in future runtime package contents.
- Repository install scripts are explicitly reviewed and version-pinned for npm's dependency lifecycle policy.
- Updated the locked development dependency graph to use the patched
  `brace-expansion` 5.0.8 release.
- `blackbox doctor` opens the evidence database without migration and fails on schema, migration-ledger, or SQLite integrity problems.
- Daemon log startup rotation retains one private backup and rejects symlinked or non-file log targets.
- Query and header collection preserves prototype-shaped names without assigning untrusted keys onto ordinary objects.
- Sensitive control files and imported archives are read through stable file descriptors with enforced byte ceilings.

### Fixed

- Recognize OpenAI Responses SSE bodies when an upstream omits the
  `Content-Type` header, including account-authenticated Codex traffic.
- Finalize abandoned recorder exchanges before a wrapped session becomes
  terminal and while the daemon shuts down, so completed sessions can be
  exported immediately without a recovery restart.
- Corrected the minimum Node.js requirement to 22.15.0, the first 22.x release with the Zstandard APIs required by the evidence blob store, and added an explicit `doctor` runtime check.
- Made `blackbox doctor` report unsupported POSIX permission-mode verification as a warning on Windows instead of failing an otherwise healthy installation.
- Made package smoke testing and release preflight invoke JavaScript entrypoints directly so Windows does not attempt to execute npm-generated `.cmd` shims through `execFile`.

### Known limitations

- Standalone Responses WebSocket/Realtime, native Bedrock, Vertex, and Foundry
  transports, and path-bearing upstream gateways are not supported. Wrapped
  Codex sessions use HTTP.
- Agent-specific adapters are not bundled.
- Black Box observes configured API, wrapped-process, and repository boundaries; it is not an operating-system sandbox or universal activity monitor.
- npm publication, signed tagging, and registry installation verification are deferred.
