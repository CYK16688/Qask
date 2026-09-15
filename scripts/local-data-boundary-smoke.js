const { app } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { inspectAttachmentPath } = require('../local-data-boundary.cjs');

app.whenReady().then(() => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'qask-boundary-check-'));
  try {
    const safe = path.join(base, 'safe.pdf');
    fs.writeFileSync(safe, 'safe', { mode: 0o600 });
    const gitDirectory = path.join(base, '.git');
    fs.mkdirSync(gitDirectory, { mode: 0o700 });
    const gitConfig = path.join(gitDirectory, 'config');
    fs.writeFileSync(gitConfig, '[remote]', { mode: 0o600 });
    const inspect = (filePath) => inspectAttachmentPath(filePath, {
      homeDir: app.getPath('home'),
      userDataDir: app.getPath('userData'),
      resolvePath: (value) => fs.realpathSync(value),
      isRegularFile: (value) => fs.statSync(value).isFile(),
    });
    const result = { safe: inspect(safe), git: inspect(gitConfig) };
    if (result.safe.allowed !== true || result.git.allowed !== false || result.git.reason !== 'hidden-or-git-path') {
      throw new Error('Local-data boundary smoke assertion failed');
    }
    console.log(JSON.stringify(result));
  } finally {
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 3 });
  }
  app.quit();
}).catch((error) => {
  console.error('Local-data boundary smoke failed');
  app.exit(1);
});
