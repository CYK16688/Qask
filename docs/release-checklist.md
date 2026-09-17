# Qask release checklist

Qask is currently released as source only. Complete this checklist before
publishing a source release or merging release-preparation changes into
`main`.

## Repository and security

- Confirm the canonical repository is `https://github.com/cyk16688/Qask`.
- Confirm the release commit is on `main` and the working tree contains no
  untracked local worktrees, profiles, credentials, or build output.
- Enable GitHub Private Vulnerability Reporting in the repository settings.
- Open the [private vulnerability report form](https://github.com/cyk16688/Qask/security/advisories/new)
  while signed out or with a test account and confirm it is the private form.

## Source and dependency checks

Run these commands from a clean checkout on the target platform:

```bash
npm ci
npm test
npm audit --omit=dev
npm run check:public-source
npm run test:layout-ui
npm pack --dry-run --json
```

Inspect the pack output and scan the exact source archive with an approved
secret scanner. Do not publish `node_modules`, test fixtures, local profiles,
screenshots containing account data, or build artifacts.

## Rights and notices

- Confirm that iCreator controls the rights to the Qask source and project
  documentation assets.
- Confirm that every documentation screenshot was captured by a maintainer in
  an unauthenticated profile and contains no account or private data.
- Keep third-party names, interfaces, and marks attributed to their owners;
  do not imply endorsement.
- For a desktop binary, generate complete dependency notices for the exact
  lockfile and target platform before distribution.

## Desktop binaries

Desktop binaries are not currently published or supported. Before starting a
binary release, add platform-specific packaging, signing, notarization,
permission-copy review, update distribution, and clean-account validation.
