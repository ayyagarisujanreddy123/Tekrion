# Black Box CLI

Black Box is a local flight recorder for AI coding agents. It records observable API traffic, model and tool events, process output, and workspace effects, then connects that evidence in a terminal workflow and browser cockpit.

> Registry publication is deferred. Until an official package release is linked from the project repository, use the source quickstart in the full project documentation.

## Requirements

- Node.js 22.15 or newer
- Codex, Claude Code, or another supported client that accepts a custom base URL

## Start recording

```bash
npm install --global @blackbox/cli
blackbox init
blackbox doctor
blackbox run -- codex
blackbox run -- claude
blackbox open
```

Direct Codex and Claude executables are auto-detected. Use `--agent` when a
common npm, pnpm, Yarn, or Bun package runner hides the executable; prefer a
direct agent command over an opaque shell command string. Codex is routed
through a temporary HTTP-only provider that reuses its ChatGPT or API-key login.
Claude receives `ANTHROPIC_BASE_URL` and retains its native OAuth/API-key
selection. Black Box does not need a separate provider credential, and neither
agent's global configuration is edited.

You can also run Black Box as a standalone localhost proxy with `blackbox start`
and point a compatible client at the printed `OPENAI_BASE_URL` or
`ANTHROPIC_BASE_URL`.

## Investigate from the terminal

```bash
blackbox sessions
blackbox inspect <session-id>
blackbox report <session-id>
blackbox export <session-id> --output incident.bbx
```

Deterministic inspection and reporting stay local. Optional AI report enrichment is disabled by default and requires explicit preview and consent. Black Box does not expose private model reasoning, sandbox the wrapped agent, or guarantee visibility into actions outside its capture boundary.

Recordings may contain prompts, source code, tool output, and credentials present in payload bodies. Protect the Black Box data directory and review the selected archive profile before sharing an export.

For the complete quickstart, supported protocols, evidence model, privacy boundaries, and source-development instructions, read the [project documentation](https://github.com/ayyagarisujanreddy123/Black-Box#readme) and [security policy](https://github.com/ayyagarisujanreddy123/Black-Box/security/policy).

Black Box is licensed under Apache-2.0. The full license text is included at `dist/LICENSE`, and notices for dependencies embedded in the browser assets are included at `dist/THIRD_PARTY_NOTICES`.
