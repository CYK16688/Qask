const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'src', 'renderer.js'), 'utf8');

const readConstant = (source, pattern, label) => {
  const match = source.match(pattern);
  assert.ok(match, `${label} constant is missing from the source`);
  return Number(match[1].replace(/_/g, ''));
};
const MICROPHONE_LEASE_DURATION_MS = readConstant(main, /MICROPHONE_LEASE_DURATION_MS = ([\d_]+)/, 'microphone lease duration');
const MAX_RECORDING_MS = readConstant(renderer, /maxRecordingDurationMs: ([\d_]+)/, 'maximum recording duration');

const createLeaseHarness = () => {
  const source = main.slice(
    main.indexOf('const MICROPHONE_LEASE_DURATION_MS ='),
    main.indexOf('function isTrustedShellWebContents'),
  );
  let nextLease = 0;
  const factory = new Function(
    'randomUUID', 'app', 'Date',
    `${source}\nreturn { grantMicrophoneLease, renewMicrophoneLease, revokeMicrophoneLease, hasActiveMicrophoneLease, MICROPHONE_LEASE_DURATION_MS };`,
  );
  return (DateImpl = Date) => factory(() => `lease-${++nextLease}`, { requestSingleInstanceLock: () => true, quit() {} }, DateImpl);
};

test('a recording can outlive a single microphone lease window', () => {
  // A lease that expires mid-recording turns the next audio stream request into
  // a bogus permission denial, so the shell must be able to extend the lease it
  // already holds for the whole length of a recording.
  assert.ok(
    MICROPHONE_LEASE_DURATION_MS < MAX_RECORDING_MS,
    'this regression only matters while the lease window is shorter than a recording',
  );
  assert.match(renderer, /maxRecordingDurationMs: 120_000/);
  assert.match(main, /function renewMicrophoneLease\(leaseId\)/);
  assert.match(main, /ipcMain\.handle\("microphone:renew-access"/);
  assert.match(preload, /renewAccess: \(leaseId\) => ipcRenderer\.invoke\("microphone:renew-access", leaseId\)/);
  assert.match(renderer, /window\.qask\?\.microphone\?\.renewAccess\?\.\(session\.leaseId\)/);
});

test('a live recording renews its lease and stops renewing once it finalizes', () => {
  assert.match(renderer, /startMicrophoneLeaseRenewal\(session\);/);
  assert.match(renderer, /clearMicrophoneLeaseRenewal\(session\);/);
  // Renewal is cleaned up by the shared timer teardown, so every stop, cancel,
  // limit and unload path releases it without a separate call site to forget.
  assert.match(renderer, /function clearRecordingTimers\(session\) \{[\s\S]*?clearMicrophoneLeaseRenewal\(session\);/);
  assert.ok(
    MICROPHONE_LEASE_DURATION_MS > 10_000,
    'the renewal interval must be shorter than the lease window it refreshes',
  );
  assert.match(renderer, /MICROPHONE_LEASE_RENEW_INTERVAL_MS = 10_000/);
});

test('renewal only extends the lease that is still held', () => {
  const start = 1_000_000;
  let now = start;
  const FakeDate = { now: () => now };
  const { grantMicrophoneLease, renewMicrophoneLease, revokeMicrophoneLease, hasActiveMicrophoneLease } = createLeaseHarness()(FakeDate);

  const staleLease = grantMicrophoneLease();
  const activeLease = grantMicrophoneLease();

  assert.equal(renewMicrophoneLease(staleLease), false, 'a superseded lease must not be extendable');
  assert.equal(renewMicrophoneLease('not-a-lease'), false);

  // Renew inside the window, then advance past the original expiry: the lease
  // must still be live, which is exactly what a two-minute recording needs.
  now = start + 20_000;
  assert.equal(renewMicrophoneLease(activeLease), true);
  now = start + 40_000;
  assert.equal(hasActiveMicrophoneLease(), true);
  assert.equal(renewMicrophoneLease(activeLease), true);

  // An expired lease cannot be resurrected by a late renewal.
  now = start + 75_000;
  assert.equal(hasActiveMicrophoneLease(), false);
  assert.equal(renewMicrophoneLease(activeLease), false);
  assert.equal(revokeMicrophoneLease(activeLease), false);
});
