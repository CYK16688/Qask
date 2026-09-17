#!/usr/bin/env node

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const expectedRepository = 'git+https://github.com/cyk16688/Qask.git';

assert.equal(packageJson.private, true, 'source package must remain private to npm');
assert.equal(packageJson.repository?.url, expectedRepository, 'repository URL is not canonical');
assert.equal(packageJson.homepage, 'https://github.com/cyk16688/Qask#readme', 'homepage is not canonical');
assert.equal(packageJson.bugs?.url, 'https://github.com/cyk16688/Qask/issues', 'issues URL is not canonical');

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
let packOutput;
try {
  packOutput = execFileSync(npmCommand, ['pack', '--dry-run', '--json'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
} catch (error) {
  process.stderr.write(error.stderr || error.message);
  process.exit(1);
}

let packReport;
try {
  packReport = JSON.parse(packOutput)[0];
} catch (error) {
  throw new Error(`Unable to parse npm pack output: ${error.message}`);
}

const packedFiles = Array.isArray(packReport?.files) ? packReport.files.map(({ path: filePath }) => filePath) : [];
assert.ok(packedFiles.length > 0, 'npm pack produced no files');

const requiredFiles = [
  'README.md',
  'LICENSE',
  'NOTICE',
  'PRIVACY.md',
  'SECURITY.md',
  'CONTRIBUTING.md',
  'COMMERCIAL-LICENSE.md',
  'main.js',
  'preload.js',
  'src/index.html',
  'src/renderer.js',
  'src/styles.css',
];
for (const filePath of requiredFiles) {
  assert.ok(packedFiles.includes(filePath), `required source file is missing from npm pack: ${filePath}`);
}

const forbiddenPath = /(^|\/)(?:node_modules|test|artifacts|build|dist|out|release|coverage|\.worktrees|\.git)(?:\/|$)/i;
const forbiddenName = /(^|\/)(?:\.env(?:\..*)?|credentials\.json|.*\.(?:pem|key|p12|pfx))$/i;
const unexpectedFiles = packedFiles.filter((filePath) => forbiddenPath.test(filePath) || forbiddenName.test(filePath));
assert.deepEqual(unexpectedFiles, [], `forbidden files are included in npm pack: ${unexpectedFiles.join(', ')}`);

const binaryExtensions = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.icns', '.dylib', '.so', '.dll', '.node']);
const highConfidenceSecret = /-----BEGIN [A-Z ]+ PRIVATE KEY-----|(?:ghp_|github_pat_|xox[baprs]-|AKIA[0-9A-Z]{16})/;
const leakedFiles = [];
for (const filePath of packedFiles) {
  const absolutePath = path.join(root, filePath);
  if (binaryExtensions.has(path.extname(filePath).toLowerCase())) continue;
  const contents = fs.readFileSync(absolutePath, 'utf8');
  if (highConfidenceSecret.test(contents)) leakedFiles.push(filePath);
}
assert.deepEqual(leakedFiles, [], `high-confidence credential pattern found in npm pack: ${leakedFiles.join(', ')}`);

console.log(`Public source check passed: ${packedFiles.length} packed files, no forbidden paths or high-confidence credentials.`);
