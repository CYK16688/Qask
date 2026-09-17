# Contributing to Qask

## Scope

Qask is a local, webview-based workspace for manually comparing responses from
multiple AI websites. It does not implement API-provider routing, API key
storage, answer scraping, or automatic export.

## License and contributions

Qask is licensed under AGPL-3.0-or-later. By submitting a contribution, you
confirm that you have the right to contribute it and license the contribution
under AGPL-3.0-or-later. Qask does not currently use a CLA or acquire an
automatic copyright assignment; maintainers cannot promise to relicense a
contribution under a separate commercial license without a separate agreement
with its copyright holder. Do not submit code, assets, credentials, or
material whose redistribution rights are unclear.

Commercial exceptions are handled separately; see
[COMMERCIAL-LICENSE.md](COMMERCIAL-LICENSE.md). Do not place commercial terms,
customer information, contracts, or other confidential information in a public
issue or pull request.

For security reports, use GitHub's private vulnerability reporting flow rather
than a public issue. See [SECURITY.md](SECURITY.md).

## Privacy and security rules

- Do not add Git, GitHub CLI/API, SSH, credential-helper, clipboard-history, or
  recursive filesystem access to the application.
- Only explicit composer text may enter a provider injection payload. Keep
  attachments in Qask memory; an attachment-bearing turn must not execute a
  provider guest script or pass a file, file path, filename, metadata, byte,
  `data:` URI, Blob/File object, DataTransfer, or clipboard payload to a site.
- Do not log prompts, attachment contents, local file paths, cookies, tokens,
  passwords, or provider console output.
- Keep provider webviews sandboxed, context-isolated, and without Node or
  preload access. Preserve HTTPS exact-origin guards.
- Never add a fixed remote-debugging port.

## Development checks

在**完整源码仓库 checkout** 中、提交修改前运行：

```bash
npm test
npm audit --omit=dev
npm run test:layout-ui
npm run check:public-source
npm pack --dry-run --json
```

The layout smoke test validates Qask's local shell only. It does not prove
third-party login, upload, message delivery, or provider acceptance.

`npm pack` 的最小运行时包刻意不包含 `package-lock.json`、`test/` 或
`scripts/layout-ui-smoke.js`，因此不能作为独立源码开发或验证归档使用。

## Pull requests

Keep changes narrowly scoped. Add a regression test for behavior changes and
document any user-visible privacy or data-retention impact. Never include real
credentials, cookies, personal data, screenshots containing account data, or
private repository material in commits, issues, or pull requests.
