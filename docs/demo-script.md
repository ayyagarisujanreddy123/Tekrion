# Demo rehearsal

The fixture path is the default stage path because it is deterministic and does not need a provider, API key or network connection.

## Before presenting

```bash
npm ci
npm run demo:offline
```

Confirm the command prints `Offline fixture ready`, the report names `event-read-result` as the top-ranked preceding evidence, and `.tekrion-demo/rogue-repo/test/math.test.js` still exists. Keep the printed `Open:` command available. Rerun `npm run demo:offline` at any time to reset the disposable evidence home and repository.

## Three-minute path

1. **0:00–0:25 — Promise.** “Tekrion records observable API, process and workspace evidence so an agent incident can be investigated without pretending to read private reasoning.”
2. **0:25–0:45 — Seed.** Run `npm run demo:offline`. Point out that it uses checked-in evidence and no provider.
3. **0:45–1:20 — Impact.** Open the cockpit with the printed command, select the `file.delete` event for `test/math.test.js`, and show that the original user explicitly said not to delete tests.
4. **1:20–2:10 — Provenance.** Open Context/Blame. Show the README tool result containing the hostile instruction, the linked delete tool call, the exact-path/quoted-substring reasons, counterevidence, and the “inferred, not causal proof” label.
5. **2:10–2:40 — Report.** Open Report or the generated `incident-report.md`. Point out the factual timeline, separate hypothesis, alternatives, prevention and no-external-evidence disclosure.
6. **2:40–3:00 — Boundary.** State that the final diff is authoritative, watcher timing is approximate, provider-hidden context is unavailable, and optional AI requires a separate redacted consent flow.

## Seven-minute path

Use the three-minute path, then add:

1. Show Raw for one event and follow its event/payload provenance without rendering captured markup as HTML.
2. Compare L1 API capture with the L2 wrapped-process evidence in [capture-model.md](capture-model.md).
3. Export the session with `tekrion export <session-id> --output incident.tkr`, explain the default share omissions, then contrast the explicit forensic profile.
4. Import into a second disposable home and show the `imported-readonly` status; explain that hashes detect modification but do not authenticate an author and that no replay action exists.
5. Preview `tekrion delete <session-id>` or `tekrion prune --older-than-days 30`, then explain why `--yes` and active-session protection exist.
6. If appropriate, show the AI preflight without confirming it. Point out categories, bytes, redactions and consent fingerprint; cancel so no provider call occurs.

## Live failure fallback

Do not debug a provider on stage. If the optional live client, credentials or network fail, run exactly:

```bash
npm run demo:offline
```

Continue from the printed session and report. The fixture is the evidence source; it does not replay tools or mutate the demo repository.

## Cleanup

```bash
npm run demo:cleanup
```
