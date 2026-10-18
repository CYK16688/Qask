const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

const renderer = read('src/renderer.js');
const indexHtml = read('src/index.html');
const styles = read('src/styles.css');
const userGuide = read('docs/user-guide.md');
const architecture = read('docs/architecture.md');
const privacy = read('PRIVACY.md');

function loadShortcutMatchers() {
  const start = renderer.indexOf('function isSendShortcut');
  const end = renderer.indexOf('document.addEventListener("keydown"', start);
  assert.notEqual(start, -1, 'shortcut matchers are missing');
  assert.notEqual(end, -1, 'shortcut matcher boundary is missing');
  const source = renderer.slice(start, end);
  return new Function('appSettings', `${source}\nreturn { isSendShortcut, matchesLayoutShortcut, matchesComparisonShortcut };`);
}

test('the sidebar and collapsed rail expose a settings entry point', () => {
  assert.match(indexHtml, /id="settingsButton"[^>]*class="settings-button"/);
  assert.match(indexHtml, /id="collapsedSettingsButton"/);
  assert.match(indexHtml, /id="settingsDialog"[^>]*role="dialog"/);
  assert.match(indexHtml, /id="settingsSendShortcut"/);
  assert.match(indexHtml, /id="settingsLayoutShortcut"/);
  assert.match(indexHtml, /id="settingsComparisonShortcut"/);
  assert.match(indexHtml, /id="settingsTheme"/);
  assert.match(indexHtml, /id="settingsAutoZoom"/);
  assert.match(indexHtml, /id="settingsAlwaysOnTop"/);
  assert.match(indexHtml, /id="settingsLaunchAtLogin"/);
  assert.match(indexHtml, /id="settingsSendMode"/);
  assert.match(indexHtml, /id="settingsComparisonModel"/);
  assert.match(indexHtml, /id="settingsConfirmSummary"[^>]*type="checkbox"/);
  assert.match(indexHtml, /id="settingsShowStatus"[^>]*type="checkbox"/);
  assert.match(indexHtml, /id="settingsVersion"/);
  assert.match(indexHtml, /id="settingsOpenRepo"/);
  assert.match(indexHtml, /id="settingsOpenData"/);
  assert.match(indexHtml, /github\.com\/CYK16688\/Qask/);
  assert.match(styles, /\.settings-panel\s*\{/);
  assert.match(styles, /\.settings-button\s*\{/);
});

test('settings persist with the status transcript hidden by default', () => {
  assert.match(renderer, /settings: "qask\.settings"/);
  assert.match(renderer, /showStatusBar: false/);
  assert.match(renderer, /confirmSummary: true/);
  assert.match(renderer, /autoPanelZoom: true/);
  assert.match(renderer, /alwaysOnTop: false/);
  assert.match(renderer, /launchAtLogin: false/);
  assert.match(renderer, /confirmSummary: value\.confirmSummary !== false/);
  assert.match(renderer, /showStatusBar: value\.showStatusBar === true/);
  assert.match(renderer, /function persistSettings\(\)/);
  assert.match(renderer, /saveToStorage\(STORAGE_KEYS\.settings, appSettings\)/);
  assert.match(renderer, /let sendModeValue = appSettings\.sendMode/);
  assert.match(renderer, /setSendMode\(option\.dataset\.sendMode, \{ persist: true \}\)/);
  assert.match(indexHtml, /id="broadcastStatus"[^>]*hidden/);
  assert.match(renderer, /broadcastStatus\.hidden = !\(appSettings\.showStatusBar \|\| transient\)/);
});

test('shortcut matchers follow the selected send, layout, and comparison bindings', () => {
  let appSettings = {
    shortcuts: { send: 'enter', layout: 'alt-arrows', comparison: 'mod-shift-c' },
  };
  let matchers = loadShortcutMatchers()(appSettings);
  assert.equal(matchers.isSendShortcut({ key: 'Enter', shiftKey: false }), true);
  assert.equal(matchers.isSendShortcut({ key: 'Enter', metaKey: true }), false);
  assert.equal(matchers.isSendShortcut({ key: 'Enter', shiftKey: true }), false);
  assert.equal(matchers.matchesLayoutShortcut({ key: 'ArrowLeft', altKey: true }), true);
  assert.equal(matchers.matchesLayoutShortcut({ key: 'ArrowLeft', altKey: true, ctrlKey: true }), false);
  assert.equal(matchers.matchesComparisonShortcut({ key: 'c', metaKey: true, shiftKey: true }), true);
  assert.equal(matchers.matchesComparisonShortcut({ key: 'c', altKey: true }), false);

  appSettings = {
    shortcuts: { send: 'mod-enter', layout: 'mod-alt-arrows', comparison: 'alt-c' },
  };
  matchers = loadShortcutMatchers()(appSettings);
  assert.equal(matchers.isSendShortcut({ key: 'Enter', metaKey: true }), true);
  assert.equal(matchers.isSendShortcut({ key: 'Enter', ctrlKey: true }), true);
  assert.equal(matchers.isSendShortcut({ key: 'Enter' }), false);
  assert.equal(matchers.matchesLayoutShortcut({ key: 'ArrowRight', altKey: true, metaKey: true }), true);
  assert.equal(matchers.matchesLayoutShortcut({ key: 'ArrowRight', altKey: true }), false);
  assert.equal(matchers.matchesComparisonShortcut({ key: 'c', altKey: true }), true);
  assert.equal(matchers.matchesComparisonShortcut({ key: 'c', metaKey: true, shiftKey: true }), false);

  appSettings = {
    shortcuts: { send: 'ctrl-enter', layout: 'disabled', comparison: 'disabled' },
  };
  matchers = loadShortcutMatchers()(appSettings);
  assert.equal(matchers.isSendShortcut({ key: 'Enter', ctrlKey: true }), true);
  assert.equal(matchers.isSendShortcut({ key: 'Enter', metaKey: true }), false);
  assert.equal(matchers.matchesLayoutShortcut({ key: 'ArrowLeft', altKey: true }), false);
  assert.equal(matchers.matchesComparisonShortcut({ key: 'c', metaKey: true, shiftKey: true }), false);
});

test('the default comparison model is used when the dialog opens', () => {
  assert.match(renderer, /comparisonModelId: typeof value\.comparisonModelId === "string"/);
  assert.match(renderer, /else if \(appSettings\.comparisonModelId !== "auto"\)/);
  assert.match(renderer, /appSettings\.confirmSummary/);
  assert.match(renderer, /settingsTheme/);
  assert.match(renderer, /candidates\.find\(\(panelState\) => panelState\.modelId === appSettings\.comparisonModelId\)/);
  assert.match(renderer, /function populateSettingsComparisonModels\(\)/);
  assert.match(renderer, /options\.push\(\{ value: "auto"/);
});

test('settings and status defaults are documented', () => {
  assert.match(userGuide, /## 设置/);
  assert.match(userGuide, /底部状态栏.*默认隐藏/);
  assert.match(userGuide, /对比默认模型/);
  assert.match(userGuide, /登录状态/);
  assert.match(userGuide, /github\.com\/CYK16688\/Qask/);
  assert.match(userGuide, /⌘\/Ctrl \+ ,` 打开设置/);
  assert.match(architecture, /`qask\.settings`/);
  assert.match(architecture, /状态栏默认隐藏/);
  assert.match(privacy, /local settings/);
});
