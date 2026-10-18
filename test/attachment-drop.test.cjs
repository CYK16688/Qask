const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('the attachment tray sits above the text input', () => {
  const html = read('src/index.html');
  const previewIndex = html.indexOf('id="attachmentPreview"');
  const inputIndex = html.indexOf('id="broadcastInput"');
  assert.ok(previewIndex > -1 && inputIndex > -1);
  assert.ok(previewIndex < inputIndex, 'attachment preview must precede the textarea');
  assert.match(html, /id="attachmentPreview"[\s\S]*?id="broadcastInput"/);
});

test('files can be dropped directly onto the composer', () => {
  const renderer = read('src/renderer.js');
  const html = read('src/index.html');
  const styles = read('src/styles.css');

  assert.match(html, /composer-drop-hint/);
  assert.match(html, /id="attachmentLocalHint"/);
  assert.match(renderer, /revealStatusBarTemporarily/);
  assert.match(renderer, /const attachmentHint = hasAttachments/);
  assert.match(renderer, /async function addAttachmentFiles\(files, source = "local"\)/);
  assert.match(renderer, /Array\.from\(event\.dataTransfer\?\.types \|\| \[\]\)\.includes\("Files"\)/);
  assert.match(renderer, /composer\?\.addEventListener\("dragenter"/);
  assert.match(renderer, /composer\?\.addEventListener\("dragover"/);
  assert.match(renderer, /composer\?\.addEventListener\("drop"/);
  assert.match(renderer, /addAttachmentFiles\(files, "drop"\)/);
  assert.match(styles, /\.composer\.is-file-drag-over \.composer-drop-hint/);
});

test('drag-and-drop attachments are documented', () => {
  const guide = read('docs/user-guide.md');
  const readme = read('README.md');
  assert.match(guide, /拖到底部输入框区域/);
  assert.match(guide, /附件预览在输入框上方/);
  assert.match(readme, /drag files onto the composer/i);
});
