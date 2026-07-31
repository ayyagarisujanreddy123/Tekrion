## Summary

Describe the problem and the focused change that addresses it.

## Evidence and compatibility

- What observable evidence, storage, archive, protocol or cockpit behavior changes?
- Are observed, derived, inferred and unknown values still clearly separated?
- Does this require a schema version, migration or compatibility note?

## Verification

List the exact commands and manual checks run.

```text
npm run check
```

## Checklist

- [ ] The change is focused and documented.
- [ ] Tests cover the relevant success and failure behavior.
- [ ] No credentials, private evidence, local databases or generated daemon files are included.
- [ ] Security, privacy and capture limitations remain accurate.
- [ ] Package or protocol changes include migration and release-note updates where required.
