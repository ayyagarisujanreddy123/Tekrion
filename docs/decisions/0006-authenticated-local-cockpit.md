# ADR 0006: Authenticated local evidence cockpit

- Status: Accepted
- Date: 2026-07-16
- Milestone: M5

## Context

Canonical evidence is useful from the terminal, but an investigator needs to browse a session while the recorder is still appending to SQLite. Exposing a localhost HTTP service creates a browser security boundary: another web origin must not gain evidence access, recorded content must not execute, credentials must not enter URLs sent to the API, and a slow live viewer must not create unbounded daemon work. The viewer also has to ship with the CLI without making runtime packages depend on the React application.

## Decision

1. Define versioned query contracts in `@tekrion/protocol` and expose read-only service methods for session pages, event pages and details, file changes, FTS search, bounded payload bytes, and daemon health. Validate identifiers, cursors, filters, limits, and response envelopes at the boundary.
2. Serve query routes from the loopback-only control listener. Keep bearer authentication mandatory for every `/v1/*` evidence and control route, validate the request `Host`, and reject untrusted browser `Origin` values before routing. Return inert payload bytes with `nosniff` and download-safe content disposition rather than replaying recorded media types as active content.
3. Stream live evidence as bounded server-sent events ordered by canonical session sequence. Accept an `after` cursor or matching `Last-Event-ID`, replay committed rows after that sequence, poll for later commits, emit heartbeats, cap concurrent streams, and destroy a connection whose writes remain backpressured beyond the configured deadline.
4. Keep the viewer a dependency leaf. Build its static assets separately, copy the production output into the CLI distribution, load only a bounded `index.html` plus allow-listed JavaScript/CSS files into daemon memory, and serve only `GET`/`HEAD` with restrictive CSP, framing, referrer, permissions, and cross-origin headers.
5. Allow the static shell itself to load without bearer authentication so it can bootstrap in a normal browser navigation; do not make any evidence anonymously readable. The shell calls evidence APIs with the bearer token in the `Authorization` header and omits credentials/caches on fetches.
6. Implement `tekrion open [session-id]` as the local auth transfer. Start or reuse the daemon, verify an optional session exists, refuse any non-loopback control origin, place the per-install token and selected session only in the URL fragment, open the system browser, then remove the fragment from browser history and retain the token in origin-scoped session storage. Never print the token or authenticated URL in normal CLI output.
7. Render recorded values as React text or inert JSON/preformatted bytes. Provide bounded timeline rendering, an accessible full-list mode, keyboard selection, timestamp modes, explicit evidence/completeness labels, and inspector views for normalized data, raw payload references, excluded headers, provenance, and file diffs.

## Consequences

- A browser can refresh or reconnect from its last canonical sequence without losing events committed while it was offline.
- The viewer can read SQLite in WAL mode while capture continues, but query payload sizes, page sizes, stream count, and slow-client write time remain bounded.
- A hostile site can navigate to the public cockpit shell, but it cannot read recordings without the random local token and cannot use a cross-origin browser request against the authenticated API.
- The long-lived per-install token briefly exists in the URL fragment passed to the browser and then in that tab's session storage. It is never sent in an HTTP request target, persisted in Tekrion evidence, placed in the daemon lock, or printed by the CLI.
- Packaged viewer startup fails closed if its expected assets are absent, empty, oversized, or outside the asset-name allow-list. Source application code remains outside daemon and CLI runtime dependency graphs.
- The cockpit exposes recorded evidence and provenance; context time travel, blame ranking, reports, retention policy, and WebSocket/Realtime capture remain later milestones.
