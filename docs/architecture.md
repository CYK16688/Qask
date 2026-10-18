# Qask 架构与开发说明

## 产品边界

Qask 是一个 Electron 桌面原型，用于把多个 AI 官方网页并排展示，并通过一条统一输入并行发起问题。当前实现包括网页模式的嵌入、布局、登录分区、文本广播尝试、本地图片/音频/PDF 附件队列、显式麦克风录音和截图。

它不是多供应商 API 客户端；API 请求、流式输出、回答自动采集、比较视图、会话持久化与导出尚未实现。

## 启动链路

```text
package.json
  └─ scripts/run-electron.js
       └─ root main.js
            ├─ preload.js
            └─ src/index.html
                 ├─ src/styles.css
                 └─ src/renderer.js
```

- `package.json` 定义 `start`、`dev` 和基于 Node 内置测试运行器的 `test`。
- 启动脚本解析 `electron` 包所提供的二进制并启动项目目录。
- `main.js` 创建 1600×900 的 BrowserWindow，加载 `src/index.html`。
- `preload.js` 只暴露窄的截图、麦克风和附件 IPC 桥接：`window.qask.screenshot`、`window.qask.microphone` 与 `window.qask.attachments.{inspect,persist,reveal}`。`inspect` 校验用户选择的磁盘文件；`persist` 只接受可信 shell 送来的录音/粘贴图片 bytes 并写入 `~/Pictures/Qask Attachments/`；`reveal` 只接受该目录内的 basename。这些接口都不会把文件内容、路径或 bytes 交给网页 guest。
- `src/renderer.js` 管理布局、模型注册、webview、广播、附件、回答对比和界面事件。

## 本地数据与 GitHub 隔离

Qask 不包含 Git、GitHub CLI/API、SSH、凭据助手或本地目录扫描功能。运行时不会读取 `.git`、Git 配置、remote、提交历史、GitHub CLI 配置、SSH 密钥、Cookie、环境文件或剪贴板历史，也不会把这些数据拼入网页注入脚本。

Qask 可将用户明确提交的 composer 文本填入已验证的第三方网页。附件由用户文件选择、图片粘贴或显式录音产生，但始终保留在 Qask 本地；附件字节、路径或文件名不会进入 guest script。带附件时 Qask 仍可填入并尝试发送文字（否则带图提问会变成静默无操作），但不会自动上传附件；结果会明确提示用户到目标网站自己的可见上传界面选择文件。Qask 不支持目录上传或递归扫描。磁盘文件会在主进程解析并验证为常规文件后才加入附件队列；隐藏路径、`.git`、受保护的凭据目录、Qask 自身会话目录和明显的 GitHub/凭据敏感文件名都会被拒绝。完整数据保留说明见仓库根目录的 [PRIVACY.md](../PRIVACY.md)。

## 网页模型与隔离

默认模型定义在 `src/renderer.js`：ChatGPT、Gemini、豆包、Claude、Copilot、DeepSeek、Kimi。

每个默认模型分配独立的持久化 webview partition，例如 `persist:chatgpt`。这使不同网站的 Cookie 和登录状态彼此隔离，并可跨应用启动保留。自定义网站模型也会创建独立的持久化 partition。

无附件的网页广播依赖每个站点对应的 JavaScript 注入构建器：

1. 查找站点输入框；
2. 写入文本并派发输入事件；
3. 在适配器允许时尝试点击网页发送；结果只能表示尝试，不表示第三方网站接受或模型读取；
4. 附件存在时仍可运行文本注入并发送文字，但附件不会进入脚本；Qask 保留本地附件，并提示用户通过目标网站自己的可见上传界面确认和上传。

这些构建器依赖第三方 DOM，不能保证长期可用。内置模型采用专用文本适配器；自定义网页采用通用 fallback。文本脚本只会向模型注册时允许的 HTTPS origin 注入。附件绝不会传入 guest JavaScript：不传字节、路径、文件名、元数据、`data:` URI、Blob/File、DataTransfer 或剪贴板负载。`test/web-adapters.test.cjs` 会验证各适配器生成的脚本可被 JavaScript 解析，但不能替代真实网页验收。

## UI 与本地状态

- `src/index.html` 提供侧栏、模型管理、动态工作区和底部输入区；输入区上方的 `#broadcastStatus` 是 `aria-live="polite"` 的本地状态条，只显示 Qask 生成的消息（`textContent`，不使用 innerHTML），最多保留 8 条。
- `src/styles.css` 提供暗色与亮色两套变量，`html[data-theme="light"]` 覆盖表面/边框/文本；默认跟随系统。主题切换通过 `window.qask.theme.set()` 设置主进程 `nativeTheme.themeSource`，使 shell 与支持 `prefers-color-scheme` 的 provider 网页保持一致。
- 主进程用 `pathToFileURL()` 生成受信任 shell URL，确保 Windows 的 `C:\...` 路径与渲染进程 frame URL 一致；macOS 与 Windows 共用同一套 IPC 与 webview 安全边界。`app:open-external` 只允许项目仓库/Releases 两个 HTTPS URL，`app:open-user-data` 只打开 Qask 的 userData 目录。
- `src/renderer.js` 的布局规范支持 `single`、`dual`、`triple` 和 `quad`。侧栏“外观”提供跟随系统/暗色/亮色三种模式，选择保存在 `qask.theme`。
- 设置保存在 `qask.settings`（快捷键、默认发送方式、对比默认模型、总结确认、自动缩放、窗口置顶、登录时启动、状态栏可见性）；主题继续保存在 `qask.theme`。窗口置顶和登录项通过受信任 IPC 应用到主进程。状态栏默认隐藏，但 `logStatus` 始终写入控制台与内存中的转录。设置「关于」通过受限 IPC 打开项目仓库和本地数据目录，不引入 GitHub 客户端或任意 shell 打开能力。
- 底部发送按钮悬停菜单提供 `send` / `queue` / `fill` 三种模式；`queue` 队列只保存在渲染进程内存中；待发送条目支持拖动/键盘排序、行内编辑和单条删除，当前发送条锁定。队列条目发送前先等待已有面板空闲（停止按钮消失 + 文本稳定），发送后按“最新回答文本稳定（停止按钮存在时多确认一轮）”判断完成，全部完成或超时后自动发送下一条。
- 面板不再渲染宿主标题栏；三面板默认 90%、四面板默认 85%，并在 `webview` 的 `dom-ready` 后通过 Electron `setZoomFactor()` 自动应用。常规刷新/缩放/面板内模型切换控件均已移除，整个面板用于网页内容；当前面板成员只由侧栏拖动排序的前 N 名决定。仅在 `did-fail-load` 或 `render-process-gone` 后显示面板内“重新加载”覆盖层（`panel-state-overlay`），重新加载保留该站点的持久化分区。
- `qask.modelOrder` 是模型网站的规范排序。侧栏仅通过拖动握柄提交排序；`reconcileActivePanelsToModelOrder()` 将排名前 N 个模型映射到 N 个活动面板。面板池最多保留四个已创建的 webview：缩小布局只隐藏未使用面板，恢复布局或将已加载网站重新排入前 N 名时会直接复用其页面、登录态、草稿和滚动位置，不会重新导航。只有当前池内从未加载过的网站才调用 `loadModel()` 创建 webview。侧栏前 N 个条目使用 `.is-active` 样式突出显示。
- 当前 `localStorage` 存储键包括：
  - `qask.layout`
  - `qask.modelOrder`
  - `qask.customModels`
  - `qask.hiddenDefaultModels`（被用户删除的内置网站 id；启动时跳过，侧栏“恢复默认网站”清除）
  - `qask.theme`（`system` / `dark` / `light`）
  - `qask.settings`（快捷键、默认发送方式、对比默认模型、状态栏可见性）
- 回答对比不写入 `localStorage` 或磁盘：renderer 在各活动面板 `ready` 且当前 URL 通过 `injectableOrigins` 校验后，执行只读提取脚本（优先使用站点专用 assistant 容器，失败时回退到通用 assistant/markdown 容器），取最后一条可见回答。提取脚本不读取输入框、侧栏或导航，不点击发送，也不修改页面。结果只保存在 renderer 内存。
- “AI 总结差异”会把已提取的回答整理成提示词，通过所选面板的普通适配器填入并尝试发送；发送前由 renderer 弹出确认。总结内容属于该第三方站点的对话，Qask 只从页面读取显示，不落盘。

历史版本的 API 原型曾将 Key 写入 renderer `localStorage`，但当前网页模式不读取或保存 API Key。未来如重新设计 API 模式，必须采用主进程管理的系统安全存储。

自定义网站标签和 URL 会保存在 `qask.customModels`。Qask 只接受 HTTPS URL，并拒绝 userinfo、query、fragment、GitHub 及其子域/相关内容域；启动时会重新验证旧条目并移除无效或受限的条目。

## 本地附件与录音

- 附件队列保存在 renderer 内存的 `Map`，不会把队列、文件路径、录音元数据或麦克风状态写入 `localStorage`。用户选择的磁盘文件保持原样；录音与粘贴图片由主进程写入 `~/Pictures/Qask Attachments/`，并向宿主返回仅用于展示的 `displayPath`。
- 限制为最多 5 个、合计 20 MB；图片 5 MB、音频/PDF 10 MB；录音最多 120 秒或 10 MB。
- 附件不读取为 Data URI，也不会交给任何 webview 或 guest JavaScript；带附件时文字仍可发送，但附件始终保留本地，等待用户在目标网站自己的上传界面操作。保存目录、文件名与路径只回传宿主 shell，不进入 guest 脚本；`attachments:persist` 有按类型的大小上限（图片 5 MB、音频/PDF 10 MB），`attachments:reveal` 拒绝目录外路径。
- `MediaRecorder` 只在用户点击录音后运行。每次录音拥有独立的 stream、chunks、计时器和 permission lease；停止进入 drain 阶段，最终 `dataavailable` 后才由该录音自己的 `stop` 回调完成附件或丢弃。取消、错误、超限与窗口卸载都会停止轨道并清除缓冲。录音作为 `audio/webm`/`audio/ogg` 附件处理，不等同于第三方网站的实时语音模式或语音转写。
- `preload.js` 仅暴露窄的 `window.qask.microphone` IPC。主进程在 macOS 上先检查/请求 `systemPreferences` 麦克风授权，并签发 30 秒、只允许主 Qask shell 音频请求的短期 lease；录制期间 renderer 每 10 秒续期一次，停止/取消/出错/卸载都会释放。所有 provider partition 的权限处理器均为拒绝。

## 截图 IPC

1. renderer 点击折叠侧栏中的截图按钮。
2. preload 调用 `ipcRenderer.send('take-screenshot')`。
3. main process 使用 `electron-screenshots` 创建捕获界面。
4. 确认或保存时，main process 将 PNG 写到 `Pictures/Qask Screenshots`。
5. main process 仅把“已保存”或取消事件回传 renderer，不回传本地保存路径。

截图需要保留 `main.js`、`preload.js` 与 `electron-screenshots` 依赖。macOS 可能要求屏幕录制权限。

## 当前限制与已知缺陷

- 本机已通过 `npm ci` 安装 macOS arm64 Electron，并已验证 `npm start` 可持续运行。若换机后 Electron 指向 `electron.exe` 或报 `spawn ENOEXEC`，删除 `node_modules` 后在目标机器重新运行 `npm ci`。
- Gemini 注入脚本已通过自动化生成脚本语法检查；外部站点变动仍可能使网页自动发送失效。
- 加载失败或页面进程退出只提供“重新加载”，不会自动恢复第三方网页的登录状态或草稿。
- 回答提取是尽力而为的 DOM 启发式：站点改版、未完成回答或反自动化页面可能读不到内容，原网页面板仍是准确来源。
- 当前不包含 API 模式或 API Key 配置界面。
- 底部状态条会显示逐面板的文本填入/发送尝试结果、超时（未确认）、处理中跳过和附件保留提示；它只代表本地观察，不代表第三方网站已上传或模型已读取附件。
- 静态测试不会证明第三方网页接收附件。上传完成、模型可读性和自动语音交互必须分别在登录后的每个网站手工验证。


## 安全状态

当前仍是原型，不应把静态测试视为正式发布验收；但 webview 安全基线已收紧：shell 与 guest 使用 `webSecurity: true`、禁用不安全内容、guest 无 Node/preload、provider partition 默认拒绝权限。所有弹窗和下载默认拒绝。已隔离的网页可完成正常站内、认证和重定向导航；Qask 填入文本前会在宿主核验当前 HTTPS exact origin，并由网页脚本在每次异步等待后、每次 DOM 写入前复核来源；导航到未登记来源时不注入内容。注入 allowlist（`injectableOrigins`）比主进程导航 allowlist 更窄，认证域（如 `accounts.google.com`、`auth.openai.com`）只允许导航、不允许注入。带附件时仍会执行文本注入，但不会把附件字节、路径或文件名交给 guest script。回答提取脚本同样只在已验证的 `injectableOrigins` 上执行，且只读取可见文本；AI 总结发送前需要用户确认。自定义网站只有用户显式登记的 HTTPS origin，且默认只填入、不自动发送。当前网页模式不保存 API Key；历史 API 原型曾把 Key 写入 renderer `localStorage`。

源码发布也使用 `package.json` 的显式 `files` allowlist 与 `.npmignore` 的 deny-by-default 规则。测试、布局截图、`artifacts/`、依赖目录和开发工具不会进入 npm 包。任何公开 GitHub 仓库或打包二进制仍需在发布前分别审计，不能仅凭这个规则认定为安全发布。

## 手工验收待办

以下条目尚未作为已通过测试记录：

- [x] 在本机 macOS arm64 环境执行 `npm ci` 后，Electron 正确启动并保持运行。
- [ ] 每种 1–4 面板布局均能切换且重启后恢复。
- [ ] 两个已登录模型可以同时收到同一条文本。
- [ ] 未登录、加载中、输入框缺失、发送控件缺失时有清晰的失败提示。
- [ ] 用户可在目标网站自己的上传界面选择并发送附件。
- [ ] 在干净的 macOS 打包应用账户中确认 `NSMicrophoneUsageDescription`、首次麦克风授权、拒绝恢复和无临时录音文件。
- [ ] 对每个内置网站/文件类型/大小组合，确认用户手动上传后的预览或明确拒绝状态；不能以 Qask 状态当作上传成功。
- [ ] 截图保存、取消与 macOS 权限路径均正常。
- [ ] 自定义网页模型新增、重新打开和删除正常。
- [ ] 未来比较视图能正确关联同一问题的各模型回答。

## 下一步

下一阶段是为各网页适配器持续建立回归验证，并在不自动采集第三方内容的前提下设计用户可见的回答对比能力。任何本地会话保存或导出功能都必须先定义明确的数据保留、删除和外发边界。
