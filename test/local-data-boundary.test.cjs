const assert = require('node:assert/strict');
const test = require('node:test');

const {
  inspectAttachmentPath,
  isRestrictedCustomProviderUrl,
  sanitizeAttachmentFileName,
  ATTACHMENT_EXTENSION_BY_KIND,
} = require('../local-data-boundary.cjs');

const createInspectionOptions = () => ({
  homeDir: '/Users/alice',
  userDataDir: '/Users/alice/Library/Application Support/Qask',
  resolvePath: (value) => value,
  isRegularFile: () => true,
});

test('selected Git, GitHub, SSH, hidden, and Qask-session paths are denied before a provider receives a payload', () => {
  const options = createInspectionOptions();

  for (const filePath of [
    '/Users/alice/project/.git/config',
    '/Users/alice/.gitconfig',
    '/Users/alice/.config/gh/hosts.yml',
    '/Users/alice/.ssh/id_ed25519',
    '/Users/alice/Documents/.env',
    '/Users/alice/Library/Application Support/Qask/Partitions/persist:chatgpt/Cookies',
  ]) {
    assert.equal(inspectAttachmentPath(filePath, options).allowed, false, filePath);
  }

  assert.deepEqual(
    inspectAttachmentPath('/Users/alice/Documents/research.pdf', options),
    { allowed: true },
  );
});

test('attachment inspection fails closed when a selected disk file cannot be resolved or is not a regular file', () => {
  assert.equal(inspectAttachmentPath('/Users/alice/Documents/missing.pdf', {
    ...createInspectionOptions(),
    resolvePath: () => { throw new Error('missing'); },
  }).allowed, false);

  assert.equal(inspectAttachmentPath('/Users/alice/Documents/folder', {
    ...createInspectionOptions(),
    isRegularFile: () => false,
  }).allowed, false);
});

test('selected credential-like names are denied even outside protected directories', () => {
  const options = createInspectionOptions();

  for (const filePath of [
    '/Volumes/share/github-token.pdf',
    '/Volumes/share/customer_credentials.pdf',
    '/Volumes/share/private-key.pdf',
    '/Volumes/share/id_ed25519',
  ]) {
    assert.equal(inspectAttachmentPath(filePath, options).allowed, false, filePath);
  }

  assert.equal(inspectAttachmentPath('/Volumes/share/meeting-notes.pdf', options).allowed, true);
});

test('GitHub web properties cannot be registered as custom model origins', () => {
  assert.equal(isRestrictedCustomProviderUrl('https://github.com/acme/private'), true);
  assert.equal(isRestrictedCustomProviderUrl('https://api.github.com/'), true);
  assert.equal(isRestrictedCustomProviderUrl('https://gist.github.com/'), true);
  assert.equal(isRestrictedCustomProviderUrl('https://raw.githubusercontent.com/acme/repo/main/README.md'), true);
  assert.equal(isRestrictedCustomProviderUrl('https://chat.example.com/'), false);
});

test('GitHub custom-origin blocking covers subdomains and canonical trailing dots without blocking lookalikes', () => {
  for (const url of [
    'https://github.com./acme/private',
    'https://objects.githubusercontent.com/private-object',
    'https://user.github.io/prompt-capture',
    'https://codeload.github.com/acme/private/zip/main',
    'https://github.dev/acme/private',
    'https://tenant.github.dev/',
    'https://tenant.github.dev./',
    'https://github.io/',
    'https://github.io./',
  ]) {
    assert.equal(isRestrictedCustomProviderUrl(url), true, url);
  }

  assert.equal(isRestrictedCustomProviderUrl('https://github.com.evil.example/'), false);
});

test('custom provider URLs reject embedded credentials and credential-like query parameters before persistence', () => {
  for (const url of [
    'https://token@example.ai/',
    'https://user:password@example.ai/',
    'https://example.ai/?access_token=redacted',
    'https://example.ai/?api_key=redacted',
    'https://example.ai/?credential=redacted',
  ]) {
    assert.equal(isRestrictedCustomProviderUrl(url), true, url);
  }

  assert.equal(isRestrictedCustomProviderUrl('https://example.ai/chat'), false);
});

test('custom provider URLs reject every query and fragment before persistence', () => {
  for (const url of [
    'https://example.ai/?mode=chat',
    'https://example.ai/#temporary-state',
  ]) {
    assert.equal(isRestrictedCustomProviderUrl(url), true, url);
  }

  assert.equal(isRestrictedCustomProviderUrl('https://example.ai/chat'), false);
});


test('Qask-generated attachment names never carry traversal, separators, or hidden-file prefixes', () => {
  const image = sanitizeAttachmentFileName('../../My Photo<script>.PNG', 'image');
  assert.equal(image, 'My Photo-script.png');
  assert.doesNotMatch(image, /[\\/]/);
  assert.ok(!image.startsWith('.'));

  const audio = sanitizeAttachmentFileName('/tmp/../voice:note.webm', 'audio');
  assert.equal(audio, 'voice-note.webm');
  assert.ok(audio.endsWith('.webm'));

  const hidden = sanitizeAttachmentFileName('.env', 'audio');
  assert.equal(hidden, 'env.webm');

  const empty = sanitizeAttachmentFileName('', 'image');
  assert.equal(empty, 'qask-image.png');

  const long = sanitizeAttachmentFileName(`${'a'.repeat(200)}.pdf`, 'document');
  assert.ok(long.length <= 73, long.length);
  assert.ok(long.endsWith('.pdf'));
});

test('Qask-generated attachment names fall back to the kind extension for unknown suffixes', () => {
  assert.equal(sanitizeAttachmentFileName('report.exe', 'document'), 'report.pdf');
  assert.equal(sanitizeAttachmentFileName('clip', 'image'), 'clip.png');
  assert.equal(sanitizeAttachmentFileName('clip', 'audio'), 'clip.webm');
  assert.equal(sanitizeAttachmentFileName('notes.md', 'document'), 'notes.pdf');
  assert.deepEqual(ATTACHMENT_EXTENSION_BY_KIND, { image: '.png', audio: '.webm', document: '.pdf' });
});
