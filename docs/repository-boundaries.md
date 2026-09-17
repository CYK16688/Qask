# Repository boundaries

This repository separates reviewable source from machine-local state and
generated distribution files. The rules below apply to pull requests,
releases, and local development.

## Track in Git

Commit files that are needed to understand, review, test, build, or legally
redistribute Qask:

- Application source and runtime entry points: `main.js`, `preload.js`,
  `local-data-boundary.cjs`, and `src/`.
- Package manifests and the lockfile: `package.json` and `package-lock.json`.
- Tests, development scripts, patches, and CI configuration: `test/`,
  `scripts/`, `patches/`, and `.github/`.
- Documentation and legal notices: `README.md`, `docs/`, `LICENSE`, `NOTICE`,
  `PRIVACY.md`, `SECURITY.md`, `CONTRIBUTING.md`, and
  `COMMERCIAL-LICENSE.md`.
- Project-owned branding and application assets in `assets/`.

The tracked-file boundary is checked with `git ls-files`. A new source,
documentation, test, workflow, or asset file should be reviewed and added
explicitly rather than relying on a broad ignore exception.

## Ignore locally

Do not commit machine-local or generated content:

- Dependencies and package-manager state: `node_modules/`, `.npm/`, and
  `.npmrc`.
- Build and test output: `dist/`, `out/`, `build/`, `release/`, `coverage/`,
  and `artifacts/`.
- Codex or developer worktrees and local application state: `.worktrees/`,
  `.hermes/`, profiles, caches, and logs.
- Operating-system files and debug logs: `.DS_Store`, `*.log`, and npm debug
  logs.
- Secrets and credentials: `.env` files except `.env.example`, `.pypirc`,
  `credentials.json`, `*.pem`, and `*.key`.

The exact rules live in [`.gitignore`](../.gitignore). Never weaken them to
make a local build pass. Move a needed example into a deliberately named,
redacted file such as `.env.example` instead.

## Distribution boundaries

- GitHub is the distribution channel for tagged source and desktop binaries.
- macOS DMGs, checksums, blockmaps, update metadata, unpacked app bundles,
  and other electron-builder output are generated under `dist/` and remain
  ignored by Git. Attach the tested files to a GitHub Release.
- `npm pack` is an inspection-only minimal runtime package. Its explicit
  allowlist is controlled by `package.json` and `.npmignore`; it intentionally
  excludes the lockfile, tests, CI files, and most development tooling.
- Local Electron profiles, website sessions, cookies, attachments, and
  screenshots are outside the repository and must never be copied into it.

Before publishing, run the checks in [`docs/release-checklist.md`](release-checklist.md),
then verify that `git status --short` contains no unexpected files and that
the release asset checksum matches the locally verified artifact.
