# Tekrion CLI

[![npm version](https://img.shields.io/npm/v/@tekrion/cli?logo=npm)](https://www.npmjs.com/package/@tekrion/cli)

Tekrion is a local-first flight recorder for AI coding agents. It records
observable provider traffic, model and tool events, process output, and
workspace effects, then connects that evidence in a terminal workflow and an
authenticated browser cockpit.

The public `@tekrion/cli` package installs the `tekrion` executable and manages
the local daemon, cockpit, recordings, reports, archives, retention, and wrapped
agent lifecycle.

## Requirements

- Node.js 22.15 or newer
- npm 10 or newer
- Codex, Claude Code, or another supported client that accepts a custom base URL

## Install and update

```bash
npm install --global @tekrion/cli@latest
tekrion --version
tekrion --help

# Later updates or removal:
npm update --global @tekrion/cli
npm uninstall --global @tekrion/cli
```

## Start recording

```bash
tekrion init
tekrion doctor
tekrion run -- codex
# or: tekrion run -- claude
tekrion open
```

Direct Codex and Claude executables are auto-detected. Use `--agent codex`,
`--agent claude`, or `--agent openai-compatible` when a common npm, pnpm, Yarn,
or Bun package runner hides the executable. Codex reuses its active ChatGPT or
API-key login through a temporary HTTP-only provider configuration. Claude
receives a session-scoped `ANTHROPIC_BASE_URL` and keeps its native OAuth/API-key
selection. Tekrion does not edit either agent's global configuration.

To investigate from the terminal:

```bash
tekrion sessions
tekrion inspect <session-id>
tekrion report <session-id>
tekrion export <session-id> --output incident.tkr
```

## Commands

| Command                                                                                                    | Purpose                                                                        |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `tekrion init [--home PATH]`                                                                               | Create or verify the private data directory, token, and evidence store         |
| `tekrion start [daemon options]`                                                                           | Start the detached localhost proxy and authenticated control server            |
| `tekrion run [daemon options] [run options] -- <command> [arguments...]`                                   | Record one process, provider traffic, output, and workspace effects            |
| `tekrion open [session-id] [daemon options]`                                                               | Start or reuse the daemon and open the authenticated browser cockpit           |
| `tekrion status [--home PATH] [--timeout-ms MS] [--json]`                                                  | Show daemon, proxy, and recorder health                                        |
| `tekrion stop [--home PATH] [--timeout-ms MS] [--json]`                                                    | Stop the daemon with bounded final cleanup                                     |
| `tekrion doctor [doctor options] [--websocket] [--json]`                                                   | Check runtime, storage, database, ports, upstream, and transport health        |
| `tekrion sessions [--home PATH] [--limit N] [--include-internal] [--json]`                                 | List recorded sessions                                                         |
| `tekrion inspect <session-id> [--home PATH] [--limit N] [--type TYPE] [--cursor CURSOR] [--json]`          | Read a page of canonical events                                                |
| `tekrion report <session-id> [--home PATH] [--target-event EVENT_ID] [--ai] [--json]`                      | Generate a deterministic report or explicitly request AI enrichment            |
| `tekrion export <session-id> --output PATH [--profile share\|forensic] [--max-bytes N] [--force] [--json]` | Create a verified portable `.tkr` archive                                      |
| `tekrion import <archive.tkr> [--home PATH] [--max-bytes N] [--json]`                                      | Verify and install a read-only investigation                                   |
| `tekrion delete <session-id> [--home PATH] [--yes] [--json]`                                               | Preview or apply deletion of one investigation                                 |
| `tekrion prune [--home PATH] [--older-than-days N] [--max-bytes N] [--yes] [--json]`                       | Preview or apply an age/size retention plan; at least one selector is required |

Every command accepts `--help`/`-h`. `--version`/`-v` is global. Valued options
accept `--flag value` or `--flag=value`; boolean options do not take a value.
Child arguments for `run` must follow `--`.

## Options

### Common and lifecycle

| Option            | Commands                                                                                           | Meaning                                                                            |
| ----------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `--home PATH`     | All                                                                                                | Override the private data directory; equivalent to `TEKRION_HOME`                  |
| `--json`          | `status`, `stop`, `doctor`, `sessions`, `inspect`, `report`, `export`, `import`, `delete`, `prune` | Emit one machine-readable JSON result                                              |
| `--timeout-ms N`  | `start`, `open`, `run`, `status`, `stop`                                                           | Bound readiness/control work; defaults to 10,000 ms, except `status` uses 2,000 ms |
| `--help`, `-h`    | Global or any command                                                                              | Print help                                                                         |
| `--version`, `-v` | Global                                                                                             | Print the installed version                                                        |

### Daemon and capture

`start`, `open`, and `run` accept every option below. `doctor` accepts all
except `--shutdown-grace-ms` and `--timeout-ms`.

| Option                           | Default               | Meaning                                                                       |
| -------------------------------- | --------------------- | ----------------------------------------------------------------------------- |
| `--upstream URL`                 | Agent route or OpenAI | Provider origin; overrides `TEKRION_UPSTREAM_URL` and automatic agent routing |
| `--proxy-host HOST`              | `127.0.0.1`           | Recorder proxy listener                                                       |
| `--proxy-port PORT`              | `4141`                | Recorder port; `0` selects a free port                                        |
| `--control-host HOST`            | `127.0.0.1`           | Authenticated control/cockpit listener; loopback only                         |
| `--control-port PORT`            | `4142`                | Control port; `0` selects a free port                                         |
| `--allow-non-loopback`           | Off                   | Permit a non-loopback proxy; control remains loopback-only                    |
| `--capture-queue-max-bytes N`    | `100663296` (96 MiB)  | Total in-memory capture queue                                                 |
| `--max-request-body-bytes N`     | `16777216` (16 MiB)   | Captured bytes per request                                                    |
| `--max-response-body-bytes N`    | `67108864` (64 MiB)   | Captured bytes per response                                                   |
| `--max-chunk-manifest-entries N` | `100000`              | Response-chunk provenance entries per exchange                                |
| `--max-stored-bytes N`           | Unbounded             | Refuse new blobs after the logical store reaches this quota                   |
| `--upstream-timeout-ms N`        | No explicit timeout   | Bound one provider request                                                    |
| `--shutdown-grace-ms N`          | `5000`                | Daemon shutdown grace for `start`, `open`, and `run`                          |

An existing daemon keeps its listener and storage settings. Stop it before
changing daemon-wide configuration.

### Inspection, reports, archives, and retention

| Option                      | Commands              | Meaning                                                                                      |
| --------------------------- | --------------------- | -------------------------------------------------------------------------------------------- |
| `--limit N`                 | `sessions`, `inspect` | Return 1–1,000 items; default `100`                                                          |
| `--include-internal`        | `sessions`            | Include isolated internal AI-analysis sessions                                               |
| `--type EVENT_TYPE`         | `inspect`             | Filter by canonical event type                                                               |
| `--cursor CURSOR`           | `inspect`             | Continue from an opaque `nextCursor`                                                         |
| `--target-event EVENT_ID`   | `report`              | Focus on one tool or filesystem action                                                       |
| `--ai`                      | `report`              | Explicitly send the printed minimized/redacted preflight to the configured analysis provider |
| `--output PATH`             | `export`              | Required archive destination                                                                 |
| `--profile share\|forensic` | `export`              | Redacted `share` (default) or sensitive full-fidelity `forensic` evidence                    |
| `--max-bytes N`             | `export`, `import`    | Archive safety ceiling; default `536870912` (512 MiB)                                        |
| `--force`                   | `export`              | Replace an existing destination                                                              |
| `--older-than-days N`       | `prune`               | Select terminal sessions at least this old                                                   |
| `--max-bytes N`             | `prune`               | Target logical evidence size                                                                 |
| `--yes`                     | `delete`, `prune`     | Apply the displayed plan; both commands are dry runs without it                              |
| `--websocket`               | `doctor`              | Require WebSocket/Realtime support; currently reports unsupported                            |

Deterministic reporting is the default; `--ai` is never implicit. A forensic
archive can contain prompts, source, paths, command output, and secrets present
in captured payloads.

### Wrapped process

| Option                         | Default           | Meaning                                               |
| ------------------------------ | ----------------- | ----------------------------------------------------- |
| `--agent NAME`                 | `auto`            | `auto`, `codex`, `claude`, or `openai-compatible`     |
| `--cwd PATH`                   | Current directory | Child working directory and workspace root            |
| `--max-output-frame-bytes N`   | `262144`          | Stored bytes in one stdout/stderr frame               |
| `--max-untracked-file-bytes N` | `1048576`         | Retained content for one changed untracked file       |
| `--watcher-debounce-ms N`      | `100`             | Approximate live filesystem timing debounce           |
| `--cleanup-timeout-ms N`       | `10000`           | Final workspace capture and recorder settlement bound |

`run` normally preserves the child's exit status and returns `127` when the
child cannot be spawned.

## Environment

| Variable                    | Purpose                                                  |
| --------------------------- | -------------------------------------------------------- |
| `TEKRION_HOME`              | Default data directory                                   |
| `TEKRION_UPSTREAM_URL`      | Default provider origin                                  |
| `TEKRION_ANALYSIS_API_KEY`  | Dedicated credential for explicit `report --ai` requests |
| `TEKRION_ANALYSIS_MODEL`    | Model used for explicit report enrichment                |
| `TEKRION_ANALYSIS_BASE_URL` | Optional OpenAI-compatible Responses endpoint            |
| `TEKRION_ANALYSIS_PROVIDER` | Provider label stored in the disclosure                  |

Do not configure `OPENAI_BASE_URL` or `ANTHROPIC_BASE_URL` as the upstream;
compatible clients use those variables to reach the local recorder.

## Privacy and documentation

Recordings may contain prompts, source code, tool output, filesystem paths, and
credentials present in payload bodies. Protect the Tekrion data directory and
review an archive's profile before sharing it. Deterministic inspection and
reporting stay local. Optional AI enrichment requires dedicated configuration,
a printed preflight, and explicit consent.

The packaged `DISCLOSURE` describes the CLI's dual-use capture capabilities and
authorized-use boundary. For the evidence model, supported protocols, privacy
boundaries, source development, and troubleshooting, read the [complete project
README](https://github.com/ayyagarisujanreddy123/Tekrion#readme) and [security
policy](https://github.com/ayyagarisujanreddy123/Tekrion/security/policy).

Tekrion is licensed under Apache-2.0. The package includes the license at
`dist/LICENSE` and browser dependency notices at `dist/THIRD_PARTY_NOTICES`.
