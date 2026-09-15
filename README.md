# Qask

Qask is available as source under **AGPL-3.0-or-later**. Commercial users may
use it under the AGPL when they meet its terms; iCreator may offer a separate
commercial license for proprietary distribution or proprietary hosted
modifications. See [LICENSE](LICENSE) and
[COMMERCIAL-LICENSE.md](COMMERCIAL-LICENSE.md).

Copyright © 2026 iCreator.

> **Release status:** the repository contains source only. No packaged desktop
> binaries are published or supported yet.

Qask 是一个 Electron 桌面原型：将多个 AI 官方网页放在同一工作区中，以一次输入并行发起对话，帮助用户横向比较不同模型的回答。

> 当前优先实现网页模式的多模型对话与结果比较。API 模式尚未实现真实调用，已从当前产品范围中移除，不能用于发送 API 请求。

## 当前能力

- 1、2、3、4 面板布局，可在侧栏切换或使用 `Alt + ← / →` 切换。
- 内置 ChatGPT、Gemini、豆包、Claude、Copilot、DeepSeek、Kimi 七个网页入口。
- 每个内置网页使用独立的持久化 Electron 分区；完成登录后，登录状态通常会保留在本机。
- 可添加自定义 HTTPS 网页模型。
- 底部统一输入框可并发尝试向所有活动面板发送文本；`Enter` 发送，`Shift + Enter` 换行。
- 支持本地图片、音频或 PDF 附件：可选择文件、粘贴图片，或用麦克风进行本地录音。附件会保留在 Qask 本地；使用附件时，请在每个目标网站自己的可见上传界面中选择、确认并发送。
- 支持截图，截图会保存到系统 `Pictures/Qask Screenshots` 目录。

## 运行

### 前提

- macOS（当前主要验证目标）
- Node.js 与 npm

### 安装与启动

以下命令适用于**完整源码仓库 checkout**；其中 `package-lock.json` 提供可复现的开发安装，测试和 GUI smoke 文件也只随完整仓库提供。

```bash
npm ci
npm start
```

`npm pack` 生成的是最小运行时包，不包含 `package-lock.json`、测试套件或 GUI smoke 脚本；它不是可验证的独立源码发行包。公开源码仓库或源码归档必须包含这些开发文件后，才可按上述流程安装和验证。

首次启动后，请在各网页面板内自行完成账号登录，然后再用底部输入框广播问题。

如果 `npm start` 报 `spawn ENOEXEC` 或 Electron 指向 `electron.exe`，说明 `node_modules` 来自 Windows 安装。删除依赖后在本机重装：

```bash
rm -rf node_modules
npm ci
```

不要手工修改 `node_modules/electron/path.txt` 或复制 Electron 二进制文件。

## 使用说明

见 [docs/user-guide.md](docs/user-guide.md)。

## 隐私与安全

- [PRIVACY.md](PRIVACY.md) — 本地数据、GitHub 信息与第三方网站之间的边界。
- [SECURITY.md](SECURITY.md) — 漏洞报告与发布前安全门槛。
- [CONTRIBUTING.md](CONTRIBUTING.md) — 贡献时必须遵守的数据处理规则。
- [COMMERCIAL-LICENSE.md](COMMERCIAL-LICENSE.md) — AGPL 与单独商业授权的说明。
- [NOTICE](NOTICE) — 项目与第三方组件声明。

Qask 不包含 Git 或 GitHub 集成，运行时不会扫描、读取或上传 `.git`、GitHub CLI 配置、Git 凭据、SSH 密钥、浏览器 Cookie 或本地项目文件。只有你明确提交的输入文本和明确选择的受支持附件，才会尝试交给已打开的第三方网页；请阅读完整的 [PRIVACY.md](PRIVACY.md) 了解限制。

## 架构、限制与开发说明

见 [docs/architecture.md](docs/architecture.md)。

## 已知限制

- 网页发送依赖第三方网站的页面结构。站点改版、未登录、验证码或反自动化限制都可能导致发送失败。
- 当前发送状态表示 Qask 对网页执行了输入/点击尝试，不等同于模型一定已接受请求或生成回答。
- Qask 不会把附件交给第三方网页脚本。文件上传、模型读取、语音转写或实时语音对话均不由 Qask 证明；请在每个网页自己的上传界面中确认并手动发送。
- Gemini 的注入脚本已通过自动化生成脚本语法检查；实际网页适配仍需随站点更新持续验证。
- API 调用、回答自动提取、对比视图、会话保存和导出尚未实现。
- 当前网页模式不提供 API 配置；启动时会删除旧版遗留的 API Key 与模式存储键，且不会读取或输出其内容。后续只有在安全密钥存储和完整请求链路完成后才会重新引入 API 功能。
- 当前 Electron 原型已启用 web security、隔离 guest、拒绝 provider 权限和外部弹窗；仍须完成打包签名、`NSMicrophoneUsageDescription` 与真实网站附件验收后才能作为正式产品发布。

## 路线图

1. 稳定网页并发对话与持续多轮发送。
2. 为各站点适配器建立可回归验证。
3. 交付用户可见的回答对比能力。
4. 在明确的数据控制与隐私设计完成后，再考虑本地会话保存和导出。

## 非关联声明

Qask 与 OpenAI、Google、Anthropic、Microsoft、字节跳动、DeepSeek、月之暗面及其产品没有隶属、赞助或授权关系。各网站、商标和服务条款归其各自权利人所有；使用者须自行遵守相应条款。
