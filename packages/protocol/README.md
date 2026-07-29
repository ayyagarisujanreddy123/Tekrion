# `@tekrion/protocol`

Versioned runtime contracts for Tekrion evidence, queries, context reconstruction,
analysis, incident reports, and portable archives.

This package contains the shared Zod schemas and TypeScript types used at Black
Box's storage, daemon, CLI, and viewer boundaries. It is primarily a Tekrion
runtime component. Most users should install
[`@tekrion/cli`](https://www.npmjs.com/package/@tekrion/cli) instead.

## Contract rules

- Parse untrusted or persisted values with the exported schemas before use.
- Preserve schema-version and evidence-kind fields when storing or exchanging
  records.
- Treat `observed`, `derived`, `inferred`, and `unknown` as distinct claims.
- Do not infer hidden model context or private reasoning from these contracts.

Schema changes must follow the repository's compatibility and fixture rules. The
canonical event envelope and archive formats are forensic boundaries, not informal
application objects.

## Project links

- [Tekrion repository](https://github.com/ayyagarisujanreddy123/Tekrion)
- [Complete project guide](https://github.com/ayyagarisujanreddy123/Tekrion/blob/main/docs/complete-project-guide.md)
- [Security policy](https://github.com/ayyagarisujanreddy123/Tekrion/security/policy)
- [Apache-2.0 license](https://github.com/ayyagarisujanreddy123/Tekrion/blob/main/LICENSE)
