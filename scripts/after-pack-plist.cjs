#!/usr/bin/env node
/**
 * electron-builder writes a generic privacy-purpose block into the packaged
 * Info.plist: a camera description, two Bluetooth descriptions, an audio
 * capture description, and a templated microphone description.
 *
 * Qask only touches the microphone, so this hook replaces the templated
 * microphone text (through `build.mac.extendInfo`) and removes the unused
 * descriptions after packing and before code signing. Shipping a camera or
 * Bluetooth purpose string the app never triggers is misleading, and the
 * release checklist requires a permission-copy review before a build is
 * described as production-supported.
 *
 * The macOS packaging smoke run verifies the result; `plutil` is macOS-only,
 * so the hook exits silently on other platforms.
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const UNUSED_PRIVACY_KEYS = [
  'NSCameraUsageDescription',
  'NSBluetoothAlwaysUsageDescription',
  'NSBluetoothPeripheralUsageDescription',
  'NSAudioCaptureUsageDescription',
];

const REQUIRED_PRIVACY_KEYS = ['NSMicrophoneUsageDescription'];

function readPlist(plistPath) {
  const json = execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plistPath], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  return JSON.parse(json);
}

function removeKey(plistPath, key) {
  execFileSync('/usr/bin/plutil', ['-remove', key, plistPath]);
}

async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const productFilename = context.packager.appInfo.productFilename;
  const plistPath = path.join(context.appOutDir, `${productFilename}.app`, 'Contents', 'Info.plist');
  if (!fs.existsSync(plistPath)) {
    throw new Error(`packaged Info.plist not found at ${plistPath}`);
  }

  const before = readPlist(plistPath);
  for (const key of REQUIRED_PRIVACY_KEYS) {
    const value = before[key];
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error(`packaged Info.plist has no ${key}; a microphone prompt would show no purpose string`);
    }
  }

  for (const key of UNUSED_PRIVACY_KEYS) {
    if (Object.hasOwn(before, key)) removeKey(plistPath, key);
  }

  const after = readPlist(plistPath);
  const leftovers = UNUSED_PRIVACY_KEYS.filter((key) => Object.hasOwn(after, key));
  if (leftovers.length > 0) {
    throw new Error(`unused privacy descriptions remain in the packaged Info.plist: ${leftovers.join(', ')}`);
  }
}

module.exports = afterPack;
module.exports.default = afterPack;
module.exports.UNUSED_PRIVACY_KEYS = UNUSED_PRIVACY_KEYS;
module.exports.REQUIRED_PRIVACY_KEYS = REQUIRED_PRIVACY_KEYS;
