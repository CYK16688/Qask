const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

const renderer = read('src/renderer.js');
const indexHtml = read('src/index.html');
const styles = read('src/styles.css');
const userGuide = read('docs/user-guide.md');
const architecture = read('docs/architecture.md');
const readme = read('README.md');
const privacy = read('PRIVACY.md');

function loadQueueCore() {
  const start = renderer.indexOf('function normalizeSendMode');
  const end = renderer.indexOf('function renderMessageQueue');
  assert.notEqual(start, -1, 'queue helpers are missing');
  assert.notEqual(end, -1, 'queue boundary is missing');
  const prefix = `const SEND_MODE_VALUES = new Set(["send", "queue", "fill"]);
const QUEUE_ANSWER_STABLE_POLLS = 1;`;
  return new Function(`${prefix}\n${renderer.slice(start, end)}\nreturn { normalizeSendMode, canQueueMessage, getAnswerWaitState, isAnswerWaitDone, buildGeneratingCheckScript };`)();
}

test('send modes normalize to immediate, queue, or fill-only', () => {
  const { normalizeSendMode, canQueueMessage } = loadQueueCore();
  assert.equal(normalizeSendMode('send'), 'send');
  assert.equal(normalizeSendMode('queue'), 'queue');
  assert.equal(normalizeSendMode('fill'), 'fill');
  assert.equal(normalizeSendMode('bogus'), 'send');
  assert.equal(normalizeSendMode(undefined), 'send');
  assert.equal(canQueueMessage('  你好  '), true);
  assert.equal(canQueueMessage('   '), false);
  assert.equal(canQueueMessage('你好', 1), false);
});

test('answer completion requires changed text plus two stable polls', () => {
  const { getAnswerWaitState, isAnswerWaitDone } = loadQueueCore();
  let state = { baseline: '', lastText: '', stable: 0, unreadable: 0, done: false };
  state = getAnswerWaitState(state, { text: '第一段', generating: false });
  assert.equal(state.stable, 0);
  state = getAnswerWaitState(state, { text: '第一段', generating: false });
  assert.equal(state.stable, 1);
  assert.equal(isAnswerWaitDone(state), true);

  // A visible stop control asks for one more confirmation poll, but no longer
  // resets progress forever (hidden/stale stop buttons used to stall the queue).
  let streaming = { baseline: '', lastText: '第一段', stable: 0 };
  streaming = getAnswerWaitState(streaming, { text: '第一段', generating: true });
  assert.equal(streaming.stable, 1);
  assert.equal(isAnswerWaitDone(streaming), false);
  streaming = getAnswerWaitState(streaming, { text: '第一段', generating: true });
  assert.equal(isAnswerWaitDone(streaming), true);
  // Unchanged baseline is not an answer.
  let baselineOnly = { baseline: '旧回答', lastText: '旧回答', stable: 1 };
  baselineOnly = getAnswerWaitState(baselineOnly, { text: '旧回答', generating: false });
  assert.equal(baselineOnly.stable, 0);
});

test('the stop-button detector is read-only and covers common label variants', () => {
  const { buildGeneratingCheckScript } = loadQueueCore();
  const script = buildGeneratingCheckScript();
  assert.match(script, /button, \[role="button"\]/);
  assert.match(script, /停止\|中止\|stop\|cancel/);
  assert.match(script, /生成\|回答\|响应\|停止\|stop\|response\|generat\|stream/);
  assert.match(script, /return \{ generating: Boolean\(stop\) \}/);
  assert.doesNotMatch(script, /\.click\(|\.value\s*=|execCommand/);
});

test('the composer exposes a hover send-mode menu and a queue panel', () => {
  assert.match(indexHtml, /id="sendMode"[^>]*data-mode="send"/);
  assert.match(indexHtml, /id="sendModeMenu"[^>]*role="menu"/);
  assert.match(indexHtml, /data-send-mode="send"[^>]*aria-checked="true"/);
  assert.match(indexHtml, /data-send-mode="queue"/);
  assert.match(indexHtml, /data-send-mode="fill"/);
  assert.match(indexHtml, /id="sendButton"[^>]*aria-haspopup="true"/);
  assert.match(indexHtml, /id="messageQueue"/);
  assert.match(indexHtml, /id="messageQueueList"/);
  assert.match(indexHtml, /id="queueSkipWait"/);
  assert.match(indexHtml, /id="queueClear"/);
  assert.match(renderer, /sendModeEl\?\.addEventListener\("pointerenter", openSendModeMenu\)/);
  assert.match(renderer, /sendModeOptions\.forEach\(\(option\) => \{/);
  assert.match(renderer, /function setSendMode\(value, \{ persist = false \} = \{\}\)/);
  assert.match(renderer, /sendButton\.title = `\$\{labels\[sendModeValue\]\} \(Enter\)`/);
});

test('submitting in queue mode enqueues text instead of broadcasting immediately', () => {
  assert.match(renderer, /if \(sendModeValue === "queue"\) \{/);
  assert.match(renderer, /if \(enqueueMessage\(text\)\) \{/);
  assert.match(renderer, /void processMessageQueue\(\)/);
  assert.match(renderer, /async function processMessageQueue\(\)/);
  assert.match(renderer, /dispatchSnapshotToPanels\(snapshot\)/);
  assert.match(renderer, /captureAnswerBaselines\(snapshot\.recipients\)/);
  assert.match(renderer, /attemptedAutoSend === true/);
  assert.match(renderer, /extractPanelAnswer\(panelState\)/);
  assert.match(renderer, /isPanelGenerating\(panelState\)/);
  assert.match(renderer, /QUEUE_ANSWER_TIMEOUT_MS/);
  assert.match(renderer, /queueSkipWaitRequested/);
  assert.match(renderer, /queueClear\?\.addEventListener/);
  assert.match(renderer, /areAnyPanelsGenerating\(activePanels\)/);
  assert.match(renderer, /waitForPanelsIdle\(activePanels/);
  assert.match(renderer, /等待当前回答完成/);
  assert.match(renderer, /已发送，等待/);
  assert.match(renderer, /const QUEUE_ANSWER_POLL_MS = 1500;/);
  assert.match(renderer, /state\.stable >= 3/);
  assert.doesNotMatch(renderer, /（\$\{elapsedSeconds\}s）/);
  assert.match(renderer, /queuedMessages = queuedMessages\.filter/);
});

test('fill-only mode passes an explicit override to the provider adapter', () => {
  assert.match(renderer, /const fillOnly = sendModeValue === "fill";/);
  assert.match(renderer, /dispatchSnapshotToPanels\(snapshot, \{ fillOnly \}\)/);
  assert.match(renderer, /dispatchMessage\(panelState, snapshot\.text, snapshot\.attachments, \{ fillOnly \}\)/);
  assert.match(renderer, /async function dispatchMessage\(panelState, text, attachmentManifest = \[\], \{ fillOnly = false \} = \{\}\)/);
  assert.match(renderer, /config\.allowAutoSend && !fillOnly \? true : false/);
});

test('the queue and send menu are styled in both themes without persistence', () => {
  assert.match(styles, /\.send-mode-menu\s*\{/);
  assert.match(styles, /\.send-mode-option\[aria-checked="true"\]/);
  assert.match(styles, /\.message-queue\s*\{/);
  assert.match(styles, /\.message-queue-item\.is-current/);
  assert.match(styles, /html\[data-theme="light"\] \.message-queue/);
  assert.doesNotMatch(renderer, /localStorage\.(getItem|setItem)\([^)]*queue/i);
});

test('queue behavior and limitations are documented', () => {
  assert.match(userGuide, /## 发送方式与队列/);
  assert.match(userGuide, /所有真正开始回答的面板完成后，自动发送队列里的下一条/);
  assert.match(userGuide, /先等当前回答结束/);
  assert.match(userGuide, /约 2 秒内稳定/);
  assert.match(userGuide, /3 分钟/);
  assert.match(userGuide, /只支持纯文本/);
  assert.match(architecture, /`send` \/ `queue` \/ `fill`/);
  assert.match(architecture, /停止按钮消失/);
  assert.match(readme, /Send modes and queue/);
  assert.match(privacy, /Queued\s+messages are held in memory only/);
});

function loadMoveQueueItem() {
  const start = renderer.indexOf('function moveQueueItem');
  const end = renderer.indexOf('function reorderQueuedItem');
  assert.notEqual(start, -1, 'moveQueueItem is missing');
  assert.notEqual(end, -1, 'moveQueueItem boundary is missing');
  return new Function(`${renderer.slice(start, end)}\nreturn moveQueueItem;`)();
}

test('queue items can be reordered before or after a target', () => {
  const moveQueueItem = loadMoveQueueItem();
  const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.deepEqual(moveQueueItem(items, 'c', 'a', false).map((item) => item.id), ['c', 'a', 'b']);
  assert.deepEqual(moveQueueItem(items, 'a', 'c', true).map((item) => item.id), ['b', 'c', 'a']);
  assert.deepEqual(moveQueueItem(items, 'b', 'c', false).map((item) => item.id), ['a', 'b', 'c']);
  assert.deepEqual(moveQueueItem(items, 'missing', 'a', false).map((item) => item.id), ['a', 'b', 'c']);
  assert.deepEqual(moveQueueItem(items, 'a', 'missing', false).map((item) => item.id), ['a', 'b', 'c']);
});

test('pending queue rows expose drag, edit, and delete controls', () => {
  assert.match(renderer, /row\.draggable = !isCurrent && !isEditing/);
  assert.match(renderer, /row\.addEventListener\("dragstart"/);
  assert.match(renderer, /row\.addEventListener\("drop"/);
  assert.match(renderer, /reorderQueuedItem\(draggedId, item\.id, after\)/);
  assert.match(renderer, /movePendingQueueItem\(item\.id, event\.key === "ArrowUp" \? -1 : 1\)/);
  assert.match(renderer, /function startQueueEdit\(item\)/);
  assert.match(renderer, /function saveQueueEdit\(item, value\)/);
  assert.match(renderer, /function cancelQueueEdit\(\)/);
  assert.match(renderer, /message-queue-edit-input/);
  assert.match(renderer, /dataset\.queueRemove = item\.id/);
  assert.match(renderer, /event\.key === "Enter" && !event\.shiftKey/);
  assert.match(styles, /\.message-queue-drag\s*\{/);
  assert.match(styles, /\.message-queue-edit-input\s*\{/);
  assert.match(styles, /\.message-queue-item\.is-drop-before/);
});

test('queue editing tools are documented', () => {
  assert.match(userGuide, /拖动左侧手柄/);
  assert.match(userGuide, /重新排序/);
  assert.match(userGuide, /Alt \+ ↑\/↓/);
  assert.match(userGuide, /点铅笔编辑/);
  assert.match(userGuide, /正在发送\/等待回答的当前条会锁定/);
});
