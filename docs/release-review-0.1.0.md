# Tekrion 0.1.0 release review

Status: **local source and package artifact review passed**

- Review date: 2026-08-15 CDT / 2026-08-15 UTC
- Reviewed runtime source commit: `c6e215c1202b032897149e80fe1394160819579e`
- Version: `0.1.0`
- Runtime: Node.js 22.20.0 on macOS 25.5.0 x64

This record closes the manual tarball and privacy review required before release
preparation. It does not authorize a push, npm publication, tag, or GitHub
release. Registry verification and exact-final-SHA CI remain external release
operations.

## Source and dependency gates

- Formatting, ESLint, strict TypeScript, all 339 unit tests, the production
  build, and both packaged end-to-end tests passed.
- All 26 focused storage tests passed with `better-sqlite3` 13.0.3.
- The npm high-severity audit reported zero vulnerabilities.
- `better-sqlite3` 13.0.3 replaces its deprecated transitive installer with an
  N-API build, removing 35 transitive packages. The upstream release notes
  describe the packaging change and Node-version-independent prebuild goal in
  [v13.0.0](https://github.com/WiseLibs/better-sqlite3/releases/tag/v13.0.0).
- The reproducible performance result for the reviewed runtime commit is in
  [performance.md](performance.md).
- Two consecutive deterministic offline incident rehearsals passed. Both
  report formats were produced, and the protected `test/math.test.js` fixture
  remained present.

## Reviewed npm artifacts

Each workspace was built and packed independently with `npm pack`. SHA-256 is
over the generated `.tgz` file.

| Artifact                        | Files | Packed bytes | SHA-256                                                            |
| ------------------------------- | ----: | -----------: | ------------------------------------------------------------------ |
| `tekrion-protocol-0.1.0.tgz`    |    27 |       20,892 | `bafa6e259388c4b016f1e47dbc4e7934e0b5412ae60df5902c4131befebb0ebf` |
| `tekrion-storage-0.1.0.tgz`     |    25 |       27,114 | `685b8a937e39339f6b4ef38f452c03384fef5a01066fbb344ec6dc136183c39c` |
| `tekrion-normalizers-0.1.0.tgz` |    25 |       23,183 | `214e277cbd10efdb05e1147abf05c10d2fb96632013311453ee37e9fbdc6832c` |
| `tekrion-context-0.1.0.tgz`     |     7 |       10,801 | `e55c48795ecadf488a00fa24365e9c8ff8d64d95d3a3e0092fc9c2faf827bbd5` |
| `tekrion-analysis-0.1.0.tgz`    |    19 |       28,003 | `576bfe007012070ffc7a1c94c0e278f4756ce4ed0d5ab3151d6d83fa96869c91` |
| `tekrion-daemon-0.1.0.tgz`      |    54 |       57,247 | `4139a8c804894ca3063081a35e57fe4467a586bb120d2ac81aebec431372c088` |
| `tekrion-cli-0.1.0.tgz`         |    40 |      146,243 | `13850ea3c62ec8c5ad00c05201b1412ed61f73ad7487db93e419eeebd5fad351` |

## Manual privacy and contents review

- No high-confidence private-key, OpenAI, Anthropic, GitHub, npm, AWS, or Slack
  credential pattern was present in the extracted artifacts.
- No local user, workspace, temporary, CI-runner, or Windows home path was
  present.
- No `.env`, log, database, source-map, TypeScript build-info, source, test, or
  unintended legacy-brand path was packaged.
- Every archive entry stayed below `package/`; no absolute path, parent
  traversal, symlink, hard link, or special file was present.
- Every runtime tarball contains its package README, compiled JavaScript and
  declarations, package manifest, and a byte-identical copy of the canonical
  Apache-2.0 license.
- The daemon and CLI tarballs contain npm's persistent dual-use metadata and a
  root-level `DISCLOSURE` describing their authorized observability purpose,
  sensitive-data boundary, and prohibited misuse.
- The CLI includes the built cockpit HTML, JavaScript, and CSS, without source
  maps. Its generated notices cover React, React DOM, Scheduler, and Zod, the
  production dependencies embedded in the browser assets.
- The default share archive warning, explicit forensic archive warning,
  rule-based-redaction limitation, optional-AI preview and fingerprint-bound
  consent, imported-session restrictions, and HTTP/WebSocket support claims
  were reviewed against the CLI, cockpit, and documentation.
- The documented Black Box configuration aliases and `.bbx` import
  compatibility remain intact; no breaking migration was introduced.

## Clean-install acceptance

The seven exact tarballs were installed together into an empty temporary npm
project. Installation added 10 runtime packages without a deprecation warning.
The installed CLI then passed:

- `tekrion --version` (`0.1.0`) and `tekrion --help`;
- private-home initialization and empty JSON session listing;
- schema-version 6 SQLite integrity and migration-ledger checks;
- control-token and private-storage checks;
- proxy and control loopback-port checks; and
- configured upstream reachability.

`tekrion doctor --json` returned `ok: true`. Its only warning was the documented
unsupported standalone WebSocket/Realtime transport; HTTP JSON and SSE remain
supported.

## External release boundary

The npm identity, `@tekrion` ownership, auth-and-writes 2FA, and the
main-restricted `npm-production` GitHub environment have been confirmed. These
external release operations remain:

1. Push the final review-only commit and require cross-platform CI and CodeQL
   to pass on its exact SHA.
2. Publish all seven packages to `next` through the guarded local interactive
   2FA path, then verify registry contents and clean installs on every claimed
   platform.
3. Create the signed tag, promote to `latest`, and publish the GitHub release
   only under their separate authorization boundary.
