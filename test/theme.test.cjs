const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

const renderer = read('src/renderer.js');
const main = read('main.js');
const preload = read('preload.js');
const indexHtml = read('src/index.html');
const styles = read('src/styles.css');
const readme = read('README.md');
const userGuide = read('docs/user-guide.md');
const architecture = read('docs/architecture.md');

test('the sidebar exposes system, dark, and light appearance modes', () => {
  assert.match(indexHtml, /id="themeSwitcher"[^>]*role="group"[^>]*aria-label="外观主题"/);
  assert.match(indexHtml, /data-theme-mode="system"[^>]*aria-pressed="true"/);
  assert.match(indexHtml, /data-theme-mode="dark"/);
  assert.match(indexHtml, /data-theme-mode="light"/);
  assert.match(renderer, /const themeOptions = Array\.from\(document\.querySelectorAll\("\.theme-option"\)\)/);
  assert.match(renderer, /themeMode = THEME_MODES\.has\(button\.dataset\.themeMode\)/);
  assert.match(renderer, /applyTheme\(\{ persist: true \}\)/);
});

test('the shell follows the system appearance by default and persists the choice', () => {
  assert.match(renderer, /theme: "qask\.theme"/);
  assert.match(renderer, /const THEME_MODES = new Set\(\["system", "dark", "light"\]\)/);
  assert.match(renderer, /window\.matchMedia\("\(prefers-color-scheme: dark\)"\)/);
  assert.match(renderer, /function getEffectiveTheme\(\)/);
  assert.match(renderer, /document\.documentElement\.dataset\.theme = effectiveTheme/);
  assert.match(renderer, /document\.documentElement\.style\.colorScheme = effectiveTheme/);
  assert.match(renderer, /saveToStorage\(STORAGE_KEYS\.theme, themeMode\)/);
  assert.match(renderer, /systemThemeQuery\.addEventListener\("change"/);
  assert.match(renderer, /window\.qask\?\.theme\?\.set/);
});

test('the theme choice is delegated to Electron nativeTheme so providers see the same preference', () => {
  assert.match(main, /nativeTheme/);
  assert.match(main, /nativeTheme\.themeSource = mode === "dark" \|\| mode === "light" \? mode : "system"/);
  assert.match(main, /ipcMain\.handle\("theme:set"/);
  assert.match(preload, /theme: \{\s*set: \(mode\) => ipcRenderer\.invoke\("theme:set", mode\),\s*\}/);
});

test('the stylesheet ships a real light palette instead of only inverting the dark one', () => {
  assert.match(styles, /html\[data-theme="light"\]\s*\{[\s\S]*--text:\s*#0f172a/);
  assert.match(styles, /html\[data-theme="light"\] body\s*\{[\s\S]*linear-gradient/);
  assert.match(styles, /html\[data-theme="light"\] \.control-panel\s*\{/);
  assert.match(styles, /html\[data-theme="light"\] \.composer\s*\{/);
  assert.match(styles, /html\[data-theme="light"\] \.model-add-panel\s*\{/);
  assert.match(styles, /html\[data-theme="light"\] \.comparison-panel\s*\{/);
  assert.match(styles, /\.theme-switcher\s*\{/);
  assert.match(styles, /\.theme-option\[aria-pressed="true"\]\s*\{/);
});

test('theme behavior and limitations are documented', () => {
  assert.match(readme, /follow the macOS appearance or pin the Qask shell to dark\/light/i);
  assert.match(userGuide, /## 外观主题/);
  assert.match(userGuide, /跟随 macOS 的浅色\/深色外观/);
  assert.match(userGuide, /不支持深色模式的网站仍使用它自己的配色/);
  assert.match(architecture, /`qask\.theme`/);
  assert.match(architecture, /nativeTheme\.themeSource/);
});


test('the saved appearance is applied before the stylesheet paints', () => {
  const themeInit = read('src/theme-init.js');
  const headStart = indexHtml.indexOf('<head>');
  const headEnd = indexHtml.indexOf('</head>');
  const head = indexHtml.slice(headStart, headEnd);

  assert.ok(head.indexOf('theme-init.js') >= 0, 'theme init script is missing from head');
  assert.ok(head.indexOf('theme-init.js') < head.indexOf('styles.css'), 'theme init must run before the stylesheet');
  assert.match(themeInit, /localStorage\.getItem\("qask\.theme"\)/);
  assert.match(themeInit, /prefers-color-scheme: dark/);
  assert.match(themeInit, /document\.documentElement\.dataset\.theme/);
  assert.match(themeInit, /document\.documentElement\.style\.colorScheme/);
});

test('iconography and list rows share one polished control language', () => {
  assert.match(indexHtml, /id="screenshotBtn"[\s\S]*?<svg/);
  assert.doesNotMatch(indexHtml, /📸/);
  assert.match(renderer, /dragHandle\.innerHTML = `<svg/);
  assert.doesNotMatch(renderer, /dragHandle\.textContent = "⠿"/);
  assert.match(renderer, /className = "panel-site-chip"/);
  assert.match(styles, /\.panel-site-chip\s*\{/);
  assert.match(styles, /\.model-list li\s*\{[\s\S]*?border: 0/);
  assert.match(styles, /\.model-remove\s*\{[\s\S]*?background: transparent/);
  assert.match(styles, /::-webkit-scrollbar-thumb/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(styles, /\[data-level="success"\][\s\S]*?var\(--success\)/);
  // The collapsed rail is only 56px wide; the clock must fit.
  assert.match(styles, /\.time-text\s*\{[\s\S]*?font-size: 14px/);
});

test('collapsed rail and panel gutters do not clip controls or waste space', () => {
  assert.match(styles, /\.panels-container\s*\{[\s\S]*?gap: 6px/);
  assert.match(styles, /\.workspace\s*\{[\s\S]*?padding: 6px 8px/);
  assert.match(styles, /control-panel\[data-collapsed="true"\] \.control-body\s*\{[\s\S]*?overflow: hidden/);
  assert.match(styles, /control-body:has\([^)]*collapsed-layout-btn:hover[^)]*\)\s*\{\s*overflow: visible/);
  assert.match(styles, /control-panel\[data-collapsed="true"\] \.collapsed-action-btn\s*\{[\s\S]*?margin-top: 8px/);
  assert.match(styles, /collapsed-layout-btn::after[\s\S]*?z-index: 1000/);
  // A light-theme shorthand previously out-specified the collapsed padding and
  // squeezed the 40px rail buttons into a 35px column.
  assert.doesNotMatch(styles, /html\[data-theme="light"\] \.control-panel\s*\{[^}]*padding:/);
  assert.match(styles, /control-panel\[data-collapsed="true"\]\s*\{[\s\S]*?padding: 12px 4px 8px/);
});

test('selected layout buttons stay filled in both themes', () => {
  assert.match(styles, /\.layout-button\.is-active,[\s\S]*?background: linear-gradient\(135deg, var\(--accent\), #6366f1\)/);
  assert.match(styles, /html\[data-theme="light"\] \.layout-button\.is-active,[\s\S]*?background: linear-gradient\(135deg, var\(--accent\), #6366f1\)/);
  assert.match(styles, /collapsed-layout-btn\[aria-pressed="true"\] \.layout-glyph--dual[\s\S]*?#ffffff/);
});
