# Capture model and completeness

Tekrion reports only evidence it can observe. A capture level describes the installed observation boundary; it is not a confidence score.

| Level | Session value     | Setup                                 | Reliably captured                                                                                           | Not guaranteed                                                                   |
| ----- | ----------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| L1    | `api`             | Point a supported client at the proxy | HTTP request/response bytes, supported JSON/SSE events, provider errors and usage                           | Tool execution timing, out-of-band actions, terminal processes or file mutations |
| L2    | `wrapped-process` | `tekrion run -- <command>`            | L1 plus process identity, bounded output, exit state, baseline/final diff and approximate file observations | Agent-internal tool semantics not visible through its API or process             |
| L3    | `adapter`         | Agent-specific adapter or hook        | Evidence explicitly emitted by that integration, potentially including tool lifecycle and approvals         | Provider-hidden prompts, remote state and private model reasoning                |

L2 is the recommended built-in path. The L3 protocol value exists for integrations, but this repository currently provides only an adapter foundation—not a bundled agent-specific adapter. See [Adapter authoring](adapter-authoring.md) for the supported 0.1 session integration contract and its limits.

## Time and filesystem precision

Proxy and process timestamps describe when Tekrion observed a boundary. The recursive filesystem watcher is deliberately labeled `approximate-watcher`: operating systems may coalesce or omit notifications. The terminal baseline-to-final comparison is authoritative for the final workspace effect and is labeled `exact-final-diff`; it does not prove the exact instant of mutation. An adapter can report `exact-adapter` only for lifecycle events it directly observes.

## Context completeness

| Label                        | Meaning                                                                                         |
| ---------------------------- | ----------------------------------------------------------------------------------------------- |
| `exact-client-request`       | The complete captured request carried its context explicitly.                                   |
| `reconstructed-client-chain` | Every locally referenced predecessor was available and linked through client-visible semantics. |
| `partial-client-chain`       | One or more referenced predecessors were missing.                                               |
| `provider-managed-context`   | Remote compaction, hosted tools or other server state can affect effective context.             |
| `unknown-unsupported`        | Tekrion retained evidence but could not interpret the context shape safely.                     |

These labels describe client-visible evidence only. Provider-hidden instructions and internal reasoning remain outside the record.

## Evidence kinds

- `observed`: directly present at a recorded API, process, filesystem or adapter boundary.
- `derived`: produced deterministically from observations, such as normalization, a diff or duration.
- `inferred`: a bounded analytical conclusion with evidence links and limitations.
- `unknown`: missing, unsupported or contradictory evidence prevents a stronger label.

Reports keep the factual timeline separate from the root-cause hypothesis. Blame ranking is evidence-linked inference, not proof of a model's private cause.
