const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('the project can produce Windows setup and portable executables', () => {
  const packageJson = JSON.parse(read('package.json'));

  assert.equal(packageJson.scripts['package:win'], 'electron-builder --win --x64 --publish never');
  assert.match(packageJson.description, /macOS and Windows/);
  assert.equal(packageJson.build.win.icon, 'assets/qask.ico');
  assert.deepEqual(packageJson.build.win.target, [
    { target: 'nsis', arch: ['x64'] },
    { target: 'portable', arch: ['x64'] },
  ]);
  assert.equal(packageJson.build.win.artifactName, 'Qask-${version}-win-${arch}.${ext}');
  assert.equal(packageJson.build.nsis.oneClick, false);
  assert.equal(packageJson.build.nsis.perMachine, false);
  assert.equal(packageJson.build.nsis.allowToChangeInstallationDirectory, true);
  assert.equal(packageJson.build.nsis.artifactName, 'Qask-${version}-win-setup-${arch}.${ext}');
  assert.equal(packageJson.build.portable.artifactName, 'Qask-${version}-win-portable-${arch}.${ext}');
  assert.ok(packageJson.build.files.includes('src/**/*'));
  assert.ok(fs.statSync(path.join(root, 'assets', 'qask.ico')).isFile());
  assert.ok(fs.statSync(path.join(root, 'assets', 'qask-logo.png')).isFile());
});

test('the trusted shell URL is portable to Windows paths', () => {
  const main = read('main.js');
  assert.match(main, /const \{ pathToFileURL \} = require\("node:url"\)/);
  assert.match(main, /const QASK_SHELL_URL = pathToFileURL\(path\.join\(__dirname, "src", "index\.html"\)\)\.toString\(\)/);
  assert.doesNotMatch(main, /new URL\(`file:\/\/\$\{path\.join/);
});

test('Windows packaging and its current limits are documented', () => {
  const readme = read('README.md');
  const guide = read('docs/user-guide.md');
  assert.match(readme, /Download the Windows preview/);
  assert.match(readme, /Qask-1\.0\.3-win-portable-x64\.exe/);
  assert.match(readme, /Qask-1\.0\.3-win-setup-x64\.exe/);
  assert.match(readme, /unsigned/i);
  assert.match(readme, /not yet been validated on Windows hardware/i);
  assert.match(guide, /## Windows 版本/);
  assert.match(guide, /win-portable-x64\.exe/);
  assert.match(guide, /SmartScreen/);
});
