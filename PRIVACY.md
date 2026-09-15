# Qask privacy and local-data boundary

Qask is a local Electron shell for websites that you choose to open. It is not
a cloud service, does not include an API-provider mode, and does not send Qask
settings or local project data to an AI website.

## What Qask does not access

Qask does **not** scan, read, index, upload, or inject the following into AI
websites or model prompts:

- local repositories or `.git` metadata;
- Git configuration, remotes, commit history, GitHub Issues or Pull Requests;
- GitHub CLI configuration, Git credential helpers, tokens, SSH keys, cookies,
  passwords, environment files, or browser profiles;
- clipboard history, desktop files, screenshots, recordings, or file-system
  paths unless you explicitly select a supported attachment or invoke a local
  screenshot action.

Qask contains no Git or GitHub integration and does not call Git, GitHub CLI,
or GitHub APIs at runtime. It has no facility for enumerating local folders or
recursively attaching a directory.

## What can leave your computer

Only the following data can be offered to a third-party AI website:

1. text you explicitly enter into the Qask composer and submit; and
2. a supported image, audio file, or PDF you explicitly choose in Qask's file
   picker, paste as an image, or record through the explicit microphone action,
   but only when you separately use that website's own visible upload interface.

A Qask attachment queue remains in renderer memory until you remove its entry
or close the app; it is not transmitted by Qask to a provider. For files
selected from disk, Qask resolves and verifies the selected regular file
in the trusted main process before it joins the local queue. It rejects hidden
files, `.git` paths, protected home-directory credential locations, Qask's own
session data, and obvious credential/GitHub-sensitive filenames before any
provider payload is created. This is a protective filename/path filter, not a
content classifier: Qask cannot infer whether an otherwise ordinary file
contains confidential material. Qask does not automatically attach files from
a folder, the clipboard, screenshots, or a repository.

Qask does not pass attachment bytes, filenames, paths, metadata, `data:` URIs,
Blob/File objects, DataTransfer, or clipboard payloads into a third-party
page's JavaScript. For an attachment-bearing turn it does not run a Qask guest
script or auto-send the text. Use each website's visible upload interface,
then confirm and send there. That website may upload, retain, or process the
file under its own policies; Qask cannot confirm acceptance, reading, deletion,
or processing. Do not submit confidential material to a provider unless you
accept that provider's terms and privacy policy.

## Local data Qask retains

- Electron provider partitions retain each website's local browser session,
  including login cookies and site cache, on this device.
- Qask localStorage retains only layout selection, website ordering, and custom
  website labels/URLs.
- Local attachments, recordings, attachment paths, and microphone status are
  not intentionally persisted in Qask localStorage.
- A user-requested screenshot is stored locally in `~/Pictures/Qask Screenshots/`.

Clear Qask application data and the relevant provider partitions to remove
local website sessions and Qask settings. Delete screenshots from the Pictures
folder separately.

## Security limits

Qask blocks guest Node access, denies guest permissions, popups, and downloads,
and applies origin checks before composer injection. These controls reduce the
risk of accidental disclosure; they do not turn third-party websites into
trusted services or replace a security review of a packaged release.

## Reporting a vulnerability

Do not publish secrets, cookies, personal data, or reproducible exploit details
in a public issue. See [SECURITY.md](SECURITY.md).
