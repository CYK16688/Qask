const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const renderer = fs.readFileSync(path.join(root, 'src/renderer.js'), 'utf8');

const createMultimodalHarness = () => {
  const start = renderer.indexOf('const ATTACHMENT_LIMITS =');
  const end = renderer.indexOf('const PANEL_LOAD_STATES =');
  const source = renderer.slice(start, end);
  return new Function('getPanelLabel', `${source}\nreturn { ATTACHMENT_LIMITS, getAttachmentKind, validateAttachmentMeta, buildAttachmentPayloads, isTrustedGuestUrl, createBroadcastSnapshot: typeof createBroadcastSnapshot === 'function' ? createBroadcastSnapshot : null, createPendingBroadcastTurn: typeof createPendingBroadcastTurn === 'function' ? createPendingBroadcastTurn : null, getPendingBroadcastAction: typeof getPendingBroadcastAction === 'function' ? getPendingBroadcastAction : null, mergePendingBroadcastResults: typeof mergePendingBroadcastResults === 'function' ? mergePendingBroadcastResults : null, settleBroadcastTasks: typeof settleBroadcastTasks === 'function' ? settleBroadcastTasks : null, createDispatchCoordinator: typeof createDispatchCoordinator === 'function' ? createDispatchCoordinator : null, shouldClearBroadcastDraft: typeof shouldClearBroadcastDraft === 'function' ? shouldClearBroadcastDraft : null, summarizeBroadcastResults: typeof summarizeBroadcastResults === 'function' ? summarizeBroadcastResults : null, isTimedOutResult: typeof isTimedOutResult === 'function' ? isTimedOutResult : null, BROADCAST_STATUS: typeof BROADCAST_STATUS === 'object' ? BROADCAST_STATUS : null, createRecordingSession: typeof createRecordingSession === 'function' ? createRecordingSession : null, requestRecordingStop: typeof requestRecordingStop === 'function' ? requestRecordingStop : null };`)((panel) => panel?.label || panel?.modelId || '网页面板');
};

const createRendererAttachmentInspectionHarness = () => {
  const start = renderer.indexOf('async function inspectSelectedAttachments');
  const end = renderer.indexOf('function setRecordingControls');
  const source = renderer.slice(start, end);
  return new Function('window', `${source}\nreturn { inspectSelectedAttachments };`);
};

test('attachment validation allows only bounded image, audio, and PDF selections', () => {
  const { ATTACHMENT_LIMITS, getAttachmentKind, validateAttachmentMeta } = createMultimodalHarness();
  const selected = [];

  assert.equal(getAttachmentKind('image/png'), 'image');
  assert.equal(getAttachmentKind('audio/webm'), 'audio');
  assert.equal(getAttachmentKind('application/pdf'), 'document');
  assert.equal(getAttachmentKind('text/plain'), null);

  assert.deepEqual(validateAttachmentMeta({ name: 'voice.webm', type: 'audio/webm', size: 1024 }, selected), { valid: true, kind: 'audio' });
  assert.equal(validateAttachmentMeta({ name: 'notes.txt', type: 'text/plain', size: 1024 }, selected).valid, false);
  assert.equal(validateAttachmentMeta({ name: 'large.png', type: 'image/png', size: ATTACHMENT_LIMITS.maxImageBytes + 1 }, selected).valid, false);
});

test('attachment validation rejects Git metadata, credentials, and hidden local files before any provider payload exists', () => {
  const { validateAttachmentMeta } = createMultimodalHarness();
  const selected = [];

  for (const file of [
    { name: '.git/config', type: 'application/pdf', size: 1024 },
    { name: 'project/.git/config', type: 'application/pdf', size: 1024 },
    { name: '.env', type: 'application/pdf', size: 1024 },
    { name: 'github-token.pdf', type: 'application/pdf', size: 1024 },
    { name: 'id_rsa.pdf', type: 'application/pdf', size: 1024 },
  ]) {
    assert.equal(validateAttachmentMeta(file, selected).valid, false, file.name);
  }

  assert.deepEqual(
    validateAttachmentMeta({ name: 'research.pdf', type: 'application/pdf', size: 1024 }, selected),
    { valid: true, kind: 'document' },
  );
});

test('selected attachments are main-process approved before they join the local queue', async () => {
  const createHarness = createRendererAttachmentInspectionHarness();
  const inspected = [];
  const { inspectSelectedAttachments } = createHarness({
    qask: {
      attachments: {
        inspect: async (file) => {
          inspected.push(file.name);
          return file.name === 'safe.pdf'
            ? { allowed: true }
            : { allowed: false, reason: 'hidden-or-git-path' };
        },
      },
    },
  });

  const result = await inspectSelectedAttachments([
    { name: 'safe.pdf' },
    { name: '.git/config' },
  ]);

  assert.deepEqual(inspected, ['safe.pdf', '.git/config']);
  assert.deepEqual(result.approved.map((file) => file.name), ['safe.pdf']);
  assert.deepEqual(result.rejected.map((entry) => entry.file.name), ['.git/config']);
});

test('attachment selection fails closed when the local-data inspection bridge is unavailable', async () => {
  const createHarness = createRendererAttachmentInspectionHarness();
  const { inspectSelectedAttachments } = createHarness({ qask: {} });

  const result = await inspectSelectedAttachments([{ name: 'safe.pdf' }]);

  assert.deepEqual(result.approved, []);
  assert.deepEqual(result.rejected.map((entry) => entry.file.name), ['safe.pdf']);
});

test('attachment payloads contain metadata only and never read local bytes for guest execution', () => {
  const { buildAttachmentPayloads } = createMultimodalHarness();
  const entries = [
    { id: 'image', kind: 'image', source: 'local', file: { name: 'photo.png', type: 'image/png', size: 12 } },
    { id: 'audio', kind: 'audio', source: 'recording', file: { name: 'voice.webm', type: 'audio/webm', size: 24 } },
  ];
  const payload = buildAttachmentPayloads(entries);

  assert.deepEqual(payload, [
    { id: 'image', kind: 'image', name: 'photo.png', type: 'image/png', size: 12, source: 'local' },
    { id: 'audio', kind: 'audio', name: 'voice.webm', type: 'audio/webm', size: 24, source: 'recording' },
  ]);
  assert.doesNotMatch(JSON.stringify(payload), /data:/i);
});

test('attachment injection only targets the configured HTTPS provider origins', () => {
  const { isTrustedGuestUrl } = createMultimodalHarness();
  const allowedOrigins = ['https://chatgpt.com', 'https://chat.openai.com'];

  assert.equal(isTrustedGuestUrl('https://chatgpt.com/c/abc', allowedOrigins), true);
  assert.equal(isTrustedGuestUrl('https://chat.openai.com/', allowedOrigins), true);
  assert.equal(isTrustedGuestUrl('http://chatgpt.com/', allowedOrigins), false);
  assert.equal(isTrustedGuestUrl('https://attacker.example/chatgpt.com', allowedOrigins), false);
});

test('guest scripts never receive attachment bytes or attempt generic file/paste injection', () => {
  const dispatchStart = renderer.indexOf('async function dispatchMessage');
  const dispatchEnd = renderer.indexOf('function presentResults');
  const dispatchSource = renderer.slice(dispatchStart, dispatchEnd);

  // Scope the byte-injection check to guest scripts and the dispatch path: the
  // renderer legitimately builds a File for local recording, which never reaches
  // a provider page.
  const adapterSource = renderer.slice(
    renderer.indexOf('const buildChatGPTScript'),
    renderer.indexOf('const DEFAULT_MODELS'),
  );
  assert.doesNotMatch(dispatchSource, /readAsDataURL|new DataTransfer\(\)|ClipboardEvent\('paste'|new File\(\[blob\]/);
  assert.doesNotMatch(adapterSource, /readAsDataURL|new DataTransfer\(\)|ClipboardEvent\('paste'|new File\(\[blob\]/);
  assert.doesNotMatch(dispatchSource, /attachmentManifest[^\n]*dataUri/);
  assert.match(dispatchSource, /if \(hasAttachments\) \{[\s\S]*?manualRequired: attachmentManifest\.map/);
  assert.doesNotMatch(dispatchSource, /executeJavaScript\([^)]*attachmentManifest/);
});

test('webpage dispatches do not leave a composer result hint', () => {
  const start = renderer.indexOf('function presentResults');
  const end = renderer.indexOf('function formatBytes');
  const source = renderer.slice(start, end);
  assert.notEqual(start, -1, 'broadcast result presenter is missing');

  assert.match(source, /results\.forEach\(\(entry\) => \{[\s\S]*?logStatus/);
  assert.doesNotMatch(source, /broadcastResults|textContent|dataset\.level|hidden/);
});

test('a broadcast freezes recipients and settles a stalled recipient with a per-panel timeout', async () => {
  const { createBroadcastSnapshot, settleBroadcastTasks } = createMultimodalHarness();
  assert.equal(typeof createBroadcastSnapshot, 'function');
  assert.equal(typeof settleBroadcastTasks, 'function');

  const panels = [
    { modelId: 'first', label: 'First', webview: { id: 'first-view' } },
    { modelId: 'second', label: 'Second', webview: { id: 'second-view' } },
    { modelId: 'third', label: 'Third', webview: { id: 'third-view' } },
  ];
  const snapshot = createBroadcastSnapshot(panels, 2, 'frozen prompt', [{ id: 'file-a' }]);
  panels.splice(0, panels.length, { modelId: 'changed', label: 'Changed' });

  assert.deepEqual(snapshot.recipients.map((recipient) => recipient.modelId), ['first', 'second']);
  assert.equal(snapshot.recipients[0].webview.id, 'first-view');
  assert.equal(snapshot.text, 'frozen prompt');
  assert.deepEqual(snapshot.attachments, [{ id: 'file-a' }]);

  const results = await settleBroadcastTasks(snapshot.recipients, (recipient) => (
    recipient.modelId === 'first'
      ? Promise.resolve({ panel: recipient.label, status: 'success', message: 'filled' })
      : new Promise(() => {})
  ), 10);

  assert.deepEqual(results[0], { panel: 'First', status: 'success', message: 'filled' });
  assert.equal(results[1].panel, 'Second');
  assert.equal(results[1].status, 'error');
  assert.match(results[1].message, /超时/);
});

test('a rejected dispatch reports a fixed local failure without exposing the thrown message', async () => {
  const { settleBroadcastTasks } = createMultimodalHarness();
  const results = await settleBroadcastTasks(
    [{ label: 'First' }],
    () => Promise.reject(new Error('provider-controlled detail')),
    100,
  );

  assert.deepEqual(results, [{ panel: 'First', status: 'error', message: '发送失败' }]);
});

test('a timed-out guest remains locked until its original dispatch settles', async () => {
  const { createDispatchCoordinator, settleBroadcastTasks } = createMultimodalHarness();
  assert.equal(typeof createDispatchCoordinator, 'function');
  const webview = { id: 'slow-view' };
  const coordinator = createDispatchCoordinator();
  let resolveFirst;
  let calls = 0;
  const first = new Promise((resolve) => { resolveFirst = resolve; });
  const recipient = { webview, label: 'Slow' };
  const dispatch = () => {
    calls += 1;
    return first;
  };

  const firstResults = await settleBroadcastTasks(
    [recipient],
    (entry) => coordinator.run(entry.webview, () => dispatch(entry)),
    1,
  );
  assert.equal(firstResults[0].status, 'error');
  assert.equal(coordinator.isBusy(webview), true);

  const secondResult = await coordinator.run(webview, () => dispatch(recipient));
  assert.deepEqual(secondResult, { skipped: true });
  assert.equal(calls, 1);

  resolveFirst({ panel: 'Slow', status: 'success', message: 'first turn' });
  await first;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(coordinator.isBusy(webview), false);
});

test('a later composer draft is not cleared by completion of an earlier turn', () => {
  const { shouldClearBroadcastDraft } = createMultimodalHarness();

  assert.equal(shouldClearBroadcastDraft({ text: 'first', revision: 1 }, { value: 'first', revision: 1 }, [{ attemptedAutoSend: true }]), true);
  assert.equal(shouldClearBroadcastDraft({ text: 'first', revision: 1 }, { value: 'second', revision: 2 }, [{ attemptedAutoSend: true }]), false);
  assert.equal(shouldClearBroadcastDraft({ text: 'first', revision: 1 }, { value: 'first', revision: 1 }, [{ attemptedAutoSend: false }]), false);
  assert.equal(shouldClearBroadcastDraft({ text: 'first', revision: 1 }, { value: 'first', revision: 1 }, [{ attemptedAutoSend: true }, { attemptedAutoSend: false }]), false);
});

test('every settled continuous broadcast releases its panels for the next turn', async () => {
  const { createBroadcastSnapshot, createDispatchCoordinator, settleBroadcastTasks } = createMultimodalHarness();
  const coordinator = createDispatchCoordinator();
  const webviews = [{ id: 'alpha-view' }, { id: 'beta-view' }];
  const panels = webviews.map((webview, index) => ({
    modelId: index === 0 ? 'alpha' : 'beta',
    label: index === 0 ? 'Alpha' : 'Beta',
    webview,
  }));
  const received = [];

  for (const text of ['turn one', 'turn two', 'turn three', 'turn four']) {
    const snapshot = createBroadcastSnapshot(panels, 2, text, []);
    const results = await settleBroadcastTasks(snapshot.recipients, (recipient) => (
      coordinator.run(recipient.webview, async () => {
        received.push(`${recipient.modelId}:${text}`);
        return { panel: recipient.label, status: 'success', attemptedAutoSend: true };
      })
    ), 25);
    assert.equal(results.every((result) => result.status === 'success'), true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(webviews.every((webview) => !coordinator.isBusy(webview)), true);
  }

  assert.deepEqual(received, [
    'alpha:turn one', 'beta:turn one',
    'alpha:turn two', 'beta:turn two',
    'alpha:turn three', 'beta:turn three',
    'alpha:turn four', 'beta:turn four',
  ]);
});

test('a retained turn retries only failed recipients and never repeats completed pages', () => {
  const {
    createBroadcastSnapshot,
    createPendingBroadcastTurn,
    getPendingBroadcastAction,
    mergePendingBroadcastResults,
  } = createMultimodalHarness();
  const panels = [
    { modelId: 'alpha', label: 'Alpha', webview: { id: 'alpha-view' } },
    { modelId: 'beta', label: 'Beta', webview: { id: 'beta-view' } },
  ];
  const snapshot = createBroadcastSnapshot(panels, 2, 'same turn', []);
  const pending = createPendingBroadcastTurn(
    snapshot,
    { text: 'same turn', revision: 7 },
    2,
    [
      { panel: 'Alpha', status: 'success', attemptedAutoSend: true },
      { panel: 'Beta', status: 'error', message: 'still busy' },
    ],
  );

  const action = getPendingBroadcastAction(pending, { value: 'same turn', revision: 7 }, 2);
  assert.equal(action.mode, 'retry');
  assert.deepEqual(action.recipients.map((recipient) => recipient.modelId), ['beta']);
  assert.deepEqual(action.attachments, []);
  assert.deepEqual(
    mergePendingBroadcastResults(pending, action.recipients, [
      { panel: 'Beta', status: 'success', attemptedAutoSend: true },
    ]),
    [
      { panel: 'Alpha', status: 'success', attemptedAutoSend: true },
      { panel: 'Beta', status: 'success', attemptedAutoSend: true },
    ],
  );
  assert.deepEqual(
    getPendingBroadcastAction(pending, { value: 'new turn', revision: 8 }, 2),
    { mode: 'new' },
  );
});

test('a fill-only turn is held rather than injected into the same webpage again', () => {
  const { createBroadcastSnapshot, createPendingBroadcastTurn, getPendingBroadcastAction } = createMultimodalHarness();
  const snapshot = createBroadcastSnapshot([
    { modelId: 'manual', label: 'Manual', webview: { id: 'manual-view' } },
  ], 1, 'confirm in page', []);
  const pending = createPendingBroadcastTurn(
    snapshot,
    { text: 'confirm in page', revision: 3 },
    0,
    [{ panel: 'Manual', status: 'success', attemptedAutoSend: false }],
  );

  assert.deepEqual(
    getPendingBroadcastAction(pending, { value: 'confirm in page', revision: 3 }, 0),
    { mode: 'hold' },
  );
});

test('attachment turns are never retained for automatic recipient-only retry', () => {
  const { createBroadcastSnapshot, createPendingBroadcastTurn } = createMultimodalHarness();
  const snapshot = createBroadcastSnapshot([
    { modelId: 'alpha', label: 'Alpha', webview: { id: 'alpha-view' } },
  ], 1, 'with a file', [{ id: 'file-a' }]);

  assert.equal(
    createPendingBroadcastTurn(
      snapshot,
      { text: 'with a file', revision: 1 },
      1,
      [{ panel: 'Alpha', status: 'error' }],
    ),
    null,
  );
});

test('recording stop requests preserve buffered chunks until the owning recorder finalizes', () => {
  const { createRecordingSession, requestRecordingStop } = createMultimodalHarness();
  const session = createRecordingSession({ generation: 1, recorder: { state: 'recording' }, stream: {}, leaseId: 'lease-a' });
  session.chunks.push({ size: 8 });

  assert.equal(requestRecordingStop(session, { message: 'size limit' }), 'stop');
  assert.equal(session.stopRequested, true);
  assert.equal(session.stopMessage, 'size limit');
  assert.deepEqual(session.chunks, [{ size: 8 }]);

  session.recorder.state = 'inactive';
  session.chunks.push({ size: 12 });
  assert.equal(requestRecordingStop(session, { discard: true }), 'draining');
  assert.equal(session.discard, true);
  assert.deepEqual(session.chunks, [{ size: 8 }, { size: 12 }]);
});

test('an externally inactive recorder still preserves a final data chunk for its stop listener', () => {
  const { createRecordingSession, requestRecordingStop } = createMultimodalHarness();
  const session = createRecordingSession({ generation: 1, recorder: { state: 'inactive' }, stream: {}, leaseId: 'lease-a' });

  assert.equal(requestRecordingStop(session, { discard: true }), 'draining');
  assert.equal(session.stopRequested, false);
  session.chunks.push({ size: 16 });
  assert.deepEqual(session.chunks, [{ size: 16 }]);
});

test('a watchdog expiry is reported as unconfirmed rather than as a failed send', async () => {
  const { settleBroadcastTasks, isTimedOutResult, BROADCAST_STATUS } = createMultimodalHarness();

  const results = await settleBroadcastTasks(
    [{ label: 'Slow' }],
    () => new Promise(() => {}),
    5,
  );

  assert.equal(results[0].status, BROADCAST_STATUS.error);
  assert.equal(results[0].timedOut, true);
  assert.equal(isTimedOutResult(results[0]), true);
  assert.match(results[0].message, /超时/);
  assert.match(results[0].message, /尚未确认/);

  // A rejected send is a real failure and must never be reported as unconfirmed.
  const [rejected] = await settleBroadcastTasks(
    [{ label: 'Rejected' }],
    () => Promise.reject(new Error('provider detail')),
    100,
  );
  assert.equal(isTimedOutResult(rejected), false);
});

test('the round summary counts every recipient, including an all-partial attachment round', () => {
  const { summarizeBroadcastResults } = createMultimodalHarness();

  const allPartial = summarizeBroadcastResults([
    { status: 'partial', attemptedAutoSend: false },
    { status: 'partial', attemptedAutoSend: false },
    { status: 'partial', attemptedAutoSend: false },
  ]);
  assert.deepEqual(allPartial, {
    total: 3,
    attemptedAutoSend: 0,
    filled: 0,
    attachmentOnly: 3,
    pending: 0,
    timedOut: 0,
    failed: 0,
  });

  const mixed = summarizeBroadcastResults([
    { status: 'success', attemptedAutoSend: true },
    { status: 'success', attemptedAutoSend: false },
    { status: 'pending' },
    { status: 'error', timedOut: true },
    { status: 'error' },
    { status: 'partial', attemptedAutoSend: false },
  ]);
  assert.deepEqual(mixed, {
    total: 6,
    attemptedAutoSend: 1,
    filled: 1,
    attachmentOnly: 1,
    pending: 1,
    timedOut: 1,
    failed: 1,
  });

  // Every recipient lands in exactly one bucket, so no panel can vanish silently.
  const buckets = mixed.attemptedAutoSend + mixed.filled + mixed.attachmentOnly + mixed.pending + mixed.timedOut + mixed.failed;
  assert.equal(buckets, mixed.total);
});

test('a panel still holding the previous turn is left alone instead of being sent again', () => {
  const rendererSource = renderer.slice(
    renderer.indexOf('async function dispatchMessage'),
    renderer.indexOf('function presentResults'),
  );

  assert.match(rendererSource, /if \(dispatchCoordinator\.isBusy\(panelState\.webview\)\) \{/);
  assert.match(rendererSource, /status: BROADCAST_STATUS\.pending/);
  assert.match(rendererSource, /以免出现重复提问/);
  assert.doesNotMatch(rendererSource, /上一轮消息仍在该网页中处理/);
});

test('a failed panel carries an actionable hint without reflecting page text', () => {
  const rendererSource = renderer.slice(
    renderer.indexOf('async function dispatchMessage'),
    renderer.indexOf('function formatBytes'),
  );

  assert.match(rendererSource, /hint: buildDispatchFailureHint\(usingFallback\)/);
  // The fixed local failure string and the anti-reflection rule both survive.
  assert.match(rendererSource, /message: `网页操作失败\$\{usingFallback \? " \(通用策略\)" : ""\}`/);
  assert.doesNotMatch(rendererSource, /error\?\.message|reason\b.*message:/);
});

test('attachments can be cleared in one action without touching a guest page', () => {
  const previewSource = renderer.slice(
    renderer.indexOf('function renderAttachmentPreview'),
    renderer.indexOf('async function startAudioRecording'),
  );
  const clickSource = renderer.slice(
    renderer.indexOf('attachmentPreview.addEventListener("click"'),
    renderer.indexOf('function selectLayout'),
  );

  assert.match(previewSource, /dataset\.attachmentAction = "clear-all"/);
  assert.match(clickSource, /event\.target\.dataset\.attachmentAction === "clear-all"[\s\S]*?clearAttachments\(\)/);
  assert.doesNotMatch(clickSource, /fileName/);
});

test('the composer only takes focus back when the composer already had it', () => {
  const focusSource = renderer.slice(
    renderer.indexOf('function restoreComposerFocusAfterBroadcast'),
    renderer.indexOf('function normalizeId'),
  );

  assert.match(focusSource, /active === document\.body \|\| active === broadcastInput/);
  // The old unconditional refocus both duplicated and stole focus from panels.
  assert.doesNotMatch(renderer, /if \(!document\.activeElement \|\| document\.activeElement !== broadcastInput\)/);
});


test('a wedged dispatch can be released instead of excluding the panel forever', async () => {
  const { createDispatchCoordinator, settleBroadcastTasks } = createMultimodalHarness();
  const coordinator = createDispatchCoordinator();
  const webview = { id: 'wedged-panel' };

  coordinator.run(webview, () => new Promise(() => {}));
  assert.equal(coordinator.isBusy(webview), true);
  coordinator.reset(webview);
  assert.equal(coordinator.isBusy(webview), false);

  // The next run must actually execute again; a swallowed reset would leave the
  // panel reporting "still processing" for the rest of the app session.
  const result = await coordinator.run(webview, () => Promise.resolve({ success: true }));
  assert.deepEqual(result, { success: true });
});

test('a watchdog timeout releases the in-flight dispatch through its cleanup hook', async () => {
  const { createDispatchCoordinator, settleBroadcastTasks } = createMultimodalHarness();
  const coordinator = createDispatchCoordinator();
  const webview = { id: 'slow-panel' };
  const released = [];

  coordinator.run(webview, () => new Promise(() => {}));
  const results = await settleBroadcastTasks(
    [{ label: 'Slow', webview }],
    () => new Promise(() => {}),
    5,
    (recipient) => {
      released.push(recipient.webview);
      coordinator.reset(recipient.webview);
    },
  );

  assert.equal(results[0].timedOut, true);
  assert.deepEqual(released, [webview]);
  assert.equal(coordinator.isBusy(webview), false);
});


test('a timed-out recipient is not retried automatically even though the turn is retained', () => {
  const { createBroadcastSnapshot, createPendingBroadcastTurn } = createMultimodalHarness();
  const panels = [
    { modelId: 'alpha', label: 'Alpha', webview: { id: 'alpha-view' } },
    { modelId: 'beta', label: 'Beta', webview: { id: 'beta-view' } },
  ];
  const snapshot = createBroadcastSnapshot(panels, 2, 'same turn', []);
  const pending = createPendingBroadcastTurn(
    snapshot,
    { text: 'same turn', revision: 4 },
    2,
    [
      { panel: 'Alpha', status: 'success', attemptedAutoSend: true },
      { panel: 'Beta', status: 'error', timedOut: true, message: '等待超时' },
    ],
  );

  // Nothing is safely retryable and no page was left fill-only: there is no
  // retained turn, so the next submit starts a new round instead of guessing.
  assert.equal(pending, null);
});

test('changing the top-N composition invalidates a retained turn before it can retry a parked panel', () => {
  const { createBroadcastSnapshot, createPendingBroadcastTurn, getPendingBroadcastAction } = createMultimodalHarness();
  const panels = [
    { modelId: 'alpha', label: 'Alpha', webview: { id: 'alpha-view' } },
    { modelId: 'beta', label: 'Beta', webview: { id: 'beta-view' } },
  ];
  const snapshot = createBroadcastSnapshot(panels, 2, 'same turn', []);
  const pending = createPendingBroadcastTurn(
    snapshot,
    { text: 'same turn', revision: 2 },
    2,
    [
      { panel: 'Alpha', status: 'success', attemptedAutoSend: true },
      { panel: 'Beta', status: 'error', message: 'still busy' },
    ],
  );

  assert.equal(getPendingBroadcastAction(pending, { value: 'same turn', revision: 2 }, 2, ['alpha', 'beta']).mode, 'retry');
  assert.deepEqual(
    getPendingBroadcastAction(pending, { value: 'same turn', revision: 2 }, 2, ['beta', 'gamma']),
    { mode: 'new' },
  );
});
