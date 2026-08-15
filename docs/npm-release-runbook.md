# npm release runbook

This runbook covers the first public release of the seven Tekrion runtime
packages. It is an operational procedure, not authorization to publish, push,
create credentials, change package settings, or create a release.

The root workspace and the viewer, demo-agent, adapters, and test-fixtures
workspaces are development-only and must remain private.

## Release order

Publish the runtime packages in dependency order:

1. `@tekrion/protocol`
2. `@tekrion/storage`
3. `@tekrion/normalizers`
4. `@tekrion/context`
5. `@tekrion/analysis`
6. `@tekrion/daemon`
7. `@tekrion/cli`

All seven packages use one version and exact internal dependency versions. The CLI
must be published last.

## npm dual-use classification

`@tekrion/daemon` and `@tekrion/cli` provide security-relevant traffic capture,
process observation, and forensic evidence capabilities. They therefore declare
`contentPolicy.class` as `dual-use` and package a root-level `DISCLOSURE` file as
required by npm's [Dual-Use Content
Policy](https://docs.npmjs.com/policies/dual-use/). The other five runtime
libraries do not themselves intercept traffic or launch observed processes.

The declaration is persistent across future daemon and CLI versions. Do not
remove it without npm Trust & Safety review. Dual-use packages must be published
through an interactive 2FA-authenticated session, or staged and later approved
with 2FA; direct publication with a bypass-2FA token or trusted-publishing OIDC is
not permitted.

## Hard gate: confirm current npm access

The package names require ownership of, or write access to, the npm `@tekrion`
scope. A registry `E404` only shows that a package version is not public; it does
not prove permission to create it.

The seven runtime manifests are already prepared for public access. That source
state is not evidence of registry permission and does not authorize publication.
Before any publication attempt:

1. Sign in with `npm login` and verify the intended identity with `npm whoami`.
2. In npm organization settings, confirm that identity owns or administers the
   `tekrion` organization, or belongs to a team with package read/write access.
3. Enable two-factor authentication and store the recovery codes safely.
4. If the scope is not controlled, choose a controlled scope and rename all seven
   packages, internal dependencies, TypeScript imports, lockfile entries, scripts,
   tests, and documentation atomically. Do not publish a mixed namespace.

The npm scope and access model is documented in [npm's package scope and access
guide](https://docs.npmjs.com/package-scope-access-level-and-visibility/).

## Prepare the exact candidate

After current scope access is confirmed:

1. Confirm that exactly the seven runtime manifests listed above omit
   `private: true` and declare `publishConfig.access` as `public`. Confirm the
   daemon and CLI still contain both the npm dual-use metadata and their
   package-root `DISCLOSURE` files.
2. Keep every development-only workspace private.
3. Replace unreleased/source-candidate wording and date the changelog only when
   publication of the genuine release candidate is explicitly authorized.
4. Run the complete local sequence:

   ```bash
   npm ci
   npm run check
   npm audit --audit-level=high
   npm run benchmark
   npm run demo:offline
   npm run demo:offline
   npm run package:smoke
   npm run release:preflight
   git status --short
   ```

5. Review every packed file list and confirm the demo repository still contains
   `test/math.test.js`.
6. Commit the candidate. Record its full SHA with `git rev-parse HEAD`.
7. Push only with explicit authorization, then require every GitHub CI job to pass
   on that exact SHA before publication.

`release:preflight` must say `READY`, and the working tree must be clean. A passing
local build is not a substitute for the cross-platform run on the candidate SHA.

## First publication requires interactive 2FA

Staged publishing requires a package to exist already, so it cannot create these
seven package names. Because the daemon and CLI are declared dual-use, the 0.1.0
bootstrap must use a local, interactive npm session with 2FA. Do not use a
bypass-2FA token, a CI secret, or direct trusted publishing for this release.

From a real terminal on the exact clean and CI-approved `main` commit:

1. Run `npm login`, verify the identity with `npm whoami`, and confirm the account
   uses `auth-and-writes` 2FA.
2. Make sure `NODE_AUTH_TOKEN` and `NPM_TOKEN` are unset. Never put an npm token or
   one-time password in a command argument, repository file, transcript, issue, or
   chat message.
3. Run the guarded interactive command, replacing the placeholder with the exact
   40-character approved commit:

   ```bash
   npm run release:publish:interactive -- <approved-commit-sha>
   ```

4. Type the command's exact release confirmation. Respond to npm's own 2FA prompts
   in that terminal. The command re-runs preflight, refuses to start if any 0.1.0
   version exists, publishes the seven packages in dependency order under `next`,
   and verifies each registry tag before continuing.

The refusal is deliberate: blindly rerunning after a partial publication can make
an incident worse. Follow the partial-publication policy below if the command stops
after any package has been created.

## Verify the real registry artifacts

Do not promote `latest` immediately. Inspect all seven `0.1.0` records, tarball
integrity values, repository metadata, licenses, READMEs, dual-use declarations,
and registry signatures first. The interactive first publication does not produce
GitHub Actions provenance; subsequent staged releases should.

Verify the CLI from a clean temporary installation:

```bash
verify_dir="$(mktemp -d)"
npm install --prefix "$verify_dir" @tekrion/cli@next
"$verify_dir/node_modules/.bin/tekrion" --version
"$verify_dir/node_modules/.bin/tekrion" init --home "$verify_dir/home"
"$verify_dir/node_modules/.bin/tekrion" sessions --home "$verify_dir/home" --json
(cd "$verify_dir" && npm audit signatures)
```

Expected results are version `0.1.0`, successful initialization, an empty session
list, working native SQLite, and valid registry signatures/attestations. Repeat the
registry installation path on every claimed platform.

## Tag and promote only the tested release

After registry and platform verification, and only with explicit authorization:

1. Create and verify a signed `v0.1.0` tag on the exact tested SHA.
2. Push that tag.
3. From the same exact clean commit, run
   `npm run release:promote:interactive -- <approved-commit-sha>`, enter its exact
   confirmation, and respond to npm's own 2FA prompts. It promotes protocol,
   storage, normalizers, context, analysis, daemon, and finally CLI from `next` to
   `latest`, verifying each tag as it proceeds.
4. Install `@tekrion/cli@latest` in another clean directory and repeat the CLI
   checks.
5. Publish the GitHub release with the supported protocols, capture levels, privacy
   warning, Node requirement, limitations, changelog, and security links.

Never attach real `.tkr` evidence, local databases, credentials, recordings, or
machine-specific configuration to a release.

## Configure staged trusted publishing for later releases

Immediately after the first successful publication:

1. Keep the `npm-production` GitHub environment restricted to `main`; add a
   required reviewer when an independent reviewer is available.
2. Add the permanent `publish.yml` workflow.
3. Configure a trusted publisher separately on all seven npm packages with:

   - provider: GitHub Actions;
   - owner: `ayyagarisujanreddy123`;
   - repository: `Tekrion`;
   - workflow filename: `publish.yml`;
   - environment: `npm-production`;
   - allowed action: `npm stage publish`.

4. Use a GitHub-hosted runner, `id-token: write`, Node.js 22.15 or newer, and a
   current npm release that supports both trusted and staged publishing. The
   permanent publishing job must not receive `NODE_AUTH_TOKEN` or another write
   credential.
5. Have a maintainer inspect the staged tarballs and approve them interactively
   with 2FA. Do not configure the trust relationship for direct `npm publish` on
   the daemon or CLI.
6. Verify one staged trusted publication before configuring packages to disallow
   ordinary publishing tokens.

Recheck the official [trusted publishing](https://docs.npmjs.com/trusted-publishers/),
[staged publishing](https://docs.npmjs.com/staged-publishing/), and [dual-use
content](https://docs.npmjs.com/policies/dual-use/) documentation before every
release because these requirements can change.

## Partial publication policy

npm versions are immutable. If the interactive publication stops after
publishing only part of the set:

1. Inspect all seven registry records and tarballs.
2. If every existing artifact is correct, publish only the missing packages in
   dependency order through a separately reviewed recovery procedure.
3. If any artifact is wrong, do not overwrite or blindly unpublish it. Prepare
   `0.1.1`, update all seven package versions and exact internal dependencies, run
   every gate again, and deprecate the defective version with a clear replacement.

Use unpublish only for a genuine security or legal emergency.
