# Qask release checklist

Qask is released as source plus a signed macOS arm64 DMG. Complete this checklist before
publishing a source release or binary release.

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
npm run package:mac
hdiutil verify dist/Qask-1.0.0-arm64.dmg
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

## macOS notarization

The Developer ID certificate signs the app; notarization is a separate Apple
service submission. Xcode account sign-in does not automatically create a
`notarytool` credential profile.

Create the profile once on the release machine. The command deliberately asks
for the password through a hidden prompt, so the app-specific password is not
saved in shell history:

```bash
xcrun notarytool store-credentials QaskNotary \
  --apple-id "YOUR_APPLE_ID" \
  --team-id DCLBAFF9Y6
```

At the prompt, enter the 16-character app-specific password generated at
`appleid.apple.com`, not the normal Apple ID password and not the macOS login
password. If validation reports that the credentials are incorrect, create a
new app-specific password, copy it without surrounding whitespace, and rerun
the command. The Apple ID must be the account belonging to Team ID
`DCLBAFF9Y6`.

After the profile is saved, rebuild and notarize the DMG:

```bash
npm run package:mac
npm run notarize:mac
```

Use another profile name with `APPLE_KEYCHAIN_PROFILE=ProfileName npm run notarize:mac`.
The script submits the DMG, staples and validates the ticket, verifies the
DMG checksum, and refreshes the `.sha256` file. Re-upload both files to the
GitHub Release only after these checks pass; stapling changes the DMG bytes.

## Desktop binaries

The macOS arm64 DMG must be signed with a Developer ID Application certificate
and notarized before being described as production-ready. Gatekeeper behavior
and macOS permissions must still be reviewed on the target machine, including
permission-copy review and clean-account validation.
