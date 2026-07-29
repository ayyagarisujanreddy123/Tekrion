# ADR 0005: Wrapped process and bounded workspace evidence

- Status: Accepted
- Date: 2026-07-16
- Milestone: M4

## Context

API-visible requests explain what an agent and model exchanged, but they do not prove which process ran or what changed on disk. A final Git diff alone also cannot distinguish pre-existing dirt from a child effect, order changes during a run, or describe non-Git workspaces. Conversely, a portable filesystem watcher is not an exact mutation log and must not be presented as one. The wrapper needs useful evidence without following unsafe symlink boundaries, retaining unbounded file contents, changing child exit behavior, or abandoning the final snapshot on Ctrl-C.

## Decision

1. Make `tekrion run -- <command...>` the L2 capture surface. Start or reuse the daemon, create one explicit wrapped-process session, inject a session-scoped internal proxy route through `OPENAI_BASE_URL`, and strip that internal route before forwarding or raw persistence.
2. Journal command identity, cwd, PID, exit code or signal, and ordered stdout/stderr frames. Preserve output bytes in bounded content-addressed blobs and mirror them to the invoking terminal. Return the child's exit status even when recorder evidence is incomplete.
3. Capture the workspace before spawning. Detect the containing Git root when available, retain HEAD and a hash of porcelain status, and store a sorted path/mode/mtime/size/SHA-256 manifest. For a non-Git directory, use the requested cwd as the root.
4. Compute authoritative effects by comparing the baseline and final manifests, not by comparing only final state with HEAD. This prevents unchanged pre-existing modifications and untracked files from being blamed on the child. Emit `exact-final-diff` create, modify, delete, and unique same-content rename records with before/after hashes.
5. For a tracked path that was clean at baseline, retain a per-change `git diff --binary --full-index` patch with external diff and text conversion disabled. Use a deterministic base64 file-delta envelope for bounded untracked, baseline-dirty, and non-Git content. If content or aggregate limits are reached, retain metadata and hashes only and label the change truncated.
6. Stream hashes instead of buffering large files. Bound manifest entries, in-memory snapshot content, persisted change payload bytes/count, Git output, watcher paths/samples/errors, and per-file content. Treat common credential/private-key paths as hash-only evidence.
7. Run a recursive debounced watcher for best-effort timing. Hash observed states, coalesce a quiet batch, pair unique same-content delete/create observations as renames, and persist these events as `approximate-watcher`. Keep them distinct from final exact events; duplication across the two precision classes is intentional evidence, not two proven mutations.
8. Restrict observation to the canonical workspace root. Exclude `.git`, dependencies, build/cache output, the Tekrion home, and Git-ignored untracked paths. Record symlink metadata and target text without following directory symlinks; reject watcher paths whose canonical parent differs from the lexical in-root parent.
9. Forward SIGINT and SIGTERM to the child and keep the parent alive for cleanup. Bound watcher drain, streaming hashes, Git subprocesses, final event persistence, and snapshot work with an abort signal and configurable cleanup deadline. Always remove signal listeners and close the watcher before storage.
10. Persist watcher/scanner failures as `workspace.error` evidence and report incomplete process evidence on stderr without replacing the child's result. Snapshot summaries and session metadata retain capture configuration and explicit limitation reasons.

## Consequences

- One wrapped session can connect API exchanges, process output, and concrete repository effects with durable sequence ordering.
- A tracked deletion has a before hash and an applicable binary-capable patch, while oversized or sensitive-path content remains absent from blobs.
- Investigators can use watcher timestamps for approximate ordering and final events for authoritative end state without confusing either with OS-level audit telemetry.
- Fast transient changes may be observed when watcher delivery and immediate sampling permit, but portable watchers can still coalesce or omit events. The final diff cannot recover an effect that left no final state.
- Writes outside the workspace, effects reached through directory symlinks, subprocess ancestry, and the identity of the actor that performed a write are outside this capture claim.
- Final capture is deliberately bounded. A timeout leaves explicit error evidence and process/session termination evidence rather than allowing indefinite cleanup.
