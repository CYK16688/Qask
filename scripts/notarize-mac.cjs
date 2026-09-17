'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
const profile = process.env.APPLE_KEYCHAIN_PROFILE || 'QaskNotary';
const artifactName = `Qask-${packageJson.version}-arm64.dmg`;
const artifactPath = path.join(projectRoot, 'dist', artifactName);

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    stdio: 'inherit',
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status}`);
  }
}

function writeChecksum(filePath) {
  const digest = crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  fs.writeFileSync(`${filePath}.sha256`, `${digest}  ${path.basename(filePath)}\n`);
  console.log(`SHA-256: ${digest}`);
}

if (!fs.existsSync(artifactPath)) {
  console.error(`Missing ${artifactPath}. Run "npm run package:mac" first.`);
  process.exit(1);
}

console.log(`Submitting ${artifactName} with Keychain profile "${profile}".`);

try {
  run('xcrun', ['notarytool', 'submit', artifactPath, '--keychain-profile', profile, '--wait']);
  run('xcrun', ['stapler', 'staple', artifactPath]);
  run('xcrun', ['stapler', 'validate', artifactPath]);
  run('hdiutil', ['verify', artifactPath]);
  writeChecksum(artifactPath);
  console.log(`Notarized artifact ready: ${artifactPath}`);
} catch (error) {
  console.error(`\nmacOS notarization failed: ${error.message}`);
  console.error('If the profile is missing or credentials were rejected, recreate it without putting the password in shell history:');
  console.error(`  xcrun notarytool store-credentials ${profile} --apple-id "YOUR_APPLE_ID" --team-id DCLBAFF9Y6`);
  console.error('At the hidden prompt, enter the newly generated app-specific password, not the normal Apple ID password.');
  process.exit(1);
}
