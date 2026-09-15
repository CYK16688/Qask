const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const renderer = fs.readFileSync(path.join(root, 'src/renderer.js'), 'utf8');

const createOrderHarness = () => {
  const start = renderer.indexOf('function normalizeModelOrder');
  const end = renderer.indexOf('function clampPanelZoom');
  assert.notEqual(start, -1, 'model order helpers are missing');
  assert.notEqual(end, -1, 'model order helper boundary is missing');
  return new Function(`${renderer.slice(start, end)}\nreturn { getAdjustedDropTargetIndex, getPanelPlacementPlan, getPanelPoolPlacement, getRankedModelIds, moveModelOrder, normalizeModelOrder };`)();
};

test('model order normalizes persisted IDs and appends available sites once', () => {
  const { normalizeModelOrder } = createOrderHarness();
  const available = ['chatgpt', 'gemini', 'doubao', 'claude'];

  assert.deepEqual(
    normalizeModelOrder(['claude', 'unknown', 'chatgpt', 'claude', null], available),
    ['claude', 'chatgpt', 'gemini', 'doubao'],
  );
  assert.deepEqual(normalizeModelOrder(null, available), available);
});

test('moving a ranked website changes only its canonical position', () => {
  const { moveModelOrder } = createOrderHarness();
  const order = ['chatgpt', 'gemini', 'doubao', 'claude'];

  assert.deepEqual(moveModelOrder(order, 'claude', 0), ['claude', 'chatgpt', 'gemini', 'doubao']);
  assert.deepEqual(moveModelOrder(order, 'gemini', 3), ['chatgpt', 'doubao', 'claude', 'gemini']);
  assert.deepEqual(moveModelOrder(order, 'missing', 0), order);
  assert.deepEqual(order, ['chatgpt', 'gemini', 'doubao', 'claude']);
});

test('dropping after a lower row accounts for removal before insertion', () => {
  const { getAdjustedDropTargetIndex, moveModelOrder } = createOrderHarness();
  const order = ['chatgpt', 'gemini', 'doubao', 'claude'];

  const afterClaude = getAdjustedDropTargetIndex(order, 'gemini', 4);
  assert.equal(afterClaude, 3);
  assert.deepEqual(moveModelOrder(order, 'gemini', afterClaude), ['chatgpt', 'doubao', 'claude', 'gemini']);

  const beforeChatGPT = getAdjustedDropTargetIndex(order, 'claude', 0);
  assert.equal(beforeChatGPT, 0);
  assert.deepEqual(moveModelOrder(order, 'claude', beforeChatGPT), ['claude', 'chatgpt', 'gemini', 'doubao']);
});

test('placement moves existing panel roots and uses only a dropped slot for a new ranked site', () => {
  const { getPanelPlacementPlan } = createOrderHarness();

  assert.deepEqual(
    getPanelPlacementPlan(['chatgpt', 'gemini', 'doubao'], ['gemini', 'chatgpt', 'doubao'], 3),
    [
      { action: 'move', index: 0, modelId: 'gemini', sourceIndex: 1, panelIndex: 1 },
      { action: 'move', index: 1, modelId: 'chatgpt', sourceIndex: 0, panelIndex: 0 },
      { action: 'keep', index: 2, modelId: 'doubao', sourceIndex: 2, panelIndex: 2 },
    ],
  );

  assert.deepEqual(
    getPanelPlacementPlan(['chatgpt', 'gemini', 'doubao'], ['kimi', 'chatgpt', 'gemini'], 3),
    [
      { action: 'load', index: 0, modelId: 'kimi', panelIndex: 2 },
      { action: 'move', index: 1, modelId: 'chatgpt', sourceIndex: 0, panelIndex: 0 },
      { action: 'move', index: 2, modelId: 'gemini', sourceIndex: 1, panelIndex: 1 },
    ],
  );
});

test('shrinking a layout preserves existing panel assignments for later expansion', () => {
  const { getPanelPlacementPlan } = createOrderHarness();

  assert.deepEqual(
    getPanelPlacementPlan(['chatgpt', 'gemini', 'doubao', 'claude'], ['chatgpt', 'gemini', 'doubao', 'claude'], 2),
    [
      { action: 'keep', index: 0, modelId: 'chatgpt', sourceIndex: 0, panelIndex: 0 },
      { action: 'keep', index: 1, modelId: 'gemini', sourceIndex: 1, panelIndex: 1 },
    ],
  );
});

test('panel pool reactivates a parked matching website before replacing a guest', () => {
  const { getPanelPoolPlacement } = createOrderHarness();

  assert.deepEqual(
    getPanelPoolPlacement(
      ['chatgpt', 'gemini', 'doubao', 'claude'],
      ['claude', 'chatgpt', 'gemini', 'doubao'],
      2,
    ),
    {
      activePanelIndexes: [3, 0],
      parkedPanelIndexes: [1, 2],
      plan: [
        { action: 'move', index: 0, modelId: 'claude', sourceIndex: 3, panelIndex: 3 },
        { action: 'move', index: 1, modelId: 'chatgpt', sourceIndex: 0, panelIndex: 0 },
      ],
    },
  );
});

test('panel pool replaces a parked slot only when the ranked website has never loaded', () => {
  const { getPanelPoolPlacement } = createOrderHarness();

  assert.deepEqual(
    getPanelPoolPlacement(
      ['chatgpt', 'gemini', 'doubao', 'claude'],
      ['kimi', 'chatgpt', 'gemini', 'doubao'],
      3,
    ),
    {
      activePanelIndexes: [3, 0, 1],
      parkedPanelIndexes: [2],
      plan: [
        { action: 'load', index: 0, modelId: 'kimi', panelIndex: 3 },
        { action: 'move', index: 1, modelId: 'chatgpt', sourceIndex: 0, panelIndex: 0 },
        { action: 'move', index: 2, modelId: 'gemini', sourceIndex: 1, panelIndex: 1 },
      ],
    },
  );
});

test('panel pool keeps its earliest parked slot when a new website enters the ranking', () => {
  const { getPanelPoolPlacement } = createOrderHarness();

  assert.deepEqual(
    getPanelPoolPlacement(
      ['chatgpt', 'gemini', 'doubao', 'claude'],
      ['kimi', 'chatgpt'],
      2,
    ),
    {
      activePanelIndexes: [2, 0],
      parkedPanelIndexes: [1, 3],
      plan: [
        { action: 'load', index: 0, modelId: 'kimi', panelIndex: 2 },
        { action: 'move', index: 1, modelId: 'chatgpt', sourceIndex: 0, panelIndex: 0 },
      ],
    },
  );
});

test('panel pool uses an empty slot before evicting a parked website', () => {
  const { getPanelPoolPlacement } = createOrderHarness();

  assert.deepEqual(
    getPanelPoolPlacement(
      ['chatgpt', null, 'doubao', 'claude'],
      ['kimi', 'chatgpt'],
      2,
    ),
    {
      activePanelIndexes: [1, 0],
      parkedPanelIndexes: [2, 3],
      plan: [
        { action: 'load', index: 0, modelId: 'kimi', panelIndex: 1 },
        { action: 'move', index: 1, modelId: 'chatgpt', sourceIndex: 0, panelIndex: 0 },
      ],
    },
  );
});

test('panel pool assigns distinct slots when a selected layout has more panels than ranked websites', () => {
  const { getPanelPoolPlacement } = createOrderHarness();

  assert.deepEqual(
    getPanelPoolPlacement([null, null], ['chatgpt'], 2),
    {
      activePanelIndexes: [0, 1],
      parkedPanelIndexes: [],
      plan: [
        { action: 'load', index: 0, modelId: 'chatgpt', panelIndex: 0 },
        { action: 'clear', index: 1, modelId: null, panelIndex: 1 },
      ],
    },
  );
});

test('panel pool reserves a unique visible slot for every selected layout position', () => {
  const { getPanelPoolPlacement } = createOrderHarness();

  for (const [currentIds, order, count] of [
    [['chatgpt', 'gemini', 'doubao', 'claude'], ['chatgpt', 'gemini', 'doubao', 'claude'], 1],
    [['chatgpt', 'gemini', 'doubao', 'claude'], ['claude', 'chatgpt', 'gemini', 'doubao'], 2],
    [['chatgpt', 'gemini', 'doubao', 'claude'], ['doubao', 'claude', 'chatgpt', 'gemini'], 3],
    [[null, null, null, null], ['chatgpt', 'gemini', 'doubao', 'claude'], 4],
  ]) {
    const placement = getPanelPoolPlacement(currentIds, order, count);
    assert.equal(placement.activePanelIndexes.length, count);
    assert.equal(new Set(placement.activePanelIndexes).size, count);
    assert.equal(placement.plan.length, count);
    assert.deepEqual(placement.plan.map(({ index }) => index), Array.from({ length: count }, (_, index) => index));
  }
});

test('rank order drives active panel reconciliation rather than stale slot selection', () => {
  const reconciliationStart = renderer.indexOf('function reconcileActivePanelsToModelOrder');
  const reconciliationEnd = renderer.indexOf('function ensurePanelCount');
  const reconciliation = renderer.slice(reconciliationStart, reconciliationEnd);

  assert.match(renderer, /modelOrder: "qask\.modelOrder"/);
  assert.match(renderer, /function reconcileActivePanelsToModelOrder\(/);
  assert.match(renderer, /function getPanelPoolPlacement\(/);
  assert.doesNotMatch(renderer, /getPanelReconciliationPlan/);
  assert.match(renderer, /loadModel\(panelState, modelId\)/);
  assert.match(renderer, /const placement = getPanelPoolPlacement\(/);
  assert.match(renderer, /panels\.splice\(0, panels\.length, \.\.\.orderedPanels\)/);
  assert.match(renderer, /parkedPanels\.splice\(0, parkedPanels\.length, \.\.\.orderedParkedPanels\)/);
  assert.match(reconciliation, /panelState\.root\.style\.order = String\(index\)/);
  assert.match(reconciliation, /panelState\.root\.dataset\.panelRank = String\(index\)/);
  assert.match(reconciliation, /panelState\.root\.dataset\.panelModelId = panelState\.modelId \|\| ""/);
  assert.doesNotMatch(reconciliation, /panelsContainer\.appendChild\(panelState\.root\)/);
  const ensurePanelCountStart = renderer.indexOf('function ensurePanelCount');
  const ensurePanelCountEnd = renderer.indexOf('function getPanelLabel');
  const ensurePanelCount = renderer.slice(ensurePanelCountStart, ensurePanelCountEnd);
  assert.match(ensurePanelCount, /while \(panels\.length < count\)/);
  assert.match(renderer, /const parkedPanels = \[\];/);
  assert.match(ensurePanelCount, /const panelState = parkedPanels\.pop\(\) \|\| createPanel\(panels\.length\);/);
  assert.match(ensurePanelCount, /removed\.root\.hidden = true;[\s\S]*?parkedPanels\.push\(removed\);/);
  assert.match(renderer, /\[\.\.\.panels, \.\.\.parkedPanels\]\.forEach\(\(panelState\) => \{/);
  assert.match(renderer, /function createDispatchCoordinator\(\) \{[\s\S]*?const inFlight = new WeakMap\(\)/);
  assert.doesNotMatch(renderer, /DEFAULT_MODEL_SEQUENCE/);
  assert.match(renderer, /modelOrder = normalizeModelOrder\(persistedModelOrder, Array\.from\(modelRegistry\.keys\(\)\)\)/);
});

test('sidebar exposes drag-only ordering and highlights the ranked active windows', () => {
  assert.match(renderer, /dragHandle\.draggable = true/);
  assert.match(renderer, /application\/x-qask-model-id/);
  assert.match(renderer, /modelList\.addEventListener\("dragover"/);
  assert.match(renderer, /modelList\.addEventListener\("drop"/);
  assert.match(renderer, /modelId !== draggedModelId/);
  assert.match(renderer, /getAdjustedDropTargetIndex\(modelOrder, modelId, targetIndex\)/);
  assert.match(renderer, /const activeModelIds = new Set\(getRankedModelIds\(modelOrder, activePanelCount\)\)/);
  assert.match(renderer, /item\.classList\.toggle\("is-active", activeModelIds\.has\(model\.id\)\)/);
  assert.doesNotMatch(renderer, /ArrowUp ArrowDown/);
  assert.doesNotMatch(renderer, /function moveModelByOffset/);
  assert.match(renderer, /已将 \$\{label\} 调整为第 \$\{rank\} 位/);
});

test('keyboard pickup retains focus on the recreated drag handle', () => {
  assert.match(renderer, /const selectedHandle = modelList\.querySelector\(`\[data-model-id="\$\{model\.id\}"\] \.model-drag-handle`\)/);
  assert.match(renderer, /selectedHandle\?\.focus\(\)/);
});

test('keyboard drag can be cancelled even after focus leaves its handle', () => {
  assert.match(renderer, /event\.key === 'Escape' && keyboardDraggedModelId/);
  assert.match(renderer, /cancelKeyboardModelDrag\(\);/);
});

test('active panel membership cannot bypass ranked drag ordering', () => {
  const createPanelStart = renderer.indexOf('function createPanel');
  const createPanelEnd = renderer.indexOf('function applyPanelZoom');
  const createPanelSource = renderer.slice(createPanelStart, createPanelEnd);

  assert.notEqual(createPanelStart, -1, 'panel creation is missing');
  assert.notEqual(createPanelEnd, -1, 'panel creation boundary is missing');
  assert.doesNotMatch(createPanelSource, /document\.createElement\("select"\)/);
  assert.doesNotMatch(createPanelSource, /panel-header|panel-model-label/);
  assert.doesNotMatch(createPanelSource, /addEventListener\("change"/);
  assert.doesNotMatch(createPanelSource, /loadModel\(panelState, modelId\)/);
});

test('active website highlighting uses color only, without a status label', () => {
  const styles = fs.readFileSync(path.join(root, 'src/styles.css'), 'utf8');
  const userGuide = fs.readFileSync(path.join(root, 'docs/user-guide.md'), 'utf8');

  assert.match(styles, /\.model-list li\.is-active \{/);
  assert.doesNotMatch(styles, /\.model-list li\.is-active \.model-list-label::after/);
  assert.doesNotMatch(styles, /content:\s*["']使用中["']/);
  assert.doesNotMatch(userGuide, /“使用中”标记/);
});
