# Contributing to Tekrion

Tekrion handles forensic evidence. Changes must preserve raw data, label uncertainty honestly, and never weaken credential-exclusion rules for convenience.

## Setup

Use Node.js 22.15 or newer and npm 10 or newer:

```bash
npm install
npm run check
```

Run a focused test while iterating, then run the full gate before handing work off:

```bash
npx vitest run packages/protocol/test/contracts.test.ts
npm run check
```

## Contract changes

- Treat `packages/protocol` as the only source of shared evidence shapes.
- Do not change a released meaning in place. Add a schema version and migration path.
- Keep outer evidence envelopes strict; provider-specific unknown data belongs in a raw blob or an explicitly opaque summary.
- Preserve observed, derived, inferred, and unknown as separate evidence kinds.
- Missing usage is `null` or `unknown`, never zero.
- Authorization, cookies, and proxy credentials must never enter persisted-header types.
- Runtime packages must not import from `apps/viewer`.

## Golden protocol fixtures

Every supported protocol behavior needs:

1. exact expected request bytes;
2. ordered response chunks and exact expected response bytes;
3. expected canonical events;
4. failure/completeness metadata where relevant;
5. a test explaining the behavior being protected.

Parser or proxy behavior that changes a golden fixture requires deliberate review. Do not regenerate snapshots merely to make a failure disappear.

## Definition of done

A change is ready when formatting, lint, typecheck, tests, and build pass; relevant failure behavior is covered; and documentation still states capture limitations accurately.
