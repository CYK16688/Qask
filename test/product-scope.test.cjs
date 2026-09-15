const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const readProjectFile = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

const RUNTIME_GITHUB_INTEGRATION_PATTERNS = [
  /node:child_process/,
  /require\(['"]child_process/,
  /\bexecFile(?:Sync)?\s*\(/,
  /\bgh\s+(?:api|repo|auth)\b/,
  /GITHUB_TOKEN/,
];

test('web-only product scope does not expose unfinished API-key configuration', () => {
  const html = readProjectFile('src/index.html');
  const renderer = readProjectFile('src/renderer.js');

  assert.doesNotMatch(html, /data-mode="api"/);
  assert.doesNotMatch(html, /apiModeSection/);
  assert.doesNotMatch(html, /apiModelAddDialog/);
  assert.doesNotMatch(html, /api-key-input/);
  assert.match(renderer, /const LEGACY_STORAGE_KEYS = \[\s+"qask\.apiKeys",/);
  assert.doesNotMatch(renderer, /AccessModeManager/);
});

test('renderer startup deletes the legacy API key without reading it', () => {
  const renderer = readProjectFile('src/renderer.js');
  const source = renderer.slice(
    renderer.indexOf('const escapeForScript ='),
    renderer.indexOf('const buildChatGPTScript ='),
  );
  const removedKeys = [];
  let readCount = 0;
  const window = {
    localStorage: {
      getItem: () => {
        readCount += 1;
        return 'must-not-be-read';
      },
      removeItem: (key) => removedKeys.push(key),
    },
  };

  const createStorageHarness = new Function(
    'window',
    `${source}\nreturn { purgeLegacyStorage };`,
  );
  createStorageHarness(window);

  assert.deepEqual(removedKeys, [
    'qask.apiKeys',
    'qask.accessMode',
    'qask.panelModels.web',
    'qask.panelModels.api',
    'qask.panelModels',
  ]);
  assert.equal(readCount, 0);
});

test('public source distribution has an explicit allowlist and excludes development artifacts', () => {
  const packageJson = JSON.parse(readProjectFile('package.json'));
  const npmIgnore = readProjectFile('.npmignore');

  assert.equal(packageJson.private, true);
  assert.deepEqual(packageJson.files, [
    'main.js',
    'local-data-boundary.cjs',
    'preload.js',
    'src/',
    'docs/',
    'scripts/run-electron.js',
    'scripts/local-data-boundary-smoke.js',
    'patches/electron-screenshots+0.5.27.patch',
    'README.md',
    'LICENSE',
    'NOTICE',
    'PRIVACY.md',
    'SECURITY.md',
    'CONTRIBUTING.md',
    'COMMERCIAL-LICENSE.md',
  ]);
  assert.match(npmIgnore, /^\*$/m);
  assert.match(npmIgnore, /^!main\.js$/m);
  assert.match(npmIgnore, /^!local-data-boundary\.cjs$/m);
  assert.match(npmIgnore, /^!src\/\*\*$/m);
  assert.match(npmIgnore, /^!docs\/\*\*$/m);
  assert.match(npmIgnore, /^!scripts\/run-electron\.js$/m);
  assert.match(npmIgnore, /^!scripts\/local-data-boundary-smoke\.js$/m);
  assert.match(npmIgnore, /^!patches\/electron-screenshots\+0\.5\.27\.patch$/m);
  assert.match(npmIgnore, /^!LICENSE$/m);
  assert.match(npmIgnore, /^!PRIVACY\.md$/m);
  assert.match(npmIgnore, /^!SECURITY\.md$/m);
  assert.match(npmIgnore, /^!CONTRIBUTING\.md$/m);
  assert.match(npmIgnore, /^!COMMERCIAL-LICENSE\.md$/m);
  assert.match(readProjectFile('.gitignore'), /^artifacts\/$/m);
  assert.match(readProjectFile('.gitignore'), /^\.npm\/$/m);
  assert.match(readProjectFile('.gitignore'), /^\.npmrc$/m);
  assert.match(readProjectFile('.gitignore'), /^\.pypirc$/m);
  assert.match(readProjectFile('.gitignore'), /^credentials\.json$/m);
  assert.match(readProjectFile('.gitignore'), /^\*\.pem$/m);
  assert.match(readProjectFile('.gitignore'), /^\*\.key$/m);
  assert.doesNotMatch(npmIgnore, /^!artifacts\//m);
  assert.doesNotMatch(npmIgnore, /^!test\//m);
});

test('public documentation and package metadata state the AGPL source and commercial-exception model without promising third-party delivery control', () => {
  const privacy = readProjectFile('PRIVACY.md');
  const readme = readProjectFile('README.md');
  const security = readProjectFile('SECURITY.md');
  const contributing = readProjectFile('CONTRIBUTING.md');
  const commercial = readProjectFile('COMMERCIAL-LICENSE.md');
  const notice = readProjectFile('NOTICE');
  const license = readProjectFile('LICENSE');
  const architecture = readProjectFile('docs/architecture.md');
  const packageJson = JSON.parse(readProjectFile('package.json'));
  const packageLock = JSON.parse(readProjectFile('package-lock.json'));

  assert.match(privacy, /does \*\*not\*\* scan, read, index, upload, or inject/i);
  assert.match(privacy, /\.git/);
  assert.match(privacy, /GitHub/i);
  assert.match(privacy, /text you explicitly enter/i);
  assert.match(privacy, /cannot\s+confirm acceptance, reading, deletion,\s+or processing/i);
  assert.match(readme, /PRIVACY\.md/);
  assert.match(readme, /SECURITY\.md/);
  assert.match(readme, /完整源码仓库 checkout/);
  assert.match(readme, /最小运行时包[\s\S]*不包含 `package-lock\.json`、测试套件或 GUI smoke 脚本/);
  assert.match(readme, /AGPL-3\.0-or-later/);
  assert.match(readme, /Copyright © 2026 iCreator/);
  assert.match(readme, /COMMERCIAL-LICENSE\.md/);
  assert.match(security, /Private vulnerability reporting/i);
  assert.match(security, /Report a vulnerability/i);
  assert.match(contributing, /AGPL-3\.0-or-later/);
  assert.match(contributing, /GitHub's private vulnerability reporting flow/i);
  assert.match(architecture, /window\.qask\.attachments\.inspect/);
  assert.match(commercial, /AGPL-3\.0-or-later/);
  assert.match(commercial, /commercial license/i);
  assert.match(notice, /Copyright \(c\) 2026 iCreator/);
  assert.match(notice, /AGPL-3\.0-or-later/);
  assert.match(license, /GNU AFFERO GENERAL PUBLIC LICENSE/);
  assert.match(license, /Version 3, 19 November 2007/);
  assert.equal(packageJson.author, 'iCreator');
  assert.equal(packageJson.license, 'AGPL-3.0-or-later');
  assert.equal(packageLock.packages[''].license, 'AGPL-3.0-or-later');
  assert.doesNotMatch(readme, /not ready to make source, archives, or desktop binaries public/);
  assert.doesNotMatch(security, /No confidential reporting channel has been published yet/);
  assert.doesNotMatch(security, /repository's About section/i);
});

test('repository-only development checks are not claimed to work from the minimal runtime package', () => {
  const readme = readProjectFile('README.md');
  const contributing = readProjectFile('CONTRIBUTING.md');
  const guide = readProjectFile('docs/user-guide.md');

  assert.match(readme, /完整源码仓库 checkout/);
  assert.match(contributing, /完整源码仓库 checkout/);
  assert.match(contributing, /不包含 `package-lock\.json`、`test\/` 或[\s\S]*`scripts\/layout-ui-smoke\.js`/);
  assert.match(guide, /最小运行时包不包含 lockfile 或测试资产/);
});

test('attachment retention documentation says local queue entries last only for the current app session', () => {
  const privacy = readProjectFile('PRIVACY.md');
  const guide = readProjectFile('docs/user-guide.md');
  const architecture = readProjectFile('docs/architecture.md');

  assert.match(privacy, /until you remove its entry\s+or close the app/i);
  assert.match(guide, /当前应用会话/);
  assert.match(guide, /主动移除或关闭 Qask 后会清除/);
  assert.match(architecture, /仅保存在 renderer 内存/);
  assert.doesNotMatch(guide, /直到你主动移除；它不会自动重试或自动清除/);
});

test('public documentation contains no private Hermes-plan reference and identifies third-party brands as unaffiliated', () => {
  const readme = readProjectFile('README.md');
  const architecture = readProjectFile('docs/architecture.md');

  assert.doesNotMatch(readme, /\.hermes\/plans/);
  assert.doesNotMatch(architecture, /\.hermes\/plans/);
  assert.match(readme, /没有隶属、赞助或授权关系/);
});

test('application source has no GitHub integration, filesystem enumeration, or raw provider IPC bridge', () => {
  const main = readProjectFile('main.js');
  const preload = readProjectFile('preload.js');
  const renderer = readProjectFile('src/renderer.js');

  assert.doesNotMatch(main, /(?:require\(['"](?:node:)?(?:child_process|os)|github|\.git)/i);
  assert.match(preload, /webUtils\.getPathForFile/);
  assert.match(preload, /ipcRenderer\.invoke\("attachments:inspect", filePath\)/);
  assert.doesNotMatch(preload, /(?:ipcRenderer\.on\s*$|github|\.git)/i);
  assert.doesNotMatch(renderer, /(?:window\.qask\.(?:git|github)|navigator\.clipboard\.read|webkitdirectory|showDirectoryPicker)/i);
  assert.match(renderer, /function isRestrictedCustomProviderUrl\(url\)/);
  assert.match(main, /nodeIntegration: false/);
  assert.match(main, /contextIsolation: true/);
  assert.match(main, /sandbox: true/);
  assert.match(main, /ipcMain\.handle\("attachments:inspect"/);
});

test('the local Electron launcher may spawn only Electron and contains no GitHub integration', () => {
  const launcher = readProjectFile('scripts/run-electron.js');

  assert.match(launcher, /spawn\(electronBinary, appArgs/);
  for (const pattern of RUNTIME_GITHUB_INTEGRATION_PATTERNS.slice(2)) {
    assert.doesNotMatch(launcher, pattern);
  }
});

test('composer exposes a real local recording control rather than a voice placeholder', () => {
  const html = readProjectFile('src/index.html');
  const renderer = readProjectFile('src/renderer.js');

  assert.match(html, /id="sendButton"/);
  assert.match(html, /id="recordAudioButton"/);
  assert.match(html, /id="stopRecordingButton"/);
  assert.doesNotMatch(html, /id="recordingStatus"/);
  assert.match(renderer, /navigator\.mediaDevices\.getUserMedia\(\{ audio:/);
  assert.doesNotMatch(renderer, /语音输入功能开发中/);
});

test('recording control uses a complete centered microphone glyph', () => {
  const html = readProjectFile('src/index.html');
  const recordButton = html.match(/<button id="recordAudioButton"[\s\S]*?<\/button>/)?.[0] || '';

  assert.match(recordButton, /<svg[^>]*viewBox="0 0 24 24"[^>]*>/);
  assert.match(recordButton, /<path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Z/);
  assert.match(recordButton, /M19 11a7 7 0 0 1-14 0H3/);
});

test('composer preserves a bounded multi-line field and right-aligned media/send controls', () => {
  const html = readProjectFile('src/index.html');
  const styles = readProjectFile('src/styles.css');
  const renderer = readProjectFile('src/renderer.js');

  assert.match(html, /class="composer-input"/);
  assert.match(html, /class="input-right-actions"/);
  assert.doesNotMatch(html, /composerShortcutHint|composer-shortcut-hint/);
  assert.doesNotMatch(html, /id="recordingStatus"|id="attachmentDestinationNotice"|id="broadcastResults"/);
  assert.match(html, /id="sendButton"[^>]*disabled/);
  assert.match(styles, /\.composer-input\s*\{[\s\S]*align-items:\s*center/);
  assert.match(styles, /\.input-right-actions\s*\{/);
  assert.doesNotMatch(styles, /\.composer-shortcut-hint|\.recording-status|\.attachment-destination-notice|\.broadcast-results/);
  assert.match(styles, /#broadcastInput\s*\{[\s\S]*height:\s*20px[\s\S]*padding:\s*0/);
  assert.match(styles, /#broadcastInput\s*\{[\s\S]*max-height:\s*120px/);
  assert.match(renderer, /const maxHeight = 120;/);
  assert.doesNotMatch(renderer, /const maxHeight = 168;/);
  assert.match(styles, /\.composer-input:focus-within/);
});

test('main process keeps remote webviews secure and denies their media permissions', () => {
  const main = readProjectFile('main.js');
  const renderer = readProjectFile('src/renderer.js');

  assert.match(main, /webSecurity: true/);
  assert.match(main, /allowRunningInsecureContent: false/);
  assert.doesNotMatch(main, /ignore-certificate-errors/);
  assert.doesNotMatch(main, /certificate-error/);
  assert.match(main, /setPermissionCheckHandler/);
  assert.match(main, /setPermissionRequestHandler/);
  assert.match(main, /will-attach-webview/);
  assert.match(main, /setWindowOpenHandler/);
  assert.match(main, /function configureWebContents\(contents\) \{[\s\S]*?contents\.setWindowOpenHandler\(\(\) => \(\{ action: "deny" \}\)\);/);
  assert.doesNotMatch(renderer, /allowpopups/);
});

function loadScreenshotCompletionHandler() {
  const main = readProjectFile('main.js');
  const start = main.indexOf('function createScreenshotCompletionHandler');
  const end = main.indexOf('app.on("web-contents-created"');

  assert.notEqual(start, -1);
  assert.ok(end > start);
  return new Function(`${main.slice(start, end)}\nreturn createScreenshotCompletionHandler;`)();
}

function loadSaveScreenshot() {
  const main = readProjectFile('main.js');
  const start = main.indexOf('function saveScreenshot');
  const end = main.indexOf('app.on("web-contents-created"');

  assert.notEqual(start, -1);
  assert.ok(end > start);
  return new Function('app', 'path', 'fs', 'randomUUID', `${main.slice(start, end)}\nreturn saveScreenshot;`);
}

test('Electron 44 screenshot confirmation bypasses the legacy clipboard handler', async () => {
  const createScreenshotCompletionHandler = loadScreenshotCompletionHandler();
  let saveCount = 0;
  let closeCount = 0;
  let resolveClose;
  const closeTask = new Promise((resolve) => {
    resolveClose = resolve;
  });
  const errors = [];
  const completeScreenshot = createScreenshotCompletionHandler({
    handleScreenshot: () => { saveCount += 1; },
    endCapture: () => {
      closeCount += 1;
      return closeTask;
    },
    reportError: (...args) => errors.push(args),
  });
  const firstEvent = {
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; },
  };
  const duplicateEvent = {
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; },
  };

  completeScreenshot(firstEvent, Buffer.from('first'));
  completeScreenshot(duplicateEvent, Buffer.from('duplicate'));

  assert.equal(firstEvent.defaultPrevented, true);
  assert.equal(duplicateEvent.defaultPrevented, true);
  assert.equal(saveCount, 1);
  assert.equal(closeCount, 1);
  assert.deepEqual(errors, []);

  resolveClose();
  await closeTask;
  await Promise.resolve();
  completeScreenshot({ preventDefault() {} }, Buffer.from('next'));

  assert.equal(saveCount, 2);
  assert.equal(closeCount, 2);
});

test('screenshot completion releases its guard after a local save error', async () => {
  const createScreenshotCompletionHandler = loadScreenshotCompletionHandler();
  let closeCount = 0;
  let saveAttempts = 0;
  const errors = [];
  const completeScreenshot = createScreenshotCompletionHandler({
    handleScreenshot: () => {
      saveAttempts += 1;
      if (saveAttempts === 1) throw new Error('disk-full');
    },
    endCapture: () => {
      closeCount += 1;
      return Promise.resolve();
    },
    reportError: (...args) => errors.push(args),
  });
  const firstEvent = { preventDefault() {} };

  await completeScreenshot(firstEvent, Buffer.from('first'));
  await completeScreenshot({ preventDefault() {} }, Buffer.from('retry'));

  assert.equal(saveAttempts, 2);
  assert.equal(closeCount, 2);
  assert.deepEqual(errors, [['Unable to save screenshot']]);
});

test('screenshot completion reports a generic local failure without passing filesystem errors to logs', async () => {
  const createScreenshotCompletionHandler = loadScreenshotCompletionHandler();
  const errors = [];
  const completeScreenshot = createScreenshotCompletionHandler({
    handleScreenshot: () => { throw new Error('sensitive local path'); },
    endCapture: () => Promise.resolve(),
    reportError: (...args) => errors.push(args),
  });

  await completeScreenshot({ preventDefault() {} }, Buffer.from('capture'));

  assert.deepEqual(errors, [['Unable to save screenshot']]);
});

test('the production screenshot error reporter logs only its fixed message', () => {
  const main = readProjectFile('main.js');

  assert.match(main, /reportError: \(message\) => console\.error\(message\)/);
  assert.doesNotMatch(main, /reportError: \(message, error\) => console\.error\(message, error\)/);
});

test('screenshot capture startup handles rejected dependency promises without exposing their error', () => {
  const main = readProjectFile('main.js');

  assert.match(
    main,
    /screenshots\.startCapture\(\)\.catch\(\(\) => \{\s*console\.error\("Unable to start screenshot capture"\);\s*}\);/,
  );
  assert.doesNotMatch(main, /startCapture\(\)\.catch\(\(error\)/);
});

test('screenshot dependency logging is patched out and the host supplies a no-op logger', () => {
  const packageJson = JSON.parse(readProjectFile('package.json'));
  const main = readProjectFile('main.js');
  const patch = readProjectFile('patches/electron-screenshots+0.5.27.patch');

  assert.equal(packageJson.dependencies['patch-package'], '8.0.1');
  assert.equal(packageJson.scripts.postinstall, 'patch-package');
  assert.match(main, /new Screenshots\(\{ singleWindow: true, logger: \(\) => \{\} \}\)/);
  assert.match(patch, /--- a\/node_modules\/electron-screenshots\/lib\/preload\.js/);
  assert.doesNotMatch(patch, /^\+.*console\.log/m);
  assert.match(patch, /-\s*console\.log\('contextBridge save', arrayBuffer, data\);/);
  assert.match(patch, /-\s*console\.log\.apply\(console, __spreadArray/);
});

test('automatic screenshots use collision-resistant local filenames', () => {
  const writePaths = [];
  const createSaveScreenshot = loadSaveScreenshot();
  const saveScreenshot = createSaveScreenshot(
    { getPath: () => '/pictures' },
    { join: (...segments) => segments.join('/') },
    { mkdirSync() {}, writeFileSync: (filePath) => writePaths.push(filePath) },
    (() => {
      let index = 0;
      return () => `uuid-${++index}`;
    })(),
  );

  saveScreenshot(Buffer.from('first'));
  saveScreenshot(Buffer.from('second'));

  assert.equal(writePaths.length, 2);
  assert.notEqual(writePaths[0], writePaths[1]);
  assert.ok(writePaths.every((filePath) => /Qask-Screenshot-.*-uuid-\d+\.png$/.test(filePath)));
});


test('main process permits only one Qask instance to own persistent provider sessions', () => {
  const main = readProjectFile('main.js');

  assert.match(main, /const hasSingleInstanceLock = app\.requestSingleInstanceLock\(\);/);
  assert.match(main, /if \(!hasSingleInstanceLock\) \{[\s\S]*?app\.quit\(\);/);
  assert.match(main, /app\.on\("second-instance", \(\) => \{[\s\S]*?mainWindow\.focus\(\);/);
});

test('layout lifecycle diagnostics are opt-in and omit message content', () => {
  const main = readProjectFile('main.js');
  const renderer = readProjectFile('src/renderer.js');
  const preload = readProjectFile('preload.js');
  const launcher = readProjectFile('scripts/run-electron.js');

  assert.match(preload, /layoutLifecycleTraceEnabled: process\.env\.QASK_TRACE_LAYOUT_LIFECYCLE === "1"/);
  assert.match(main, /if \(layoutLifecycleTraceEnabled\) \{\s*mainWindow\.webContents\.openDevTools\(\{ mode: "detach", activate: false \}\);/);
  assert.match(launcher, /traceLayoutLifecycle = args\.includes\("--trace-layout-lifecycle"\)/);
  assert.match(renderer, /window\.qask\?\.diagnostics\?\.layoutLifecycleTraceEnabled === true/);
  assert.match(renderer, /function traceLayoutState\(stage, extra = \{\}\)/);
  assert.match(renderer, /event: "layout-state"/);
  assert.match(renderer, /traceLayoutState\("selected"\)/);
  assert.doesNotMatch(renderer, /prompt:.*qask-layout-trace/);
  assert.match(main, /layoutLifecycleTraceEnabled = process\.env\.QASK_TRACE_LAYOUT_LIFECYCLE === "1"/);
  assert.match(main, /function configureShellLifecycleTrace\(contents\) \{\s+if \(!layoutLifecycleTraceEnabled \|\| contents !== mainWindow\?\.webContents\) return;/);
  assert.match(main, /contents\.on\("console-message", \(details\) => \{[\s\S]*?details\.message\.startsWith\("\[qask-layout-trace\]"\)/);
  const traceSources = Array.from(renderer.matchAll(/console\.info\("\[qask-layout-trace\]", JSON\.stringify\(\{([\s\S]{0,800}?)}\)\);/g)).map((match) => match[0]);
  assert.ok(traceSources.length >= 2);
  assert.ok(traceSources.some((source) => /panelId:[\s\S]*?modelId,[\s\S]*?event,[\s\S]*?origin,[\s\S]*?elapsedMs:/.test(source)));
  assert.ok(traceSources.every((source) => !/(?:text|attachment|cookie|payload)/i.test(source)));
});

test('local status and screenshot notifications do not log user paths or attachment names', () => {
  const renderer = readProjectFile('src/renderer.js');
  const statusStart = renderer.indexOf('function logStatus');
  const statusEnd = renderer.indexOf('function closeModelAddDialog');
  const statusSource = renderer.slice(statusStart, statusEnd);
  const screenshotStart = renderer.indexOf('window.qask.screenshot.onSaved');
  const screenshotEnd = renderer.indexOf('window.qask.screenshot.onCancelled');
  const screenshotSource = renderer.slice(screenshotStart, screenshotEnd);

  assert.doesNotMatch(statusSource, /console\.log/);
  assert.match(statusSource, /const method = level === "error" \? console\.error : console\.info/);
  assert.doesNotMatch(screenshotSource, /console\.(?:log|info|warn|error)\([^\n]*filePath/);
  assert.doesNotMatch(screenshotSource, /filePath\.split/);
  assert.match(screenshotSource, /logStatus\("截图已保存到本地", "success"\)/);
});

test('screenshot notifications do not surface a local filename to the renderer', () => {
  const renderer = readProjectFile('src/renderer.js');
  const screenshotStart = renderer.indexOf('window.qask.screenshot.onSaved');
  const screenshotEnd = renderer.indexOf('window.qask.screenshot.onCancelled');
  const screenshotSource = renderer.slice(screenshotStart, screenshotEnd);

  assert.doesNotMatch(screenshotSource, /filePath|截图已保存:\s*\$\{/);
  assert.match(screenshotSource, /logStatus\("截图已保存到本地", "success"\)/);
});

test('the screenshot preload bridge does not expose a saved local path', () => {
  const preload = readProjectFile('preload.js');

  assert.match(preload, /onSaved: \(callback\) => ipcRenderer\.on\('screenshot-saved', \(\) => callback\(\)\)/);
  assert.doesNotMatch(preload, /screenshot-saved', \(event, filePath\)/);
});

test('attachment-bearing status output contains no selected attachment name or path', () => {
  const renderer = readProjectFile('src/renderer.js');
  const submitStart = renderer.indexOf('broadcastForm.addEventListener("submit"');
  const submitEnd = renderer.indexOf('broadcastInput.addEventListener("keydown"', submitStart);
  const submitSource = renderer.slice(submitStart, submitEnd);

  assert.doesNotMatch(submitSource, /entry\.file\.name|localAttachments\.map\(/);
  assert.match(submitSource, /附件保留在本地；请在每个网页自己的上传界面中选择、确认并手动发送/);
});

test('guest execution failures and attachment removal statuses do not log remote errors or local filenames', () => {
  const renderer = readProjectFile('src/renderer.js');
  const dispatchStart = renderer.indexOf('async function dispatchMessage');
  const dispatchEnd = renderer.indexOf('function presentResults');
  const dispatchSource = renderer.slice(dispatchStart, dispatchEnd);
  const attachmentClickStart = renderer.indexOf('attachmentPreview.addEventListener("click"');
  const attachmentClickEnd = renderer.indexOf('function selectLayout', attachmentClickStart);
  const attachmentClickSource = renderer.slice(attachmentClickStart, attachmentClickEnd);

  assert.doesNotMatch(dispatchSource, /error\.message/);
  assert.doesNotMatch(renderer.slice(0, renderer.indexOf('const DEFAULT_MODELS =')), /error\?\.message/);
  assert.match(dispatchSource, /message: `网页操作失败\$\{usingFallback \? " \(通用策略\)" : ""\}`/);
  assert.doesNotMatch(attachmentClickSource, /fileName/);
  assert.match(attachmentClickSource, /logStatus\("附件已移除", "info"\)/);
});

test('the launcher does not suppress Electron security warnings', () => {
  const launcher = readProjectFile('scripts/run-electron.js');

  assert.doesNotMatch(launcher, /ELECTRON_DISABLE_SECURITY_WARNINGS/);
});

test('package exposes an Electron GUI layout smoke test rather than claiming static assertions are visual verification', () => {
  const packageJson = JSON.parse(readProjectFile('package.json'));
  const smoke = readProjectFile('scripts/layout-ui-smoke.js');

  assert.equal(packageJson.scripts['test:layout-ui'], 'electron scripts/layout-ui-smoke.js');
  assert.match(smoke, /BrowserWindow\.getAllWindows\(\)\[0\]/);
  assert.match(smoke, /layoutButton\.click\(\)/);
  assert.match(smoke, /getBoundingClientRect\(\)/);
  assert.match(smoke, /capturePage\(\)/);
  assert.match(smoke, /activeSidebarModels/);
  assert.match(smoke, /collapsedPressed/);
});

test('local-data boundary smoke uses a private unique temporary directory and asserts its policy result', () => {
  const smoke = readProjectFile('scripts/local-data-boundary-smoke.js');

  assert.match(smoke, /fs\.mkdtempSync\(path\.join\(os\.tmpdir\(\), 'qask-boundary-check-'/);
  assert.doesNotMatch(smoke, /['"]\/tmp\/qask-boundary-check['"]/);
  assert.match(smoke, /result\.safe\.allowed !== true/);
  assert.match(smoke, /result\.git\.allowed !== false/);
  assert.match(smoke, /result\.git\.reason !== 'hidden-or-git-path'/);
  assert.match(smoke, /fs\.rmSync\(base, \{ recursive: true, force: true, maxRetries: 3 \}\)/);
  assert.match(smoke, /console\.error\('Local-data boundary smoke failed'\)/);
  assert.doesNotMatch(smoke, /error\.stack|error\.message/);
});

test('runtime Electron is pinned to the audited supported release line', () => {
  const packageJson = JSON.parse(readProjectFile('package.json'));
  const lockfile = JSON.parse(readProjectFile('package-lock.json'));

  assert.equal(packageJson.dependencies.electron, '44.3.0');
  assert.equal(packageJson.dependencies['electron-screenshots'], '0.5.27');
  assert.equal(packageJson.dependencies['patch-package'], '8.0.1');
  assert.equal(packageJson.engines.node, '>=22.12.0');
  assert.equal(lockfile.packages[''].dependencies.electron, '44.3.0');
  assert.equal(lockfile.packages[''].dependencies['electron-screenshots'], '0.5.27');
  assert.equal(lockfile.packages[''].dependencies['patch-package'], '8.0.1');
  assert.match(readProjectFile('package.json'), /"private": true/);
  assert.doesNotMatch(readProjectFile('package.json'), /"package-lock"/);
  assert.equal(
    Object.values(lockfile.packages).some((entry) => String(entry?.resolved || '').includes('registry.npmmirror.com')),
    false,
  );
});

test('provider guest navigation, popups, and downloads fail closed outside each provider allowlist', () => {
  const main = readProjectFile('main.js');

  assert.match(main, /const PROVIDER_ORIGIN_ALLOWLIST =/);
  assert.match(main, /function isAllowedProviderUrl\(policy, value\)/);
  assert.match(main, /providerSession\.on\("will-download"/);
  assert.match(main, /setWindowOpenHandler\(\(\) => \(\{ action: "deny" \}\)\)/);
  assert.doesNotMatch(main, /shell\.openExternal\(url\)/);
});

test('provider guest navigation is enforced by the main-process allowlist and dispatch stays origin-bound', () => {
  const main = readProjectFile('main.js');
  const renderer = readProjectFile('src/renderer.js');

  assert.match(main, /function enforceProviderNavigation\(contents\) \{/);
  assert.match(main, /contents\.on\("will-navigate", \(event, url\) => \{/);
  assert.match(main, /contents\.on\("will-redirect", \(event, url\) => \{/);
  assert.match(main, /getProviderNavigationPolicy\(contents\.session\)/);
  assert.match(main, /if \(!isAllowedProviderUrl\(policy, url\)\) \{[\s\S]*?event\.preventDefault\(\);/);
  assert.match(main, /function configureWebContents\(contents\) \{[\s\S]*?enforceProviderNavigation\(contents\);/);
  assert.match(renderer, /if \(!isTrustedGuestUrl\(currentUrl, config\.allowedOrigins \|\| \[\]\)\)/);
  assert.match(renderer, /function buildOriginCheckExpression\(origins, originExpression = "location\.origin"\)/);
  assert.match(renderer, /const originCheck = buildOriginCheckExpression\(origins\);[\s\S]*?const isAllowedOrigin = \(\) => \$\{originCheck\};/);
});

test('provider navigation preserves known first-party authentication origins', () => {
  const main = readProjectFile('main.js');
  const start = main.indexOf('const PROVIDER_PARTITION_PREFIX');
  const end = main.indexOf('function hasActiveMicrophoneLease');
  const source = main.slice(start, end);
  const sessions = new Map();
  const session = {
    fromPartition(partition) {
      if (!sessions.has(partition)) {
        sessions.set(partition, {
          setPermissionCheckHandler() {},
          setPermissionRequestHandler() {},
          on() {},
        });
      }
      return sessions.get(partition);
    },
  };
  const harness = new Function('session', 'app', `${source}\nreturn { configureProviderSession, getProviderNavigationPolicy, isAllowedProviderUrl };`);
  const { configureProviderSession, getProviderNavigationPolicy, isAllowedProviderUrl } = harness(session, { requestSingleInstanceLock: () => true, quit() {} });

  const chatgptPolicy = getProviderNavigationPolicy(configureProviderSession('persist:chatgpt', 'https://chat.openai.com/'));
  assert.equal(isAllowedProviderUrl(chatgptPolicy, 'https://auth.openai.com/log-in'), true);

  const claudePolicy = getProviderNavigationPolicy(configureProviderSession('persist:claude', 'https://claude.ai/new'));
  assert.equal(isAllowedProviderUrl(claudePolicy, 'https://accounts.google.com/o/oauth2/auth'), true);
  assert.equal(isAllowedProviderUrl(claudePolicy, 'https://claude.com/app-unavailable-in-region'), true);
  assert.equal(isAllowedProviderUrl(claudePolicy, 'https://evil.example/oauth'), false);

  const kimiPolicy = getProviderNavigationPolicy(configureProviderSession('persist:kimi', 'https://www.kimi.com/'));
  assert.equal(isAllowedProviderUrl(kimiPolicy, 'https://kimi.moonshot.cn/'), true);
});

test('provider navigation policy is session-bound, exact-origin, and configured only once', () => {
  const main = readProjectFile('main.js');
  const start = main.indexOf('const PROVIDER_PARTITION_PREFIX');
  const end = main.indexOf('function hasActiveMicrophoneLease');
  const source = main.slice(start, end);
  const createdSessions = new Map();
  const session = {
    fromPartition(partition) {
      if (!createdSessions.has(partition)) {
        createdSessions.set(partition, {
          permissionChecks: 0,
          permissionRequests: 0,
          downloadListeners: 0,
          setPermissionCheckHandler() { this.permissionChecks += 1; },
          setPermissionRequestHandler() { this.permissionRequests += 1; },
          on(eventName) {
            if (eventName === 'will-download') this.downloadListeners += 1;
          },
        });
      }
      return createdSessions.get(partition);
    },
  };
  const createPolicyHarness = new Function(
    'session', 'app',
    `${source}\nreturn { configureProviderSession, getProviderNavigationPolicy, isAllowedProviderUrl };`,
  );
  const { configureProviderSession, getProviderNavigationPolicy, isAllowedProviderUrl } = createPolicyHarness(session, { requestSingleInstanceLock: () => true, quit() {} });

  const customSession = configureProviderSession('persist:custom-site', 'https://trusted.example/app');
  const customPolicy = getProviderNavigationPolicy(customSession);
  assert.ok(customPolicy);
  assert.equal(isAllowedProviderUrl(customPolicy, 'https://trusted.example/next'), true);
  assert.equal(isAllowedProviderUrl(customPolicy, 'https://elsewhere.example/'), false);
  assert.equal(configureProviderSession('persist:custom-site', 'https://elsewhere.example/'), null);
  assert.equal(isAllowedProviderUrl(customPolicy, 'https://elsewhere.example/'), false);

  const chatgptSession = configureProviderSession('persist:chatgpt', 'https://chatgpt.com/');
  const chatgptPolicy = getProviderNavigationPolicy(chatgptSession);
  assert.equal(isAllowedProviderUrl(chatgptPolicy, 'https://chatgpt.com/auth/login'), true);
  assert.equal(isAllowedProviderUrl(chatgptPolicy, 'https://attacker.example/'), false);
  configureProviderSession('persist:chatgpt', 'https://chatgpt.com/');
  assert.equal(chatgptSession.downloadListeners, 1);
  assert.equal(chatgptSession.permissionChecks, 1);
  assert.equal(chatgptSession.permissionRequests, 1);
  assert.doesNotMatch(main, /getPartition/);
});

test('main-process provider navigation enforcement rejects unknown origins without affecting the shell', () => {
  const main = readProjectFile('main.js');
  const start = main.indexOf('function enforceProviderNavigation');
  const end = main.indexOf('function configureShellLifecycleTrace', start);
  const createHarness = new Function(
    'getProviderNavigationPolicy',
    'isAllowedProviderUrl',
    `${main.slice(start, end)}\nreturn { enforceProviderNavigation };`,
  );
  const allowedPolicy = { allowedOrigins: ['https://trusted.example'] };
  const { enforceProviderNavigation } = createHarness(
    (providerSession) => providerSession?.policy || null,
    (policy, url) => policy.allowedOrigins.includes(new URL(url).origin),
  );
  const handlers = new Map();
  const contents = {
    session: { policy: allowedPolicy },
    on(eventName, handler) { handlers.set(eventName, handler); },
  };
  enforceProviderNavigation(contents);

  let allowedPrevented = false;
  handlers.get('will-navigate')({ preventDefault: () => { allowedPrevented = true; } }, 'https://trusted.example/next');
  assert.equal(allowedPrevented, false);

  let blockedPrevented = false;
  handlers.get('will-redirect')({ preventDefault: () => { blockedPrevented = true; } }, 'https://untrusted.example/');
  assert.equal(blockedPrevented, true);
});

test('documented localStorage keys match actual retained state', () => {
  const renderer = readProjectFile('src/renderer.js');
  const privacy = readProjectFile('PRIVACY.md');
  const architecture = readProjectFile('docs/architecture.md');

  assert.doesNotMatch(renderer, /panelModels:\s*"qask\.panelModels"/);
  assert.doesNotMatch(renderer, /function persistPanelSelections\(/);
  assert.match(renderer, /"qask\.panelModels",/);
  assert.match(privacy, /layout selection, website ordering, and custom\s+website labels\/URLs/);
  assert.match(architecture, /`qask\.layout`/);
  assert.match(architecture, /`qask\.modelOrder`/);
  assert.match(architecture, /`qask\.customModels`/);
  assert.doesNotMatch(architecture, /`qask\.panelModels`/);
});

test('custom webpage models require explicit confirmation before they can auto-send', () => {
  const renderer = readProjectFile('src/renderer.js');

  assert.match(renderer, /allowAutoSend: Boolean\(model\.allowAutoSend\)/);
  assert.match(renderer, /modelAddAutoSendInput/);
  assert.match(renderer, /config\.allowAutoSend \? true : false/);
});

test('text-only webview dispatch reports attempted auto-send separately from input fill', () => {
  const renderer = readProjectFile('src/renderer.js');

  assert.match(renderer, /const attemptedCount = results\.filter\(\(result\) => result\.attemptedAutoSend === true\)/);
  assert.match(renderer, /已尝试触发 \$\{attemptedCount\} 个网页发送/);
  assert.match(renderer, /已填充 \$\{filledCount\} 个网页输入框，请在网页中确认发送/);
  assert.doesNotMatch(renderer, /成功发送到 \$\{successCount\} 个模型/);
});

test('user guide documents safe consecutive broadcasts and retained later drafts', () => {
  const guide = readProjectFile('docs/user-guide.md');

  assert.match(guide, /继续发送下一轮/);
  assert.match(guide, /上一轮注入仍未结束时，Qask 会跳过该网页/);
  assert.match(guide, /会保留新草稿，不会被上一轮完成动作清空/);
});

test('continuous broadcasts preserve guest sessions and keep per-webview dispatch ordering', () => {
  const renderer = readProjectFile('src/renderer.js');
  const guide = readProjectFile('docs/user-guide.md');

  assert.match(renderer, /const dispatchCoordinator = createDispatchCoordinator\(\);/);
  assert.match(renderer, /if \(dispatchCoordinator\.isBusy\(panelState\.webview\)\)/);
  assert.match(renderer, /reconcileActivePanelsToModelOrder\(\) \{[\s\S]*?plan\.filter\(\(\{ action \}\) => action === "load"\)/);
  assert.match(guide, /不限轮次/);
  assert.match(guide, /不会被永久排除/);
});

test('a retained broadcast retries only failed text recipients and preserves manual page drafts', () => {
  const renderer = readProjectFile('src/renderer.js');

  assert.match(renderer, /let pendingBroadcastTurn = null/);
  assert.match(renderer, /const pendingAction = getPendingBroadcastAction\(pendingBroadcastTurn/);
  assert.match(renderer, /if \(pendingAction\.mode === "hold"\)/);
  assert.match(renderer, /pendingAction\.mode === "retry"/);
  assert.match(renderer, /if \(snapshot\.attachments\.length > 0\) return null/);
});

test('microphone access is an explicit trusted-shell IPC request, not a guest capability', () => {
  const main = readProjectFile('main.js');
  const preload = readProjectFile('preload.js');
  const renderer = readProjectFile('src/renderer.js');

  assert.match(main, /systemPreferences/);
  assert.match(main, /ipcMain\.handle\("microphone:request-access"/);
  assert.match(main, /isTrustedShellSender\(event\)/);
  assert.match(main, /askForMediaAccess\("microphone"\)/);
  assert.match(preload, /microphone:/);
  assert.match(preload, /ipcRenderer\.invoke\("microphone:request-access"\)/);
  assert.match(renderer, /qask\?\.microphone\?\.requestAccess\?\.\(\)/);
});

test('microphone leases are capability tokens so a stale cancelled request cannot revoke a newer recorder', () => {
  const main = readProjectFile('main.js');
  const preload = readProjectFile('preload.js');
  const renderer = readProjectFile('src/renderer.js');
  const leaseSource = main.slice(
    main.indexOf('const MICROPHONE_LEASE_DURATION_MS ='),
    main.indexOf('function isTrustedShellWebContents'),
  );
  let nextLease = 0;
  const createLeaseHarness = new Function(
    'randomUUID', 'app',
    `${leaseSource}\nreturn { grantMicrophoneLease, revokeMicrophoneLease, hasActiveMicrophoneLease };`,
  );
  const { grantMicrophoneLease, revokeMicrophoneLease, hasActiveMicrophoneLease } = createLeaseHarness(() => `lease-${++nextLease}`, { requestSingleInstanceLock: () => true, quit() {} });
  const staleLease = grantMicrophoneLease();
  const activeLease = grantMicrophoneLease();

  assert.notEqual(staleLease, activeLease);
  assert.equal(revokeMicrophoneLease(staleLease), false);
  assert.equal(hasActiveMicrophoneLease(), true);
  assert.equal(revokeMicrophoneLease(activeLease), true);
  assert.equal(hasActiveMicrophoneLease(), false);
  assert.match(preload, /releaseAccess: \(leaseId\) => ipcRenderer\.invoke\("microphone:release-access", leaseId\)/);
  assert.match(renderer, /let activeRecordingSession = null/);
  assert.match(renderer, /leaseId: acquiredLeaseId/);
  assert.match(renderer, /releaseMicrophoneLease\(acquiredLeaseId\)/);
});

test('custom webpage models are limited to HTTPS because guest webviews reject insecure URLs', () => {
  const renderer = readProjectFile('src/renderer.js');
  const guide = readProjectFile('docs/user-guide.md');

  assert.match(renderer, /parsedUrl\.protocol !== "https:"/);
  assert.match(renderer, /请输入有效的 HTTPS 网址/);
  assert.doesNotMatch(renderer, /必须以 http:\/\/ 或 https:\/\/ 开头/);
  assert.match(guide, /`https:\/\/`/);
  assert.doesNotMatch(guide, /`http:\/\//);
});

test('custom model registration rejects GitHub web properties before persistent settings are created', () => {
  const renderer = readProjectFile('src/renderer.js');
  const start = renderer.indexOf('function isRestrictedCustomProviderUrl');
  const end = renderer.indexOf('function registerModel');
  const loadCustomOriginBoundary = new Function(
    'isTrustedGuestUrl',
    `${renderer.slice(start, end)}\nreturn { isRestrictedCustomProviderUrl, getAllowedOrigins };`,
  );
  const { isRestrictedCustomProviderUrl, getAllowedOrigins } = loadCustomOriginBoundary((value, origins) => {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && origins.includes(url.origin);
    } catch {
      return false;
    }
  });

  assert.match(renderer, /function isRestrictedCustomProviderUrl\(url\)/);
  assert.match(renderer, /"github\.com"/);
  assert.match(renderer, /"api\.github\.com"/);
  assert.match(renderer, /"raw\.githubusercontent\.com"/);
  assert.match(renderer, /if \(isRestrictedCustomProviderUrl\(parsedUrl\)\) \{[\s\S]*?不能将 GitHub 站点注册为 AI 模型/);
  assert.match(renderer, /function registerModel\(model, \{ replace = false \} = \{\}\) \{[\s\S]*?isRestrictedCustomProviderUrl\(model\.url\)/);
  assert.equal(isRestrictedCustomProviderUrl('https://github.com/acme/private'), true);
  assert.equal(isRestrictedCustomProviderUrl('https://api.github.com/'), true);
  assert.equal(isRestrictedCustomProviderUrl('https://github.com./acme/private'), true);
  assert.equal(isRestrictedCustomProviderUrl('https://objects.githubusercontent.com/private-object'), true);
  assert.equal(isRestrictedCustomProviderUrl('https://user.github.io/prompt-capture'), true);
  assert.equal(isRestrictedCustomProviderUrl('https://codeload.github.com/acme/private/zip/main'), true);
  assert.equal(isRestrictedCustomProviderUrl('https://github.dev/acme/private'), true);
  assert.equal(isRestrictedCustomProviderUrl('https://tenant.github.dev/'), true);
  assert.equal(isRestrictedCustomProviderUrl('https://tenant.github.dev./'), true);
  assert.equal(isRestrictedCustomProviderUrl('https://github.io/'), true);
  assert.equal(isRestrictedCustomProviderUrl('https://github.io./'), true);
  assert.equal(isRestrictedCustomProviderUrl('https://token@chat.example.com/'), true);
  assert.equal(isRestrictedCustomProviderUrl('https://chat.example.com/?access_token=redacted'), true);
  assert.equal(isRestrictedCustomProviderUrl('https://chat.example.com/?api_key=redacted'), true);
  assert.equal(isRestrictedCustomProviderUrl('https://chat.example.com/?mode=chat'), true);
  assert.equal(isRestrictedCustomProviderUrl('https://chat.example.com/#temporary-state'), true);
  assert.equal(isRestrictedCustomProviderUrl('https://chat.example.com/'), false);
  assert.deepEqual(
    getAllowedOrigins({
      url: 'https://chat.example.com/app',
      allowedOrigins: ['https://github.com', 'https://objects.githubusercontent.com', 'https://chat.example.com'],
    }),
    ['https://chat.example.com'],
  );
});

test('saved custom provider entries are revalidated and unsafe entries are removed from local storage', () => {
  const renderer = readProjectFile('src/renderer.js');
  const start = renderer.indexOf('DEFAULT_MODELS.forEach');
  const end = renderer.indexOf('modelOrder = normalizeModelOrder', start);
  const hydrationSource = renderer.slice(start, end);

  assert.match(hydrationSource, /if \(!model \|\| !model\.id \|\| !model\.url\)/);
  assert.match(hydrationSource, /if \(isRestrictedCustomProviderUrl\(model\.url\)\) \{[\s\S]*?removedUnsafeCustomModel = true/);
  assert.match(hydrationSource, /if \(removedUnsafeCustomModel\) \{[\s\S]*?persistCustomModels\(\)/);
});

test('the composer guards a broadcast in flight without rendering a status result region', () => {
  const renderer = readProjectFile('src/renderer.js');

  assert.match(renderer, /let isBroadcasting = false/);
  assert.match(renderer, /if \(isBroadcasting\) return;/);
  assert.doesNotMatch(renderer, /function showBroadcastResult\(/);
});

test('attachments cannot be removed after a broadcast snapshots them', () => {
  const renderer = readProjectFile('src/renderer.js');
  const previewStart = renderer.indexOf('function renderAttachmentPreview');
  const previewEnd = renderer.indexOf('function clearAttachments');
  const preview = renderer.slice(previewStart, previewEnd);

  assert.match(renderer, /let isBroadcasting = false/);
  assert.match(preview, /removeButton\.disabled = isBroadcasting/);
  assert.match(renderer, /if \(isBroadcasting\) return;[\s\S]*?attachments\.delete\(id\)/);
});

test('the composer defers sending until a recording is finalized', () => {
  const renderer = readProjectFile('src/renderer.js');

  assert.match(renderer, /function getBroadcastBlockReason\(/);
  assert.match(renderer, /const broadcastBlockReason = getBroadcastBlockReason\(\);/);
  assert.match(renderer, /if \(broadcastBlockReason\) \{/);
  assert.match(renderer, /isBroadcasting \|\| getBroadcastBlockReason\(\)/);
  assert.match(renderer, /请先停止或取消录音，再发送消息/);
});

test('the composer keeps its send state and IME submission semantics explicit', () => {
  const renderer = readProjectFile('src/renderer.js');

  assert.match(renderer, /function canSubmitComposer\(/);
  assert.match(renderer, /function syncComposerState\(/);
  assert.match(renderer, /sendButton\.disabled = !canSubmitComposer\(\)/);
  assert.match(renderer, /event\.isComposing \|\| event\.keyCode === 229/);
  assert.match(renderer, /event\.key === "Enter" && !event\.shiftKey/);
  assert.match(renderer, /hasAutoSendAttempt/);
  assert.doesNotMatch(renderer, /hasAcceptedText/);
});

test('recording start uses a cancellation-safe generation guard', () => {
  const renderer = readProjectFile('src/renderer.js');

  assert.match(renderer, /let recordingStartPending = false/);
  assert.match(renderer, /let recordingGeneration = 0/);
  assert.match(renderer, /if \(activeRecorder \|\| recordingStartPending\) return;/);
  assert.match(renderer, /recordingGeneration \+= 1/);
  assert.match(renderer, /stopStreamTracks\(stream\)/);
  assert.match(renderer, /if \(generation !== recordingGeneration\) \{\s+releaseMicrophoneLease\(acquiredLeaseId\);\s+return;/);
  assert.match(renderer, /if \(generation !== recordingGeneration\) \{\s+stopStreamTracks\(stream\);\s+releaseMicrophoneLease\(acquiredLeaseId\);\s+return;/);
  assert.match(renderer, /createRecordingSession\(\{/);
  assert.match(renderer, /window\.addEventListener\("beforeunload"/);
});

test('microphone permission pending blocks the full composer without adding hint text', () => {
  const html = readProjectFile('src/index.html');
  const renderer = readProjectFile('src/renderer.js');

  assert.match(html, /id="attachmentPreview"[^>]*aria-label="待发送附件"/);
  assert.match(renderer, /recordingStartPending = true;\s+const generation = \+\+recordingGeneration;\s+syncComposerState\(\);/);
  assert.match(renderer, /recordingStartPending = false;\s+syncComposerState\(\);/);
  assert.doesNotMatch(renderer, /recordAudioButton\.disabled = false/);
});

test('attachment rejections preserve composer state without a visible status hint', () => {
  const renderer = readProjectFile('src/renderer.js');

  assert.match(renderer, /if \(!validation\.valid\) \{[\s\S]*?return null/);
  assert.doesNotMatch(renderer, /showBroadcastResult\(/);
});

test('model ranking supports keyboard drag without restoring visible move arrows', () => {
  const renderer = readProjectFile('src/renderer.js');

  assert.match(renderer, /let keyboardDraggedModelId = null/);
  assert.match(renderer, /event\.key === "ArrowUp"/);
  assert.match(renderer, /event\.key === "ArrowDown"/);
  assert.match(renderer, /event\.key === "Escape"/);
  assert.match(renderer, /aria-pressed/);
});

test('the custom-model dialog makes the background inert while it is open', () => {
  const renderer = readProjectFile('src/renderer.js');

  assert.match(renderer, /appShell\?\.setAttribute\("inert", ""\)/);
  assert.match(renderer, /appShell\?\.removeAttribute\("inert"\)/);
  assert.match(renderer, /trapModelAddDialogFocus/);
});

test('layout glyph controls retain an accessible pressed state in both sidebars', () => {
  const html = readProjectFile('src/index.html');
  const renderer = readProjectFile('src/renderer.js');
  const styles = readProjectFile('src/styles.css');

  assert.match(html, /class="collapsed-layout-btn"[^>]*aria-label="单窗口布局"[^>]*aria-pressed="false"/);
  assert.match(html, /class="layout-button"[^>]*aria-label="单窗口布局"[^>]*aria-pressed="false"/);
  assert.doesNotMatch(html, /collapsed-layout-btn"[^>]*aria-checked/);
  assert.doesNotMatch(html, /role="radiogroup"/);
  assert.match(renderer, /button\.setAttribute\("aria-pressed", String\(isActive\)\)/);
  assert.match(renderer, /\[\.\.\.layoutButtons, \.\.\.collapsedLayoutButtons\]\.forEach/);
  assert.match(renderer, /synchronizeLayoutControls\(preset\.id\)/);
  assert.match(styles, /\.collapsed-layout-btn\[aria-pressed="true"\]/);
});

test('README describes the shipped HTTPS-only multimodal boundary', () => {
  const readme = readProjectFile('README.md');

  assert.match(readme, /自定义 HTTPS 网页模型/);
  assert.match(readme, /本地录音/);
  assert.match(readme, /音频或 PDF/);
  assert.doesNotMatch(readme, /自定义 HTTP\/HTTPS/);
  assert.doesNotMatch(readme, /非图片文件不会上传/);
  assert.doesNotMatch(readme, /宽松安全配置/);
});
