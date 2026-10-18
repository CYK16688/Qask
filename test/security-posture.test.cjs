const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

const main = read('main.js');
const preload = read('preload.js');
const indexHtml = read('src/index.html');

test('the shell keeps a self-only CSP with no inline or eval script execution', () => {
  const cspMatch = indexHtml.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/);
  assert.ok(cspMatch, 'the shell must declare a Content-Security-Policy meta tag');

  const csp = cspMatch[1];
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /connect-src 'self'/);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /base-uri 'none'/);
  assert.match(csp, /form-action 'self'/);

  // A page that can run eval or fetch anywhere reopens the exfiltration path the
  // local-data boundary exists to close.
  assert.doesNotMatch(csp, /unsafe-eval/);
  assert.doesNotMatch(csp, /script-src[^;]*\*/);
  assert.doesNotMatch(csp, /connect-src[^;]*\*/);
  assert.doesNotMatch(csp, /default-src[^;]*\*/);
});

test('the shell window runs isolated and sandboxed without Node integration', () => {
  // Slice the createMainWindow body itself. An end marker that appears earlier
  // in the file (for example the first `mainWindow.webContents` reference in
  // isTrustedShellWebContents) would silently produce an empty slice, so pin the
  // boundary to the next function and fail loudly if the source moves.
  const windowStart = main.indexOf('function createMainWindow');
  const windowEnd = main.indexOf('function isTrustedShellSender');
  assert.ok(windowStart >= 0, 'createMainWindow is missing');
  assert.ok(windowEnd > windowStart, 'createMainWindow slice boundaries are inverted');
  const windowPrefs = main.slice(windowStart, windowEnd);

  assert.match(windowPrefs, /nodeIntegration: false/);
  assert.match(windowPrefs, /contextIsolation: true/);
  assert.match(windowPrefs, /sandbox: true/);
  assert.match(windowPrefs, /webSecurity: true/);
  assert.match(windowPrefs, /allowRunningInsecureContent: false/);
  assert.doesNotMatch(windowPrefs, /nodeIntegration: true/);
  assert.doesNotMatch(windowPrefs, /contextIsolation: false/);
  assert.doesNotMatch(windowPrefs, /sandbox: false/);
});

test('every guest webview is stripped of its preload and hardened before it attaches', () => {
  const attachHandler = main.slice(
    main.indexOf('will-attach-webview'),
    main.indexOf('function createMainWindow'),
  );

  // An unconfigured partition must never attach at all.
  assert.match(attachHandler, /if \(!providerSession\) \{[\s\S]*?event\.preventDefault\(\)/);
  assert.match(attachHandler, /delete webPreferences\.preload;/);
  assert.match(attachHandler, /delete webPreferences\.preloadURL;/);
  assert.match(attachHandler, /webPreferences\.nodeIntegration = false;/);
  assert.match(attachHandler, /webPreferences\.contextIsolation = true;/);
  assert.match(attachHandler, /webPreferences\.sandbox = true;/);
  assert.match(attachHandler, /webPreferences\.webSecurity = true;/);
  assert.match(attachHandler, /webPreferences\.allowRunningInsecureContent = false;/);
});

test('the preload bridge exposes only the named screenshot, microphone and attachment surfaces', () => {
  const exposed = preload.slice(
    preload.indexOf('contextBridge.exposeInMainWorld'),
    preload.indexOf('diagnostics:'),
  );

  assert.match(preload, /contextBridge\.exposeInMainWorld\("qask", \{/);
  for (const surface of ['screenshot', 'microphone', 'attachments']) {
    assert.match(exposed, new RegExp(`\\b${surface}:`));
  }
  // No generic escape hatch: the shell must not be able to send arbitrary IPC.
  assert.doesNotMatch(exposed, /ipcRenderer\.send\(channel/);
  assert.doesNotMatch(exposed, /ipcRenderer\.on\(channel/);
  assert.doesNotMatch(exposed, /exposeInMainWorld\("(require|electron|process)"/);
  assert.doesNotMatch(preload, /nodeIntegration/);
});

test('microphone permission is granted only for audio while a lease is held', () => {
  const permissionHandlers = main.slice(
    main.indexOf('function isAudioOnlyShellCheck'),
    main.indexOf('function enforceProviderNavigation'),
  );

  assert.match(permissionHandlers, /permission === "media"/);
  assert.match(permissionHandlers, /details\.mediaType === "audio"/);
  assert.match(permissionHandlers, /details\.mediaTypes\?\.length === 1/);
  assert.match(permissionHandlers, /details\.mediaTypes\[0\] === "audio"/);
  assert.match(permissionHandlers, /&& hasActiveMicrophoneLease\(\)/);
  // Video and screen capture must never be covered by the audio lease.
  assert.doesNotMatch(permissionHandlers, /"video"|"audio", "video"|display-capture/);
});

test('new windows and untrusted navigations never open inside the shell', () => {
  assert.match(main, /contents\.setWindowOpenHandler\(\(\) => \(\{ action: "deny" \}\)\)/);
  assert.match(main, /contents\.on\("will-navigate"/);
  assert.match(main, /contents\.on\("will-redirect"/);
  assert.match(main, /if \(!policy\) return;[\s\S]*?if \(!isAllowedProviderUrl\(policy, url\)\) \{[\s\S]*?event\.preventDefault\(\)/);
});
