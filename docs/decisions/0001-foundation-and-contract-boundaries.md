# ADR 0001: Foundation and contract boundaries

- Status: Accepted
- Date: 2026-07-16
- Milestone: M0

## Context

Tekrion needs to pass raw provider traffic without changing it while also producing normalized evidence that can evolve. The viewer, recorder, storage layer, and future analyzers need a shared vocabulary without becoming coupled to one another's implementation details.

## Decision

1. Use private npm workspaces and strict TypeScript project builds on Node.js 22.15 or newer. This is the first Node.js 22 release that provides the Zstandard APIs required by the evidence blob codec.
2. Keep shared runtime contracts in `@tekrion/protocol` and validate them with Zod.
3. Start every durable top-level contract at `schemaVersion: 1`. Current schemas reject an unsupported required version with a distinct error.
4. Preserve unsupported or malformed records through a typed pointer to the untouched raw blob. Parsing failure must never become evidence loss.
5. Keep canonical event types open-ended so an unknown provider event remains visible without being assigned invented semantics.
6. Make the viewer a dependency leaf. Runtime packages may depend on shared contracts but never on `@tekrion/viewer`.
7. Store golden transport expectations as bytes and ordered chunks, independently from expected canonical events.
8. Pin the checked toolchain in the lockfile. TypeScript 6 is used because the selected TypeScript ESLint release does not yet declare TypeScript 7 compatibility.

## Consequences

- Storage and normalization can be implemented independently after M0.
- A newer record can be retained and later reprocessed by a newer parser.
- Protocol fidelity tests do not depend on normalization succeeding.
- Schema changes require explicit version and fixture review.
- The early CLI remains deliberately limited until lifecycle behavior is implemented and tested.
