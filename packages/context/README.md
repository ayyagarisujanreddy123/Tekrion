# `@tekrion/context`

Client-visible model-context reconstruction for Tekrion investigations.

The package reconstructs explicit request context and locally retained Responses
ancestry, attaches provenance, and reports a completeness label when evidence is
missing, unsupported, or provider-managed. It does not claim access to hidden
prompts, chain-of-thought, or private model state.

This is primarily a Tekrion runtime component. Most users should install
[`@tekrion/cli`](https://www.npmjs.com/package/@tekrion/cli) instead.

## Completeness labels

- `exact-client-request`
- `reconstructed-client-chain`
- `partial-client-chain`
- `provider-managed-context`
- `unknown-unsupported`

Consumers should display the label and limitation reasons alongside reconstructed
items. A partial or provider-managed result must never be presented as complete.

## Project links

- [Tekrion repository](https://github.com/ayyagarisujanreddy123/Tekrion)
- [Capture model](https://github.com/ayyagarisujanreddy123/Tekrion/blob/main/docs/capture-model.md)
- [Security policy](https://github.com/ayyagarisujanreddy123/Tekrion/security/policy)
- [Apache-2.0 license](https://github.com/ayyagarisujanreddy123/Tekrion/blob/main/LICENSE)
