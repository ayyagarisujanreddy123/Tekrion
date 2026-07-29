# ADR 0007: Client-visible context time travel

- Status: Accepted
- Date: 2026-07-20
- Milestone: M6

## Context

A captured model request does not always contain its entire preceding conversation in one body. Chat Completions clients resend message history explicitly, while Responses clients can reference `previous_response_id`, a provider Conversation, or provider-resolved state. A forensic viewer must distinguish locally reconstructable API-visible context from remote state and must never imply access to private model reasoning or provider-hidden instructions.

## Decision

1. Reconstruct context only from retained request bodies, canonical events, and raw-exchange provenance. Every displayed item identifies its source event and exchange, and retained payload references remain navigable through the authenticated viewer.
2. Treat a complete, understood Chat Completions message array or standalone Responses request as `exact-client-request`. Treat a fully local Responses predecessor chain as `reconstructed-client-chain`, and identify absent, incomplete, cyclic, over-depth, or out-of-sequence ancestry as `partial-client-chain` with explicit limitation reasons.
3. Treat Conversation objects, reusable prompt templates, and explicit server context management as `provider-managed-context`. Preserve their client-visible references and variables, but do not claim the resolved remote content. Unsupported protocols, undecodable bodies, and incomplete current request capture use `unknown-unsupported`.
4. Follow the documented Responses rule that a predecessor's top-level `instructions` do not carry through `previous_response_id`. Reconstruct prior request inputs and observable response output items in order, then add only the current request's instructions, tool definitions, and settings.
5. Preserve reasoning items only as opaque markers describing which API-visible fields existed. Never copy encrypted reasoning content into context summaries or manufacture hidden reasoning text.
6. Show provider-reported input tokens separately from a deterministic rough estimate of the reconstructed visible items. Do not infer a model context limit without versioned local metadata.
7. Serve reconstruction through the authenticated event API and expose it only for `model.request` events. The cockpit displays the completeness banner, limitations, ordered items, ancestry, token measures, and clickable event provenance.

## Consequences

- Investigators can distinguish the exact client payload from a locally reconstructed chain and from remote context that Tekrion cannot observe.
- A missing response ID, corrupt ancestry, incomplete capture, reusable prompt, or provider Conversation visibly lowers the claim instead of silently disappearing.
- Reconstruction remains deterministic and offline; it makes no provider call and does not require a tokenizer or model-metadata service.
- The visible-token estimate is useful for comparison but is not presented as provider billing or an exact tokenizer count.
- New provider context mechanisms must receive an explicit parser and completeness policy before they can be labeled exact.
