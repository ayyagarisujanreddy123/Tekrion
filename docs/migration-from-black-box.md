# Migrating from pre-release Black Box builds

Black Box was renamed to Tekrion before the first public npm release. The new
identity is:

| Surface              | Current value                    |
| -------------------- | -------------------------------- |
| Product              | Tekrion                          |
| CLI                  | `tekrion`                        |
| npm packages         | `@tekrion/*`                     |
| Configuration prefix | `TEKRION_*`                      |
| New default archive  | `.tkr` with format `tekrion-tkr` |

The migration is intentionally non-destructive. Tekrion never moves, copies, or
deletes a pre-rebrand evidence store automatically.

## Existing evidence homes

New installations use these defaults:

- macOS: `~/Library/Application Support/Tekrion`
- Windows: `%LOCALAPPDATA%\Tekrion`
- Linux and other Unix systems: `$XDG_DATA_HOME/tekrion`, or
  `~/.local/share/tekrion`

When the Tekrion database does not exist but a pre-rebrand
`blackbox.sqlite` database exists in the old default home, Tekrion reuses that
home and database in place. An explicit `--home` always remains authoritative.
Inside an explicit home, `tekrion.sqlite` wins when present; otherwise an
existing `blackbox.sqlite` is opened.

Direct users of `@tekrion/storage` receive the same treatment for the old
default `blackbox-data` blob directory when `tekrion-data` does not yet exist.
Back up forensic evidence before manually moving either layout.

## Environment variables

Use the new names:

| Current                     | Accepted pre-rebrand alias   |
| --------------------------- | ---------------------------- |
| `TEKRION_HOME`              | `BLACKBOX_HOME`              |
| `TEKRION_UPSTREAM_URL`      | `BLACKBOX_UPSTREAM_URL`      |
| `TEKRION_ANALYSIS_API_KEY`  | `BLACKBOX_ANALYSIS_API_KEY`  |
| `TEKRION_ANALYSIS_MODEL`    | `BLACKBOX_ANALYSIS_MODEL`    |
| `TEKRION_ANALYSIS_BASE_URL` | `BLACKBOX_ANALYSIS_BASE_URL` |
| `TEKRION_ANALYSIS_PROVIDER` | `BLACKBOX_ANALYSIS_PROVIDER` |

When both forms are set, the `TEKRION_*` value wins. The old names are
compatibility aliases and should not be used in new automation.

For one transition period, `tekrion run` also supplies both the current and
pre-rebrand forms of the agent/session metadata variables so existing private
adapters continue to work.

## Proxy and browser compatibility

New integrations should use `x-tekrion-*` session headers and
`/.tekrion/session/` scoped routes. The recorder accepts and strips the old
`x-blackbox-*` headers and parses old `/.blackbox/session/` routes. Conflicting
new and old headers are rejected instead of choosing an ambiguous identity.

The cockpit migrates an existing `blackbox.control-token` session-storage value
to `tekrion.control-token`. The viewer also understands pre-rebrand
`blackbox.ready` and `blackbox.event` SSE frames while the Tekrion daemon emits
the new event names.

## Archive compatibility

New exports use the `.tkr` extension and the `tekrion-tkr` manifest format.
Import remains content-based and accepts pre-rebrand `.bbx` files whose
manifest format is `blackbox-bbx`. Imported legacy investigations receive the
same strict size, path, hash, relationship, read-only, and no-replay checks as
new archives.

The archive extension is a convention rather than the trust boundary. Do not
rename or edit an evidence archive to make it pass verification; Tekrion
validates its contents independently.

## Command and package changes

Replace source commands such as `npm run blackbox -- ...` with
`npm run tekrion -- ...`, and replace installed `blackbox ...` commands with
`tekrion ...`. Package imports move from `@blackbox/*` to `@tekrion/*`.

Because no pre-rebrand npm packages were published, the released CLI does not
ship a second `blackbox` executable or duplicate packages under the old scope.
