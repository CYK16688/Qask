const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const renderer = fs.readFileSync(path.join(root, 'src', 'renderer.js'), 'utf8');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const indexHtml = fs.readFileSync(path.join(root, 'src', 'index.html'), 'utf8');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
const userGuide = fs.readFileSync(path.join(root, 'docs', 'user-guide.md'), 'utf8');

const createComparisonHarness = () => {
  const start = renderer.indexOf('const RESPONSE_SELECTORS =');
  const end = renderer.indexOf('async function extractPanelAnswer');
  assert.ok(start >= 0 && end > start, 'comparison extraction helpers are missing');
  const source = renderer.slice(start, end);
  const factory = new Function(`${source}\nreturn {
    RESPONSE_SELECTORS,
    buildExtractAnswerScript,
    getSynchronizedScrollTop,
    buildDifferenceSummaryPrompt,
  };`);
  return factory();
};

const createElement = (text, { visible = true, selector = '' } = {}) => ({
  innerText: text,
  selector,
  getClientRects: () => (visible ? [{ width: 400, height: 40 }] : []),
  getBoundingClientRect: () => ({ width: visible ? 400 : 0, height: visible ? 40 : 0 }),
  closest: () => null,
  compareDocumentPosition: () => 4,
});

test('the answer extraction script only reads and parses for every provider', () => {
  const { buildExtractAnswerScript, RESPONSE_SELECTORS } = createComparisonHarness();

  assert.ok(Object.keys(RESPONSE_SELECTORS).length >= 7);
  for (const modelId of ['chatgpt', 'gemini', 'doubao', 'claude', 'copilot', 'deepseek', 'kimi', 'custom-site']) {
    const script = buildExtractAnswerScript(modelId);
    assert.equal(typeof script, 'string');
    assert.doesNotThrow(() => new Function(script), modelId);
    assert.match(script, /innerText/);
    // Extraction is read-only: it must not click, type, or dispatch events.
    assert.doesNotMatch(script, /\.click\(|dispatchEvent|\.value\s*=|insertText/);
  }
});

test('answer extraction picks the last visible assistant answer and ignores the composer and sidebar', () => {
  const { buildExtractAnswerScript } = createComparisonHarness();
  const answerOne = createElement('第一条回答：先给结论 A。');
  const answerTwo = createElement('第二条回答：先给结论 B，并补充了数据。');
  const userMessage = createElement('用户提问内容');
  const composer = createElement('composer draft');
  const sidebar = createElement('sidebar item');
  const hiddenAnswer = createElement('隐藏回答', { visible: false });
  const nodesBySelector = {
    '[data-message-author-role="assistant"]': [answerOne, answerTwo, hiddenAnswer],
    'textarea': [],
    'input': [],
    '[contenteditable="true"]': [],
  };
  const document = {
    querySelectorAll(selector) {
      return nodesBySelector[selector] || [];
    },
  };
  // The generic fallback is not reached because provider selectors match.
  const script = buildExtractAnswerScript('chatgpt');
  const result = new Function('document', 'Node', `return ${script}`)(document, { DOCUMENT_POSITION_FOLLOWING: 4 });

  assert.equal(result.ok, true);
  assert.match(result.text, /第二条回答/);
  assert.doesNotMatch(result.text, /用户提问|composer|sidebar|隐藏回答/);
  assert.ok(![userMessage, composer, sidebar].some((node) => result.text.includes(node.innerText)));
});

test('answer extraction falls back to generic assistant/markdown containers', () => {
  const { buildExtractAnswerScript } = createComparisonHarness();
  const genericAnswer = createElement('通用容器里的最后一条回答，长度足够被选中。');
  const document = {
    querySelectorAll(selector) {
      if (selector.includes('markdown')) return [genericAnswer];
      return [];
    },
  };
  const result = new Function('document', 'Node', `return ${buildExtractAnswerScript('custom-site')}`)(
    document,
    { DOCUMENT_POSITION_FOLLOWING: 4 },
  );
  assert.equal(result.ok, true);
  assert.match(result.text, /通用容器/);
});

test('synchronized scrolling maps the source ratio to each target pane', () => {
  const { getSynchronizedScrollTop } = createComparisonHarness();

  assert.equal(getSynchronizedScrollTop(0, 1000, 200, 800, 200), 0);
  assert.equal(getSynchronizedScrollTop(800, 1000, 200, 800, 200), 600);
  assert.equal(getSynchronizedScrollTop(400, 1000, 200, 800, 200), 300);
  // No scrollable source or target is a no-op.
  assert.equal(getSynchronizedScrollTop(10, 200, 200, 900, 300), 0);
  assert.equal(getSynchronizedScrollTop(10, 1000, 200, 300, 300), 0);
  // Ratios are clamped even if a browser reports an overscrolled value.
  assert.equal(getSynchronizedScrollTop(99999, 1000, 200, 800, 200), 600);
});

test('the difference prompt includes each answer and demands a structured summary', () => {
  const { buildDifferenceSummaryPrompt } = createComparisonHarness();
  const answers = [
    { ok: true, label: '豆包', text: '豆包回答：杭州今天多云。' },
    { ok: true, label: 'Kimi', text: 'Kimi 回答：杭州今天有阵雨。' },
  ];
  const prompt = buildDifferenceSummaryPrompt(answers, '杭州天气怎么样？');

  assert.match(prompt, /豆包/);
  assert.match(prompt, /Kimi/);
  assert.match(prompt, /杭州天气怎么样/);
  assert.match(prompt, /共识/);
  assert.match(prompt, /关键差异/);
  assert.match(prompt, /各自优劣/);
  assert.match(prompt, /一句结论/);
  // Fewer than two usable answers cannot produce a comparison.
  assert.equal(buildDifferenceSummaryPrompt([answers[0]], '问题'), null);
  assert.equal(buildDifferenceSummaryPrompt([{ ok: false, label: 'x', text: '' }, answers[1]], '问题'), null);
});

test('the comparison view is live, read-only, and has no local save/export path', () => {
  assert.match(indexHtml, /id="comparisonRefresh"[^>]*>刷新回答/);
  assert.match(indexHtml, /id="comparisonSyncScroll"[^>]*checked/);
  assert.match(indexHtml, /id="comparisonSummarizer"/);
  assert.match(indexHtml, /id="comparisonSummarize"[^>]*>AI 总结差异/);
  assert.match(indexHtml, /id="comparisonAnswers"[^>]*aria-label="各模型回答"/);
  assert.match(indexHtml, /id="comparisonSummary"/);

  assert.match(renderer, /function buildExtractAnswerScript\(modelId\)/);
  assert.match(renderer, /function getSynchronizedScrollTop\(/);
  assert.match(renderer, /function buildDifferenceSummaryPrompt\(/);
  assert.match(renderer, /function refreshComparisonAnswers\(/);
  assert.match(renderer, /function summarizeComparisonDifferences\(/);
  assert.match(renderer, /comparisonSyncScroll\?\.checked/);
  assert.match(renderer, /window\.confirm\(/);
  assert.match(renderer, /COMPARISON_REFRESH_INTERVAL_MS = 4000/);

  // The old manual-paste/local-store design is gone end to end.
  assert.doesNotMatch(renderer, /comparisonSaveAnswers|saveComparisonState|loadComparisonState|recordComparisonRound/);
  assert.doesNotMatch(renderer, /window\.qask\?\.comparison/);
  assert.doesNotMatch(main, /comparison:(load|save|export)|comparison\.json/);
  assert.doesNotMatch(preload, /comparison:/);
  assert.doesNotMatch(readme, /comparison log|人工粘贴|保存并导出 Markdown/);
  assert.match(readme, /Live answer comparison/);
  assert.match(userGuide, /同步滚动/);
  assert.match(userGuide, /AI 总结差异/);
});
