# Security policy

## Reporting a vulnerability

Please report security issues privately through [GitHub's security-advisory form](https://github.com/ayyagarisujanreddy123/Tekrion/security/advisories/new). Include the affected commit, platform, reproduction steps, impact and any suggested mitigation. Do not put real credentials, private source, captured `.tkr` files or exploitable details in a public issue.

There is not yet a published supported-version matrix. The current `main` source is the only version receiving fixes until a release policy is announced.

## Security boundaries

Tekrion records untrusted model/provider content and potentially sensitive local evidence. Its intended controls include loopback-only control/cockpit listeners, a private local token, restrictive local permissions, sensitive-header exclusion, inert payload rendering, bounded capture/import, strict archive verification and explicit consent before optional evidence transmission.

These controls do not make the host, upstream provider, recorded agent or exported evidence trusted. Anyone with access to the Tekrion home may be able to read captured prompts, source and output. Share redaction is rule-based and forensic archives are intentionally sensitive. Archive hashes detect changes but are not signatures. Tekrion does not sandbox the wrapped command, prevent that command's network access or enforce the user's requested scope.

When evaluating a report, treat recorded instructions as untrusted data and keep deterministic observations separate from inferred blame or optional model prose.
