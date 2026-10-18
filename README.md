<div align="center">

<img src="assets/qask-logo.svg" width="104" alt="Qask logo">

# Qask

**One question. Every model. The real web.**

A local-first desktop workspace that turns the AI sites you already use into one calm, comparable surface.

[![CI](https://github.com/CYK16688/Qask/actions/workflows/ci.yml/badge.svg)](https://github.com/CYK16688/Qask/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/CYK16688/Qask?include_prereleases&label=release)](https://github.com/CYK16688/Qask/releases)
[![License: AGPL-3.0-or-later](https://img.shields.io/badge/License-AGPL--3.0--or--later-8a2be2.svg)](LICENSE)
[![Electron](https://img.shields.io/badge/Electron-44.3.0-47848f.svg)](https://www.electronjs.org/)
[![macOS + Windows](https://img.shields.io/badge/platform-macOS%20%7C%20Windows-111111.svg)](#install)

[Why Qask](#why-qask) · [Tour](#a-tour-of-the-workspace) · [Install](#install) · [中文说明](#中文说明) · [Docs](docs/user-guide.md)

</div>

![Qask four-panel workspace: a quiet dark desktop with four AI websites arranged in a 2×2 grid and one shared composer.](docs/images/layout-quad.png)

<p align="center"><sub>ChatGPT, Gemini, Doubao, Claude and more — each in its own official web UI, arranged in one workspace.</sub></p>

> **Release status:** Qask is open source under **AGPL-3.0-or-later**. The macOS arm64 1.0.3 preview is signed, notarized, and stapled. Version 1.0.3 adds a **Windows x64 preview** (portable + installer) under [v1.0.3](https://github.com/CYK16688/Qask/releases/tag/v1.0.3); the Windows builds are **unsigned**, cross-built from macOS, and **not yet been validated on Windows hardware**. The macOS 1.0.2 DMG remains available as the previous signed/notarized preview. Treat all previews as evaluation builds, not production support.

## The short version

Qask is a **local-first multi-AI comparison desktop app** for people who no longer believe one model has the whole answer.

It puts the official **ChatGPT, Gemini, Claude, DeepSeek, Kimi, Doubao (豆包), and Copilot** web apps in one window. One composer sends the same prompt to up to four active panels; a comparison view shows where their answers converge and where they disagree.

If you are looking for a **ChatGPT + Claude + Gemini side-by-side desktop app**, a **multi-LLM comparison workspace**, or a **local AI aggregator that does not require API keys**, this is the category Qask is building in.

> The bottleneck is no longer access to a model. It is judgment across models. Qask makes that judgment a first-class workflow.

### Who it is for

- **Researchers and analysts** who want to see where models agree, where they hallucinate, and which source is worth trusting.
- **Writers and product teams** who use one model for structure, another for critique, and a third for a different voice.
- **Developers and technical teams** who compare explanations, code paths, and trade-offs before committing.
- **Prompt engineers** who want to test the same instruction against several model families without copying and pasting between tabs.
- **Anyone who pays for more than one AI subscription** and wants the subscriptions to feel like one workspace.

### What makes Qask different

Qask is not another API wrapper, not a prompt marketplace, and not a hosted chat product. It is a **local control room for the multi-model web**.

| Approach | What you get | What you give up |
| --- | --- | --- |
| API aggregator | One API, automation, programmatic output | API keys, per-token costs, no native tools or model UI |
| A row of browser tabs | The real products, exactly as shipped | Constant context switching, no shared composer, no comparison |
| Qask | Real provider UIs, one prompt, persistent sessions, live comparison | It inherits the fragility of third-party web UIs |

The bet behind Qask is simple: in a world of many strong models, **the interface that matters is not another chat box — it is a place to compare**.

## Why Qask

The web is still where AI products move fastest. Qask does not wrap an API, proxy a prompt, or flatten every model into the same chat box. It gives the real websites a better room.

| | |
| --- | --- |
| **The real web, not an API approximation** | Keep each provider's own account, model picker, attachments, tools, and conversation context. No API keys. No server-side relay. |
| **One prompt, many models** | Put 1–4 official AI sites side by side and broadcast the same question to the active panels from one composer. |
| **Compare what actually happened** | Read the latest visible answer from every panel in **Live answer comparison**, scroll the panes in sync, refresh on demand, or ask one model to summarize the differences. |
| **A workspace, not a tab farm** | Persistent per-site sessions, draggable website order, four layouts, queue mode, and a local-first ownership model. |
| **Attachments that respect the boundary** | Drag images, audio, or PDFs into the composer. Qask can place a local file into a site's own file input; if that is not possible, it tells you and keeps the manual path. |
| **Built to be inspected** | Sandboxed webviews, explicit HTTPS origin checks, a narrow preload bridge, and an open-source codebase you can read before you sign in anywhere. |

## Built for real work

Qask is most useful when the question is too important for one answer:

- **Cross-check a claim** — ask several models the same factual question and look for consensus, caveats, and confident mistakes.
- **Pressure-test a decision** — give the same brief to a strategist, a critic, and a technical model; compare the assumptions each one makes.
- **Iterate a prompt** — keep the prompt identical, change the model, and see which instruction survives contact with different model families.
- **Compare explanations** — ask for a concept explained at several levels, then keep the version that actually lands.
- **Build a reading desk** — keep ChatGPT, Claude, Gemini, and DeepSeek open around a single research question without losing the original context.

## A tour of the workspace

| Focus | Side by side |
| --- | --- |
| ![Focused single-panel Qask workspace.](docs/images/layout-single.png) | ![Two AI websites side by side in Qask.](docs/images/layout-dual.png) |
| One model, full attention. | Two answers, one question. |

| Three panels | Four panels |
| --- | --- |
| ![Three AI websites in a Qask row.](docs/images/layout-triple.png) | ![Four AI websites in a 2×2 Qask grid.](docs/images/layout-quad.png) |
| Keep three perspectives in view. | A 2×2 research desk for four models. |

| Attachment tray | Settings |
| --- | --- |
| ![A local image queued above the Qask composer while the text field remains available for typing.](docs/images/attachments.png) | ![Qask settings dialog with theme, window, shortcuts, send, comparison, and privacy controls.](docs/images/settings.png) |
| Files sit above the text field; keep typing while the queue is visible. | Theme, shortcuts, send behavior, comparison defaults, and local data. |

| About Qask |
| --- |
| ![Qask About panel with logo, version, AGPL license, repository link, and local-data access.](docs/images/settings-about.png) |
| Version, license, repository, and the local data directory — in one place. |

<details>
<summary><sub>Screenshot notes</sub></summary>

Screenshots were captured from a fresh, unauthenticated Qask profile in dark theme. They contain no account identity, user prompt, response, credential, or conversation history. Visible pages are public landing, sign-in, or verification states; some providers may show an anti-bot gate. They demonstrate layout and local UI, not successful third-party delivery or model output. Third-party names and marks belong to their respective owners; screenshots are documentation only and do not imply endorsement.

</details>

## The workflow

1. **Choose a layout.** Focus, dual, triple, or 2×2. Cycle with `Alt + ←` / `Alt + →` when the Qask shell has focus.
2. **Order the websites.** Drag entries in **Model Website Management**. The first *N* entries populate the active *N*-panel layout.
3. **Sign in once in each panel.** Every site keeps its own persistent session partition. Qask never asks for an API key or a password.
4. **Write once, send thoughtfully.** `Enter` sends; `Shift + Enter` inserts a newline. Hover the send button to choose **send now**, **queue**, or **fill only**.
5. **Compare.** Open **对比 / Compare** to read the latest visible answers side by side, sync their scroll, refresh, or hand the differences to one selected model for a summary.

## What is inside

### A four-panel workspace
- **1 / 2 / 3 / 4 panel layouts** with automatic panel zoom for denser grids.
- **Seven built-in website entries:** ChatGPT, Gemini, Doubao (豆包), Claude, Copilot, DeepSeek, and Kimi.
- **Custom HTTPS websites** with explicit origin consent; custom sites are fill-only until you allow sending.
- **Drag to reorder**; remove any website entry and restore removed built-ins from the sidebar.
- **Persistent per-site partitions**, so logins stay isolated and normally survive a restart.

### A composer built for the real web
- **Send modes and queue:** send immediately, queue the next prompt, or only fill the page composer. Queue mode waits for the current answers to finish before sending the next item, then advances automatically.
- **Configurable shortcuts** for send, layout switching, comparison, and settings.
- **Attachment tray above the composer:** `drag files onto the composer` or use `+`; the text field stays below, so you can keep writing.
- **Local attachment handling:** images, **音频或 PDF**, plus explicit **本地录音** and screen-region capture. Qask matches a local file to the site's own upload control when it can; if not, it reports the failure and leaves the manual route available.
- **Optional status transcript:** hidden by default, available from Settings or `⌘/Ctrl + /` when you need the detailed local trace.

### Live answer comparison
**Live answer comparison** reads the latest visible answer from the active panels using best-effort DOM extraction. It never calls a provider API, never stores extracted answers on disk, and always treats the original panel as the source of truth. The comparison dialog supports synchronized scrolling, manual refresh, and a one-click difference summary from a model you choose.

### Settings that stay out of the way
- **Appearance:** follow the macOS appearance or pin the Qask shell to dark/light.
- **Window & layout:** auto-zoom for 3/4 panels, always-on-top, launch-at-login.
- **Composer & comparison:** default send mode, comparison model, summary confirmation, experimental attachment upload.
- **Data & About:** local data directory, version, AGPL license, repository, and release links.

### Local-first, by architecture
- No Git, GitHub API, repository scanning, cloud sync, or provider API integration.
- Remote websites run in isolated, sandboxed webviews with Node access, popups, downloads, and provider permissions denied.
- Qask checks trusted HTTPS origins before injecting text. Only the text you explicitly submit is offered to active third-party pages.
- The preload bridge is intentionally narrow. Provider pages never receive local file bytes or repository data through Qask's injected scripts.

Read [PRIVACY.md](PRIVACY.md) and [SECURITY.md](SECURITY.md) before using sensitive information.

## Install

### Requirements

- **macOS** (arm64 preview) or **Windows x64** (preview).
- Node.js **22.12.0 or later** and npm when building from source.
- A **完整源码仓库 checkout** with `package-lock.json` and the `test/` directory. A minimal `npm pack` artifact is not a standalone development checkout.

### Download the macOS preview

The signed, notarized Apple Silicon **1.0.3** preview is attached to [v1.0.3](https://github.com/CYK16688/Qask/releases/tag/v1.0.3). Both the `.app` and the DMG are signed with a Developer ID Application certificate; the DMG is notarized, stapled, and accepted by Gatekeeper. Verify it before opening:

```bash
shasum -a 256 -c Qask-1.0.3-arm64.dmg.sha256
```

- [Qask-1.0.3-arm64.dmg](https://github.com/CYK16688/Qask/releases/download/v1.0.3/Qask-1.0.3-arm64.dmg)
- [SHA-256](https://github.com/CYK16688/Qask/releases/download/v1.0.3/Qask-1.0.3-arm64.dmg.sha256)

The previous signed and notarized 1.0.2 DMG remains available on the [1.0.2 release](https://github.com/CYK16688/Qask/releases/tag/v1.0.2) for comparison.

### Download the Windows preview

Download the **v1.0.3** preview:

- [Qask-1.0.3-win-portable-x64.exe](https://github.com/CYK16688/Qask/releases/download/v1.0.3/Qask-1.0.3-win-portable-x64.exe) — one executable, no installer;
- [Qask-1.0.3-win-setup-x64.exe](https://github.com/CYK16688/Qask/releases/download/v1.0.3/Qask-1.0.3-win-setup-x64.exe) — per-user NSIS installer with an optional install directory;
- [SHA-256 checksums](https://github.com/CYK16688/Qask/releases/download/v1.0.3/Qask-1.0.3-win-x64.sha256).

The Windows builds are **unsigned**, so SmartScreen may warn. They are cross-built from macOS and **not yet been validated on Windows hardware**; use a clean profile first. The target is x64; ARM64 Windows can run it through emulation.

```bash
npm run package:win
# dist/Qask-1.0.3-win-portable-x64.exe
# dist/Qask-1.0.3-win-setup-x64.exe
```

### Run from source

```bash
git clone https://github.com/CYK16688/Qask.git
cd Qask
npm ci
npm start
```

On first launch, sign in inside each website panel. Then choose a layout, arrange the sites, and ask from the shared composer.

`npm start` launches Electron's development binary. The logical application name is Qask; macOS may show the host process as **Electron** in Activity Monitor/Dock. A packaged bundle (`Qask.app` / `Qask.exe`) shows Qask as the system application name. To build a local unsigned macOS bundle:

```bash
CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac dir --arm64 --publish never
open "dist/mac-arm64/Qask.app"
```

If Electron reports `spawn ENOEXEC` or tries to use `electron.exe`, the dependencies were installed on a different platform. Reinstall them on the target machine:

```bash
rm -rf node_modules
npm ci
```

Do not modify `node_modules/electron/path.txt` or copy Electron binaries between platforms.

`npm pack` creates a **最小运行时包** for inspection only. It **不包含 `package-lock.json`、测试套件或 GUI smoke 脚本**, so it is not a standalone source distribution for development verification.

## Release status

- **macOS:** 1.0.3 arm64 preview; signed, notarized, and stapled. The previous 1.0.2 signed/notarized DMG remains available.
- **Windows:** 1.0.3 x64 preview; unsigned, cross-built from macOS, and still awaiting Windows hardware validation.
- **Source:** every tagged GitHub release includes the corresponding source. The packaged macOS app ships the AGPL license, `NOTICE`, and `PRIVACY.md` inside `Qask.app/Contents/Resources/`.
- **Latest links:** [Releases](https://github.com/CYK16688/Qask/releases) · [v1.0.3](https://github.com/CYK16688/Qask/releases/tag/v1.0.3)

## Under the hood

Qask is deliberately small and legible: **Electron 44**, vanilla HTML/CSS/JavaScript, no framework, no bundler, and Node's built-in test runner.

- **Webview isolation:** `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`; provider pages have no Node or preload access.
- **Per-site sessions:** persistent `persist:<site>` partitions, isolated cookies and storage, no cross-site session sharing.
- **Narrow IPC surface:** screenshot, microphone, attachments, theme, app metadata, and a tiny set of user-triggered helpers.
- **HTTPS-origin gates:** host and guest both validate the exact origin before injecting text.
- **Tested in the open:** CI runs the Node test suite and a layout smoke job; the local suite currently covers **211 tests**.

```bash
npm test
npm run test:layout-ui
```

See [docs/architecture.md](docs/architecture.md) for the startup chain, webview isolation model, state model, IPC boundary, and known limitations.

## Limitations, stated plainly

- Website adapters depend on third-party DOM structures, login state, bot checks, and service availability. A Qask send attempt is not proof that a provider accepted the prompt.
- Qask does not use provider APIs or streaming. Comparison extraction is best-effort; the panel itself remains the source of truth.
- **Automatic attachment upload is experimental.** It can fail when a provider changes its composer, hides a file input in a shadow root, rejects a file type, or requires extra confirmation. Qask cannot prove a model read an attachment.
- Website automation may be restricted by a provider's terms, account policy, or anti-bot controls. Review the provider's current terms.
- macOS microphone and screen-capture permissions may be required for those features.
- The Windows builds are unsigned and not hardware-validated. The macOS 1.0.3 preview is signed, notarized, and stapled, but remains an evaluation preview.

## FAQ

**Is Qask an API client?**  
No. Qask opens the official provider websites in isolated desktop webviews. It has no model API integration, no API-key storage, and no hosted relay.

**Do I need API keys?**  
No. Sign in to the provider websites you already use. Qask never asks for an API key or your provider password.

**Which AI sites are built in?**  
ChatGPT, Gemini, Doubao (豆包), Claude, Copilot, DeepSeek, and Kimi, plus any custom HTTPS website you add.

**Can I compare ChatGPT, Claude, and Gemini side by side?**  
Yes. Choose the dual, triple, or 2×2 layout, order the sites in the sidebar, and use one composer for the active panels. Open **对比 / Compare** to read the latest visible answers side by side.

**Does Qask work on macOS and Windows?**  
Yes. macOS arm64 has a signed/notarized/stapled 1.0.3 preview; Windows x64 has an unsigned 1.0.3 preview. See [Install](#install) for exact caveats.

**Does Qask upload attachments automatically?**  
It can try. Qask matches local images, audio, or PDFs to a compatible site file input and sets the file through Electron's debugging protocol. If the site does not expose a usable input, Qask keeps the manual upload path. Treat automatic upload as experimental.

**Is Qask free?**  
Qask is open source under **AGPL-3.0-or-later**. Commercial licensing is available for proprietary distribution or hosted modifications; see [COMMERCIAL-LICENSE.md](COMMERCIAL-LICENSE.md).

**Why not just use browser tabs?**  
Tabs are good at keeping pages. They are bad at turning several answers into one decision. Qask adds a shared composer, queueing, persistent workspaces, synchronized comparison, and a local-first privacy boundary around the same real websites.

## Documentation

- [User guide](docs/user-guide.md)
- [Architecture and development notes](docs/architecture.md)
- [Privacy and local-data boundary](PRIVACY.md)
- [Security policy](SECURITY.md)
- [Contributing](CONTRIBUTING.md)
- [Code of conduct](.github/CODE_OF_CONDUCT.md)
- [Commercial licensing](COMMERCIAL-LICENSE.md)
- [Notices](NOTICE)
- [Repository and distribution boundaries](docs/repository-boundaries.md)
- [Release checklist](docs/release-checklist.md)

## If Qask is useful to you

Star the repository, share it with someone who compares models for a living, or open an issue with the provider and workflow you are trying to use. Stars and real usage reports are how a small local-first project becomes easier to find — and easier to improve.

## Contributing, questions, security

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md) first. Do not put credentials, browser profiles, local data, private screenshots, or exploit details in public issues or pull requests.

- **Usage, commercial licensing, and conduct:** [GitHub Discussions](https://github.com/CYK16688/Qask/discussions). Public threads are world-readable; never post contracts, customer data, credentials, or incident details.
- **Security vulnerabilities:** use [GitHub private vulnerability reporting](https://github.com/CYK16688/Qask/security/advisories/new), never a public issue.
- **Behavior expectations:** [CODE_OF_CONDUCT.md](.github/CODE_OF_CONDUCT.md).

## License

Copyright © 2026 iCreator.

Qask is open source under **AGPL-3.0-or-later** — see [LICENSE](LICENSE). Commercial users may use Qask under the AGPL when they meet its terms; iCreator may offer separate commercial licensing for proprietary distribution or proprietary hosted modifications. See [COMMERCIAL-LICENSE.md](COMMERCIAL-LICENSE.md).

Every tagged source release on GitHub provides the corresponding source for that build. The packaged macOS app additionally ships the license text, `NOTICE`, and `PRIVACY.md` inside `Qask.app/Contents/Resources/`.

## Trademark notice

Qask is not affiliated with, sponsored by, or endorsed by OpenAI, Google, Anthropic, Microsoft, 字节跳动, DeepSeek, 月之暗面, or their products. Names and trademarks of third-party websites belong to their respective owners. Users are responsible for complying with the terms of each service they open.

---

## 中文说明

<div align="center">

**一次提问，多模型同屏。**

Qask 是一个本地优先的 **多模型对比** 桌面工作区，也是一个无需 API Key 的 AI 对比工具：把你已经在用的 AI 官方网页放进同一个窗口，用一个输入框并行提问，在原生界面里阅读回答，再用「对比」并排查看和总结差异。

如果你在找 **ChatGPT / Claude / Gemini / DeepSeek / Kimi 同屏对比**、Mac 多模型对比工具，或一个不依赖 API Key 的本地 AI 对比软件，Qask 就是为这个场景设计的。

</div>

### 为什么是 Qask

- **不模拟 API，直接使用真实网页。** 每个网站保留自己的登录、模型选择、附件能力、工具和对话上下文。
- **一次输入，多站发送。** 单、双、三、四面板布局；一条问题发给当前活动面板。
- **回答对比。** 读取各面板最新可见回答，并排展示、同步滚动、随时刷新，并可让一个模型总结差异。
- **发送方式可控。** 立即发送、排队发送、仅填入。排队消息会先等当前回答结束，再自动推进。
- **附件工作流。** 支持图片、**音频或 PDF**、**本地录音**和本地截图。附件托盘在输入框上方，文字输入框在下方；可拖入文件后继续输入。
- **可添加自定义 HTTPS 网页模型。** 默认只填入文字；只有对精确 origin 明确授权后，才会尝试自动发送。
- **本地优先。** 每个网站独立持久化会话；无 Git/GitHub 扫描、无云同步、无 API Key。
- **可检查的实现。** Electron 沙箱 webview、HTTPS origin 校验、窄 preload IPC、211 项本地测试。

### 安装

macOS arm64 1.0.3 预览版已签名、公证并 stapling；Windows x64 1.0.3 预览版未签名、由 macOS 交叉构建、尚未在 Windows 真机验收。下载与校验信息见上方 [Install](#install) 和 [Releases](https://github.com/CYK16688/Qask/releases)。

从源码运行：

```bash
git clone https://github.com/CYK16688/Qask.git
cd Qask
npm ci
npm start
```

需要 Node.js 22.12.0 或更高版本，以及**完整源码仓库 checkout**（包含 `package-lock.json` 和测试目录）。

### 隐私与边界

Qask 不包含 Git、GitHub API、目录扫描、云同步或模型 API 集成；不会读取或上传 `.git`、本地仓库、SSH 密钥、Cookie、环境文件或浏览器 profile。只有你明确提交的文字才会被尝试交给活动网页。附件自动上传是实验性能力，失败时会回退到手动上传。完整说明见 [PRIVACY.md](PRIVACY.md)。

Qask 与 OpenAI、Google、Anthropic、Microsoft、字节跳动、DeepSeek、月之暗面及其产品**没有隶属、赞助或授权关系**。

### 许可

Copyright © 2026 iCreator。Qask 以 **AGPL-3.0-or-later** 开源；商业授权与分发边界见 [COMMERCIAL-LICENSE.md](COMMERCIAL-LICENSE.md)。

> Qask 不是 API 聚合客户端。第三方网页是否接收消息、附件或生成回答，应以网页实际显示为准。
