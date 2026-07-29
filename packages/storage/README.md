# `@tekrion/storage`

The storage package is the durable local Tekrion evidence journal. It can be used
independently of the daemon and viewer, although it is primarily a Tekrion
runtime component. Most users should install
[`@tekrion/cli`](https://www.npmjs.com/package/@tekrion/cli) instead.

```ts
import { openTekrionStorage } from "@tekrion/storage";

const storage = await openTekrionStorage({
  databasePath: "/path/to/tekrion.sqlite",
  dataDirectory: "/path/to/tekrion-data",
});

try {
  console.log(storage.schemaVersion, storage.recovery);
} finally {
  storage.close();
}
```

Opening a writable store enables WAL, validates the migration ledger, applies
pending migrations after a backup, removes orphan temporary blobs, and marks
interrupted exchanges as incomplete. Pass `allowNewerReadOnly: true` only when
query-only access to a future schema is preferable to a compatibility error.
Pass `readOnly: true` to require an existing database, skip directory creation and
migrations, enable SQLite query-only mode, and verify the recorded migration
checksums. This is the appropriate path for non-mutating health inspection.

Blob reads always verify stored length, decoded length, and SHA-256.
`unsafeDatabase` exists for diagnostics and low-level tests; application code
should use the repositories. Do not write directly to the database or blob
directory from another process.

## Project links

- [Tekrion repository](https://github.com/ayyagarisujanreddy123/Tekrion)
- [Storage architecture](https://github.com/ayyagarisujanreddy123/Tekrion/blob/main/docs/decisions/0002-crash-safe-local-journal.md)
- [Security policy](https://github.com/ayyagarisujanreddy123/Tekrion/security/policy)
- [Apache-2.0 license](https://github.com/ayyagarisujanreddy123/Tekrion/blob/main/LICENSE)
