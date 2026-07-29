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

## Hard gate: confirm the npm namespace

The package names require ownership of, or write access to, the npm `@tekrion`
scope. A registry `E404` only shows that a package version is not public; it does
not prove permission to create it.

Before changing any runtime `private` flag:

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

After scope ownership is confirmed:

1. Remove `private: true` from exactly the seven runtime manifests listed above.
2. Keep every development-only workspace private.
3. Replace unreleased/source-candidate wording and date the changelog only when
   this is the genuine release candidate.
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

## Protect the one-time bootstrap

An npm trusted publisher cannot be attached until each package exists. The checked
in `bootstrap-npm.yml` workflow therefore supports the first publication with a
short-lived granular token.

Before dispatching it:

1. Create a GitHub environment named `npm-production`.
2. Restrict that environment to the `main` branch and configure a required reviewer
   when an independent reviewer is available.
3. Create a granular npm token with the shortest practical expiration, package and
   scope read/write access only for the controlled namespace, and the minimum
   organization permission required. npm requires 2FA or a write token configured
   to bypass 2FA for non-interactive package creation.
4. Store the token only as the `NPM_TOKEN` secret on `npm-production`. Never put it
   in a repository, command transcript, issue, archive, or workflow file.
5. Dispatch **Bootstrap npm release** from `main`, entering the exact 40-character
   candidate SHA and the confirmation `publish-0.1.0-to-next`.

The workflow installs only the explicitly reviewed, version-pinned dependency
lifecycle scripts, re-runs all local gates, verifies the token identity, refuses to
begin if any `0.1.0` package already exists, and publishes dependencies first under
the `next` dist-tag with provenance. The refusal is deliberate: blindly rerunning
after a partial publication can make an incident worse.

GitHub environments can hold approval-gated secrets as described in [GitHub's
deployment environment documentation](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments/).
Granular token controls are documented in [npm's access-token
guide](https://docs.npmjs.com/creating-and-viewing-access-tokens/).

## Verify the real registry artifacts

Do not promote `latest` immediately. Inspect all seven `0.1.0` records, tarball
integrity values, repository metadata, licenses, READMEs, and provenance first.

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
3. Promote `@tekrion/protocol`, storage, normalizers, context, analysis, daemon,
   and finally CLI from `next` to `latest`.
4. Install `@tekrion/cli@latest` in another clean directory and repeat the CLI
   checks.
5. Publish the GitHub release with the supported protocols, capture levels, privacy
   warning, Node requirement, limitations, changelog, and security links.

Never attach real `.tkr` evidence, local databases, credentials, recordings, or
machine-specific configuration to a release.

## Replace bootstrap credentials with trusted publishing

Immediately after the first successful publication:

1. Revoke the bootstrap npm token and remove the `NPM_TOKEN` environment secret.
2. Remove `bootstrap-npm.yml` in a focused commit.
3. Add the permanent `publish.yml` workflow.
4. Configure a trusted publisher separately on all seven npm packages with:

   - provider: GitHub Actions;
   - owner: `ayyagarisujanreddy123`;
   - repository: `Tekrion`;
   - workflow filename: `publish.yml`;
   - environment: `npm-production`;
   - allowed action: `npm publish`.

5. Use a GitHub-hosted runner, `id-token: write`, Node.js 22.15 or newer, and npm
   11.5.1 or newer. This satisfies both Tekrion's runtime contract and npm's
   lower trusted-publishing minimum. The permanent publishing job must not receive
   `NODE_AUTH_TOKEN` or another write credential.
6. Verify one trusted publication before configuring packages to disallow ordinary
   publishing tokens.

As verified on 2026-07-20, npm trusted publishing supports GitHub-hosted runners,
automatically generates provenance for public packages from public repositories,
requires npm 11.5.1 or newer and Node.js 22.14 or newer, and requires an allowed
action on newly created trust relationships. Recheck [the official trusted
publishing documentation](https://docs.npmjs.com/trusted-publishers/) before every
release because these requirements can change.

## Partial publication policy

npm versions are immutable. If the bootstrap stops after publishing only part of
the set:

1. Inspect all seven registry records and tarballs.
2. If every existing artifact is correct, publish only the missing packages in
   dependency order through a separately reviewed recovery procedure.
3. If any artifact is wrong, do not overwrite or blindly unpublish it. Prepare
   `0.1.1`, update all seven package versions and exact internal dependencies, run
   every gate again, and deprecate the defective version with a clear replacement.

Use unpublish only for a genuine security or legal emergency.
