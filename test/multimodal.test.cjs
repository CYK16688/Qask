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
  return new Function('getPanelLabel', `${source}\nreturn { ATTACHMENT_LIMITS, getAttachmentKind, validateAttachmentMeta, buildAttachmentPayloads, shouldClearAttachmentsForResults, shouldAutoSendAttachmentMessage, isTrustedGuestUrl, getAttachmentDispatchStatus: typeof getAttachmentDispatchStatus === 'function' ? getAttachmentDispatchStatus : null, getBroadcastResultLevel: typeof getBroadcastResultLevel === 'function' ? getBroadcastResultLevel : null, createBroadcastSnapshot: typeof createBroadcastSnapshot === 'function' ? createBroadcastSnapshot : null, createPendingBroadcastTurn: typeof createPendingBroadcastTurn === 'function' ? createPendingBroadcastTurn : null, getPendingBroadcastAction: typeof getPendingBroadcastAction === 'function' ? getPendingBroadcastAction : null, mergePendingBroadcastResults: typeof mergePendingBroadcastResults === 'function' ? mergePendingBroadcastResults : null, settleBroadcastTasks: typeof settleBroadcastTasks === 'function' ? settleBroadcastTasks : null, createDispatchCoordinator: typeof createDispatchCoordinator === 'function' ? createDispatchCoordinator : null, shouldClearBroadcastDraft: typeof shouldClearBroadcastDraft === 'function' ? shouldClearBroadcastDraft : null, createRecordingSession: typeof createRecordingSession === 'function' ? createRecordingSession : null, requestRecordingStop: typeof requestRecordingStop === 'function' ? requestRecordingStop : null, getRecordingStopAction: typeof getRecordingStopAction === 'function' ? getRecordingStopAction : null };`)((panel) => panel?.label || panel?.modelId || '网页面板');
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

test('attachment payloads contain metadata only and never read local bytes for guest execution', async () => {
  const { buildAttachmentPayloads } = createMultimodalHarness();
  const entries = [
    { id: 'image', kind: 'image', source: 'local', file: { name: 'photo.png', type: 'image/png', size: 12 } },
    { id: 'audio', kind: 'audio', source: 'recording', file: { name: 'voice.webm', type: 'audio/webm', size: 24 } },
  ];
  const result = await buildAttachmentPayloads(entries);

  assert.deepEqual(result.payload, [
    { id: 'image', kind: 'image', name: 'photo.png', type: 'image/png', size: 12, source: 'local' },
    { id: 'audio', kind: 'audio', name: 'voice.webm', type: 'audio/webm', size: 24, source: 'recording' },
  ]);
  assert.deepEqual(result.failures, []);
  assert.doesNotMatch(JSON.stringify(result.payload), /data:/i);
});

test('third-party page reports never auto-clear local attachments', () => {
  const { shouldClearAttachmentsForResults } = createMultimodalHarness();

  assert.equal(shouldClearAttachmentsForResults([{ attachments: { confirmed: 0 } }], 1), false);
  assert.equal(shouldClearAttachmentsForResults([{ attachments: { confirmed: 1 } }, { attachments: { confirmed: 1 } }], 1), false);
});

test('attachment injection only targets the configured HTTPS provider origins', () => {
  const { isTrustedGuestUrl } = createMultimodalHarness();
  const allowedOrigins = ['https://chatgpt.com', 'https://chat.openai.com'];

  assert.equal(isTrustedGuestUrl('https://chatgpt.com/c/abc', allowedOrigins), true);
  assert.equal(isTrustedGuestUrl('https://chat.openai.com/', allowedOrigins), true);
  assert.equal(isTrustedGuestUrl('http://chatgpt.com/', allowedOrigins), false);
  assert.equal(isTrustedGuestUrl('https://attacker.example/chatgpt.com', allowedOrigins), false);
});

test('attachment mode blocks auto-send when any local attachment cannot be serialized', () => {
  const { shouldAutoSendAttachmentMessage } = createMultimodalHarness();

  assert.equal(shouldAutoSendAttachmentMessage(0, 0), true);
  assert.equal(shouldAutoSendAttachmentMessage(1, 0), false);
  assert.equal(shouldAutoSendAttachmentMessage(1, 1), false);
});

test('guest scripts never receive attachment bytes or attempt generic file/paste injection', () => {
  const dispatchStart = renderer.indexOf('async function dispatchMessage');
  const dispatchEnd = renderer.indexOf('function presentResults');
  const dispatchSource = renderer.slice(dispatchStart, dispatchEnd);

  assert.doesNotMatch(renderer, /readAsDataURL|new DataTransfer\(\)|ClipboardEvent\('paste'|new File\(\[blob\]/);
  assert.doesNotMatch(dispatchSource, /attachmentManifest[^\n]*dataUri/);
  assert.match(dispatchSource, /if \(hasAttachments\) \{[\s\S]*?manualRequired: attachmentManifest\.map/);
  assert.doesNotMatch(dispatchSource, /executeJavaScript\([^)]*attachmentManifest/);
});

test('attachment delivery is never reported as complete before a third-party page can be confirmed', () => {
  const { getAttachmentDispatchStatus } = createMultimodalHarness();

  assert.equal(typeof getAttachmentDispatchStatus, 'function');
  assert.equal(getAttachmentDispatchStatus({ requested: 0 }), 'success');
  assert.equal(getAttachmentDispatchStatus({ requested: 1, assigned: 1, manualRequired: [] }), 'partial');
  assert.equal(getAttachmentDispatchStatus({ requested: 2, assigned: 1, manualRequired: [{ id: 'pdf' }] }), 'partial');
  assert.equal(getAttachmentDispatchStatus({ requested: 1, assigned: 0, manualRequired: [{ id: 'audio' }] }), 'error');
});

test('an attempted third-party attachment handoff is a warning, not an error', () => {
  const { getBroadcastResultLevel } = createMultimodalHarness();

  assert.equal(typeof getBroadcastResultLevel, 'function');
  assert.equal(getBroadcastResultLevel([{ status: 'partial' }]), 'warning');
  assert.equal(getBroadcastResultLevel([{ status: 'partial' }, { status: 'success' }]), 'warning');
  assert.equal(getBroadcastResultLevel([{ status: 'error' }]), 'error');
  assert.equal(getBroadcastResultLevel([{ status: 'success' }]), 'success');
});

test('a mixed broadcast result remains an error when any recipient fails', () => {
  const { getBroadcastResultLevel } = createMultimodalHarness();

  assert.equal(getBroadcastResultLevel([{ status: 'success' }, { status: 'error' }]), 'error');
  assert.equal(getBroadcastResultLevel([{ status: 'partial' }, { status: 'error' }]), 'error');
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

test('an inactive recorder drains its final data event before host cleanup', () => {
  const { getRecordingStopAction } = createMultimodalHarness();

  assert.equal(typeof getRecordingStopAction, 'function');
  assert.equal(getRecordingStopAction({ state: 'recording' }), 'stop');
  assert.equal(getRecordingStopAction({ state: 'inactive' }), 'draining');
  assert.equal(getRecordingStopAction(null), 'cleanup');
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
