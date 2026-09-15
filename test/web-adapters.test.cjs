const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const renderer = fs.readFileSync(path.join(root, 'src/renderer.js'), 'utf8');

const adapterNames = [
  'buildChatGPTScript',
  'buildGeminiScript',
  'buildDoubaoScript',
  'buildClaudeScript',
  'buildCopilotScript',
  'buildDeepSeekScript',
  'buildKimiScript',
  'buildGenericScript',
];

const createAdapterHarness = () => {
  const start = renderer.indexOf('const escapeForScript =');
  const end = renderer.indexOf('const DEFAULT_MODELS =');
  const source = renderer.slice(start, end);
  const factory = new Function(`${source}\nreturn { ${adapterNames.join(', ')}, buildOriginGuardedScript: typeof buildOriginGuardedScript === 'function' ? buildOriginGuardedScript : null };`);
  return factory();
};

const renderedScript = (adapter, attachments = attachmentManifest) => {
  const script = adapter('test message', true, attachments);
  assert.equal(typeof script, 'string');
  assert.doesNotThrow(() => new Function(script));
  return script;
};

const runGeneratedScript = (script, globals) => {
  const invoke = new Function(
    'document',
    'window',
    'location',
    'HTMLTextAreaElement',
    'HTMLInputElement',
    'InputEvent',
    'Event',
    'KeyboardEvent',
    'DataTransfer',
    'ClipboardEvent',
    'File',
    'fetch',
    'setTimeout',
    `return ${script};`,
  );
  return invoke(
    globals.document,
    globals.window,
    globals.location || { origin: 'https://test.provider' },
    globals.HTMLTextAreaElement,
    globals.HTMLInputElement,
    globals.InputEvent,
    globals.Event,
    globals.KeyboardEvent,
    globals.DataTransfer,
    globals.ClipboardEvent,
    globals.File,
    globals.fetch,
    globals.setTimeout,
  );
};

class TestEvent {
  constructor(type, init = {}) {
    this.type = type;
    Object.assign(this, init);
  }
}

class TestKeyboardEvent extends TestEvent {}

const createEditable = () => ({
  closest: () => null,
  events: [],
  focus() {},
  dispatchEvent(event) {
    this.events.push(event);
    return true;
  },
});

const createSelection = () => ({
  addRange() {},
  removeAllRanges() {},
});


test('text-only adapter wrapper refuses a redirect before it can touch the guest DOM', async () => {
  const { buildOriginGuardedScript } = createAdapterHarness();
  assert.equal(typeof buildOriginGuardedScript, 'function');

  const script = buildOriginGuardedScript(
    `(async () => { document.querySelector('textarea'); return { success: true, autoSent: true }; })()`,
    ['https://trusted.provider'],
  );
  const result = await runGeneratedScript(script, {
    document: { querySelector: () => { throw new Error('redirected page must not be queried'); } },
    window: {},
    location: { origin: 'https://redirected.example' },
    HTMLTextAreaElement: class {},
    HTMLInputElement: class {},
    InputEvent: undefined,
    Event: TestEvent,
    KeyboardEvent: TestKeyboardEvent,
    DataTransfer: undefined,
    ClipboardEvent: undefined,
    File: undefined,
    fetch: undefined,
    setTimeout: (resolve) => resolve(),
  });

  assert.equal(result.success, false);
  assert.match(result.reason, /未验证来源/);
});

test('origin guards use direct comparisons rather than page-overridable Array methods', async () => {
  const { buildGenericScript, buildOriginGuardedScript } = createAdapterHarness();
  const script = buildOriginGuardedScript(
    buildGenericScript('sensitive message', false, []),
    ['https://trusted.provider'],
  );
  const originalIncludes = Array.prototype.includes;
  const originalSome = Array.prototype.some;
  const originalMap = Array.prototype.map;
  let queried = false;
  Array.prototype.includes = () => true;
  Array.prototype.some = () => true;
  Array.prototype.map = () => ['true'];
  try {
    const result = await runGeneratedScript(script, {
      document: {
        querySelector() {
          queried = true;
          throw new Error('redirected page must not be queried');
        },
      },
      window: { getSelection: createSelection },
      location: { origin: 'https://redirected.example' },
      HTMLTextAreaElement: class {},
      HTMLInputElement: class {},
      InputEvent: undefined,
      Event: TestEvent,
      KeyboardEvent: TestKeyboardEvent,
      DataTransfer: undefined,
      ClipboardEvent: undefined,
      File: undefined,
      fetch: undefined,
      setTimeout: (resolve) => resolve(),
    });

    assert.equal(result.success, false);
    assert.equal(queried, false);
  } finally {
    Array.prototype.includes = originalIncludes;
    Array.prototype.some = originalSome;
    Array.prototype.map = originalMap;
  }
});

test('text-only adapter wrapper rejects a navigation that completes while an async adapter is running', async () => {
  const { buildOriginGuardedScript } = createAdapterHarness();
  const location = { origin: 'https://trusted.provider' };
  const script = buildOriginGuardedScript(
    `(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); return { success: true, autoSent: true }; })()`,
    ['https://trusted.provider'],
  );
  const result = await runGeneratedScript(script, {
    document: {},
    window: {},
    location,
    HTMLTextAreaElement: class {},
    HTMLInputElement: class {},
    InputEvent: undefined,
    Event: TestEvent,
    KeyboardEvent: TestKeyboardEvent,
    DataTransfer: undefined,
    ClipboardEvent: undefined,
    File: undefined,
    fetch: undefined,
    setTimeout: (resolve) => {
      location.origin = 'https://redirected.example';
      resolve();
    },
  });

  assert.equal(result.success, false);
  assert.match(result.reason, /未验证来源/);
});

test('a wrapped provider adapter checks the origin again before its delayed send action', async () => {
  const { buildChatGPTScript, buildOriginGuardedScript } = createAdapterHarness();
  const location = { origin: 'https://trusted.provider' };
  const target = createEditable();
  class TestTextAreaElement {}
  Object.defineProperty(TestTextAreaElement.prototype, 'value', { set() {} });
  target.closest = () => ({
    querySelector: () => ({
      click() {
        throw new Error('redirected page must not receive a send click');
      },
    }),
  });
  const script = buildOriginGuardedScript(
    buildChatGPTScript('test message', true, []),
    ['https://trusted.provider'],
  );
  const result = await runGeneratedScript(script, {
    document: {
      querySelector: () => target,
      dispatchEvent() {},
    },
    window: { HTMLTextAreaElement: TestTextAreaElement },
    location,
    HTMLTextAreaElement: TestTextAreaElement,
    HTMLInputElement: class {},
    InputEvent: undefined,
    Event: TestEvent,
    KeyboardEvent: TestKeyboardEvent,
    DataTransfer: undefined,
    ClipboardEvent: undefined,
    File: undefined,
    fetch: undefined,
    setTimeout: (resolve) => {
      location.origin = 'https://redirected.example';
      resolve();
    },
  });

  assert.equal(result.success, false);
  assert.match(result.reason, /未验证来源/);
});

test('generic adapter does not dispatch a send key after a redirected delayed send', async () => {
  const { buildGenericScript, buildOriginGuardedScript } = createAdapterHarness();
  const location = { origin: 'https://trusted.provider' };
  const target = createEditable();
  const script = buildOriginGuardedScript(
    buildGenericScript('test message', true, []),
    ['https://trusted.provider'],
  );
  const result = await runGeneratedScript(script, {
    document: {
      createRange: () => ({ selectNodeContents() {} }),
      execCommand() {},
      querySelector: (selector) => (selector.includes('textarea') ? target : null),
      querySelectorAll: () => [],
    },
    window: { getSelection: createSelection },
    location,
    HTMLTextAreaElement: class {},
    HTMLInputElement: class {},
    InputEvent: undefined,
    Event: TestEvent,
    KeyboardEvent: TestKeyboardEvent,
    DataTransfer: undefined,
    ClipboardEvent: undefined,
    File: undefined,
    fetch: undefined,
    setTimeout: (resolve) => {
      location.origin = 'https://redirected.example';
      resolve();
    },
  });

  assert.equal(result.success, false);
  assert.equal(target.events.filter((event) => event instanceof TestKeyboardEvent).length, 0);
});

test('all text adapters ignore attachment arguments and exclude image-byte decoding', () => {
  const adapters = createAdapterHarness();

  for (const adapterName of adapterNames) {
    const script = adapters[adapterName]('test message', false, [{ id: 'image', name: 'example.png', type: 'image/png' }]);
    assert.doesNotMatch(script, /dataUri|fetch\(|new DataTransfer\(|new File\(|ClipboardEvent\('paste'/, adapterName);
  }
});

test('every auto-send provider adapter guards delayed send work against a redirected origin', () => {
  const adapters = createAdapterHarness();

  for (const adapterName of adapterNames) {
    const script = adapters[adapterName]('test message', true, []);
    assert.match(script, /await new Promise\(\(resolve\) => setTimeout\(resolve, 120\)\);[\s\S]*?qaskOriginAllowed/);
  }
});


test('Gemini adapter generates a complete parseable broadcast script', () => {
  const { buildGeminiScript } = createAdapterHarness();
  const script = renderedScript(buildGeminiScript, []);

  assert.match(script, /const editable = document\.querySelector/);
  assert.match(script, /return \{ success: true/);
});

test('Copilot adapter uses its contenteditable fallback for text and keyboard send', async () => {
  const { buildCopilotScript } = createAdapterHarness();
  const editable = createEditable();
  let insertedText = '';

  class TestTextArea {
    set value(value) {
      if (!(this instanceof TestTextArea)) {
        throw new TypeError('textarea setter was called on a non-textarea');
      }
      this._value = value;
    }
  }

  const document = {
    createRange: () => ({ selectNodeContents() {} }),
    dispatchEvent() {},
    execCommand: (command, _showUi, value) => {
      if (command === 'insertText') insertedText = value;
      return true;
    },
    querySelector: (selector) => {
      if (selector.startsWith('button')) return null;
      if (selector.includes('textarea')) return null;
      if (selector.includes('[contenteditable')) return editable;
      return null;
    },
  };
  const result = await runGeneratedScript(buildCopilotScript('test message', true, []), {
    document,
    window: { getSelection: createSelection },
    HTMLTextAreaElement: TestTextArea,
    HTMLInputElement: class {},
    InputEvent: undefined,
    Event: TestEvent,
    KeyboardEvent: TestKeyboardEvent,
    DataTransfer: undefined,
    ClipboardEvent: undefined,
    File: undefined,
    fetch: undefined,
    setTimeout: (resolve) => resolve(),
  });

  assert.equal(result.success, true);
  assert.equal(insertedText, 'test message');
  assert.ok(editable.events.some((event) => event instanceof TestKeyboardEvent));
});

test('generic adapter defaults to fill-only and makes at most one keyboard send attempt', async () => {
  const { buildGenericScript } = createAdapterHarness();
  const editable = createEditable();
  const documentEvents = [];
  const document = {
    createRange: () => ({ selectNodeContents() {} }),
    dispatchEvent(event) { documentEvents.push(event); },
    execCommand: () => true,
    querySelector: (selector) => (selector.includes('textarea') ? editable : null),
    querySelectorAll: () => [],
  };

  const fillOnly = await runGeneratedScript(buildGenericScript('test message', false, []), {
    document,
    window: { getSelection: createSelection },
    HTMLTextAreaElement: class {},
    HTMLInputElement: class {},
    InputEvent: undefined,
    Event: TestEvent,
    KeyboardEvent: TestKeyboardEvent,
    DataTransfer: undefined,
    ClipboardEvent: undefined,
    File: undefined,
    fetch: undefined,
    setTimeout: (resolve) => resolve(),
  });
  assert.equal(fillOnly.success, true);
  assert.equal(fillOnly.autoSent, false);
  assert.equal(editable.events.filter((event) => event instanceof TestKeyboardEvent).length, 0);

  const sent = await runGeneratedScript(buildGenericScript('test message', true, []), {
    document,
    window: { getSelection: createSelection },
    HTMLTextAreaElement: class {},
    HTMLInputElement: class {},
    InputEvent: undefined,
    Event: TestEvent,
    KeyboardEvent: TestKeyboardEvent,
    DataTransfer: undefined,
    ClipboardEvent: undefined,
    File: undefined,
    fetch: undefined,
    setTimeout: (resolve) => resolve(),
  });
  assert.equal(sent.success, true);
  assert.equal(sent.autoSent, true);
  assert.equal(editable.events.filter((event) => event instanceof TestKeyboardEvent && event.type === 'keydown').length, 1);
  assert.equal(documentEvents.filter((event) => event instanceof TestKeyboardEvent && event.type === 'keydown').length, 0);
});

test('generic adapter does not claim an attempted send through a disabled control', async () => {
  const { buildGenericScript } = createAdapterHarness();
  const editable = createEditable();
  const disabledButton = {
    disabled: true,
    click() {
      throw new Error('disabled send control must not be clicked');
    },
  };
  const document = {
    createRange: () => ({ selectNodeContents() {} }),
    execCommand: () => true,
    querySelector: (selector) => (selector.includes('textarea') ? editable : disabledButton),
    querySelectorAll: () => [],
  };

  const result = await runGeneratedScript(buildGenericScript('test message', true, []), {
    document,
    window: { getSelection: createSelection },
    HTMLTextAreaElement: class {},
    HTMLInputElement: class {},
    InputEvent: undefined,
    Event: TestEvent,
    KeyboardEvent: TestKeyboardEvent,
    DataTransfer: undefined,
    ClipboardEvent: undefined,
    File: undefined,
    fetch: undefined,
    setTimeout: (resolve) => resolve(),
  });

  assert.equal(result.success, true);
  assert.equal(result.autoSent, false);
  assert.equal(editable.events.filter((event) => event instanceof TestKeyboardEvent).length, 0);
});

test('built-in adapters retain a fill-only result when their discovered send control is disabled', () => {
  const adapters = createAdapterHarness();

  for (const adapterName of adapterNames.filter((name) => name !== 'buildGenericScript')) {
    const script = adapters[adapterName]('test message', true, []);
    assert.match(script, /let attemptedAutoSend = false/);
    assert.match(script, /autoSent: attemptedAutoSend/);
    assert.match(script, /!.*\.disabled/);
  }
});

test('built-in adapter fallback scripts do not duplicate a bubbling send event on document', () => {
  const adapters = createAdapterHarness();

  for (const adapterName of adapterNames) {
    const script = adapters[adapterName]('test message', true, []);
    assert.doesNotMatch(script, /document\.dispatchEvent\(new KeyboardEvent/);
  }
});

test('Claude adapter ignores attachment arguments and does not schedule image paste work', () => {
  const { buildClaudeScript } = createAdapterHarness();
  const script = buildClaudeScript('test message', false, [{ id: 'image', name: 'example.png', type: 'image/png' }]);

  assert.doesNotMatch(script, /dataUri|fetch\(|new DataTransfer\(|new File\(|ClipboardEvent\('paste'/);
});
