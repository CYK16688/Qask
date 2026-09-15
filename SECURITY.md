# Security policy

## Supported source line

Security fixes are prepared against the current `main` source line. Packaged
releases are not yet published or supported.

## Reporting a vulnerability

For the public Qask repository, use GitHub's **Private vulnerability reporting**
flow: open the repository's **Security → Advisories** page and select
**Report a vulnerability**. This route is available only after the repository
owner enables GitHub Private Vulnerability Reporting.

If that button is unavailable, do not disclose credentials, cookies, private
repository information, personal data, or exploit details through a public
issue. Wait for the maintainer to restore the private reporting route; do not
infer an alternate contact route from this source package.

Once a private route is published, a report should include:

- an impact summary;
- minimal reproduction steps;
- affected Qask and Electron versions; and
- safe redacted logs only.

The maintainer should acknowledge the report, coordinate a fix, and publish a
sanitized advisory after affected users can update.

## Security boundaries

Qask loads remote AI websites in sandboxed, context-isolated webviews without
Node integration. Provider sessions deny permissions, downloads, and popups.
Composer injection requires a trusted HTTPS provider origin. The main-process
IPC surface is restricted to trusted Qask shell requests.

These boundaries are intentionally narrow. Do not add a preload to provider
webviews, relax web security, add a remote debugging port, expose raw IPC, or
add filesystem/Git/GitHub access without a threat model, tests, and independent
security review.

## Release gates

Before publishing source, an archive, or a desktop binary:

1. run the full tests and runtime dependency audit;
2. inspect the exact publish/archive file list and scan it for credentials;
3. confirm license ownership and third-party notices;
4. verify no local profiles, screenshots, build artifacts, or test fixtures are
   included unintentionally; and
5. for macOS binaries, complete signing, notarization, permission-copy review,
   and clean-account validation.
