# ADR 0010: Tamper-evident archives and explicit retention

- Status: Accepted
- Date: 2026-07-20
- Milestone: M9

## Context

An investigation must be portable without quietly broadening the privacy boundary or weakening the evidence model. A shared artifact needs enough structure to detect corruption, a full-fidelity transfer must preserve raw bytes, and an imported investigation must not become a replay surface. Local recordings also need predictable deletion and capacity controls without removing an active capture or leaving unreferenced payloads behind.

## Decision

1. Use a versioned, self-contained `.tkr` JSON container with a canonical manifest, ordered entry descriptors, base64 payloads, per-entry SHA-256 hashes, and a SHA-256 hash of the manifest. Bound the encoded file and decoded entry total before importing it, and reject unexpected, missing, duplicate, non-canonical, or traversal-capable paths.
2. Make `share` the default export profile. It removes raw exchanges and payload bytes, clears filesystem scope and upstream identifiers, strips payload references, and applies the shared secret-redaction rules to the retained session, events, context, and deterministic report. Include a disclosure describing omitted evidence and applied rules.
3. Require an explicit `forensic` profile for full-fidelity transfer. Preserve exact raw exchange records, normalization runs, stored analysis and redaction records, and every referenced content-addressed blob. Warn that this profile can contain prompts, source, paths, output, and credentials that were present in payload bodies.
4. Export only settled sessions. Refuse to overwrite an archive unless `--force` is explicit, write through a private temporary file, and publish atomically. Generate both JSON and Markdown forms of the same deterministic report inside the archive.
5. Verify the entire archive before opening a write transaction. Re-parse every record, validate counts and cross-record ownership, require exact blob coverage and matching blob metadata, compare the JSON and Markdown report representations, and reject an existing session or globally duplicated record ID.
6. Mark imported sessions `imported-readonly`. Enforce immutability with SQLite triggers, bypass report-cache writes, disable optional AI analysis for imported evidence, and expose no replay operation. Deletion remains available as the deliberate escape hatch.
7. Make session deletion and retention pruning plan-first. A command without `--yes` is a dry run. Never select an active session, include linked internal analysis sessions, revalidate the plan at execution time, delete transactionally, and garbage-collect only blobs with no remaining database references.
8. Offer both age and logical-byte retention targets. Count record bytes plus distinct referenced stored blobs, explain when active evidence prevents satisfying a size target, and allow a daemon blob-store ceiling that refuses new payload blobs rather than silently evicting evidence.

## Consequences

- A recipient can detect accidental corruption and modifications to a self-contained archive before any record is imported.
- SHA-256 integrity is not authorship or authenticity. Because `.tkr` archives are not signed, an attacker who can rewrite an archive can also recompute its hashes; provenance still depends on a trusted transfer channel or an external signature.
- The default artifact is useful for review while materially reducing disclosure, but redaction is necessarily rule-based and cannot guarantee that arbitrary secrets or sensitive prose are absent. Investigators must inspect an archive before sharing it.
- Full-fidelity imports preserve evidence without turning Tekrion into an action-replay system, and database-level guards cover callers outside the CLI.
- Capacity pressure is visible and explicit. Operators choose what to remove, while active captures and blobs shared by retained sessions remain protected.
