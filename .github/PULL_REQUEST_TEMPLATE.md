# Pull request

## What changed

<!-- One or two sentences. Link the issue or discussion this addresses, if any. -->

## How it was verified

<!-- List the exact commands you ran and what they reported. -->

- [ ] `npm test`
- [ ] `npm audit --omit=dev`
- [ ] `npm run check:public-source`
- [ ] `npm run test:layout-ui` (GUI smoke test; requires a local display)

## Privacy and security checklist

- [ ] No prompt text, attachment content, local file path, cookie, token, password, or provider
      console output is added to logs, storage, or error messages.
- [ ] Provider webviews remain sandboxed and context-isolated, with no preload, no Node access,
      no remote-debugging port, and HTTPS exact-origin guards intact.
- [ ] No new Git, GitHub CLI/API, SSH, credential-helper, clipboard-history, or recursive
      filesystem access is added to the application.
- [ ] Attachment-bearing turns still execute no provider guest script and pass no file, path,
      metadata, `data:` URI, Blob/File object, DataTransfer, or clipboard payload to a site.
- [ ] This change includes no real credentials, cookies, personal data, screenshots containing
      account data, or private repository material.

## Notes for reviewers

<!-- Behavior changes, documentation impact, or follow-up work. Delete if empty. -->
