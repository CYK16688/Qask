const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { sanitizeAttachmentFileName } = require('../local-data-boundary.cjs');

const root = path.resolve(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'src', 'renderer.js'), 'utf8');

const createHarness = () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qask-attachment-test-'));
  const source = main.slice(
    main.indexOf('const ATTACHMENT_SAVE_DIR_NAME ='),
    main.indexOf('app.on("web-contents-created"'),
  );
  assert.ok(source.includes('persistShellAttachment'), 'attachment persistence source is missing');
  const factory = new Function(
    'path',
    'fs',
    'app',
    'randomUUID',
    'isTrustedShellSender',
    'sanitizeAttachmentFileName',
    'shell',
    'Buffer',
    'console',
    `${source}\nreturn {
      persistShellAttachment,
      revealShellAttachment,
      getAttachmentSaveDirectory,
      ATTACHMENT_SAVE_DIR_NAME,
      ATTACHMENT_SAVE_LIMITS,
    };`,
  );
  const appStub = {
    getPath(name) {
      if (name === 'pictures') return path.join(tmpRoot, 'Pictures');
      if (name === 'home') return tmpRoot;
      return tmpRoot;
    },
  };
  const revealed = [];
  const shellStub = { showItemInFolder: (filePath) => revealed.push(filePath) };
  const api = factory(
    path,
    fs,
    appStub,
    () => 'uuid-1234-5678',
    (event) => event === 'trusted',
    sanitizeAttachmentFileName,
    shellStub,
    Buffer,
    { error() {} },
  );
  return { api, tmpRoot, revealed };
};

const bufferFor = (text) => Buffer.from(text, 'utf8');

test('the main process writes trusted recordings/pasted images into the visible Qask folder', (t) => {
  const { api, tmpRoot, revealed } = createHarness();
  t.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

  const result = api.persistShellAttachment('trusted', {
    kind: 'image',
    name: '../../My Photo<script>.PNG',
    buffer: bufferFor('png-bytes'),
  });

  assert.equal(result.saved, true);
  assert.match(result.fileName, /^[0-9T:.Z-]+-[0-9a-z-]+-My Photo-script\.png$/);
  assert.equal(result.displayPath, `~/Pictures/Qask Attachments/${result.fileName}`);
  assert.doesNotMatch(result.fileName, /[\\/]|\.\./);

  const savedPath = path.join(tmpRoot, 'Pictures', 'Qask Attachments', result.fileName);
  assert.equal(path.dirname(savedPath), api.getAttachmentSaveDirectory());
  assert.equal(fs.readFileSync(savedPath, 'utf8'), 'png-bytes');

  assert.equal(api.revealShellAttachment('trusted', result.fileName), true);
  assert.deepEqual(revealed, [savedPath]);
});

test('attachment persistence rejects untrusted senders, unsupported kinds, empty bytes, and oversized files', (t) => {
  const { api, tmpRoot } = createHarness();
  t.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

  assert.deepEqual(
    api.persistShellAttachment('untrusted', { kind: 'image', buffer: bufferFor('x') }),
    { saved: false, reason: 'untrusted-sender' },
  );
  assert.deepEqual(
    api.persistShellAttachment('trusted', { kind: 'script', buffer: bufferFor('x') }),
    { saved: false, reason: 'unsupported-kind' },
  );
  assert.deepEqual(
    api.persistShellAttachment('trusted', { kind: 'image', buffer: Buffer.alloc(0) }),
    { saved: false, reason: 'invalid-size' },
  );
  assert.deepEqual(
    api.persistShellAttachment('trusted', {
      kind: 'image',
      buffer: Buffer.alloc(api.ATTACHMENT_SAVE_LIMITS.image + 1),
    }),
    { saved: false, reason: 'invalid-size' },
  );
  assert.equal(fs.existsSync(api.getAttachmentSaveDirectory()), false);
});

test('attachment reveal only accepts existing basenames inside the Qask attachment folder', (t) => {
  const { api, tmpRoot, revealed } = createHarness();
  t.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

  assert.equal(api.revealShellAttachment('untrusted', 'x.png'), false);
  assert.equal(api.revealShellAttachment('trusted', '../x.png'), false);
  assert.equal(api.revealShellAttachment('trusted', 'missing.png'), false);
  assert.deepEqual(revealed, []);
});

test('the preload bridge exposes attachment persistence and reveal without a generic IPC escape hatch', () => {
  assert.match(preload, /persist: \(payload\) => ipcRenderer\.invoke\("attachments:persist", payload\)/);
  assert.match(preload, /reveal: \(fileName\) => ipcRenderer\.invoke\("attachments:reveal", fileName\)/);
  assert.match(main, /ipcMain\.handle\("attachments:persist", persistShellAttachment\)/);
  assert.match(main, /ipcMain\.handle\("attachments:reveal", revealShellAttachment\)/);
});

test('recordings and pasted images are persisted before the attachment chip claims they are saved', () => {
  assert.match(renderer, /persistAttachmentFile\(file, ATTACHMENT_KINDS\.audio\)/);
  assert.match(renderer, /persistAttachmentFile\(file, ATTACHMENT_KINDS\.image\)/);
  assert.match(renderer, /markAttachmentSaved\(entry, saved\)/);
  assert.match(renderer, /录音已保存到 \$\{saved\.displayPath\}/);
  assert.match(renderer, /dataset\.attachmentAction = "reveal"/);
  assert.match(renderer, /window\.qask\?\.attachments\?\.reveal\?\.\(savedName\)/);

  const pasteSource = renderer.slice(
    renderer.indexOf('broadcastInput.addEventListener("paste"'),
    renderer.indexOf('const modelRegistry = new Map()'),
  );
  // Clipboard Files have no usable disk path, so paste must not go through the
  // path-based inspector; it persists a Qask-owned copy instead.
  assert.doesNotMatch(pasteSource, /inspectSelectedAttachments/);
  assert.match(pasteSource, /persistAttachmentFile\(file, ATTACHMENT_KINDS\.image\)/);
});
