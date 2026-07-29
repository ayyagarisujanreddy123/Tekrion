# `.tkr` archive format

This document describes `tekrion-tkr` schema version 1. The protocol schemas in `packages/protocol/src/archive.ts` are authoritative.

For compatibility, import also accepts the pre-rebrand `blackbox-bbx` format
commonly stored with a `.bbx` extension. New exports always use
`tekrion-tkr` and `.tkr`; both formats pass through the same verification and
read-only import boundary.

## Container

A `.tkr` file is UTF-8 JSON with a trailing newline:

```json
{
  "schemaVersion": 1,
  "manifest": {},
  "manifestSha256": "<64 lowercase hex characters>",
  "entries": [
    {
      "path": "records/session.json",
      "encoding": "base64",
      "data": "..."
    }
  ]
}
```

The manifest declares the archive ID, export time, profile, source session/status, source storage schema, ordered entries, blob references, record counts, decoded byte total, redaction summary and warnings. Each entry descriptor has a normalized relative path, media type, decoded byte length and SHA-256. Entry paths allow only ASCII letters, digits, `.`, `_`, `/` and `-`; absolute, empty and `..` segments are rejected.

Version 1 reserves these record paths:

- `records/session.json`
- `records/events.jsonl`
- `records/raw-exchanges.jsonl`
- `records/normalization-runs.jsonl`
- `records/file-changes.jsonl`
- `records/context-edges.jsonl`
- `records/analysis-runs.jsonl`
- `records/redactions.jsonl`
- `report/incident-report.json` and `report/incident-report.md` when a report is present
- `blobs/<sha256>.bin` for each forensic payload

JSONL entries are canonical JSON objects separated by `\n` and end with a newline. Empty collections are zero-byte entries. Payload entries occur in the exact order declared by the manifest and use canonical base64.

## Profiles

`share` is the default. It includes one redacted session, canonical events, file-change/context records and the deterministic report. It removes raw exchanges, normalization runs, stored analysis/redaction records and all payload blobs/references. It also minimizes private process/workspace scope and applies the shared recognized-secret rules. This is risk reduction, not a guarantee that the artifact contains no sensitive information.

`forensic` includes exact stored records plus every and only content-addressed blob referenced by them. It can disclose prompts, responses, source, paths, patches, terminal output and credentials present inside payloads.

## Verification and import

Import performs these checks before committing a session:

1. bound both encoded file size and cumulative decoded entry bytes;
2. parse the strict versioned container and canonical base64;
3. recompute the SHA-256 of canonical manifest JSON;
4. recompute every entry length and SHA-256;
5. verify blob ID, digest, length, codec, media type and truncation metadata;
6. require exact paths, profile contents, counts, unique identifiers and same-session relationships;
7. require the Markdown report to equal the Markdown embedded in its JSON result;
8. reject an existing session or globally conflicting evidence ID;
9. write all records transactionally and mark the session `imported-readonly`.

Database triggers prevent inserts, updates and direct child-record deletion for imported evidence. Deleting the whole imported session remains explicit and supported. Import never executes a recorded tool or process, and optional AI analysis is disabled for imported sessions.

SHA-256 makes accidental corruption and unsophisticated modification evident. It does not authenticate the author: an attacker able to rewrite the file can recompute all hashes. Use a trusted transfer channel or a detached signature when origin matters.

The CLI default safety limit is 512 MiB. Use `--max-bytes` to choose a lower or explicitly higher bound. Export refuses an existing destination unless `--force` is supplied and publishes through a private temporary file.
