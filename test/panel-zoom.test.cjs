const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const renderer = fs.readFileSync(path.join(root, 'src/renderer.js'), 'utf8');

const zoomSourceStart = renderer.indexOf('const PANEL_ZOOM =');
const zoomSourceEnd = renderer.indexOf('const buildChatGPTScript =');

const createZoomHarness = () => {
  assert.notEqual(zoomSourceStart, -1, 'PANEL_ZOOM configuration is missing');
  assert.notEqual(zoomSourceEnd, -1, 'adapter boundary is missing');
  const source = renderer.slice(zoomSourceStart, renderer.indexOf('const LEGACY_STORAGE_KEYS ='));
  return new Function(`${source}\nreturn { PANEL_LOAD_STATES, PANEL_ZOOM, advancePanelLoadState, clampPanelZoom, getAutomaticPanelZoom, shouldRunPanelReadyEffects, updatePanelLoadState };`)();
};

test('automatic panel zoom clamps factors and adapts to layout density', () => {
  const {
    PANEL_ZOOM,
    clampPanelZoom,
    getAutomaticPanelZoom,
  } = createZoomHarness();

  assert.equal(PANEL_ZOOM.defaultFactor, 1);
  assert.equal(clampPanelZoom('invalid'), 1);
  assert.equal(clampPanelZoom(0.62), 0.7);
  assert.equal(clampPanelZoom(1.42), 1.3);
  assert.equal(getAutomaticPanelZoom('single'), 1);
  assert.equal(getAutomaticPanelZoom('triple'), 0.9);
});

test('layout presets keep the selected grid shape aligned with its visible panel count', () => {
  const start = renderer.indexOf('const LAYOUT_PRESETS =');
  const end = renderer.indexOf('const storedCustomModels =');
  assert.notEqual(start, -1, 'layout presets are missing');
  assert.notEqual(end, -1, 'layout preset boundary is missing');
  const { LAYOUT_PRESETS, normalizeLayoutPreset } = new Function(`${renderer.slice(start, end)}\nreturn { LAYOUT_PRESETS, normalizeLayoutPreset };`)();

  assert.deepEqual(
    Object.fromEntries(Object.entries(LAYOUT_PRESETS).map(([id, preset]) => [id, [preset.count, preset.columns, preset.rows || null]])),
    {
      single: [1, '1fr', null],
      dual: [2, 'repeat(2, 1fr)', null],
      triple: [3, 'repeat(3, 1fr)', null],
      quad: [4, 'repeat(2, 1fr)', 'repeat(2, minmax(0, 1fr))'],
    },
  );
  assert.equal(normalizeLayoutPreset('missing').id, 'dual');
});

test('layout selection synchronizes expanded and collapsed buttons through the same state path', () => {
  const controlsStart = renderer.indexOf('function synchronizeLayoutControls');
  const controlsEnd = renderer.indexOf('const storedCustomModels =');
  const selectLayoutStart = renderer.indexOf('function selectLayout');
  const selectLayoutEnd = renderer.indexOf('layoutButtons.forEach');
  const controls = renderer.slice(controlsStart, controlsEnd);
  const selectLayout = renderer.slice(selectLayoutStart, selectLayoutEnd);

  assert.notEqual(selectLayoutStart, -1, 'layout selection is missing');
  assert.match(controls, /\[\.\.\.layoutButtons, \.\.\.collapsedLayoutButtons\]\.forEach/);
  assert.match(controls, /button\.setAttribute\("aria-pressed", String\(isActive\)\)/);
  assert.match(controls, /button\.classList\.toggle\("is-active", isActive\)/);
  assert.match(selectLayout, /synchronizeLayoutControls\(preset\.id\)/);
  assert.match(selectLayout, /setPanelsLayoutGeometry\(preset\)/);
  assert.match(selectLayout, /ensurePanelCount\(preset\.count\)/);
});

test('layout reconciliation detects a count, index, or visual-order mismatch instead of silently rendering it', () => {
  const invariantStart = renderer.indexOf('function getLayoutInvariantViolation');
  const invariantEnd = renderer.indexOf('const storedCustomModels =');
  const reconciliationStart = renderer.indexOf('function reconcileActivePanelsToModelOrder');
  const reconciliationEnd = renderer.indexOf('function ensurePanelCount');
  const invariant = renderer.slice(invariantStart, invariantEnd);
  const reconciliation = renderer.slice(reconciliationStart, reconciliationEnd);

  assert.notEqual(invariantStart, -1, 'layout invariant helper is missing');
  assert.match(invariant, /active-panel-count/);
  assert.match(invariant, /missing-panel-index/);
  assert.match(invariant, /duplicate-panel-index/);
  assert.match(invariant, /visible-panel-count/);
  assert.match(invariant, /visible-panel-order/);
  assert.match(reconciliation, /getLayoutInvariantViolation\(\{/);
  assert.match(reconciliation, /panelState\.root\.hidden/);
  assert.match(reconciliation, /\[layout\] invariant violation/);
});

test('parked panels are explicitly removed from the grid while retaining their connected webviews', () => {
  const styles = fs.readFileSync(path.join(root, 'src/styles.css'), 'utf8');

  assert.match(styles, /\.panel\[hidden\]\s*\{\s*display:\s*none\s*!important/);
  assert.match(renderer, /removed\.root\.hidden = true/);
  assert.match(renderer, /if \(!panelState\.root\.isConnected\) \{\s*panelsContainer\.appendChild\(panelState\.root\)/);
});

test('automatic zoom updates both visible and parked panels for the next layout activation', () => {
  assert.match(renderer, /function syncAutomaticPanelZoom\(\) \{\s*\[\.\.\.panels, \.\.\.parkedPanels\]\.forEach/);
});

test('embedded webpages have no Qask panel header and webview zoom is applied after dom-ready', () => {
  const styles = fs.readFileSync(path.join(root, 'src/styles.css'), 'utf8');
  const userGuide = fs.readFileSync(path.join(root, 'docs/user-guide.md'), 'utf8');

  assert.doesNotMatch(renderer, /className = "panel-actions"/);
  assert.doesNotMatch(renderer, /刷新此网页/);
  assert.doesNotMatch(renderer, /缩小网页/);
  assert.doesNotMatch(renderer, /放大网页/);
  assert.doesNotMatch(renderer, /网页缩放/);
  assert.doesNotMatch(renderer, /model-select/);
  assert.doesNotMatch(renderer, /document\.createElement\("select"\)/);
  assert.doesNotMatch(renderer, /panel-model-label/);
  assert.doesNotMatch(renderer, /panel-header/);
  assert.doesNotMatch(styles, /\.panel-actions|\.panel-zoom-controls|\.panel-action-button|\.panel-zoom-readout/);
  assert.doesNotMatch(styles, /\.panel-header|\.panel-model-label/);
  assert.doesNotMatch(userGuide, /刷新图标和缩放控件/);
  assert.doesNotMatch(userGuide, /每个面板顶部只显示当前模型名称/);
  assert.match(renderer, /webview\.addEventListener\("dom-ready", \(\) => \{[\s\S]*applyPanelZoom\(panelState\)/);
  assert.match(renderer, /const currentUrl = webview\.getURL\?\.\(\) \|\| "";[\s\S]*?if \(!isTrustedGuestUrl\(currentUrl, config\.allowedOrigins \|\| \[\]\)\) \{[\s\S]*?return;/);
  assert.doesNotMatch(styles, /\.panels-container\s*\{[\s\S]*?transition:\s*grid-template-columns/);
});

test('failed main-frame loads leave controls unavailable until the next successful readiness event', () => {
  const { PANEL_LOAD_STATES, advancePanelLoadState, shouldRunPanelReadyEffects, updatePanelLoadState } = createZoomHarness();
  const panelState = { loadState: PANEL_LOAD_STATES.loading, ready: false };

  assert.equal(updatePanelLoadState(panelState, 'fail'), false);
  assert.equal(panelState.loadState, PANEL_LOAD_STATES.failed);
  assert.equal(updatePanelLoadState(panelState, 'ready'), false, 'the error document must not re-enable a failed panel');
  assert.equal(panelState.ready, false);
  assert.equal(advancePanelLoadState(panelState.loadState, 'start'), PANEL_LOAD_STATES.loading);
  assert.equal(updatePanelLoadState(panelState, 'start'), false);
  assert.equal(updatePanelLoadState(panelState, 'ready'), true, 'a later navigation can recover normally');
  assert.equal(panelState.loadState, PANEL_LOAD_STATES.ready);
  assert.equal(shouldRunPanelReadyEffects(PANEL_LOAD_STATES.failed, PANEL_LOAD_STATES.failed), false);
  assert.equal(shouldRunPanelReadyEffects(PANEL_LOAD_STATES.loading, PANEL_LOAD_STATES.ready), true);

  assert.match(renderer, /did-fail-load", \(event\) => \{[\s\S]*if \(!event\.isMainFrame\) return;[\s\S]*updatePanelLoadState\(panelState, "fail"\)/);
  assert.match(renderer, /const previousLoadState = panelState\.loadState;[\s\S]*updatePanelLoadState\(panelState, "ready"\);[\s\S]*shouldRunPanelReadyEffects\(previousLoadState, panelState\.loadState\)/);
  assert.doesNotMatch(renderer, /did-stop-loading", \(\) => \{[\s\S]*?panelState\.ready = true/);
});

test('ordinary webview loading activity does not revoke a ready panel between conversation turns', () => {
  const lifecycleStart = renderer.indexOf('webview.addEventListener("did-start-loading"');
  const lifecycleEnd = renderer.indexOf('webview.addEventListener("did-finish-load"');
  const lifecycle = renderer.slice(lifecycleStart, lifecycleEnd);

  assert.notEqual(lifecycleStart, -1, 'did-start-loading listener is missing');
  assert.doesNotMatch(lifecycle, /updatePanelLoadState\(panelState, "start"\)/);
  const navigationStart = renderer.indexOf('webview.addEventListener("did-start-navigation"');
  const navigationEnd = renderer.indexOf('webview.addEventListener("did-start-loading"');
  const navigation = renderer.slice(navigationStart, navigationEnd);
  assert.match(navigation, /event\.isMainFrame/);
  assert.match(navigation, /event\.isInPlace/);
  assert.match(navigation, /updatePanelLoadState\(panelState, "start"\)/);
});

test('cancelled or stale navigation failures do not permanently fail a ready panel', () => {
  const failureStart = renderer.indexOf('webview.addEventListener("did-fail-load"');
  const failureEnd = renderer.indexOf('swapWebview(panelState, webview);');
  const failure = renderer.slice(failureStart, failureEnd);

  assert.notEqual(failureStart, -1, 'did-fail-load listener is missing');
  assert.match(failure, /event\.errorCode === -3/);
  assert.match(failure, /if \(panelState\.loadState !== PANEL_LOAD_STATES\.loading\) return;/);
  assert.match(failure, /updatePanelLoadState\(panelState, "fail"\)/);
});
