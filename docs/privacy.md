# Privacy and data handling

Black Box is a local recorder for sensitive engineering evidence. Local-first operation reduces transmission, but it does not make recorded prompts, source or output harmless.

## Stored locally

Depending on capture level and configured bounds, the private Black Box home can contain:

- session and process metadata, including command, working directory and repository root;
- API method/path/query metadata and bounded request/response bodies;
- normalized messages, tool calls/results, errors and usage;
- bounded stdout/stderr payloads;
- workspace manifests, hashes, file paths and bounded content or patches;
- deterministic context, blame, anomaly and report results;
- explicit optional-AI attempt metadata and the minimized snapshot used for that attempt.

SQLite uses WAL mode and payloads use a content-addressed blob store. The home, token, database and exported archives are created with restrictive permissions where the host supports POSIX modes. On Windows, `blackbox doctor` verifies that storage and the control token are usable but warns that Node.js cannot verify POSIX owner/group/other mode separation; protect the account and profile directory with appropriate Windows access controls. Set the location with `--home` or `BLACKBOX_HOME`.

Operational daemon output is limited to lifecycle and error summaries rather than request headers or bodies. On startup, `daemon.log` rotates at 1 MiB to one private `daemon.log.1` backup, and symlinked or non-file log targets are refused. Logs can still contain local paths, provider origins, or error text and must be handled as sensitive.

## Credentials and redaction

Authorization, `x-api-key`, `ChatGPT-Account-ID`, proxy-authorization, cookie,
set-cookie and configured sensitive header values are excluded from persisted
header evidence. The ChatGPT account identifier is used only in memory to route
Codex account traffic. Credentials may still appear inside request bodies,
model text, source files, tool output or terminal output. Known credential
filenames are hash-only, oversized file content is omitted, and recognized
secret patterns are redacted before optional AI transmission or `share` export.

Provider-support storage migrations scrub historically retained `x-api-key` and
ChatGPT account-identifier header fields from the active database. A private
database backup created before either migration preserves the pre-migration
state and can still contain those bytes. Protect or retire it under the same
credential and personal-data handling policy as a forensic archive.

Redaction is rule-based. It recognizes private-key blocks and common OpenAI, GitHub, AWS, JWT, bearer and named credential forms, plus structurally named secret fields. It cannot guarantee that arbitrary secrets, personal data or sensitive prose are absent. Review every artifact before sharing it.

The `share` archive profile also removes raw exchanges, payload blobs, command/repository/upstream fields, process arguments and known absolute workspace-scope fields. The `forensic` profile preserves full evidence and should be handled like the original Black Box home.

## Network behavior

Normal recorded API traffic is forwarded to the upstream selected by the user; this is the agent's intended network call. The cockpit and control API bind to loopback and require a private local token. Black Box has no telemetry or cloud sync.

Context reconstruction, blame, anomalies and deterministic reports make no model call. Optional report enrichment is disabled by default and requires dedicated `BLACKBOX_ANALYSIS_*` configuration plus an explicit preflight/consent action. The preflight shows provider, model, prompt version, categories, byte counts, redaction rules and a consent fingerprint. Black Box sends only that minimized snapshot with provider storage disabled and records whether external evidence was sent. Imported archive sessions cannot invoke optional AI analysis.

## Retention and deletion

`blackbox delete` and `blackbox prune` are dry runs unless `--yes` is supplied. Active sessions are protected, linked internal analysis sessions are included, and unreferenced blobs are collected after transactional deletion. `--max-stored-bytes` refuses new blobs over a configured ceiling; it does not silently evict old evidence.

Deleting a session and collecting its unreferenced blobs removes it from the Black Box store, but it cannot erase copies in filesystem backups, exported archives, logs outside Black Box or artifacts already transmitted to another party or provider.
