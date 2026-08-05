# Production operations

Tekrion is a single-user, local application. A production deployment means a
reviewed installation on a developer workstation or a dedicated private account,
with its proxy, control API, and evidence cockpit kept off public networks. It is
not a hosted multi-user service and must not be exposed directly to the Internet.

This runbook covers initial deployment, health checks, retention, backup, upgrade,
and incident handling. Read the [privacy guide](privacy.md) and
[security policy](../SECURITY.md) before recording real work.

## Deployment boundary

- Use Node.js 22.15.0 or newer on a currently supported operating system.
- Run Tekrion as the user who owns the recorded workspace. Do not run it as
  `root`, Administrator, or a shared service account.
- Put `TEKRION_HOME` on a private local disk. Do not use a shared, synchronized,
  or publicly mounted directory for live SQLite and blob data.
- Keep the control API and cockpit on their enforced loopback listener. Keep the
  proxy on its default loopback listener as well. `--allow-non-loopback` is an
  exceptional escape hatch, not a deployment recommendation.
- Treat the evidence home, forensic exports, backups, and operational logs as
  sensitive. They can contain prompts, source, paths, command output, and model
  responses even though known credential headers are excluded.
- Tekrion records an agent; it does not sandbox or authorize the agent's actions.

## Install a reviewed build

The seven runtime manifests are prepared for public access, but no package has
been published and manifest state is not publication authorization. Until npm
identity and current scope access are confirmed and a registry release is
independently verified, operate a reviewed source commit:

```bash
git clone https://github.com/ayyagarisujanreddy123/Tekrion.git
cd Tekrion
git checkout <reviewed-full-commit-sha>
npm ci
npm run check
npm run build
npm run tekrion -- --version
```

Use `npm run tekrion --` in place of `tekrion` for the remaining commands in this
runbook. Do not deploy a moving branch name without recording its immutable commit
SHA and successful CI run.

After an official npm release has passed the registry-install checks in the
[release runbook](npm-release-runbook.md), an installed deployment can use:

```bash
npm install --global @tekrion/cli@<verified-version>
tekrion --version
```

Do not use an unpublished package name or an unverified prerelease tag for a
production installation.

## Initial bring-up

Choose the evidence home and the storage ceiling before the first real capture.
The example ceiling below is 10 GiB; size it for the sensitivity and workload of
the installation.

```bash
export TEKRION_HOME="/private/local/path/tekrion"
tekrion init
tekrion doctor --upstream https://api.openai.com
tekrion start \
  --upstream https://api.openai.com \
  --max-stored-bytes 10737418240
tekrion status --json
```

On Windows, set `TEKRION_HOME` with the shell's normal environment-variable
syntax. `doctor` warns that Node.js cannot verify POSIX owner/group/other modes;
use Windows account and directory access controls to protect the home.

Start flags are runtime configuration, not persisted configuration. Use the same
reviewed upstream, limits, ports, and home whenever the daemon is restarted.
Never place credentials in the upstream URL.

For normal use, prefer the wrapper because it adds process and workspace evidence:

```bash
tekrion run --cwd /path/to/workspace -- codex
tekrion run --cwd /path/to/workspace -- claude
```

Direct Codex and Claude executables are detected automatically. Use
`--agent codex`, `--agent claude`, or `--agent openai-compatible` when a common
npm, pnpm, Yarn, or Bun package runner hides the executable. Prefer a direct
agent command over an opaque shell command string, which cannot be rewritten
safely. Codex receives a temporary HTTP-only recorder provider that reuses its
active ChatGPT or API-key authentication. Tekrion selects the matching OpenAI
backend from the request in memory. Claude receives `ANTHROPIC_BASE_URL` and
keeps its native OAuth/API-key credential precedence. Each session pins its
validated routing mode, so one daemon can safely serve concurrent or sequential
Codex and Claude sessions. An explicit `--upstream` always wins and disables
automatic first-party routing for that session.

Tekrion never needs the Codex or Claude credential itself. Verify the native
login before a valuable capture with `codex login status` or
`claude auth status`; do not paste the result into Tekrion. For a Codex
`CODEX_API_KEY` one-shot run, set that variable only on the wrapped `codex exec`
invocation, following Codex's own credential-handling guidance.

The child must honor its selected base URL for provider-traffic capture. If it
ignores that setting, process and workspace evidence can still exist while API
evidence is absent. Native Bedrock, Vertex, and Foundry transports, hosted
web/cloud sessions, IDE sessions not launched by the wrapper, standalone OpenAI
WebSocket/Realtime, and gateways that require a path-bearing upstream URL are
outside the supported production boundary. The Codex wrapper disables
WebSockets for that run and uses the supported HTTP transport.

## Health and readiness

Run these checks before a valuable capture and after an upgrade:

```bash
tekrion doctor --upstream https://api.openai.com --json
tekrion status --json
```

`doctor` checks the Node runtime, private writable layout, SQLite migration ledger
and integrity in read-only mode, control token, daemon lock, listener availability,
upstream reachability, capture limits, and known transport limits. Warnings are
reported separately from failures; the WebSocket/Realtime warning is expected when
that transport is not required.

For automated readiness, parse JSON and require all of the following:

- `doctor.ok` is `true`;
- the `database` check is `pass` after initialization;
- daemon `state` is `ready`;
- proxy `status` is `healthy`.

Do not rely only on the `status` process exit code: a daemon that is still starting
can return successfully before it is ready. Tekrion intentionally has no
telemetry or remote monitoring endpoint. Monitoring must remain on the same host
and must not copy evidence or the control token into a central log service.

## Data locations and permissions

The default home is platform-specific and can be replaced with `--home` or
`TEKRION_HOME`:

| Platform   | Default home                                                                 |
| ---------- | ---------------------------------------------------------------------------- |
| macOS      | `~/Library/Application Support/Tekrion`                                      |
| Windows    | `%LOCALAPPDATA%\Tekrion`                                                     |
| Linux/Unix | `${XDG_DATA_HOME}/tekrion` when absolute, otherwise `~/.local/share/tekrion` |

The home contains the control token, daemon lock, SQLite database and side files,
content-addressed blobs, migration backups, and daemon logs. POSIX directories are
kept at mode `0700` and sensitive files at `0600`. Do not edit SQLite, its WAL/SHM
files, blob names, or the lock file by hand.

## Capacity and retention

`--max-stored-bytes` is a refusal ceiling, not automatic eviction. When the ceiling
is reached, Tekrion preserves existing evidence and refuses additional blob
writes rather than silently deleting older sessions.

Review retention plans before applying them:

```bash
tekrion prune --older-than-days 30
tekrion prune --max-bytes 5368709120
tekrion prune --older-than-days 30 --max-bytes 5368709120 --yes
```

Commands without `--yes` are dry runs. Active sessions are protected, linked
analysis evidence is handled with its source session, and unreferenced blobs are
collected only after transactional deletion. Re-run `doctor` after storage errors
or an unclean host shutdown.

## Backup and restore

For a completed investigation, a forensic `.tkr` export is the preferred portable
backup unit:

```bash
tekrion export <session-id> \
  --profile forensic \
  --output /private/backup/session-id.tkr
```

A share-profile archive is deliberately minimized and is not a full backup. Verify
that an archive can be read before depending on it, protect forensic archives like
the original home, and never attach real evidence to a public issue.

For whole-install disaster recovery:

1. Run `tekrion stop` and confirm `tekrion status --json` reports `stopped`.
2. Copy the entire home as one unit, including SQLite side files, blobs, logs, and
   the control token. Do not copy only `tekrion.sqlite` from a live daemon.
3. Store the snapshot encrypted with access limited to the owning user or recovery
   operators.
4. Rehearse restoration on an isolated host with the same or a newer compatible
   Tekrion version.
5. Restore only while the daemon is stopped, preserve private permissions, then
   run `tekrion doctor` before starting it.

The database-only files under `data/backups/` protect migration steps; they do not
include external blobs and are not complete disaster-recovery backups. Never merge
two evidence homes or open an upgraded database with an older application.

## Upgrade and rollback

1. Finish active captures and stop the daemon.
2. Create a forensic export of critical sessions and a stopped whole-home snapshot.
3. Record the current application version and commit/package integrity.
4. Install the reviewed new version and run its full source or registry validation.
5. Run `tekrion init`; this applies supported forward migrations with a database
   backup when required.
6. Run `tekrion doctor`, start with the previously reviewed runtime flags, and
   require healthy JSON status.
7. Perform a disposable capture and verify sessions, inspection, report, export,
   stop, and restart before resuming critical work.

Application rollback is unsafe after a schema migration. Restore the stopped
whole-home snapshot with the matching older version instead. Preserve the failed
upgrade copy for investigation.

Provider-support migrations remove historically retained `x-api-key`,
`ChatGPT-Account-ID`, and `Anthropic-Organization-ID` fields from active
raw-exchange header records. A private pre-migration database backup can still
contain the earlier bytes. Protect or retire that backup according to your
credential and personal-data retention policy, and rotate an Anthropic key if it
was previously routed through an older Tekrion build.

## Operational logs

The daemon writes bounded lifecycle and error summaries to `logs/daemon.log`; it
does not intentionally log request headers or bodies. At daemon startup, a log at
or above 1 MiB is moved to `daemon.log.1`, the previous backup is removed, and both
files are kept private. Symlinked and non-file log targets are rejected. The active
file can grow until the next restart, so include both files in local disk checks.

Treat logs as sensitive despite their narrow content. Do not forward them to a
shared log processor without review, and never paste them publicly without checking
for paths, provider origins, and error text.

## Incident response

If integrity, unexpected exposure, or unsafe agent behavior is suspected:

1. Stop the daemon and the wrapped agent without deleting evidence.
2. Record the Tekrion version, source SHA, host time, `doctor --json`, and
   `status --json` output in a private incident record.
3. Preserve a stopped whole-home snapshot and forensic exports of relevant
   completed sessions. Hash copies using the organization's approved tooling.
4. Review `daemon.log` and `daemon.log.1` locally. Do not run repair SQL or bypass a
   failed archive integrity check.
5. If credentials could appear in bodies, source, output, exports, or optional-AI
   disclosure, rotate them at their issuing systems; header exclusion is not a
   guarantee that credentials never entered other evidence fields.
6. Report product vulnerabilities through the private process in
   [SECURITY.md](../SECURITY.md), not a public issue with evidence attached.

## Production acceptance checklist

- [ ] Deployment is tied to an immutable reviewed commit or verified package.
- [ ] The full local gate and matching GitHub CI/CodeQL runs pass.
- [ ] The process runs as a dedicated private user, not a privileged account.
- [ ] Home, backup, and export locations are private local storage.
- [ ] Control, cockpit, and proxy listeners remain on loopback.
- [ ] `doctor` passes, including the read-only database integrity check.
- [ ] JSON status reaches `ready` with a healthy proxy.
- [ ] Capture and storage byte limits are explicit and appropriate.
- [ ] Retention, stopped backup, restore rehearsal, and upgrade ownership are set.
- [ ] Known protocol, privacy, redaction, and sandbox limitations are accepted.
- [ ] Any npm-based deployment uses independently verified registry artifacts;
      otherwise an immutable reviewed source commit is used.
