const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('the logo appears in the app shell and Settings About', () => {
  const html = read('src/index.html');
  const svg = read('assets/qask-logo.svg');
  const packageJson = JSON.parse(read('package.json'));

  assert.match(html, /class="brand-lockup"[\s\S]*?assets\/qask-logo\.svg/);
  assert.match(html, /id="settingsDialog"[\s\S]*?assets\/qask-logo\.svg/);
  assert.match(html, /id="settingsVersion"/);
  assert.match(html, /github\.com\/CYK16688\/Qask/);
  assert.match(html, /id="settingsOpenData"/);
  assert.ok(fs.statSync(path.join(root, 'assets', 'qask-logo.svg')).isFile());
  assert.ok(fs.statSync(path.join(root, 'assets', 'qask.icns')).isFile());
  assert.ok(fs.statSync(path.join(root, 'assets', 'qask.ico')).isFile());
  assert.ok(packageJson.build.files.includes('assets/qask.icns'));
  assert.ok(packageJson.build.files.includes('assets/qask-logo.svg'));
  assert.ok(packageJson.build.files.includes('assets/qask.ico'));
  assert.ok(packageJson.build.files.includes('assets/qask-logo.png'));
  assert.match(svg, /<circle cx="492" cy="470"/);
  assert.equal((svg.match(/<rect x="(?:373|515)"/g) || []).length, 4);
});

test('Window and macOS dock icons use the packaged logo files', () => {
  const main = read('main.js');
  assert.match(main, /process\.platform === "win32" \? \{ icon: path\.join\(__dirname, "assets", "qask\.ico"\) \}/);
  assert.match(main, /app\.setName\("Qask"\)/);
  assert.match(main, /app\.setPath\("userData", initialUserDataPath\)/);
  assert.match(main, /app\.setAppUserModelId\("com\.icreator\.qask"\)/);
  assert.match(main, /app\.dock\.setIcon\(path\.join\(__dirname, "assets", "qask-logo\.png"\)\)/);
  assert.match(main, /ipcMain\.handle\("app:info"/);
  assert.match(main, /ipcMain\.handle\("app:open-external"/);
  assert.match(main, /ipcMain\.handle\("app:open-user-data"/);
  assert.match(main, /ipcMain\.handle\("window:set-always-on-top"/);
  assert.match(main, /ipcMain\.handle\("app:set-launch-at-login"/);
  assert.match(main, /ipcMain\.handle\("attachments:upload-to-guest"/);
  assert.match(main, /guest\.hostWebContents !== mainWindow\.webContents/);
  assert.match(main, /DOM\.setFileInputFiles/);
  assert.match(main, /EXTERNAL_LINK_ALLOWLIST/);
  const preload = read('preload.js');
  assert.match(preload, /app: \{\s*info:/);
  assert.match(preload, /openExternal: \(url\) => ipcRenderer\.invoke\("app:open-external", url\)/);
  assert.match(preload, /openUserData: \(\) => ipcRenderer\.invoke\("app:open-user-data"\)/);
  assert.match(preload, /uploadToGuest: \(payload\) => ipcRenderer\.invoke\("attachments:upload-to-guest", payload\)/);
  assert.match(preload, /setLaunchAtLogin: \(enabled\) => ipcRenderer\.invoke\("app:set-launch-at-login", enabled\)/);
  assert.match(preload, /window: \{\s*setAlwaysOnTop:/);
});

test('login persistence and the expanded settings are documented', () => {
  const guide = read('docs/user-guide.md');
  const privacy = read('PRIVACY.md');
  const architecture = read('docs/architecture.md');
  assert.match(guide, /登录状态由各网站保存在本机持久化分区/);
  assert.match(guide, /正常重启不需要重新登录/);
  assert.match(guide, /发送 AI 总结前再次确认/);
  assert.match(guide, /关于/);
  assert.match(privacy, /Provider login cookies/);
  assert.match(architecture, /`qask\.settings`/);
  assert.match(architecture, /app:open-external/);
});

test('provider sessions use persistent partitions and startup never clears them', () => {
  const renderer = read('src/renderer.js');
  const main = read('main.js');
  const guide = read('docs/user-guide.md');

  assert.match(renderer, /partition: "persist:chatgpt"/);
  assert.match(renderer, /partition: "persist:kimi"/);
  assert.match(main, /session\.fromPartition\(partition\)/);
  assert.doesNotMatch(main, /clearStorageData|clearCache\(/);
  assert.match(guide, /Qask 启动时不会清除/);
  assert.match(guide, /正常重启不需要重新登录/);
});
