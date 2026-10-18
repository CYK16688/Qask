const escapeForScript = (value) => JSON.stringify(value ?? "");
const boolLiteral = (value) => (value ? "true" : "false");
const ORIGIN_GUARD_FAILURE = "if (typeof qaskOriginAllowed === 'function' && !qaskOriginAllowed()) return { success: false, reason: '网页已跳转到未验证来源；为保护内容已取消发送', autoSent: false };";
const layoutLifecycleTraceEnabled = typeof window !== "undefined"
  && window.qask?.diagnostics?.layoutLifecycleTraceEnabled === true;

const STORAGE_KEYS = {
  layout: "qask.layout",
  customModels: "qask.customModels",
  modelOrder: "qask.modelOrder",
  hiddenDefaultModels: "qask.hiddenDefaultModels",
  theme: "qask.theme",
  settings: "qask.settings",
};

const THEME_MODES = new Set(["system", "dark", "light"]);

const PANEL_ZOOM = {
  defaultFactor: 1,
  minFactor: 0.7,
  maxFactor: 1.3,
};

const ATTACHMENT_LIMITS = {
  maxCount: 5,
  maxTotalBytes: 20 * 1024 * 1024,
  maxImageBytes: 5 * 1024 * 1024,
  maxAudioBytes: 10 * 1024 * 1024,
  maxDocumentBytes: 10 * 1024 * 1024,
  maxRecordingDurationMs: 120_000,
  maxRecordingBytes: 10 * 1024 * 1024,
};

const ATTACHMENT_KINDS = {
  image: "image",
  audio: "audio",
  document: "document",
};

function getAttachmentKind(type = "") {
  if (type.startsWith("image/")) return ATTACHMENT_KINDS.image;
  if (type.startsWith("audio/")) return ATTACHMENT_KINDS.audio;
  if (type === "application/pdf") return ATTACHMENT_KINDS.document;
  return null;
}

function getAttachmentLimit(kind) {
  if (kind === ATTACHMENT_KINDS.image) return ATTACHMENT_LIMITS.maxImageBytes;
  if (kind === ATTACHMENT_KINDS.audio) return ATTACHMENT_LIMITS.maxAudioBytes;
  if (kind === ATTACHMENT_KINDS.document) return ATTACHMENT_LIMITS.maxDocumentBytes;
  return 0;
}

function hasSensitiveLocalFileName(name = "") {
  const normalized = String(name).replace(/\\/g, "/").trim().toLowerCase();
  if (!normalized) return true;
  const segments = normalized.split("/").filter(Boolean);
  const baseName = segments.at(-1) || "";
  if (segments.some((segment) => segment.startsWith(".") || segment === ".git")) return true;
  return /(?:^|[-_.])(github|git[-_.]?(?:token|credential|config)|token|secret|password|passwd|credential|id_rsa|id_ed25519)(?:[-_.]|$)/i.test(baseName);
}

function validateAttachmentMeta(file, existingEntries = []) {
  const kind = getAttachmentKind(file?.type || "");
  if (!file || !kind) return { valid: false, reason: "仅支持图片、音频和 PDF 附件" };
  if (hasSensitiveLocalFileName(file.name)) return { valid: false, reason: "为保护本地 GitHub 与凭据数据，不能添加隐藏或敏感文件" };
  if (!Number.isFinite(file.size) || file.size <= 0) return { valid: false, reason: "附件为空或无法读取" };
  if (file.size > getAttachmentLimit(kind)) return { valid: false, reason: `${kind === ATTACHMENT_KINDS.image ? "图片" : kind === ATTACHMENT_KINDS.audio ? "音频" : "PDF"} 超过大小限制` };
  if (existingEntries.length >= ATTACHMENT_LIMITS.maxCount) return { valid: false, reason: `最多添加 ${ATTACHMENT_LIMITS.maxCount} 个附件` };
  const currentTotal = existingEntries.reduce((total, entry) => total + (entry.file?.size || 0), 0);
  if (currentTotal + file.size > ATTACHMENT_LIMITS.maxTotalBytes) return { valid: false, reason: "附件总大小超过 20 MB" };
  return { valid: true, kind };
}

// A watchdog expiry shares the error status with a rejected send, but it means
// "we could not confirm", not "the site refused". Keeping the two apart is what
// stops a slow site from being reported to the user as a failure.
function isTimedOutResult(result) {
  return result?.status === BROADCAST_STATUS.error && result?.timedOut === true;
}

// Counts every recipient exactly once so the per-round summary can never omit a
// panel: the previous ad-hoc counters reported nothing at all for a round in
// which every panel returned "partial" (the attachment path).
function summarizeBroadcastResults(results = []) {
  const entries = Array.isArray(results) ? results : [];
  return {
    total: entries.length,
    attemptedAutoSend: entries.filter((entry) => entry?.attemptedAutoSend === true).length,
    filled: entries.filter((entry) => entry?.status === BROADCAST_STATUS.success && entry?.attemptedAutoSend !== true).length,
    attachmentOnly: entries.filter((entry) => entry?.status === BROADCAST_STATUS.partial).length,
    pending: entries.filter((entry) => entry?.status === BROADCAST_STATUS.pending).length,
    timedOut: entries.filter(isTimedOutResult).length,
    failed: entries.filter((entry) => entry?.status === BROADCAST_STATUS.error && !isTimedOutResult(entry)).length,
  };
}

function createBroadcastSnapshot(panelStates, activeCount, text, attachmentPayload) {
  const recipients = (Array.isArray(panelStates) ? panelStates : [])
    .slice(0, Math.max(0, Number(activeCount) || 0))
    .map((panelState) => ({
      panelState,
      modelId: panelState?.modelId || null,
      webview: panelState?.webview || null,
      label: getPanelLabel(panelState),
    }));
  return {
    text,
    attachments: Array.isArray(attachmentPayload) ? attachmentPayload : [],
    recipients,
  };
}

function shouldClearBroadcastDraft(snapshot, currentDraft, results) {
  if (!snapshot || !currentDraft) return false;
  if (snapshot.text !== currentDraft.value || snapshot.revision !== currentDraft.revision) return false;
  const hasAutoSendAttempt = Array.isArray(results)
    && results.length > 0
    && results.every((entry) => entry?.attemptedAutoSend === true);
  return hasAutoSendAttempt;
}

function createPendingBroadcastTurn(snapshot, draft, activeCount, results) {
  if (!snapshot || !draft || !Array.isArray(results)) return null;
  // File placement is not a reliable delivery acknowledgement, so never replay
  // an attachment-bearing turn. The attachment path also runs no guest script,
  // so there is no filled text to hold or retry.
  if (snapshot.attachments.length > 0) return null;
  const retryRecipients = snapshot.recipients.filter((recipient, index) => (
    results[index]?.attemptedAutoSend !== true
    // A watchdog timeout means the site may already have received the text, so
    // retrying automatically would risk asking the same question twice.
    && results[index]?.timedOut !== true
    && (results[index]?.status === BROADCAST_STATUS.error
      || results[index]?.status === BROADCAST_STATUS.pending)
  ));
  const hasManualFill = results.some((result) => (
    result?.status === BROADCAST_STATUS.success && result?.attemptedAutoSend !== true
  ));
  if (!retryRecipients.length && !hasManualFill) return null;
  return {
    recipients: snapshot.recipients,
    results,
    text: snapshot.text,
    revision: draft.revision,
    activeCount,
    attachments: snapshot.attachments,
    retryRecipients,
    hasManualFill,
    composition: snapshot.recipients.map((recipient) => recipient.modelId || null),
  };
}

function mergePendingBroadcastResults(pendingTurn, retryRecipients, retryResults) {
  if (!pendingTurn) return Array.isArray(retryResults) ? retryResults : [];
  return pendingTurn.recipients.map((recipient, index) => {
    const retryIndex = retryRecipients.indexOf(recipient);
    return retryIndex >= 0 ? retryResults[retryIndex] : pendingTurn.results[index];
  });
}

function getPendingBroadcastAction(pendingTurn, currentDraft, activeCount, currentComposition = null) {
  if (!pendingTurn) return { mode: "new" };
  if (pendingTurn.text !== currentDraft?.value || pendingTurn.revision !== currentDraft?.revision) {
    return { mode: "new" };
  }
  if (pendingTurn.activeCount !== activeCount) return { mode: "new" };
  // The same count with different websites is a different turn: retrying into a
  // now-parked panel would send the text to the wrong place.
  if (Array.isArray(currentComposition)) {
    const pendingComposition = Array.isArray(pendingTurn.composition) ? pendingTurn.composition : [];
    if (pendingComposition.join("|") !== currentComposition.join("|")) return { mode: "new" };
  }
  if (pendingTurn.retryRecipients.length) {
    return {
      mode: "retry",
      recipients: pendingTurn.retryRecipients,
      attachments: pendingTurn.attachments,
    };
  }
  return pendingTurn.hasManualFill ? { mode: "hold" } : { mode: "new" };
}

function createDispatchCoordinator() {
  const inFlight = new WeakMap();
  return {
    isBusy(webview) {
      return Boolean(webview && inFlight.has(webview));
    },
    // Elapsed time separates "still working on a slow site" from "wedged", and
    // is the difference between asking the user to wait and asking them to
    // reload the panel.
    busyForMs(webview) {
      const entry = webview ? inFlight.get(webview) : null;
      return entry ? Date.now() - entry.startedAt : 0;
    },
    // A watchdog expiry, a crash, or a navigation means whatever was injected
    // into the old document can no longer block the panel forever.
    reset(webview) {
      if (webview) {
        inFlight.delete(webview);
      }
    },
    run(webview, operation) {
      if (!webview || inFlight.has(webview)) {
        return Promise.resolve({ skipped: true });
      }
      const task = Promise.resolve().then(operation);
      inFlight.set(webview, { task, startedAt: Date.now() });
      task.finally(() => {
        if (inFlight.get(webview)?.task === task) {
          inFlight.delete(webview);
        }
      }).catch(() => {});
      return task;
    },
  };
}

// A watchdog expiry is not the same as a rejected send: the injected script may
// still be running, so the panel is "unconfirmed", not "failed". It keeps the
// error status the product already guarantees (docs and tests), but carries an
// explicit timedOut flag so the summary can say "未确认" instead of claiming a
// failure the app cannot actually observe. "pending" covers the separate case
// where a panel is still holding the previous turn.
const BROADCAST_STATUS = {
  success: "success",
  partial: "partial",
  pending: "pending",
  error: "error",
};

async function settleBroadcastTasks(recipients, dispatch, timeoutMs = 15_000, onTimeout = null) {
  const boundedTimeout = Math.max(1, Number(timeoutMs) || 15_000);
  return Promise.all((Array.isArray(recipients) ? recipients : []).map(async (recipient) => {
    const fallbackLabel = recipient?.label || "网页面板";
    let timerId;
    const timeout = new Promise((resolve) => {
      timerId = setTimeout(() => {
        try {
          onTimeout?.(recipient);
        } catch (error) {
          console.warn("[dispatch] timeout cleanup failed", error?.name || "unknown");
        }
        resolve({
          panel: fallbackLabel,
          status: BROADCAST_STATUS.error,
          timedOut: true,
          message: "等待超时；该网页可能仍在处理，尚未确认是否已发送",
        });
      }, boundedTimeout);
    });
    try {
      return await Promise.race([
        Promise.resolve().then(() => dispatch(recipient)),
        timeout,
      ]);
    } catch {
      return { panel: fallbackLabel, status: BROADCAST_STATUS.error, message: "发送失败" };
    } finally {
      clearTimeout(timerId);
    }
  }));
}

function buildAttachmentPayloads(entries) {
  // Metadata only: no bytes, path, or data URI ever leaves the renderer.
  return (Array.isArray(entries) ? entries : []).map((entry) => ({
    id: entry.id,
    kind: entry.kind,
    name: entry.file.name,
    type: entry.file.type,
    size: entry.file.size,
    source: entry.source,
  }));
}

function isTrustedGuestUrl(value, allowedOrigins = []) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && allowedOrigins.some((origin) => origin === url.origin);
  } catch {
    return false;
  }
}

function buildOriginCheckExpression(origins, originExpression = "location.origin") {
  const trustedOrigins = [];
  if (Array.isArray(origins)) {
    for (const origin of origins) {
      if (typeof origin === "string") {
        trustedOrigins.push(origin);
      }
    }
  }
  return trustedOrigins.length
    ? trustedOrigins.reduce((expression, origin) => (
      expression ? `${expression} || ${originExpression} === ${JSON.stringify(origin)}` : `${originExpression} === ${JSON.stringify(origin)}`
    ), "")
    : "false";
}

function buildOriginGuardedScript(script, allowedOrigins = []) {
  const origins = Array.isArray(allowedOrigins) ? allowedOrigins : [];
  const originCheck = buildOriginCheckExpression(origins);
  return `(async () => {
    const isAllowedOrigin = () => ${originCheck};
    const qaskOriginAllowed = isAllowedOrigin;
    if (!isAllowedOrigin()) {
      return { success: false, reason: '网页已跳转到未验证来源；为保护内容已取消发送', autoSent: false };
    }
    const result = await (${script});
    if (!isAllowedOrigin()) {
      return { success: false, reason: '网页已跳转到未验证来源；为保护内容已取消发送', autoSent: false };
    }
    return result;
  })()`;
}

function createRecordingSession({ generation, recorder, stream, leaseId, mimeType, startedAt = Date.now() }) {
  return {
    generation,
    recorder,
    stream,
    leaseId,
    mimeType,
    startedAt,
    chunks: [],
    discard: false,
    stopMessage: "",
    stopRequested: false,
    finalized: false,
    timer: null,
    limitTimer: null,
    leaseRenewTimer: null,
  };
}

function requestRecordingStop(session, { discard = false, message = "" } = {}) {
  if (!session || session.finalized) return "cleanup";
  session.discard = session.discard || discard;
  if (message) session.stopMessage = message;
  if (session.stopRequested) {
    return "draining";
  }
  if (session.recorder?.state === "inactive") return "draining";
  session.stopRequested = true;
  return "stop";
}

const PANEL_LOAD_STATES = {
  loading: "loading",
  ready: "ready",
  failed: "failed",
};

function advancePanelLoadState(currentState, event) {
  if (event === "start") return PANEL_LOAD_STATES.loading;
  if (event === "fail") return PANEL_LOAD_STATES.failed;
  if (event === "ready" && currentState !== PANEL_LOAD_STATES.failed) return PANEL_LOAD_STATES.ready;
  return currentState;
}

function updatePanelLoadState(panelState, event) {
  panelState.loadState = advancePanelLoadState(panelState.loadState, event);
  panelState.ready = panelState.loadState === PANEL_LOAD_STATES.ready;
  return panelState.ready;
}

function shouldRunPanelReadyEffects(previousState, nextState) {
  return previousState !== PANEL_LOAD_STATES.ready && nextState === PANEL_LOAD_STATES.ready;
}

function normalizeModelOrder(savedOrder, availableIds) {
  const available = Array.isArray(availableIds) ? availableIds.filter((id) => typeof id === "string") : [];
  const validIds = new Set(available);
  const orderedIds = Array.isArray(savedOrder) ? savedOrder : [];
  const result = [];
  const seen = new Set();

  for (const id of orderedIds) {
    if (typeof id !== "string" || !validIds.has(id) || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  for (const id of available) {
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

function moveModelOrder(order, modelId, targetIndex) {
  const currentOrder = Array.isArray(order) ? order : [];
  const sourceIndex = currentOrder.indexOf(modelId);
  if (sourceIndex < 0 || !Number.isInteger(targetIndex)) return currentOrder;
  const nextOrder = [...currentOrder];
  nextOrder.splice(sourceIndex, 1);
  const boundedIndex = Math.max(0, Math.min(targetIndex, nextOrder.length));
  nextOrder.splice(boundedIndex, 0, modelId);
  return nextOrder;
}

function getAdjustedDropTargetIndex(order, modelId, targetIndex) {
  const sourceIndex = Array.isArray(order) ? order.indexOf(modelId) : -1;
  if (!Number.isInteger(targetIndex) || sourceIndex < 0) {
    return targetIndex;
  }
  return sourceIndex < targetIndex ? targetIndex - 1 : targetIndex;
}

function getRankedModelIds(order, activeCount) {
  const count = Number.isInteger(activeCount) && activeCount > 0 ? activeCount : 0;
  const rankedOrder = Array.isArray(order) ? order : [];
  return Array.from({ length: count }, (_, index) => rankedOrder[index] || null);
}

function getPanelPoolPlacement(poolModelIds, order, activeCount) {
  const currentIds = Array.isArray(poolModelIds) ? poolModelIds : [];
  const desiredIds = getRankedModelIds(order, activeCount);
  const sourceIndexes = desiredIds.map((modelId) => (modelId ? currentIds.indexOf(modelId) : -1));
  const reservedIndexes = new Set(sourceIndexes.filter((index) => index >= 0));
  const availableIndexes = currentIds
    .map((_, panelIndex) => panelIndex)
    .filter((panelIndex) => !reservedIndexes.has(panelIndex));
  const takeAvailableIndex = (predicate) => {
    const index = availableIndexes.findIndex(predicate);
    if (index < 0) return null;
    return availableIndexes.splice(index, 1)[0];
  };
  const plan = desiredIds.map((modelId, index) => {
    const sourceIndex = sourceIndexes[index];
    if (!modelId) {
      const panelIndex = takeAvailableIndex(() => true);
      return { action: "clear", index, modelId: null, panelIndex: Number.isInteger(panelIndex) ? panelIndex : null };
    }
    if (sourceIndex >= 0) {
      return {
        action: sourceIndex === index ? "keep" : "move",
        index,
        modelId,
        sourceIndex,
        panelIndex: sourceIndex,
      };
    }
    const panelIndex = takeAvailableIndex((candidate) => !currentIds[candidate])
      ?? takeAvailableIndex((candidate) => candidate >= activeCount)
      ?? takeAvailableIndex(() => true);
    if (!Number.isInteger(panelIndex)) {
      return { action: "load", index, modelId, panelIndex: null };
    }
    return { action: "load", index, modelId, panelIndex };
  });
  const activePanelIndexes = plan.map(({ panelIndex }) => panelIndex);
  const activePanelIndexSet = new Set(activePanelIndexes.filter((panelIndex) => Number.isInteger(panelIndex)));
  const parkedPanelIndexes = currentIds
    .map((_, panelIndex) => panelIndex)
    .filter((panelIndex) => !activePanelIndexSet.has(panelIndex));

  return { plan, activePanelIndexes, parkedPanelIndexes };
}

function clampPanelZoom(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return PANEL_ZOOM.defaultFactor;
  }
  const boundedValue = Math.min(PANEL_ZOOM.maxFactor, Math.max(PANEL_ZOOM.minFactor, numericValue));
  return Math.round(boundedValue * 100) / 100;
}

function getAutomaticPanelZoom(layoutId) {
  if (layoutId === "quad") return 0.85;
  if (layoutId === "triple") return 0.9;
  return PANEL_ZOOM.defaultFactor;
}

const LEGACY_STORAGE_KEYS = [
  "qask.apiKeys",
  "qask.accessMode",
  "qask.panelModels.web",
  "qask.panelModels.api",
  "qask.panelModels",
];

function purgeLegacyStorage() {
  if (typeof window === "undefined") {
    return;
  }
  for (const key of LEGACY_STORAGE_KEYS) {
    try {
      window.localStorage.removeItem(key);
    } catch (error) {
      console.warn("[storage] 移除废弃配置失败", error);
    }
  }
}

purgeLegacyStorage();

const KEY_EVENT_INIT = "{ key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true, composed: true }";
const KEY_EVENT_INIT_CTRL_ENTER = "{ key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true, composed: true, ctrlKey: true }";

function loadFromStorage(key, fallback) {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch (error) {
    console.warn(`[storage] 读取 ${key} 失败`, error);
    return fallback;
  }
}

function saveToStorage(key, value) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch (error) {
    console.warn(`[storage] 写入 ${key} 失败`, error);
  }
}

function persistLayout(layoutId) {
  saveToStorage(STORAGE_KEYS.layout, layoutId);
}

function persistModelOrder() {
  saveToStorage(STORAGE_KEYS.modelOrder, modelOrder);
}

function syncModelOrder() {
  modelOrder = normalizeModelOrder(modelOrder, Array.from(modelRegistry.keys()));
}

function persistHiddenDefaultModels() {
  saveToStorage(STORAGE_KEYS.hiddenDefaultModels, Array.from(hiddenDefaultModelIds));
}

function persistCustomModels() {
  const customs = Array.from(modelRegistry.values())
    .filter((model) => model.origin !== "default")
    .map((model) => ({
      id: model.id,
      label: model.label,
      url: model.url,
      partition: model.partition,
      allowAutoSend: Boolean(model.allowAutoSend),
    }));
  saveToStorage(STORAGE_KEYS.customModels, customs);
}

const buildChatGPTScript = (text, autoSend, _attachments = []) => {
  const payload = escapeForScript(text);
  const sendClause = autoSend
    ? `
    await new Promise((resolve) => setTimeout(resolve, 120));
    ${ORIGIN_GUARD_FAILURE}
    let attemptedAutoSend = false;
    const form = target.closest("form");
    const button = document.querySelector('button[data-testid="send-button"]')
      || (form ? form.querySelector('button[type="submit"]') : null)
      || Array.from(document.querySelectorAll('button[aria-label*="Send" i], button[aria-label*="发送"]'))
        .find((candidate) => candidate.getClientRects().length > 0)
      || null;
    if (button && !button.disabled && button.getAttribute?.('aria-disabled') !== 'true' && typeof button.click === 'function') {
      button.click();
      attemptedAutoSend = true;
    } else if (!button && target) {
      const keyEventInit = ${KEY_EVENT_INIT};
      target.dispatchEvent(new KeyboardEvent('keydown', keyEventInit));
      target.dispatchEvent(new KeyboardEvent('keypress', keyEventInit));
      target.dispatchEvent(new KeyboardEvent('keyup', keyEventInit));
      attemptedAutoSend = true;
    }
    if (!attemptedAutoSend) {
      return { success: true, autoSent: false, sendControlDisabled: true, timestamp: Date.now() };
    }
    if (!attemptedAutoSend) {
      return { success: true, autoSent: false, sendControlDisabled: true, timestamp: Date.now() };
    }
  `
    : "let attemptedAutoSend = false;";
  return `(async () => {
    const textarea = document.querySelector('textarea[data-id="prompt-textarea"]');
    const editable = textarea ? null : document.querySelector('div[contenteditable="true"][data-testid="prompt-textarea"], [contenteditable="true"][aria-label*="Message" i], [contenteditable="true"][aria-label*="消息"]');
    const target = textarea || editable;
    if (!target) {
      return { success: false, reason: "输入框尚未出现" };
    }
    if (textarea) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
      setter.call(textarea, ${payload});
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      textarea.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
      editable.focus();
      const selection = window.getSelection();
      selection?.removeAllRanges();
      const range = document.createRange();
      range.selectNodeContents(editable);
      selection?.addRange(range);
      document.execCommand("selectAll", false, null);
      document.execCommand("insertText", false, ${payload});
      editable.dispatchEvent(new Event('input', { bubbles: true }));
      editable.dispatchEvent(new Event('change', { bubbles: true }));
    }
    ${sendClause}
    return { success: true, autoSent: attemptedAutoSend, timestamp: Date.now() };
  })()`;
};

const buildGeminiScript = (text, autoSend, _attachments = []) => {
  const payload = escapeForScript(text);
  const sendClause = autoSend
    ? `
    await new Promise((resolve) => setTimeout(resolve, 120));
    ${ORIGIN_GUARD_FAILURE}
    let attemptedAutoSend = false;
    const primaryButton = document.querySelector('button[aria-label="Send message"], button[aria-label="Send"], button[aria-label*="发送"], button[data-testid="send-button"]');
    const fallback = Array.from(document.querySelectorAll('button, [role="button"]')).find((btn) => /发送|send/i.test((btn.textContent || btn.getAttribute('aria-label') || "").trim()));
    const trigger = primaryButton || fallback;
    const actionable = trigger ? (trigger.closest && trigger.closest('button')) || trigger : null;
    if (actionable && !actionable.disabled && actionable.getAttribute?.('aria-disabled') !== 'true' && typeof actionable.click === 'function') {
      actionable.click();
      attemptedAutoSend = true;
    } else if (!actionable) {
      const keyEventInit = ${KEY_EVENT_INIT};
      editable.dispatchEvent(new KeyboardEvent('keydown', keyEventInit));
      editable.dispatchEvent(new KeyboardEvent('keypress', keyEventInit));
      editable.dispatchEvent(new KeyboardEvent('keyup', keyEventInit));
      attemptedAutoSend = true;
    }
    if (!attemptedAutoSend) {
      return { success: true, autoSent: false, sendControlDisabled: true, timestamp: Date.now() };
    }
  `
    : "let attemptedAutoSend = false;";
  return `(async () => {
    const editable = document.querySelector('[contenteditable="true"][aria-label]');
    if (!editable) {
      return { success: false, reason: "输入框尚未出现" };
    }
    editable.focus();
    const selection = window.getSelection();
    selection.removeAllRanges();
    const range = document.createRange();
    range.selectNodeContents(editable);
    selection.addRange(range);
    document.execCommand("selectAll", false, null);
    document.execCommand("insertText", false, ${payload});
    editable.dispatchEvent(new Event('input', { bubbles: true }));
    editable.dispatchEvent(new Event('change', { bubbles: true }));
    ${sendClause}
    return { success: true, autoSent: attemptedAutoSend, timestamp: Date.now() };
  })()`;
};

const buildDoubaoScript = (text, autoSend, _attachments = []) => {
  const payload = escapeForScript(text);
  const sendClause = autoSend
    ? `
    await new Promise((resolve) => setTimeout(resolve, 120));
    ${ORIGIN_GUARD_FAILURE}
    let attemptedAutoSend = false;
    const directButton = document.querySelector('button[data-testid="send-button"], button[data-testid="chat-send"], button[aria-label*="发送"], button[type="submit"]');
    const allButtons = Array.from(document.querySelectorAll('button, [role="button"]'));
    const textButton = allButtons.find((btn) => {
      const label = (btn.getAttribute && btn.getAttribute('aria-label')) || "";
      const content = (btn.textContent || "").trim();
      return /发送|send|提交/i.test(label) || /发送|send|提交/i.test(content);
    });
    const finalButton = directButton || textButton || null;
    const actionable = finalButton ? (finalButton.closest && finalButton.closest('button')) || finalButton : null;
    if (actionable && !actionable.disabled && actionable.getAttribute?.('aria-disabled') !== 'true' && typeof actionable.click === 'function') {
      actionable.click();
      attemptedAutoSend = true;
    } else if (!actionable && inputTarget) {
      const keyEventInit = ${KEY_EVENT_INIT};
      inputTarget.dispatchEvent(new KeyboardEvent('keydown', keyEventInit));
      inputTarget.dispatchEvent(new KeyboardEvent('keypress', keyEventInit));
      inputTarget.dispatchEvent(new KeyboardEvent('keyup', keyEventInit));
      attemptedAutoSend = true;
    }
    if (!attemptedAutoSend) {
      return { success: true, autoSent: false, sendControlDisabled: true, timestamp: Date.now() };
    }
  `
    : "let attemptedAutoSend = false;";
  return `(async () => {
    const isVisible = (element) => Boolean(element && element.getClientRects().length > 0);
    const textarea = Array.from(document.querySelectorAll('textarea')).find(isVisible) || null;
    const editable = textarea ? null : (Array.from(document.querySelectorAll('[contenteditable="true"]')).find(isVisible) || null);
    const inputTarget = textarea || editable;
    if (!inputTarget) {
      return { success: false, reason: "输入框尚未出现" };
    }
    if (textarea) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
      setter.call(textarea, ${payload});
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      textarea.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (editable) {
      editable.focus();
      const selection = window.getSelection();
      selection.removeAllRanges();
      const range = document.createRange();
      range.selectNodeContents(editable);
      selection.addRange(range);
      document.execCommand("selectAll", false, null);
      document.execCommand("insertText", false, ${payload});
      editable.dispatchEvent(new Event('input', { bubbles: true }));
      editable.dispatchEvent(new Event('change', { bubbles: true }));
    }
    ${sendClause}
    return { success: true, autoSent: attemptedAutoSend, timestamp: Date.now() };
  })()`;
};

const buildClaudeScript = (text, autoSend, _attachments = []) => {
  const payload = escapeForScript(text);
  const sendClause = autoSend
    ? `
    await new Promise((resolve) => setTimeout(resolve, 120));
    ${ORIGIN_GUARD_FAILURE}
    let attemptedAutoSend = false;
    const sendButton = document.querySelector('button[data-testid="send-button"], button[aria-label*="发送"], button[aria-label*="Send"], button[type="submit"]');
    if (sendButton
      && !sendButton.disabled
      && sendButton.getAttribute?.('aria-disabled') !== 'true'
      && typeof sendButton.click === 'function') {
      sendButton.click();
      attemptedAutoSend = true;
    } else if (!sendButton && editable) {
      const keyEventInit = ${KEY_EVENT_INIT};
      editable.dispatchEvent(new KeyboardEvent('keydown', keyEventInit));
      editable.dispatchEvent(new KeyboardEvent('keypress', keyEventInit));
      editable.dispatchEvent(new KeyboardEvent('keyup', keyEventInit));
      attemptedAutoSend = true;
    }
    if (!attemptedAutoSend) {
      return { success: true, autoSent: false, sendControlDisabled: true, timestamp: Date.now() };
    }
    `
    : "let attemptedAutoSend = false;";

  return `(async () => {
    const editable = document.querySelector('[data-testid="prompt-textarea"] div[contenteditable="true"], [contenteditable="true"][data-placeholder], [data-testid="composer"] [contenteditable="true"]');
    if (!editable) {
      return { success: false, reason: "输入框尚未出现" };
    }
    editable.focus();
    const selection = window.getSelection();
    selection?.removeAllRanges();
    const range = document.createRange();
    range.selectNodeContents(editable);
    selection?.addRange(range);
    document.execCommand("selectAll", false, null);
    document.execCommand("insertText", false, ${payload});
    editable.dispatchEvent(new Event('input', { bubbles: true }));
    editable.dispatchEvent(new Event('change', { bubbles: true }));
    ${sendClause}
    return { success: true, autoSent: attemptedAutoSend, timestamp: Date.now() };
  })()`;
};

const buildCopilotScript = (text, autoSend, _attachments = []) => {
  const payload = escapeForScript(text);
  const sendClause = autoSend
    ? `
    await new Promise((resolve) => setTimeout(resolve, 120));
    ${ORIGIN_GUARD_FAILURE}
    let attemptedAutoSend = false;
    const sendButton = document.querySelector('button[aria-label="Send"], button[aria-label*="发送"], button[data-testid="send-button"], button[name="send"]');
    if (sendButton
      && !sendButton.disabled
      && sendButton.getAttribute?.('aria-disabled') !== 'true'
      && typeof sendButton.click === 'function') {
      sendButton.click();
      attemptedAutoSend = true;
    } else if (!sendButton && textarea) {
      const keyEventInit = ${KEY_EVENT_INIT};
      textarea.dispatchEvent(new KeyboardEvent('keydown', keyEventInit));
      textarea.dispatchEvent(new KeyboardEvent('keypress', keyEventInit));
      textarea.dispatchEvent(new KeyboardEvent('keyup', keyEventInit));
      attemptedAutoSend = true;
    } else if (!sendButton && editable) {
      const keyEventInit = ${KEY_EVENT_INIT};
      editable.dispatchEvent(new KeyboardEvent('keydown', keyEventInit));
      editable.dispatchEvent(new KeyboardEvent('keypress', keyEventInit));
      editable.dispatchEvent(new KeyboardEvent('keyup', keyEventInit));
      attemptedAutoSend = true;
    }
    if (!attemptedAutoSend) {
      return { success: true, autoSent: false, sendControlDisabled: true, timestamp: Date.now() };
    }
    `
    : "let attemptedAutoSend = false;";

  return `(async () => {
    const isVisible = (element) => Boolean(element && element.getClientRects().length > 0);
    const textarea = Array.from(document.querySelectorAll('textarea[aria-label*="Copilot" i], textarea[aria-label*="输入"], textarea')).find(isVisible) || null;
    const editable = textarea ? null : (Array.from(document.querySelectorAll('[contenteditable="true"][role="textbox"], div[contenteditable="true"][aria-label]')).find(isVisible) || null);
    const target = textarea || editable;
    if (!target) {
      return { success: false, reason: "输入框尚未出现" };
    }
    if (textarea) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
      setter.call(textarea, ${payload});
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      textarea.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      editable.focus();
      const selection = window.getSelection();
      selection?.removeAllRanges();
      const range = document.createRange();
      range.selectNodeContents(editable);
      selection?.addRange(range);
      document.execCommand('selectAll', false, null);
    document.execCommand('insertText', false, ${payload});
      editable.dispatchEvent(new Event('input', { bubbles: true }));
      editable.dispatchEvent(new Event('change', { bubbles: true }));
    }
    ${sendClause}
    return { success: true, autoSent: attemptedAutoSend, timestamp: Date.now() };
  })()`;
};

const buildDeepSeekScript = (text, autoSend, _attachments = []) => {
  const payload = escapeForScript(text);
  const sendClause = autoSend
    ? `
    await new Promise((resolve) => setTimeout(resolve, 120));
    ${ORIGIN_GUARD_FAILURE}
    let attemptedAutoSend = false;
    const sendButton = document.querySelector('button[data-testid="send-button"], button[class*="SendButton"], button[aria-label*="发送"], button[aria-label*="Send"], button[type="submit"]');
    if (sendButton
      && !sendButton.disabled
      && sendButton.getAttribute?.('aria-disabled') !== 'true'
      && typeof sendButton.click === 'function') {
      sendButton.click();
      attemptedAutoSend = true;
    } else if (!sendButton && target) {
      const keyEventInit = ${KEY_EVENT_INIT};
      target.dispatchEvent(new KeyboardEvent('keydown', keyEventInit));
      target.dispatchEvent(new KeyboardEvent('keypress', keyEventInit));
      target.dispatchEvent(new KeyboardEvent('keyup', keyEventInit));
      attemptedAutoSend = true;
    }
    if (!attemptedAutoSend) {
      return { success: true, autoSent: false, sendControlDisabled: true, timestamp: Date.now() };
    }
    `
    : "let attemptedAutoSend = false;";

  return `(async () => {
    const isVisible = (element) => Boolean(element && element.getClientRects().length > 0);
    const selectors = [
      'textarea',
      '[contenteditable="true"][data-placeholder]',
      'div[contenteditable="true"][role="textbox"]'
    ];
    const target = selectors
      .map((selector) => Array.from(document.querySelectorAll(selector)).find(isVisible))
      .find(Boolean);
    if (!target) {
      return { success: false, reason: "输入框尚未出现" };
    }
    if (target instanceof HTMLTextAreaElement) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
      setter.call(target, ${payload});
      target.dispatchEvent(new Event('input', { bubbles: true }));
      target.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      target.focus();
      const selection = window.getSelection();
      selection?.removeAllRanges();
      const range = document.createRange();
      range.selectNodeContents(target);
      selection?.addRange(range);
      document.execCommand('selectAll', false, null);
      document.execCommand('insertText', false, ${payload});
      target.dispatchEvent(new Event('input', { bubbles: true }));
      target.dispatchEvent(new Event('change', { bubbles: true }));
    }
    ${sendClause}
    return { success: true, autoSent: attemptedAutoSend, timestamp: Date.now() };
  })()`;
};

const buildKimiScript = (text, autoSend, _attachments = []) => {
  const payload = escapeForScript(text);
  const sendClause = autoSend
    ? `
    await new Promise((resolve) => setTimeout(resolve, 120));
    ${ORIGIN_GUARD_FAILURE}
    const sendButton = document.querySelector('button[data-testid="chat-send"], button[aria-label*="发送"], button[data-icon="send"], button[type="submit"], .send-button-container');
    if (!sendButton || sendButton.disabled === true) {
      return { success: true, autoSent: false, sendControlDisabled: true, timestamp: Date.now() };
    }
    // Kimi's send control is a Vue-bound div. A synthetic DOM click can be
    // swallowed while an attachment is being processed, so the host performs a
    // trusted CDP mouse click at the control's center instead.
    return { success: true, autoSent: false, hostClickRequired: true, timestamp: Date.now() };
    `
    : "let attemptedAutoSend = false;";

  return `(async () => {
    const isVisible = (element) => Boolean(element && element.getClientRects().length > 0);
    const textarea = Array.from(document.querySelectorAll('textarea, textarea[aria-label], textarea[placeholder]')).find(isVisible) || null;
    const editable = textarea ? null : (Array.from(document.querySelectorAll('[contenteditable="true"][role="textbox"], div[contenteditable="true"][aria-label]')).find(isVisible) || null);
    const target = textarea || editable;
    if (!target) {
      return { success: false, reason: "输入框尚未出现" };
    }
    if (textarea) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
      setter.call(textarea, ${payload});
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      textarea.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      editable.focus();
      const selection = window.getSelection();
      selection?.removeAllRanges();
      const range = document.createRange();
      range.selectNodeContents(editable);
      selection?.addRange(range);
      document.execCommand('selectAll', false, null);
      document.execCommand('insertText', false, ${payload});
      editable.dispatchEvent(new Event('input', { bubbles: true }));
      editable.dispatchEvent(new Event('change', { bubbles: true }));
    }
    ${sendClause}
    return { success: true, autoSent: attemptedAutoSend, timestamp: Date.now() };
  })()`;
};

const buildGenericScript = (text, autoSend = false, _attachments = []) => {
  const payload = escapeForScript(text);
  return `(async () => {
    const selectors = [
      'textarea:not([disabled]):not([readonly])',
      'input[type="text"]:not([disabled]):not([readonly])',
      'input[type="search"]:not([disabled]):not([readonly])',
      '[contenteditable="true"]',
      'div[role="textbox"]',
      '[data-placeholder][contenteditable="true"]'
    ];

    const findTarget = () => {
      for (const selector of selectors) {
        try {
          const node = document.querySelector(selector);
          if (node) return node;
        } catch (_) {
          continue;
        }
      }
      return null;
    };

    const target = findTarget();
    if (!target) {
      return { success: false, reason: "未找到可填写的输入区域" };
    }

    const applyText = (el) => {
      if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
        descriptor?.set?.call(el, ${payload});
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        el.focus();
        const selection = window.getSelection();
        selection?.removeAllRanges();
        const range = document.createRange();
        range.selectNodeContents(el);
        selection?.addRange(range);
        document.execCommand('selectAll', false, null);
        document.execCommand('insertText', false, ${payload});
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
    };

    applyText(target);

    if (!${boolLiteral(autoSend)}) {
      return { success: true, autoSent: false, timestamp: Date.now() };
    }

    await new Promise((resolve) => setTimeout(resolve, 120));
    ${ORIGIN_GUARD_FAILURE}

    const tryClick = () => {
      const sendSelectors = [
        'button[type="submit"]',
        'button[aria-label*="send" i]',
        'button[aria-label*="发送"]',
        '[role="button"][aria-label*="send" i]',
        '[role="button"][aria-label*="发送"]',
        'button[data-testid*="send" i]',
        'button:has(svg[data-icon="send"])',
        'input[type="submit"]',
        'input[value*="发送" i]'
      ];
      for (const selector of sendSelectors) {
        try {
          const button = document.querySelector(selector);
          if (button) return button;
        } catch (_) {
          continue;
        }
      }
      const candidates = Array.from(document.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"]'));
      return candidates.find((btn) => {
        const text = (btn.innerText || btn.textContent || '').trim().toLowerCase();
        const label = (btn.getAttribute?.('aria-label') || '').toLowerCase();
        return text.includes('send') || text.includes('发送') || label.includes('send') || label.includes('发送');
      }) || null;
    };

    const sendButton = tryClick();
    if (sendButton
      && !sendButton.disabled
      && sendButton.getAttribute?.('aria-disabled') !== 'true'
      && typeof sendButton.click === 'function') {
      sendButton.click();
      return { success: true, autoSent: true, timestamp: Date.now() };
    }

    if (sendButton) {
      return { success: true, autoSent: false, timestamp: Date.now() };
    }

    const keyEventInit = ${KEY_EVENT_INIT};
    target.dispatchEvent(new KeyboardEvent('keydown', keyEventInit));
    target.dispatchEvent(new KeyboardEvent('keypress', keyEventInit));
    target.dispatchEvent(new KeyboardEvent('keyup', keyEventInit));

    return { success: true, autoSent: true, timestamp: Date.now() };
  })()`;
};

const DEFAULT_MODELS = [
  { id: "chatgpt", label: "ChatGPT", url: "https://chat.openai.com/", allowedOrigins: ["https://chat.openai.com", "https://chatgpt.com"], partition: "persist:chatgpt", composeMessageScript: buildChatGPTScript, origin: "default" },
  { id: "gemini", label: "Gemini", url: "https://gemini.google.com/app", partition: "persist:gemini", composeMessageScript: buildGeminiScript, origin: "default" },
  { id: "doubao", label: "豆包", url: "https://www.doubao.com/chat/", partition: "persist:doubao", composeMessageScript: buildDoubaoScript, origin: "default" },
  { id: "claude", label: "Claude", url: "https://claude.ai/new", partition: "persist:claude", composeMessageScript: buildClaudeScript, origin: "default" },
  { id: "copilot", label: "Copilot", url: "https://copilot.microsoft.com/", partition: "persist:copilot", composeMessageScript: buildCopilotScript, origin: "default" },
  { id: "deepseek", label: "DeepSeek", url: "https://chat.deepseek.com/", partition: "persist:deepseek", composeMessageScript: buildDeepSeekScript, origin: "default" },
  { id: "kimi", label: "Kimi", url: "https://www.kimi.com/", partition: "persist:kimi", composeMessageScript: buildKimiScript, origin: "default" }
];

const DEFAULT_MODEL_IDS = new Set(DEFAULT_MODELS.map((model) => model.id));

const LAYOUT_PRESETS = {
  single: { id: "single", count: 1, columns: "1fr" },
  dual: { id: "dual", count: 2, columns: "repeat(2, 1fr)" },
  triple: { id: "triple", count: 3, columns: "repeat(3, 1fr)" },
  quad: { id: "quad", count: 4, columns: "repeat(2, 1fr)", rows: "repeat(2, minmax(0, 1fr))" },
};

function getLayoutInvariantViolation({ layoutId, panelCount, activePanelIndexes, desiredModelIds, visiblePanelIndexes }) {
  const preset = LAYOUT_PRESETS[layoutId];
  if (!preset) return "unknown-layout";
  if (panelCount !== preset.count) return "active-panel-count";
  if (!Array.isArray(activePanelIndexes) || activePanelIndexes.length !== preset.count) return "placement-count";
  if (!activePanelIndexes.every((panelIndex) => Number.isInteger(panelIndex))) return "missing-panel-index";
  if (new Set(activePanelIndexes).size !== activePanelIndexes.length) return "duplicate-panel-index";
  if (!Array.isArray(desiredModelIds) || desiredModelIds.length !== preset.count) return "ranked-model-count";
  if (!Array.isArray(visiblePanelIndexes) || visiblePanelIndexes.length !== preset.count) return "visible-panel-count";
  if (visiblePanelIndexes.join(",") !== activePanelIndexes.join(",")) return "visible-panel-order";
  return null;
}

function normalizeLayoutPreset(layoutId) {
  return LAYOUT_PRESETS[layoutId] || LAYOUT_PRESETS.dual;
}

function setPanelsLayoutGeometry(preset) {
  panelsContainer.dataset.layout = preset.id;
  panelsContainer.style.setProperty("--panel-columns", preset.columns);
  if (preset.rows) {
    panelsContainer.style.setProperty("--panel-rows", preset.rows);
  } else {
    panelsContainer.style.removeProperty("--panel-rows");
  }
}

function synchronizeLayoutControls(layoutId) {
  [...layoutButtons, ...collapsedLayoutButtons].forEach((button) => {
    const isActive = button.dataset.layout === layoutId;
    button.setAttribute("aria-pressed", String(isActive));
    button.classList.toggle("is-active", isActive);
  });
}

function getEffectiveTheme() {
  if (themeMode === "system") {
    return systemThemeQuery.matches ? "dark" : "light";
  }
  return themeMode;
}

function applyTheme({ persist = false } = {}) {
  const effectiveTheme = getEffectiveTheme();
  document.documentElement.dataset.theme = effectiveTheme;
  document.documentElement.style.colorScheme = effectiveTheme;
  themeOptions.forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.themeMode === themeMode));
  });
  // Consumers of prefers-color-scheme (including provider webviews that support
  // dark mode) follow Electron's nativeTheme source.
  const setNativeTheme = window.qask?.theme?.set;
  if (typeof setNativeTheme === "function") {
    setNativeTheme(themeMode).catch(() => {});
  }
  if (persist) {
    saveToStorage(STORAGE_KEYS.theme, themeMode);
  }
}



const storedCustomModels = loadFromStorage(STORAGE_KEYS.customModels, []);
const persistedCustomModels = Array.isArray(storedCustomModels) ? storedCustomModels : [];
const DEFAULT_SETTINGS = Object.freeze({
  sendMode: "send",
  comparisonModelId: "auto",
  confirmSummary: true,
  autoUploadAttachments: true,
  autoPanelZoom: true,
  alwaysOnTop: false,
  launchAtLogin: false,
  showStatusBar: false,
  shortcuts: Object.freeze({
    send: "enter",
    layout: "alt-arrows",
    comparison: "mod-shift-c",
  }),
});

const SETTINGS_SEND_SHORTCUTS = new Set(["enter", "mod-enter", "ctrl-enter"]);
const SETTINGS_LAYOUT_SHORTCUTS = new Set(["alt-arrows", "mod-alt-arrows", "disabled"]);
const SETTINGS_COMPARISON_SHORTCUTS = new Set(["mod-shift-c", "alt-c", "disabled"]);

function normalizeSettings(raw) {
  const value = raw && typeof raw === "object" ? raw : {};
  const shortcuts = value.shortcuts && typeof value.shortcuts === "object" ? value.shortcuts : {};
  return {
    sendMode: ["send", "queue", "fill"].includes(value.sendMode) ? value.sendMode : DEFAULT_SETTINGS.sendMode,
    comparisonModelId: typeof value.comparisonModelId === "string" && value.comparisonModelId.trim()
      ? value.comparisonModelId.trim()
      : DEFAULT_SETTINGS.comparisonModelId,
    confirmSummary: value.confirmSummary !== false,
    autoUploadAttachments: value.autoUploadAttachments !== false,
    autoPanelZoom: value.autoPanelZoom !== false,
    alwaysOnTop: value.alwaysOnTop === true,
    launchAtLogin: value.launchAtLogin === true,
    // The transcript starts hidden: it is a diagnostic surface, not the primary
    // conversation, and it used to cover the composer on startup.
    showStatusBar: value.showStatusBar === true,
    shortcuts: {
      send: SETTINGS_SEND_SHORTCUTS.has(shortcuts.send) ? shortcuts.send : DEFAULT_SETTINGS.shortcuts.send,
      layout: SETTINGS_LAYOUT_SHORTCUTS.has(shortcuts.layout) ? shortcuts.layout : DEFAULT_SETTINGS.shortcuts.layout,
      comparison: SETTINGS_COMPARISON_SHORTCUTS.has(shortcuts.comparison) ? shortcuts.comparison : DEFAULT_SETTINGS.shortcuts.comparison,
    },
  };
}

let appSettings = normalizeSettings(loadFromStorage(STORAGE_KEYS.settings, null));

function persistSettings() {
  saveToStorage(STORAGE_KEYS.settings, appSettings);
}


const storedModelOrder = loadFromStorage(STORAGE_KEYS.modelOrder, []);
const persistedModelOrder = Array.isArray(storedModelOrder) ? storedModelOrder : [];
let themeMode = THEME_MODES.has(loadFromStorage(STORAGE_KEYS.theme, "system"))
  ? loadFromStorage(STORAGE_KEYS.theme, "system")
  : "system";
const systemThemeQuery = window.matchMedia("(prefers-color-scheme: dark)");
const storedHiddenDefaults = loadFromStorage(STORAGE_KEYS.hiddenDefaultModels, []);
let hiddenDefaultModelIds = new Set(
  Array.isArray(storedHiddenDefaults)
    ? storedHiddenDefaults.filter((id) => typeof id === "string" && DEFAULT_MODEL_IDS.has(id))
    : [],
);
let currentLayout = loadFromStorage(STORAGE_KEYS.layout, "dual");
if (!LAYOUT_PRESETS[currentLayout]) {
  currentLayout = "dual";
}

const controlPanel = document.querySelector(".control-panel");
const sidebarToggle = document.getElementById("sidebarToggle");
const layoutControls = document.getElementById("layoutControls");
const layoutButtons = Array.from(layoutControls.querySelectorAll("[data-layout]"));
const themeOptions = Array.from(document.querySelectorAll(".theme-option"));

themeOptions.forEach((button) => {
  button.addEventListener("click", () => {
    themeMode = THEME_MODES.has(button.dataset.themeMode) ? button.dataset.themeMode : "system";
    applyTheme({ persist: true });
  });
});

systemThemeQuery.addEventListener("change", () => {
  if (themeMode === "system") {
    applyTheme();
  }
});

applyTheme();
const modelList = document.getElementById("modelList");
const modelAddButton = document.getElementById("modelAddButton");
const modelRestoreDefaultsButton = document.getElementById("modelRestoreDefaultsButton");
const appShell = document.querySelector(".app-shell");
const modelAddDialog = document.getElementById("modelAddDialog");
const modelAddForm = document.getElementById("modelAddForm");
const modelAddNameInput = document.getElementById("modelAddName");
const modelAddUrlInput = document.getElementById("modelAddUrl");
const modelAddAutoSendInput = document.getElementById("modelAddAutoSend");
const modelAddCancel = document.getElementById("modelAddCancel");
const settingsButton = document.getElementById("settingsButton");
const collapsedSettingsButton = document.getElementById("collapsedSettingsButton");
const settingsDialog = document.getElementById("settingsDialog");
const settingsForm = document.getElementById("settingsForm");
const settingsClose = document.getElementById("settingsClose");
const settingsCancel = document.getElementById("settingsCancel");
const settingsReset = document.getElementById("settingsReset");
const settingsSendShortcut = document.getElementById("settingsSendShortcut");
const settingsLayoutShortcut = document.getElementById("settingsLayoutShortcut");
const settingsComparisonShortcut = document.getElementById("settingsComparisonShortcut");
const settingsSendMode = document.getElementById("settingsSendMode");
const settingsComparisonModel = document.getElementById("settingsComparisonModel");
const settingsAutoUpload = document.getElementById("settingsAutoUpload");
const settingsConfirmSummary = document.getElementById("settingsConfirmSummary");
const settingsShowStatus = document.getElementById("settingsShowStatus");
const settingsTheme = document.getElementById("settingsTheme");
const settingsAutoZoom = document.getElementById("settingsAutoZoom");
const settingsAlwaysOnTop = document.getElementById("settingsAlwaysOnTop");
const settingsLaunchAtLogin = document.getElementById("settingsLaunchAtLogin");
const settingsVersion = document.getElementById("settingsVersion");
const settingsAboutStatus = document.getElementById("settingsAboutStatus");
const settingsOpenData = document.getElementById("settingsOpenData");
const settingsOpenRepo = document.getElementById("settingsOpenRepo");
const settingsOpenReleases = document.getElementById("settingsOpenReleases");
const panelsContainer = document.getElementById("panelsContainer");
const broadcastForm = document.getElementById("broadcastForm");
const composer = document.querySelector(".composer");
const composerDropHint = document.getElementById("composerDropHint");
const broadcastInput = document.getElementById("broadcastInput");
const attachmentInput = document.getElementById("attachmentInput");
const attachmentPreview = document.getElementById("attachmentPreview");
const attachmentLocalHint = document.getElementById("attachmentLocalHint");
const sendButton = document.getElementById("sendButton");
const sendModeEl = document.getElementById("sendMode");
const sendModeMenu = document.getElementById("sendModeMenu");
const sendModeOptions = Array.from(document.querySelectorAll(".send-mode-option"));
const messageQueueEl = document.getElementById("messageQueue");
const messageQueueTitle = document.getElementById("messageQueueTitle");
const messageQueueHint = document.getElementById("messageQueueHint");
const messageQueueList = document.getElementById("messageQueueList");
const queueSkipWait = document.getElementById("queueSkipWait");
const queueClear = document.getElementById("queueClear");
const addAttachmentBtn = document.getElementById("addAttachment");
const recordAudioButton = document.getElementById("recordAudioButton");
const stopRecordingButton = document.getElementById("stopRecordingButton");
const cancelRecordingButton = document.getElementById("cancelRecordingButton");
const broadcastStatus = document.getElementById("broadcastStatus");
const broadcastStatusList = document.getElementById("broadcastStatusList");
const broadcastStatusClear = document.getElementById("broadcastStatusClear");
const comparisonButton = document.getElementById("comparisonButton");
const comparisonDialog = document.getElementById("comparisonDialog");
const comparisonClose = document.getElementById("comparisonClose");
const comparisonRefresh = document.getElementById("comparisonRefresh");
const comparisonSyncScroll = document.getElementById("comparisonSyncScroll");
const comparisonSummarizer = document.getElementById("comparisonSummarizer");
const comparisonSummarize = document.getElementById("comparisonSummarize");
const comparisonStatus = document.getElementById("comparisonStatus");
const comparisonPrompt = document.getElementById("comparisonPrompt");
const comparisonEmpty = document.getElementById("comparisonEmpty");
const comparisonAnswers = document.getElementById("comparisonAnswers");
const comparisonSummary = document.getElementById("comparisonSummary");
const comparisonSummaryText = document.getElementById("comparisonSummaryText");

// 折叠工具栏元素
const collapsedDateEl = document.getElementById("collapsedDate");
const collapsedTimeEl = document.getElementById("collapsedTime");
const collapsedLayoutButtons = Array.from(document.querySelectorAll(".collapsed-layout-btn"));
const screenshotBtn = document.getElementById("screenshotBtn");

autoResize(broadcastInput);
broadcastInput.addEventListener("input", () => {
  draftRevision += 1;
  pendingBroadcastTurn = null;
  autoResize(broadcastInput);
  syncComposerState();
});

broadcastInput.addEventListener("paste", async (event) => {
  const clipboardData = event.clipboardData || window.clipboardData;
  if (!clipboardData) {
    return;
  }

  const files = Array.from(clipboardData.files || []);
  const imageFiles = files.filter((file) => file.type && file.type.startsWith("image/"));

  if (imageFiles.length === 0) {
    return;
  }

  event.preventDefault();
  const text = clipboardData.getData('text');
  if (text) {
    const start = broadcastInput.selectionStart ?? broadcastInput.value.length;
    const end = broadcastInput.selectionEnd ?? start;
    const value = broadcastInput.value;
    broadcastInput.value = value.slice(0, start) + text + value.slice(end);
    const caret = start + text.length;
    broadcastInput.setSelectionRange(caret, caret);
    broadcastInput.dispatchEvent(new Event('input', { bubbles: true }));
  }

  // Clipboard files have no disk path, so the local-data-boundary filter cannot
  // verify them. Persist them into Qask's own visible folder first; that gives
  // the main process a file it owns and the user a file they can pick from a
  // website's upload dialog.
  let addedCount = 0;
  let savedCount = 0;
  let unsavedCount = 0;
  for (const file of imageFiles) {
    const entry = await addAttachment(file, "clipboard");
    if (!entry) continue;
    addedCount += 1;
    const saved = await persistAttachmentFile(file, ATTACHMENT_KINDS.image);
    if (!saved) {
      attachments.delete(entry.id);
      unsavedCount += 1;
      continue;
    }
    markAttachmentSaved(entry, saved);
    savedCount += 1;
  }
  if (addedCount > 0) {
    renderAttachmentPreview();
  }
  if (savedCount > 0) {
    logStatus(`粘贴了 ${savedCount} 张图片，已保存到 ~/Pictures/Qask Attachments/，可在网站上传界面选择`, "info");
  }
  if (unsavedCount > 0) {
    logStatus(`${unsavedCount} 张粘贴图片未能保存到本地文件夹，无法在网站上传界面选择`, "error");
  }
});

const modelRegistry = new Map();
const panels = [];
const parkedPanels = [];
let modelOrder = [];
let draggedModelId = null;
let keyboardDraggedModelId = null;
let keyboardDraggedOriginalOrder = null;
let activePanelCount = 2;
const attachments = new Map();
let attachmentCounter = 0;
let activeRecorder = null;
let activeRecordingSession = null;
let recordingStartPending = false;
let recordingGeneration = 0;
let isBroadcasting = false;
let draftRevision = 0;
let pendingBroadcastTurn = null;
const SEND_MODE_VALUES = new Set(["send", "queue", "fill"]);
let sendModeValue = appSettings.sendMode;
const QUEUE_LIMIT = 20;
const QUEUE_ANSWER_POLL_MS = 1500;
const QUEUE_ANSWER_TIMEOUT_MS = 180000;
const QUEUE_ANSWER_STABLE_POLLS = 1;
const QUEUE_UNREADABLE_POLLS = 3;
let queuedMessages = [];
let queueProcessing = false;
let queueCurrentItem = null;
let queueSkipWaitRequested = false;
let queueSequence = 0;
let queueEditingId = null;
let queueDraggingId = null;
let sendModeCloseTimer = null;
let comparisonLastFocus = null;
let comparisonAnswersState = [];
let comparisonAnswersRefreshing = false;
let comparisonAnswersFrozen = false;
let comparisonSummarizing = false;
let comparisonRefreshTimer = null;
let comparisonSyncingScroll = false;
let comparisonLastPrompt = "";
const dispatchCoordinator = createDispatchCoordinator();

async function inspectSelectedAttachments(files) {
  const approved = [];
  const rejected = [];
  const paths = new Map();
  const inspect = window.qask?.attachments?.inspect;
  for (const file of Array.from(files || [])) {
    try {
      if (typeof inspect !== "function") {
        rejected.push({ file, reason: "local-data-boundary" });
        continue;
      }
      const inspection = await inspect(file);
      if (inspection?.allowed === true) {
        approved.push(file);
        if (typeof inspection.filePath === "string" && inspection.filePath) {
          paths.set(file, inspection.filePath);
        }
      } else {
        rejected.push({ file, reason: inspection?.reason || "local-data-boundary" });
      }
    } catch {
      rejected.push({ file, reason: "local-data-boundary" });
    }
  }
  return { approved, rejected, paths };
}

function setRecordingControls(isRecording) {
  if (recordAudioButton) recordAudioButton.hidden = isRecording;
  if (stopRecordingButton) stopRecordingButton.hidden = !isRecording;
  if (cancelRecordingButton) cancelRecordingButton.hidden = !isRecording;
  if (addAttachmentBtn) addAttachmentBtn.disabled = isRecording;
  syncComposerState();
}

function stopStreamTracks(stream) {
  if (stream) {
    stream.getTracks().forEach((track) => track.stop());
  }
}

// Chromium asks the main process again whenever the page opens another audio
// stream, and the main process only honours an active lease. Recording can run
// for two minutes while a lease lives for 30 s, so a live session keeps its
// lease fresh instead of turning a device change into a bogus permission error.
const MICROPHONE_LEASE_RENEW_INTERVAL_MS = 10_000;

function startMicrophoneLeaseRenewal(session) {
  if (!session?.leaseId || session.leaseRenewTimer) return;
  session.leaseRenewTimer = setInterval(() => {
    if (session.finalized) {
      clearMicrophoneLeaseRenewal(session);
      return;
    }
    window.qask?.microphone?.renewAccess?.(session.leaseId).catch(() => {});
  }, MICROPHONE_LEASE_RENEW_INTERVAL_MS);
}

function clearMicrophoneLeaseRenewal(session) {
  if (!session?.leaseRenewTimer) return;
  clearInterval(session.leaseRenewTimer);
  session.leaseRenewTimer = null;
}

function releaseMicrophoneLease(leaseId) {
  if (!leaseId) return;
  window.qask?.microphone?.releaseAccess?.(leaseId).catch(() => {});
}

function clearRecordingTimers(session) {
  if (!session) return;
  if (session.timer) clearInterval(session.timer);
  if (session.limitTimer) clearTimeout(session.limitTimer);
  clearMicrophoneLeaseRenewal(session);
  session.timer = null;
  session.limitTimer = null;
}

function getRecordingMimeType() {
  if (typeof MediaRecorder === "undefined") return "";
  return ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"].find((type) => MediaRecorder.isTypeSupported(type)) || "";
}

function recordingExtensionForType(type) {
  if (type.includes("ogg")) return "ogg";
  return "webm";
}

function stopActiveRecording(options = {}) {
  const session = activeRecordingSession;
  if (!session) {
    recordingGeneration += 1;
    recordingStartPending = false;
    setRecordingControls(false);
    return;
  }

  requestRecordingStopForSession(session, options);
}

function updateRecordingControlsAfterSession(session) {
  if (activeRecordingSession && activeRecordingSession !== session) {
    return;
  }
  setRecordingControls(false);
}

function discardRecordingSession(session, message = "") {
  if (!session || session.finalized) return;
  session.finalized = true;
  clearRecordingTimers(session);
  stopStreamTracks(session.stream);
  session.chunks.length = 0;
  releaseMicrophoneLease(session.leaseId);
  if (activeRecordingSession === session) activeRecordingSession = null;
  if (activeRecorder === session.recorder) activeRecorder = null;
  updateRecordingControlsAfterSession(session);
}

function requestRecordingStopForSession(session, options = {}) {
  const action = requestRecordingStop(session, options);
  if (action === "cleanup" || action === "draining") return action;
  clearRecordingTimers(session);
  try {
    session.recorder.stop();
  } catch (_) {
    discardRecordingSession(session, options.message || "录音已停止");
  }
  return action;
}

async function finalizeRecordingSession(session) {
  if (!session || session.finalized) return;
  session.finalized = true;
  const chunks = session.chunks.slice();
  const shouldDiscard = session.discard;
  const stopMessage = session.stopMessage;
  clearRecordingTimers(session);
  stopStreamTracks(session.stream);
  releaseMicrophoneLease(session.leaseId);
  if (activeRecordingSession === session) activeRecordingSession = null;
  if (activeRecorder === session.recorder) activeRecorder = null;
  updateRecordingControlsAfterSession(session);
  session.chunks.length = 0;

  if (shouldDiscard || !chunks.length) {
    if (shouldDiscard) {
      logStatus("已取消录音，未保留任何音频", "info");
    }
    return;
  }

  const actualType = session.recorder?.mimeType || session.mimeType || "audio/webm";
  const blob = new Blob(chunks, { type: actualType });
  const recordedAt = new Date();
  const file = new File(
    [blob],
    `Qask-${recordedAt.toISOString().replace(/[:.]/g, "-").slice(0, -5)}.${recordingExtensionForType(actualType)}`,
    { type: actualType },
  );
  if (stopMessage) {
    logStatus(stopMessage, "info");
  } else {
    logStatus("录音已停止，正在保存本地文件", "info");
  }
  const entry = await addAttachment(file, "recording");
  if (!entry) {
    return;
  }
  const saved = await persistAttachmentFile(file, ATTACHMENT_KINDS.audio);
  if (saved) {
    markAttachmentSaved(entry, saved);
    renderAttachmentPreview();
    logStatus(`录音已保存到 ${saved.displayPath}；请在该网站的上传界面选择此文件`, "success");
  } else {
    attachments.delete(entry.id);
    renderAttachmentPreview();
    logStatus("录音未能保存到本地文件夹，无法在网站上传界面选择；请重新录制", "error");
  }
}

async function addAttachment(file, source = "local", filePath = null) {
  const validation = validateAttachmentMeta(file, Array.from(attachments.values()));
  if (!validation.valid) {
    logStatus(validation.reason, "error");
    return null;
  }

  const id = `att-${attachmentCounter++}`;
  const entry = {
    id,
    file,
    source,
    kind: validation.kind,
    savedFileName: null,
    savedPathLabel: null,
    filePath: typeof filePath === "string" ? filePath : null,
  };
  attachments.set(id, entry);
  return entry;
}

function markAttachmentSaved(entry, saved) {
  if (!entry || !saved) return;
  entry.savedFileName = saved.fileName;
  entry.savedPathLabel = saved.displayPath;
}

async function persistAttachmentFile(file, kind) {
  const persist = window.qask?.attachments?.persist;
  if (typeof persist !== "function" || !file) {
    return null;
  }
  try {
    const buffer = await file.arrayBuffer();
    if (!buffer || buffer.byteLength === 0) {
      return null;
    }
    const result = await persist({ buffer, name: file.name, type: file.type, kind });
    if (result?.saved !== true || typeof result.fileName !== "string") {
      return null;
    }
    return result;
  } catch (error) {
    return null;
  }
}

sidebarToggle.setAttribute("aria-label", "折叠侧边栏");

function autoResize(element) {
  if (!element) return;

  element.style.height = "auto";
  const minHeight = 20;
  const maxHeight = 120;
  const newHeight = Math.max(minHeight, Math.min(element.scrollHeight, maxHeight));
  element.style.height = `${newHeight}px`;
  if (element.scrollHeight > maxHeight) {
    element.style.overflowY = "auto";
  } else {
    element.style.overflowY = "hidden";
  }
}

function canSubmitComposer() {
  return Boolean(broadcastInput?.value.trim() || attachments.size > 0)
    && !isBroadcasting
    && !activeRecorder
    && !recordingStartPending;
}

function syncComposerState() {
  if (sendButton) {
    sendButton.disabled = !canSubmitComposer();
  }
  if (addAttachmentBtn) {
    addAttachmentBtn.disabled = Boolean(activeRecorder || recordingStartPending || isBroadcasting);
  }
  if (recordAudioButton) {
    recordAudioButton.disabled = Boolean(activeRecorder || recordingStartPending || isBroadcasting);
  }
}

const STATUS_LOG_LIMIT = 8;
const STATUS_LEVEL_PREFIXES = {
  error: "[错误]",
  warning: "[注意]",
  success: "[完成]",
  info: "[提示]",
};

function normalizeStatusLevel(level) {
  return Object.hasOwn(STATUS_LEVEL_PREFIXES, level) ? level : "info";
}

// The visible transcript is the user-facing half of logStatus. Every message is
// a Qask-owned string, so it is written with textContent only: a page-derived
// value can never become markup here.
function appendStatusMessage(message, level) {
  if (!broadcastStatusList || !broadcastStatus) return;
  const item = document.createElement("li");
  item.dataset.level = normalizeStatusLevel(level);
  item.textContent = String(message);
  broadcastStatusList.appendChild(item);
  while (broadcastStatusList.children.length > STATUS_LOG_LIMIT) {
    broadcastStatusList.firstElementChild?.remove();
  }
  applyStatusBarVisibility();
  if (!broadcastStatus.hidden) {
    broadcastStatus.scrollTop = broadcastStatus.scrollHeight;
  }
}

function clearStatusMessages() {
  if (broadcastStatusList) {
    broadcastStatusList.replaceChildren();
  }
  if (broadcastStatus) {
    broadcastStatus.hidden = true;
  }
}

function logStatus(message, level = "info") {
  const normalizedLevel = normalizeStatusLevel(level);
  const prefix = STATUS_LEVEL_PREFIXES[normalizedLevel];
  const method = normalizedLevel === "error"
    ? console.error
    : normalizedLevel === "warning" ? console.warn : console.info;
  method(`${prefix} ${message}`);
  appendStatusMessage(message, normalizedLevel);
}


function getBroadcastBlockReason() {
  if (activeRecorder || recordingStartPending) {
    return "请先停止或取消录音，再发送消息";
  }
  return "";
}

// Refocusing the composer is only polite when the composer is where the user
// already is. A broadcast can settle seconds later, by which time the user may
// have clicked into a panel to read an answer; yanking focus back into the
// textarea then interrupts them mid-read.
function restoreComposerFocusAfterBroadcast() {
  const active = document.activeElement;
  const composerOwnsFocus = !active || active === document.body || active === broadcastInput;
  if (!composerOwnsFocus) return;
  setTimeout(() => {
    if (document.activeElement !== broadcastInput) {
      broadcastInput.focus({ preventScroll: true });
    }
  }, 0);
}

function normalizeId(label) {
  const base = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-") // 支持中文字符
    .replace(/^-+|-+$/g, "") || "model";
  let candidate = base;
  let counter = 1;
  while (modelRegistry.has(candidate)) {
    candidate = `${base}-${counter++}`;
  }
  return candidate;
}

let modelDialogLastFocus = null;

function isModelAddDialogOpen() {
  return !!(modelAddDialog && !modelAddDialog.hasAttribute("hidden"));
}

function getModelAddDialogFocusableElements() {
  if (!modelAddDialog) return [];
  return Array.from(modelAddDialog.querySelectorAll(
    'button:not([disabled]), input:not([disabled]), [href], select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  )).filter((element) => !element.hasAttribute("hidden"));
}

function trapModelAddDialogFocus(event) {
  if (!isModelAddDialogOpen() || event.key !== "Tab") return;
  const focusable = getModelAddDialogFocusableElements();
  if (!focusable.length) {
    event.preventDefault();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function openModelAddDialog() {
  if (!modelAddDialog) {
    logStatus("暂不支持添加模型", "error");
    return;
  }
  modelDialogLastFocus = document.activeElement;
  appShell?.setAttribute("inert", "");
  if (modelAddForm) {
    modelAddForm.reset();
  }
  modelAddDialog.removeAttribute("hidden");
  modelAddDialog.removeAttribute("aria-hidden");
  setTimeout(() => {
    modelAddNameInput?.focus();
  }, 0);
}

function closeModelAddDialog() {
  if (!modelAddDialog) {
    return;
  }
  modelAddDialog.setAttribute("hidden", "");
  modelAddDialog.setAttribute("aria-hidden", "true");
  appShell?.removeAttribute("inert");
  if (modelAddForm) {
    modelAddForm.reset();
  }
  if (modelDialogLastFocus instanceof HTMLElement) {
    modelDialogLastFocus.focus();
  }
}

let settingsDialogLastFocus = null;

function isSettingsDialogOpen() {
  return !!(settingsDialog && !settingsDialog.hasAttribute("hidden"));
}

function getSettingsDialogFocusableElements() {
  if (!settingsDialog) return [];
  return Array.from(settingsDialog.querySelectorAll(
    'button:not([disabled]), input:not([disabled]), [href], select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  )).filter((element) => !element.hasAttribute("hidden"));
}

function trapSettingsDialogFocus(event) {
  if (!isSettingsDialogOpen() || event.key !== "Tab") return;
  const focusable = getSettingsDialogFocusableElements();
  if (!focusable.length) {
    event.preventDefault();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function populateSettingsComparisonModels() {
  if (!settingsComparisonModel) return;
  const current = appSettings.comparisonModelId || "auto";
  const options = [];
  options.push({ value: "auto", label: "自动（优先使用第一个可用面板）" });
  Array.from(modelRegistry.entries())
    .filter(([, config]) => config.allowAutoSend === true)
    .sort((a, b) => a[1].label.localeCompare(b[1].label, "zh-CN"))
    .forEach(([id, config]) => options.push({ value: id, label: config.label }));
  settingsComparisonModel.replaceChildren();
  options.forEach(({ value, label }) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    settingsComparisonModel.appendChild(option);
  });
  settingsComparisonModel.value = options.some((option) => option.value === current) ? current : "auto";
}

function applyStatusBarVisibility() {
  if (!broadcastStatus) return;
  const hasMessages = Boolean(broadcastStatusList?.children.length);
  broadcastStatus.hidden = !appSettings.showStatusBar || !hasMessages;
}

function openSettingsDialog() {
  if (!settingsDialog) return;
  if (isModelAddDialogOpen() || isComparisonDialogOpen()) return;
  settingsDialogLastFocus = document.activeElement;
  appShell?.setAttribute("inert", "");
  settingsSendShortcut.value = appSettings.shortcuts.send;
  settingsLayoutShortcut.value = appSettings.shortcuts.layout;
  settingsComparisonShortcut.value = appSettings.shortcuts.comparison;
  settingsSendMode.value = appSettings.sendMode;
  if (settingsTheme) settingsTheme.value = themeMode;
  if (settingsAutoZoom) settingsAutoZoom.checked = appSettings.autoPanelZoom;
  if (settingsAlwaysOnTop) settingsAlwaysOnTop.checked = appSettings.alwaysOnTop;
  if (settingsLaunchAtLogin) settingsLaunchAtLogin.checked = appSettings.launchAtLogin;
  if (settingsAutoUpload) settingsAutoUpload.checked = appSettings.autoUploadAttachments;
  if (settingsConfirmSummary) settingsConfirmSummary.checked = appSettings.confirmSummary;
  if (settingsShowStatus) settingsShowStatus.checked = appSettings.showStatusBar;
  if (settingsAboutStatus) settingsAboutStatus.textContent = "";
  if (settingsVersion) settingsVersion.textContent = "…";
  Promise.resolve(window.qask?.app?.info?.())
    .then((info) => {
      if (settingsVersion && info?.version) settingsVersion.textContent = `v${info.version}`;
    })
    .catch(() => {
      if (settingsVersion) settingsVersion.textContent = "v1.0.3";
    });
  populateSettingsComparisonModels();
  settingsDialog.removeAttribute("hidden");
  settingsDialog.removeAttribute("aria-hidden");
  setTimeout(() => {
    settingsSendShortcut?.focus();
  }, 0);
}

function closeSettingsDialog({ restoreFocus = true } = {}) {
  if (!settingsDialog) return;
  settingsDialog.setAttribute("hidden", "");
  settingsDialog.setAttribute("aria-hidden", "true");
  appShell?.removeAttribute("inert");
  if (restoreFocus && settingsDialogLastFocus instanceof HTMLElement) {
    settingsDialogLastFocus.focus();
  }
}

function applyWindowPreferences() {
  Promise.resolve(window.qask?.window?.setAlwaysOnTop?.(appSettings.alwaysOnTop)).catch(() => {});
  Promise.resolve(window.qask?.app?.setLaunchAtLogin?.(appSettings.launchAtLogin)).catch(() => {});
}

function resetSettingsForm() {
  settingsSendShortcut.value = DEFAULT_SETTINGS.shortcuts.send;
  settingsLayoutShortcut.value = DEFAULT_SETTINGS.shortcuts.layout;
  settingsComparisonShortcut.value = DEFAULT_SETTINGS.shortcuts.comparison;
  settingsSendMode.value = DEFAULT_SETTINGS.sendMode;
  if (settingsTheme) settingsTheme.value = "system";
  if (settingsAutoZoom) settingsAutoZoom.checked = DEFAULT_SETTINGS.autoPanelZoom;
  if (settingsAlwaysOnTop) settingsAlwaysOnTop.checked = DEFAULT_SETTINGS.alwaysOnTop;
  if (settingsLaunchAtLogin) settingsLaunchAtLogin.checked = DEFAULT_SETTINGS.launchAtLogin;
  if (settingsAutoUpload) settingsAutoUpload.checked = DEFAULT_SETTINGS.autoUploadAttachments;
  if (settingsConfirmSummary) settingsConfirmSummary.checked = DEFAULT_SETTINGS.confirmSummary;
  settingsShowStatus.checked = DEFAULT_SETTINGS.showStatusBar;
  if (settingsComparisonModel) settingsComparisonModel.value = "auto";
}

function isRestrictedCustomProviderUrl(url) {
  let parsedUrl;
  try {
    parsedUrl = url instanceof URL ? url : new URL(url);
  } catch {
    return true;
  }
  if (parsedUrl.protocol !== "https:" || parsedUrl.username || parsedUrl.password || parsedUrl.search || parsedUrl.hash) {
    return true;
  }
  const host = parsedUrl.hostname;
  const normalizedHost = host.toLowerCase().replace(/\.+$/, "");
  return [
    "github.com",
    "api.github.com",
    "gist.github.com",
    "raw.githubusercontent.com",
    "githubusercontent.com",
  ].includes(normalizedHost)
    || normalizedHost.endsWith(".github.com")
    || normalizedHost.endsWith(".githubusercontent.com")
    || normalizedHost === "github.io"
    || normalizedHost.endsWith(".github.io")
    || normalizedHost === "github.dev"
    || normalizedHost.endsWith(".github.dev");
}

function getAllowedOrigins(model) {
  let primaryOrigin;
  try {
    const primaryUrl = new URL(model?.url);
    if (primaryUrl.protocol !== "https:") return [];
    primaryOrigin = primaryUrl.origin;
  } catch {
    return [];
  }

  const configuredOrigins = (Array.isArray(model?.allowedOrigins) ? model.allowedOrigins : [])
    .filter((origin) => !isRestrictedCustomProviderUrl(origin));
  return Array.from(new Set([primaryOrigin, ...configuredOrigins].filter((origin) => isTrustedGuestUrl(origin, [origin]))));
}

// Auth origins are needed for navigation (login redirects) but must never be
// targets for prompt injection. The navigation allowlist stays in main.js; this
// is the smaller renderer-side injection allowlist.
const AUTH_ONLY_ORIGINS = new Set([
  "https://auth.openai.com",
  "https://accounts.google.com",
  "https://login.microsoftonline.com",
  "https://login.live.com",
]);

function getInjectableOrigins(model) {
  return getAllowedOrigins(model).filter((origin) => !AUTH_ONLY_ORIGINS.has(origin));
}

function registerModel(model, { replace = false } = {}) {
  if (!model || typeof model.id !== "string" || !model.id.trim() || model.id.length > 120) {
    return false;
  }
  if (!replace && modelRegistry.has(model.id)) {
    logStatus(`${model.label} 已存在`, "error");
    return false;
  }
  const origin = model.origin || "custom";
  if (origin !== "default") {
    // A stored custom entry must never shadow a built-in adapter or reuse its
    // partition; ids come from normalizeId() and are re-validated on load.
    if (DEFAULT_MODEL_IDS.has(model.id) || !/^[a-z0-9\u4e00-\u9fa5-]+$/i.test(model.id)) {
      logStatus("自定义模型条目无效，已忽略", "error");
      return false;
    }
    if (isRestrictedCustomProviderUrl(model.url)) {
      logStatus("不能将 GitHub 站点注册为 AI 模型，以保护本地 GitHub 信息", "error");
      return false;
    }
  }
  const normalized = {
    ...model,
    origin,
    partition: origin === "default" ? model.partition : `persist:${model.id}`,
    composeMessageScript: model.composeMessageScript || buildGenericScript,
    allowAutoSend: origin === "default" || Boolean(model.allowAutoSend),
  };
  normalized.allowedOrigins = getAllowedOrigins(normalized);
  normalized.injectableOrigins = getInjectableOrigins(normalized);
  if (!normalized.allowedOrigins.length || !normalized.injectableOrigins.length) {
    logStatus(`${model.label} 的网站地址无效`, "error");
    return false;
  }
  modelRegistry.set(model.id, normalized);
  syncModelOrder();
  if (normalized.origin !== "default") {
    persistCustomModels();
    persistModelOrder();
  }
  if (panels.length > 0) {
    refreshModelList();
  }
  return true;
}

function removeModel(modelId) {
  if (!modelRegistry.has(modelId)) {
    return;
  }
  const model = modelRegistry.get(modelId);
  const label = model?.label ?? modelId;
  if (model?.origin === "default") {
    // Built-ins are re-registered at startup, so remember the removal and skip
    // it next launch; the restore button can bring it back without losing data.
    hiddenDefaultModelIds.add(modelId);
    persistHiddenDefaultModels();
  }
  modelRegistry.delete(modelId);
  syncModelOrder();
  persistModelOrder();
  [...panels, ...parkedPanels].forEach((panelState) => {
    if (panelState.modelId === modelId) {
      panelState.modelId = null;
      swapWebview(panelState, null);
    }
  });
  persistCustomModels();
  reconcileActivePanelsToModelOrder();
  logStatus(`${label} 已移除`, "info");
}

function restoreDefaultModels() {
  const restoredIds = [];
  DEFAULT_MODELS.forEach((model) => {
    if (!hiddenDefaultModelIds.has(model.id)) {
      return;
    }
    if (registerModel(model, { replace: true })) {
      restoredIds.push(model.id);
    }
    hiddenDefaultModelIds.delete(model.id);
  });
  if (!restoredIds.length) {
    persistHiddenDefaultModels();
    refreshModelList();
    logStatus("没有需要恢复的默认网站", "info");
    return;
  }
  persistHiddenDefaultModels();
  modelOrder = normalizeModelOrder([...modelOrder, ...restoredIds], Array.from(modelRegistry.keys()));
  persistModelOrder();
  reconcileActivePanelsToModelOrder();
  refreshModelList();
  logStatus(`已恢复 ${restoredIds.length} 个默认网站`, "success");
}

function syncDefaultRestoreButton() {
  if (!modelRestoreDefaultsButton) return;
  const count = hiddenDefaultModelIds.size;
  modelRestoreDefaultsButton.hidden = count === 0;
  modelRestoreDefaultsButton.textContent = count > 0 ? `恢复默认网站（${count}）` : "恢复默认网站";
}

function getModelOptions() {
  return modelOrder
    .map((modelId) => modelRegistry.get(modelId))
    .filter(Boolean);
}

function setModelOrderStatus(message) {
  const status = document.getElementById("modelOrderStatus");
  if (status) {
    status.textContent = message;
  }
}

function getDropTargetIndex(event, item) {
  const bounds = item.getBoundingClientRect();
  const itemIndex = modelOrder.indexOf(item.dataset.modelId);
  return event.clientY < bounds.top + (bounds.height / 2) ? itemIndex : itemIndex + 1;
}

function clearModelDragState() {
  draggedModelId = null;
  modelList.querySelectorAll(".is-dragging, .drop-before, .drop-after").forEach((item) => {
    item.classList.remove("is-dragging", "drop-before", "drop-after");
  });
}

function cancelKeyboardModelDrag() {
  if (!keyboardDraggedModelId) return;
  const originalOrder = keyboardDraggedOriginalOrder;
  const movedModelId = keyboardDraggedModelId;
  keyboardDraggedModelId = null;
  keyboardDraggedOriginalOrder = null;
  if (Array.isArray(originalOrder) && originalOrder.join("\u0000") !== modelOrder.join("\u0000")) {
    modelOrder = normalizeModelOrder(originalOrder, Array.from(modelRegistry.keys()));
    persistModelOrder();
    reconcileActivePanelsToModelOrder();
    getModelDragHandle(movedModelId)?.focus();
    const label = modelRegistry.get(movedModelId)?.label ?? movedModelId;
    setModelOrderStatus(`已取消 ${label} 的键盘排序，已恢复原位置。`);
    return;
  }
  refreshModelList();
  setModelOrderStatus("已取消键盘排序。");
}

function commitModelOrder(nextOrder, movedModelId) {
  const normalizedOrder = normalizeModelOrder(nextOrder, Array.from(modelRegistry.keys()));
  if (normalizedOrder.join("\u0000") === modelOrder.join("\u0000")) {
    clearModelDragState();
    return;
  }
  modelOrder = normalizedOrder;
  persistModelOrder();
  reconcileActivePanelsToModelOrder();
  clearModelDragState();
  const rank = modelOrder.indexOf(movedModelId) + 1;
  const label = modelRegistry.get(movedModelId)?.label ?? movedModelId;
  setModelOrderStatus(`已将 ${label} 调整为第 ${rank} 位，当前布局已更新。`);
}

function getModelDragHandle(modelId) {
  const item = Array.from(modelList.querySelectorAll("li[data-model-id]"))
    .find((candidate) => candidate.dataset.modelId === modelId);
  return item?.querySelector(".model-drag-handle") || null;
}

function refreshModelList() {
  modelList.innerHTML = "";
  const activeModelIds = new Set(getRankedModelIds(modelOrder, activePanelCount));
  getModelOptions().forEach((model) => {
    const item = document.createElement("li");
    item.dataset.modelId = model.id;
    item.classList.toggle("is-active", activeModelIds.has(model.id));

    const dragHandle = document.createElement("button");
    dragHandle.type = "button";
    dragHandle.className = "model-drag-handle";
    dragHandle.draggable = true;
    dragHandle.innerHTML = `<svg viewBox="0 0 12 16" width="12" height="16" aria-hidden="true" focusable="false">
      <g fill="currentColor">
        <circle cx="3" cy="3" r="1.15"/><circle cx="9" cy="3" r="1.15"/>
        <circle cx="3" cy="8" r="1.15"/><circle cx="9" cy="8" r="1.15"/>
        <circle cx="3" cy="13" r="1.15"/><circle cx="9" cy="13" r="1.15"/>
      </g>
    </svg>`;
    dragHandle.setAttribute("aria-label", `拖动排序 ${model.label}`);
    dragHandle.title = "拖动排序";
    dragHandle.setAttribute("aria-pressed", "false");
    dragHandle.addEventListener("dragstart", (event) => {
      keyboardDraggedModelId = null;
      keyboardDraggedOriginalOrder = null;
      draggedModelId = model.id;
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("application/x-qask-model-id", model.id);
      item.classList.add("is-dragging");
    });
    dragHandle.addEventListener("dragend", clearModelDragState);
    dragHandle.addEventListener("keydown", (event) => {
      if (event.key === " " || event.key === "Enter") {
        event.preventDefault();
        const isDropping = keyboardDraggedModelId === model.id;
        keyboardDraggedModelId = isDropping ? null : model.id;
        keyboardDraggedOriginalOrder = isDropping ? null : [...modelOrder];
        refreshModelList();
        getModelDragHandle(model.id)?.focus();
        setModelOrderStatus(keyboardDraggedModelId
          ? `已选中 ${model.label}。使用上下方向键调整位置，按 Escape 取消。`
          : `已放下 ${model.label}。`);
        return;
      }
      if (event.key === "Escape" && keyboardDraggedModelId) {
        event.preventDefault();
        cancelKeyboardModelDrag();
        return;
      }
      if (!keyboardDraggedModelId || keyboardDraggedModelId !== model.id) return;
      const direction = event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0;
      if (!direction) return;
      event.preventDefault();
      const currentIndex = modelOrder.indexOf(model.id);
      const targetIndex = Math.max(0, Math.min(modelOrder.length - 1, currentIndex + direction));
      if (targetIndex === currentIndex) return;
      commitModelOrder(moveModelOrder(modelOrder, model.id, targetIndex), model.id);
      keyboardDraggedModelId = model.id;
      refreshModelList();
      getModelDragHandle(model.id)?.focus();
    });

    const label = document.createElement("span");
    label.className = "model-list-label";
    label.textContent = model.label;

    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "model-remove";
    deleteButton.setAttribute("aria-label", `删除 ${model.label}`);
    deleteButton.title = deleteButton.getAttribute("aria-label");
    deleteButton.addEventListener("click", () => removeModel(model.id));

    item.append(dragHandle, label, deleteButton);
    if (keyboardDraggedModelId === model.id) {
      item.classList.add("is-keyboard-dragging");
      dragHandle.setAttribute("aria-pressed", "true");
    }
    modelList.appendChild(item);
  });
  syncDefaultRestoreButton();
}

modelList.addEventListener("dragover", (event) => {
  const item = event.target instanceof Element ? event.target.closest("li[data-model-id]") : null;
  if (!item || !draggedModelId || item.dataset.modelId === draggedModelId) {
    return;
  }
  event.preventDefault();
  event.dataTransfer.dropEffect = "move";
  modelList.querySelectorAll(".drop-before, .drop-after").forEach((candidate) => {
    candidate.classList.remove("drop-before", "drop-after");
  });
  const targetIndex = getDropTargetIndex(event, item);
  item.classList.add(targetIndex <= modelOrder.indexOf(item.dataset.modelId) ? "drop-before" : "drop-after");
});

modelList.addEventListener("dragleave", (event) => {
  if (event.relatedTarget instanceof Node && modelList.contains(event.relatedTarget)) {
    return;
  }
  modelList.querySelectorAll(".drop-before, .drop-after").forEach((item) => {
    item.classList.remove("drop-before", "drop-after");
  });
});

modelList.addEventListener("drop", (event) => {
  const item = event.target instanceof Element ? event.target.closest("li[data-model-id]") : null;
  const modelId = event.dataTransfer.getData("application/x-qask-model-id");
  if (!item || !draggedModelId || modelId !== draggedModelId || !modelRegistry.has(modelId)) {
    clearModelDragState();
    return;
  }
  event.preventDefault();
  const targetIndex = getDropTargetIndex(event, item);
  const adjustedTargetIndex = getAdjustedDropTargetIndex(modelOrder, modelId, targetIndex);
  commitModelOrder(moveModelOrder(modelOrder, modelId, adjustedTargetIndex), modelId);
});

function createPanel(index) {
  const root = document.createElement("section");
  root.className = "panel";
  root.dataset.panelId = `panel-${index}`;

  const viewWrapper = document.createElement("div");
  viewWrapper.className = "panel-webview-wrapper";

  const siteChip = document.createElement("span");
  siteChip.className = "panel-site-chip";
  siteChip.hidden = true;
  siteChip.setAttribute("aria-hidden", "true");

  const stateOverlay = document.createElement("div");
  stateOverlay.className = "panel-state-overlay";
  stateOverlay.hidden = true;
  stateOverlay.setAttribute("role", "status");
  stateOverlay.setAttribute("aria-live", "polite");
  const stateText = document.createElement("p");
  stateText.className = "panel-state-text";
  const reloadButton = document.createElement("button");
  reloadButton.type = "button";
  reloadButton.className = "panel-state-reload";
  reloadButton.textContent = "重新加载";
  reloadButton.setAttribute("aria-label", "重新加载此面板");
  stateOverlay.append(stateText, reloadButton);

  root.append(viewWrapper, siteChip, stateOverlay);

  const panelState = {
    id: `panel-${index}`,
    root,
    viewWrapper,
    siteChip,
    stateOverlay,
    stateText,
    reloadButton,
    webview: null,
    modelId: null,
    ready: false,
    loadState: PANEL_LOAD_STATES.loading,
    zoomFactor: appSettings.autoPanelZoom ? getAutomaticPanelZoom(currentLayout) : 1,
  };
  reloadButton.addEventListener("click", () => reloadPanel(panelState));
  return panelState;
}

function showPanelStateOverlay(panelState, message, { reloadable = true } = {}) {
  if (!panelState?.stateOverlay) return;
  panelState.stateText.textContent = message;
  panelState.reloadButton.hidden = !reloadable;
  panelState.stateOverlay.hidden = false;
}

function hidePanelStateOverlay(panelState) {
  if (!panelState?.stateOverlay) return;
  panelState.stateOverlay.hidden = true;
}

// A failed or crashed guest has no in-page recovery affordance; the user needs
// one host-side action. Reload keeps the panel's session partition, so logins
// survive the retry.
function reloadPanel(panelState) {
  if (!panelState) return;
  const webview = panelState.webview;
  hidePanelStateOverlay(panelState);
  if (!webview) {
    if (panelState.modelId) {
      loadModel(panelState, panelState.modelId);
    }
    return;
  }
  dispatchCoordinator.reset(webview);
  updatePanelLoadState(panelState, "start");
  logStatus(`${getPanelLabel(panelState)} 正在重新加载`, "info");
  try {
    webview.reload();
  } catch (error) {
    if (panelState.modelId) {
      loadModel(panelState, panelState.modelId);
    }
  }
}

function applyPanelZoom(panelState) {
  const webview = panelState.webview;
  if (!webview || !panelState.ready || typeof webview.setZoomFactor !== "function") {
    return;
  }

  const factor = clampPanelZoom(panelState.zoomFactor);
  try {
    webview.setZoomFactor(factor);
  } catch (error) {
    console.warn(`[zoom] ${panelState.id} 缩放设置失败`, error);
  }
}

function syncAutomaticPanelZoom() {
  [...panels, ...parkedPanels].forEach((panelState) => {
    panelState.zoomFactor = appSettings.autoPanelZoom ? getAutomaticPanelZoom(currentLayout) : 1;
    applyPanelZoom(panelState);
  });
}

function swapWebview(panelState, newWebview) {
  if (panelState.webview) {
    panelState.webview.remove();
  }
  if (!newWebview) {
    panelState.root.removeAttribute("aria-label");
    if (panelState.siteChip) {
      panelState.siteChip.hidden = true;
      panelState.siteChip.textContent = "";
    }
  }
  panelState.webview = newWebview;
  updatePanelLoadState(panelState, "start");
  if (newWebview) {
    panelState.viewWrapper.appendChild(newWebview);
  }
}

function traceLayoutState(stage, extra = {}) {
  if (!layoutLifecycleTraceEnabled) return;
  console.info("[qask-layout-trace]", JSON.stringify({
    event: "layout-state",
    stage,
    layout: currentLayout,
    activePanelCount,
    modelOrder: modelOrder.slice(0, activePanelCount),
    activePanels: panels.map((panelState) => ({
      panelId: panelState.id,
      modelId: panelState.modelId,
      rank: panelState.root.dataset.panelRank || null,
      hidden: panelState.root.hidden,
      order: panelState.root.style.order || null,
    })),
    parkedPanels: parkedPanels.map((panelState) => ({
      panelId: panelState.id,
      modelId: panelState.modelId,
      hidden: panelState.root.hidden,
    })),
    ...extra,
  }));
}

function loadModel(panelState, modelId) {
  const config = modelRegistry.get(modelId);

  if (!config) {
    console.error(`模型配置未找到: ${modelId}`);
    return;
  }

  if (!config.url) {
    console.error(`模型 ${modelId} 没有 URL 配置`);
    swapWebview(panelState, null);
    panelState.modelId = null;
    return;
  }

  const webview = document.createElement("webview");
  webview.className = "model-view";
  webview.setAttribute("aria-label", `${config.label} 网页面板`);
  webview.setAttribute("partition", config.partition || `persist:${modelId}`);
  webview.style.width = "100%";
  webview.style.height = "100%";
  webview.style.flex = "1";
  webview.src = config.url;
  const loadStartedAt = performance.now();

  const traceLifecycle = (event, extra = {}) => {
    if (!layoutLifecycleTraceEnabled) return;
    let origin = "";
    try {
      origin = new URL(webview.getURL?.() || config.url).origin;
    } catch {}
    console.info("[qask-layout-trace]", JSON.stringify({
      panelId: panelState.id,
      modelId,
      event,
      origin,
      elapsedMs: Math.round(performance.now() - loadStartedAt),
      ...extra,
    }));
  };

  webview.addEventListener("dom-ready", () => {
    if (panelState.webview !== webview) {
      return;
    }
    hidePanelStateOverlay(panelState);
    const previousLoadState = panelState.loadState;
    updatePanelLoadState(panelState, "ready");
    traceLifecycle("dom-ready");
    applyPanelZoom(panelState);
    if (!shouldRunPanelReadyEffects(previousLoadState, panelState.loadState)) {
      return;
    }
    logStatus(`${config.label} 已就绪，可以填充内容`, "success");
    const currentUrl = webview.getURL?.() || "";
    if (!isTrustedGuestUrl(currentUrl, config.injectableOrigins || [])) {
      return;
    }
    webview.insertCSS(`
      :root, html, body {
        overscroll-behavior-y: contain;
      }
    `).catch(() => {});
    webview.executeJavaScript(`
      (() => {
        const root = document.documentElement;
        const body = document.body;
        if (root && getComputedStyle(root).overflowY === 'hidden') {
          root.style.overflowY = 'auto';
        }
        if (body && getComputedStyle(body).overflowY === 'hidden') {
          body.style.overflowY = 'auto';
        }
      })();
    `, true).catch(() => {});
  });

  webview.addEventListener("did-start-navigation", (event) => {
    if (panelState.webview !== webview) return;
    if (!event.isMainFrame || event.isInPlace) return;
    // A new document cannot still be running a script injected into the old one.
    dispatchCoordinator.reset(webview);
    hidePanelStateOverlay(panelState);
    updatePanelLoadState(panelState, "start");
    traceLifecycle("did-start-navigation");
  });

  webview.addEventListener("did-start-loading", () => {
    if (panelState.webview !== webview) return;
    traceLifecycle("did-start-loading");
  });

  webview.addEventListener("did-finish-load", () => {
    if (panelState.webview !== webview) return;
    hidePanelStateOverlay(panelState);
    updatePanelLoadState(panelState, "ready");
    traceLifecycle("did-finish-load");
    applyPanelZoom(panelState);
  });

  webview.addEventListener("did-fail-load", (event) => {
    if (panelState.webview !== webview) return;
    if (!event.isMainFrame) return;
    // Electron reports ERR_ABORTED (-3) for a superseded navigation. It is not a
    // page-load failure and must not lock an otherwise usable conversation panel.
    if (event.errorCode === -3) return;
    // A delayed failure from an earlier navigation must not demote a page that
    // has already become ready for a newer document.
    if (panelState.loadState !== PANEL_LOAD_STATES.loading) return;
    updatePanelLoadState(panelState, "fail");
    dispatchCoordinator.reset(webview);
    traceLifecycle("did-fail-load", { errorCode: event.errorCode });
    showPanelStateOverlay(panelState, `${config.label} 加载失败，请检查网络后重新加载`);
    logStatus(`${config.label} 加载失败，请检查网络`, "error");
  });

  // WebviewDocumentEvents render-process-gone is the guest-renderer equivalent
  // of a tab crash: without this the panel would stay "ready" forever.
  webview.addEventListener("render-process-gone", (event) => {
    if (panelState.webview !== webview) return;
    const reason = event?.details?.reason || "unknown";
    dispatchCoordinator.reset(webview);
    updatePanelLoadState(panelState, "fail");
    showPanelStateOverlay(panelState, `${config.label} 页面进程已退出（${reason}），可重新加载`);
    traceLifecycle("render-process-gone", { reason });
    logStatus(`${config.label} 页面进程已退出，请重新加载面板`, "error");
  });

  hidePanelStateOverlay(panelState);
  panelState.root.setAttribute("aria-label", `${config.label} 网页面板`);
  if (panelState.siteChip) {
    panelState.siteChip.textContent = config.label;
    panelState.siteChip.hidden = false;
  }
  swapWebview(panelState, webview);
  panelState.modelId = modelId;
}

function reconcileActivePanelsToModelOrder() {
  const panelPool = [...panels, ...parkedPanels];
  const placement = getPanelPoolPlacement(
    panelPool.map((panelState) => panelState.modelId),
    modelOrder,
    activePanelCount,
  );
  const { plan } = placement;

  plan.forEach(({ index, panelIndex }) => {
    const panelState = panelPool[panelIndex];
    if (panelState) {
      panelState.root.style.order = String(index);
      panelState.root.hidden = false;
    }
  });

  plan.filter(({ action }) => action === "load").forEach(({ panelIndex, modelId }) => {
    const panelState = panelPool[panelIndex];
    if (panelState) {
      loadModel(panelState, modelId);
    }
  });

  plan.filter(({ action }) => action === "clear").forEach(({ panelIndex }) => {
    const panelState = panelPool[panelIndex];
    if (panelState) {
      swapWebview(panelState, null);
      panelState.modelId = null;
    }
  });

  const orderedPanels = plan
    .map(({ panelIndex }) => panelPool[panelIndex])
    .filter(Boolean);
  const activePanelSet = new Set(orderedPanels);
  const orderedParkedPanels = panelPool.filter((panelState) => !activePanelSet.has(panelState));
  orderedParkedPanels.forEach((panelState) => {
    panelState.root.hidden = true;
    delete panelState.root.dataset.panelRank;
    panelState.root.dataset.panelModelId = panelState.modelId || "";
  });
  panels.splice(0, panels.length, ...orderedPanels);
  parkedPanels.splice(0, parkedPanels.length, ...orderedParkedPanels);
  panels.forEach((panelState, index) => {
    panelState.root.hidden = false;
    panelState.root.style.order = String(index);
    panelState.root.dataset.panelRank = String(index);
    panelState.root.dataset.panelModelId = panelState.modelId || "";
    applyPanelZoom(panelState);
  });

  const visiblePanelIndexes = panels.map((panelState) => panelPool.indexOf(panelState));
  const violation = getLayoutInvariantViolation({
    layoutId: currentLayout,
    panelCount: panels.length,
    activePanelIndexes: placement.activePanelIndexes,
    desiredModelIds: getRankedModelIds(modelOrder, activePanelCount),
    visiblePanelIndexes,
  });
  if (violation) {
    console.error(`[layout] invariant violation: ${violation}`);
  }
  traceLayoutState("reconciled", { violation });

  refreshModelList();
}

function ensurePanelCount(count) {
  activePanelCount = count;

  while (panels.length < count) {
    const panelState = parkedPanels.pop() || createPanel(panels.length);
    panels.push(panelState);
    if (!panelState.root.isConnected) {
      panelsContainer.appendChild(panelState.root);
    }
    panelState.root.hidden = false;
  }

  while (panels.length > count) {
    const removed = panels.pop();
    removed.root.hidden = true;
    parkedPanels.push(removed);
  }

  reconcileActivePanelsToModelOrder();
}

function getPanelLabel(panelState) {
  if (!panelState.modelId) {
    return panelState.id;
  }
  return modelRegistry.get(panelState.modelId)?.label ?? panelState.modelId;
}

function buildManualAttachmentReport(attachmentManifest = []) {
  return {
    requested: attachmentManifest.length,
    assigned: 0,
    confirmed: 0,
    unverified: [],
    manualRequired: attachmentManifest.map((item) => ({ id: item.id, name: item.name, reason: "manual-required" })),
  };
}

// The failure *message* stays the fixed local string the project guarantees: no
// text a page could influence is ever reflected into a log. The actionable part
// is derived only from local state (which adapter the shell chose), so a user
// still learns whether to expect a site redesign or a plain generic failure.
function buildDispatchFailureHint(usingFallback) {
  return usingFallback
    ? "该面板使用通用策略：请确认页面已加载完成，必要时重新加载面板后再试"
    : "该网站的结构可能已改版，或页面尚未加载完成；请切换到该面板确认状态";
}

async function dispatchMessage(panelState, text, attachmentManifest = [], { fillOnly = false } = {}) {
  if (!panelState.modelId) {
    return { panel: getPanelLabel(panelState), status: BROADCAST_STATUS.error, message: "未选择模型" };
  }
  if (!panelState.webview) {
    return { panel: getPanelLabel(panelState), status: BROADCAST_STATUS.error, message: "窗口尚未加载" };
  }
  if (!panelState.ready) {
    return { panel: getPanelLabel(panelState), status: BROADCAST_STATUS.error, message: "请等待页面加载完成" };
  }

  const config = modelRegistry.get(panelState.modelId);
  if (!config) {
    return { panel: getPanelLabel(panelState), status: BROADCAST_STATUS.error, message: "模型配置不可用", attachments: { requested: attachmentManifest.length, confirmed: 0 } };
  }

  // Checked after the config lookup so the message can name the panel the user
  // needs to wait for, and can say how long it has been working.
  if (dispatchCoordinator.isBusy(panelState.webview)) {
    const busySeconds = Math.round(dispatchCoordinator.busyForMs(panelState.webview) / 1000);
    return {
      panel: config.label,
      status: BROADCAST_STATUS.pending,
      message: busySeconds > 0
        ? `${config.label} 仍在处理上一条消息（已 ${busySeconds} 秒）；本面板未重发，以免出现重复提问`
        : `${config.label} 仍在处理上一条消息；本面板未重发，以免出现重复提问`,
    };
  }

  const currentUrl = panelState.webview.getURL?.() || "";
  if (!isTrustedGuestUrl(currentUrl, config.injectableOrigins || [])) {
    return {
      panel: config.label,
      status: BROADCAST_STATUS.error,
      message: "网页已跳转到未验证来源；为保护内容已取消发送",
      attachments: { requested: attachmentManifest.length, confirmed: 0, unverified: [], manualRequired: [] },
    };
  }

  const hasAttachments = attachmentManifest.length > 0;
  const attachmentPaths = hasAttachments
    ? attachmentManifest.map((item) => attachments.get(item.id)?.filePath).filter(Boolean)
    : [];
  let autoUploaded = false;
  let attachmentUploadFailed = false;
  if (hasAttachments
    && appSettings.autoUploadAttachments
    && attachmentPaths.length === attachmentManifest.length) {
    let guestId = null;
    try {
      guestId = panelState.webview.getWebContentsId?.() ?? null;
    } catch (error) {
      guestId = null;
    }
    const upload = guestId
      ? await window.qask?.attachments?.uploadToGuest?.({
        webContentsId: guestId,
        filePaths: attachmentPaths,
        fileTypes: attachmentManifest.map((item) => item.type || ""),
        fileNames: attachmentManifest.map((item) => item.name || ""),
      })
      : null;
    if (!upload?.ok) {
      attachmentUploadFailed = true;
    } else {
      autoUploaded = true;
    }
    // Give the site a moment to create its upload preview before sending text.
    await new Promise((resolve) => setTimeout(resolve, 2500));
  }
  // Attachment bytes never enter the guest script. Text can still ride the
  // normal adapter; the result says whether the files were placed in the site's
  // file input or still need a manual upload.
  const attachmentHint = hasAttachments
    ? (autoUploaded
      ? "；附件已填入网页上传控件，请确认预览"
      : attachmentUploadFailed
        ? "；附件自动上传失败，请在该网页手动上传"
        : "；附件仍在本机，请在各网页手动上传")
    : "";
  const usingFallback = (config.composeMessageScript === buildGenericScript);
  const script = buildOriginGuardedScript(
    (config.composeMessageScript || buildGenericScript)(text, config.allowAutoSend && !fillOnly ? true : false, []),
    config.injectableOrigins || [],
  );

  try {
    const result = await dispatchCoordinator.run(
      panelState.webview,
      () => panelState.webview.executeJavaScript(script, true),
    );
    if (result?.skipped) {
      return {
        panel: config.label,
        status: BROADCAST_STATUS.pending,
        message: `${config.label} 仍在处理上一条消息；本面板未重发，以免出现重复提问`,
      };
    }
    if (result && result.success && result.hostClickRequired && panelState.modelId === "kimi") {
      let guestId = null;
      try { guestId = panelState.webview.getWebContentsId?.() ?? null; } catch (error) { guestId = null; }
      const hostClick = guestId
        ? await window.qask?.guest?.clickKimiSend?.(guestId)
        : null;
      if (hostClick?.ok) {
        result.autoSent = true;
        result.hostClicked = true;
      } else {
        result.sendControlDisabled = true;
      }
    }
    if (result && result.success) {
      const autoSentText = result.autoSent ? "已尝试触发网页发送" : "已填充输入框";
      const sendControlHint = result.sendControlDisabled === true
        ? "（发送按钮仍不可用，请在该网页手动发送）"
        : "";
      return {
        panel: config.label,
        status: BROADCAST_STATUS.success,
        message: `${config.label} ${autoSentText}${sendControlHint}${usingFallback ? " (通用策略)" : ""}${attachmentHint}`,
        autoSent: result.autoSent === true,
        attemptedAutoSend: result.autoSent === true,
        attachmentUploaded: autoUploaded,
        attachmentUploadFailed,
      };
    }
    return {
      panel: config.label,
      status: BROADCAST_STATUS.error,
      message: `网页操作失败${usingFallback ? " (通用策略)" : ""}${attachmentHint}`,
      hint: buildDispatchFailureHint(usingFallback),
      attachments: buildManualAttachmentReport(attachmentManifest),
    };
  } catch (error) {
    return {
      panel: config.label,
      status: BROADCAST_STATUS.error,
      message: `网页操作失败${usingFallback ? " (通用策略)" : ""}${attachmentHint}`,
      hint: buildDispatchFailureHint(usingFallback),
      attachments: buildManualAttachmentReport(attachmentManifest),
    };
  }
}

function getResultStatusLevel(result) {
  if (result?.status === BROADCAST_STATUS.error) {
    // A watchdog expiry means "unconfirmed", not "the site refused".
    return isTimedOutResult(result) ? "warning" : "error";
  }
  if (result?.status === BROADCAST_STATUS.success) return "success";
  if (result?.status === BROADCAST_STATUS.partial
    || result?.status === BROADCAST_STATUS.pending) return "warning";
  return "info";
}

function presentResults(results) {
  results.forEach((entry) => {
    logStatus(`${entry.panel}: ${entry.message}`, getResultStatusLevel(entry));
    if (entry.status === BROADCAST_STATUS.error && entry.hint) {
      logStatus(`${entry.panel}: ${entry.hint}`, "info");
    }
  });
}

function logBroadcastSummary(results) {
  // Every recipient must be accounted for: a round where every panel came
  // back "partial" (attachments) previously logged no summary at all, leaving
  // the user unable to tell what happened to the other six sites. A watchdog
  // expiry is also reported as unconfirmed rather than as a failure.
  const summary = summarizeBroadcastResults(results);
  const attemptedCount = summary.attemptedAutoSend;
  const filledCount = summary.filled;
  const attachmentCount = summary.attachmentOnly;
  const pendingCount = summary.pending;
  const timedOutCount = summary.timedOut;
  const errorCount = summary.failed;

  if (attemptedCount > 0) {
    logStatus(`已尝试触发 ${attemptedCount} 个网页发送`, "success");
  }
  if (filledCount > 0) {
    logStatus(`已填充 ${filledCount} 个网页输入框，请在网页中确认发送`, "info");
  }
  if (attachmentCount > 0) {
    logStatus(`${attachmentCount} 个面板保留附件：请在各自网页手动上传后再发送`, "info");
  }
  if (timedOutCount > 0) {
    logStatus(`${timedOutCount} 个面板等待超时，尚未确认是否已发送；请稍候再试`, "info");
  }
  if (pendingCount > 0) {
    logStatus(`${pendingCount} 个面板仍在处理上一条消息，本轮已跳过`, "info");
  }
  if (errorCount > 0) {
    logStatus(`${errorCount} 个模型发送失败`, "error");
  }
  if (summary.total > 0) {
    logStatus(
      `本轮共 ${summary.total} 个面板：已尝试发送 ${attemptedCount} · 已填充 ${filledCount} · 待确认超时 ${timedOutCount} · 处理中跳过 ${pendingCount} · 需手动传附件 ${attachmentCount} · 失败 ${errorCount}`,
      errorCount > 0 ? "error" : "info",
    );
  }
}

function formatBytes(size) {
  if (size < 1024) return `${size} B`;
  const units = ["KB", "MB", "GB"];
  let value = size / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

function updateAttachmentLocalHint(message = null) {
  if (!attachmentLocalHint) return;
  if (attachments.size === 0) {
    attachmentLocalHint.hidden = true;
    return;
  }
  attachmentLocalHint.hidden = false;
  attachmentLocalHint.textContent = message || (appSettings.autoUploadAttachments
    ? "附件会尝试自动填入网页上传控件；若网站不支持，请在该网页中手动上传。"
    : "附件只保存在本机：发送会发送文字，文件需在各网页中手动上传。");
}

function renderAttachmentPreview() {
  attachmentPreview.innerHTML = "";
  attachments.forEach((item, id) => {
    const li = document.createElement("li");
    li.dataset.kind = item.kind;
    const kindSpan = document.createElement("span");
    kindSpan.className = "attachment-kind";
    kindSpan.textContent = item.kind === ATTACHMENT_KINDS.image ? "图片" : item.kind === ATTACHMENT_KINDS.audio ? "音频" : "PDF";
    const nameSpan = document.createElement("span");
    nameSpan.textContent = item.file.name;
    const sizeSmall = document.createElement("small");
    sizeSmall.textContent = formatBytes(item.file.size);
    const savedSmall = document.createElement("small");
    savedSmall.className = "attachment-saved";
    if (item.savedPathLabel) {
      savedSmall.textContent = "已保存";
    } else if (item.source === "local") {
      savedSmall.textContent = "磁盘文件";
    } else {
      savedSmall.textContent = "仅本地";
    }
    savedSmall.title = item.savedPathLabel
      ? `已保存到 ${item.savedPathLabel}`
      : item.source === "local"
        ? "该附件来自你选择的磁盘文件，可在网站上传界面重新选择"
        : "该附件没有可用的磁盘文件；录音/粘贴的附件只有在保存成功后才能在网站上传界面选择";
    const controls = [];
    if (item.savedFileName) {
      const revealButton = document.createElement("button");
      revealButton.type = "button";
      revealButton.dataset.attachmentAction = "reveal";
      revealButton.dataset.savedName = item.savedFileName;
      revealButton.textContent = "显示";
      revealButton.disabled = false;
      revealButton.setAttribute("aria-label", `在 Finder 中显示 ${item.file.name}`);
      revealButton.title = `在 Finder 中显示 ${item.savedPathLabel || ""}`.trim();
      controls.push(revealButton);
    }
    const removeButton = document.createElement("button");
    removeButton.type = "button";
    removeButton.dataset.attachmentId = id;
    removeButton.textContent = "×";
    removeButton.disabled = isBroadcasting;
    removeButton.setAttribute("aria-label", `移除 ${item.file.name}`);
    removeButton.title = `移除 ${item.file.name}`;
    controls.push(removeButton);

    li.title = item.savedPathLabel ? `已保存到 ${item.savedPathLabel}` : "";
    li.append(kindSpan, nameSpan, sizeSmall, savedSmall, ...controls);
    attachmentPreview.appendChild(li);
  });
  // Attachments deliberately never clear themselves (a page's DOM cannot prove
  // an upload happened), so give the user one obvious way out of the queue
  // instead of making them remove a broadcast's worth of files one by one.
  updateAttachmentLocalHint();
  if (attachments.size > 1) {
    const clearItem = document.createElement("li");
    clearItem.className = "attachment-clear-all";
    const clearButton = document.createElement("button");
    clearButton.type = "button";
    clearButton.dataset.attachmentAction = "clear-all";
    clearButton.textContent = `清空全部 ${attachments.size} 个附件`;
    clearButton.disabled = isBroadcasting;
    clearButton.setAttribute("aria-label", "清空全部本地附件");
    clearButton.title = "清空全部本地附件（附件不会上传到任何网站）";
    clearItem.appendChild(clearButton);
    attachmentPreview.appendChild(clearItem);
  }
  syncComposerState();
}

function clearAttachments() {
  attachments.clear();
  renderAttachmentPreview();
  attachmentInput.value = "";
}

async function startAudioRecording() {
  if (activeRecorder || recordingStartPending) return;
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
    logStatus("当前环境不支持本地录音", "error");
    return;
  }

  recordingStartPending = true;
  const generation = ++recordingGeneration;
  syncComposerState();
  let acquiredLeaseId = null;
  let acquiredStream = null;
  try {
    const access = await window.qask?.microphone?.requestAccess?.();
    acquiredLeaseId = access?.leaseId || null;
    if (generation !== recordingGeneration) {
      releaseMicrophoneLease(acquiredLeaseId);
      return;
    }
    if (!access?.granted) {
      const reason = access?.reason === "denied" || access?.reason === "restricted"
        ? "未获得麦克风权限；请在系统设置中允许 Qask 使用麦克风后重启应用"
        : "无法获得麦克风访问权限";
      logStatus(reason, "error");
      return;
    }
    // The Qask shell requests audio only after the user clicks the record button.
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    acquiredStream = stream;
    if (generation !== recordingGeneration) {
      stopStreamTracks(stream);
      releaseMicrophoneLease(acquiredLeaseId);
      return;
    }
    const mimeType = getRecordingMimeType();
    const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    const session = createRecordingSession({
      generation,
      recorder,
      stream,
      leaseId: acquiredLeaseId,
      mimeType,
    });
    activeRecordingSession = session;
    activeRecorder = recorder;

    recorder.addEventListener("dataavailable", (event) => {
      if (session.finalized || !event.data?.size) return;
      session.chunks.push(event.data);
      const recordedBytes = session.chunks.reduce((total, chunk) => total + chunk.size, 0);
      if (recordedBytes >= ATTACHMENT_LIMITS.maxRecordingBytes) {
        requestRecordingStopForSession(session, { message: "录音达到大小上限，已停止" });
      }
    });
    recorder.addEventListener("error", () => {
      requestRecordingStopForSession(session, { discard: true, message: "录音失败，未保留任何音频" });
    });
    recorder.addEventListener("stop", () => finalizeRecordingSession(session));

    recorder.start(500);
    recordingStartPending = false;
    setRecordingControls(true);
    logStatus("正在录音（最长 2 分钟）；点击停止或取消结束", "info");
    startMicrophoneLeaseRenewal(session);
    session.limitTimer = setTimeout(() => {
      requestRecordingStopForSession(session, { message: "录音达到 2 分钟上限，已停止" });
    }, ATTACHMENT_LIMITS.maxRecordingDurationMs);
  } catch (error) {
    if (acquiredStream) stopStreamTracks(acquiredStream);
    releaseMicrophoneLease(acquiredLeaseId);
    if (activeRecordingSession?.generation === generation && !activeRecordingSession.finalized) {
      discardRecordingSession(activeRecordingSession);
    }
    setRecordingControls(false);
    const reason = error?.name === "NotAllowedError" ? "未获得麦克风权限；请在系统设置中允许 Qask 使用麦克风后重启应用" : "无法访问麦克风";
    logStatus(reason, "error");
  } finally {
    if (generation === recordingGeneration && !activeRecorder) {
      recordingStartPending = false;
      syncComposerState();
    }
  }
}

recordAudioButton?.addEventListener("click", () => {
  startAudioRecording();
});
stopRecordingButton?.addEventListener("click", () => {
  stopActiveRecording();
});
cancelRecordingButton?.addEventListener("click", () => {
  stopActiveRecording({ discard: true });
});
window.addEventListener("beforeunload", () => {
  recordingGeneration += 1;
  recordingStartPending = false;
  const session = activeRecordingSession;
  if (session) {
    session.discard = true;
    clearRecordingTimers(session);
    // unload does not wait for MediaRecorder's stop event; release hardware now.
    stopStreamTracks(session.stream);
    releaseMicrophoneLease(session.leaseId);
    session.chunks.length = 0;
    session.finalized = true;
    if (session.recorder.state !== "inactive") {
      try {
        session.recorder.stop();
      } catch (_) {}
    }
  }
  activeRecordingSession = null;
  activeRecorder = null;
});

async function addAttachmentFiles(files, source = "local") {
  const selected = Array.from(files || []);
  if (!selected.length) return 0;
  const { approved, rejected, paths } = await inspectSelectedAttachments(selected);
  if (rejected.length) {
    logStatus(`为保护本地 GitHub 与凭据数据，已拒绝 ${rejected.length} 个敏感或不可验证附件`, "error");
  }
  const entries = await Promise.all(approved.map((file) => addAttachment(file, source, paths.get(file))));
  const added = entries.filter(Boolean);
  if (added.length) {
    renderAttachmentPreview();
    logStatus(`已添加 ${added.length} 个附件`, "info");
  }
  return added.length;
}

attachmentInput.addEventListener("change", async (event) => {
  await addAttachmentFiles(event.target.files, "local");
  attachmentInput.value = "";
});

// Files can be dropped anywhere on the composer: the tray sits above the text
// field, so the user can keep typing while the attached files stay visible.
let composerDragDepth = 0;
function hasDraggedFiles(event) {
  return Array.from(event.dataTransfer?.types || []).includes("Files");
}
function clearComposerDragState() {
  composerDragDepth = 0;
  composer?.classList.remove("is-file-drag-over");
  composerDropHint?.setAttribute("aria-hidden", "true");
}
composer?.addEventListener("dragenter", (event) => {
  if (!hasDraggedFiles(event)) return;
  event.preventDefault();
  composerDragDepth += 1;
  composer.classList.add("is-file-drag-over");
  composerDropHint?.setAttribute("aria-hidden", "false");
});
composer?.addEventListener("dragover", (event) => {
  if (!hasDraggedFiles(event)) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
});
composer?.addEventListener("dragleave", (event) => {
  if (!hasDraggedFiles(event)) return;
  composerDragDepth = Math.max(0, composerDragDepth - 1);
  if (composerDragDepth === 0) clearComposerDragState();
});
composer?.addEventListener("drop", async (event) => {
  if (!hasDraggedFiles(event)) return;
  event.preventDefault();
  clearComposerDragState();
  const files = Array.from(event.dataTransfer?.files || []);
  if (files.length) {
    await addAttachmentFiles(files, "drop");
  }
});
window.addEventListener("dragover", (event) => {
  if (hasDraggedFiles(event)) event.preventDefault();
});
window.addEventListener("drop", (event) => {
  if (hasDraggedFiles(event)) event.preventDefault();
});

attachmentPreview.addEventListener("click", (event) => {
  if (!(event.target instanceof HTMLButtonElement)) {
    return;
  }
  if (event.target.dataset.attachmentAction === "reveal") {
    const savedName = event.target.dataset.savedName;
    if (savedName) {
      window.qask?.attachments?.reveal?.(savedName).catch(() => {});
    }
    return;
  }
  if (isBroadcasting) return;
  if (event.target.dataset.attachmentAction === "clear-all") {
    clearAttachments();
    logStatus("已清空本地附件", "info");
    return;
  }
  const id = event.target.dataset.attachmentId;
  if (!id) {
    return;
  }
  attachments.delete(id);
  renderAttachmentPreview();
  logStatus("附件已移除", "info");
});

broadcastStatusClear?.addEventListener("click", () => {
  clearStatusMessages();
});

const RESPONSE_SELECTORS = {
  chatgpt: ['[data-message-author-role="assistant"]'],
  gemini: ['model-response', 'message-content', '.model-response-text'],
  doubao: ['[data-testid="message_text_content"]', '[class*="message-content"]'],
  claude: ['.font-claude-message', '[data-testid="assistant-message"]'],
  copilot: ['[data-content="ai-message"]', '[class*="ac-textBlock"]'],
  deepseek: ['.ds-markdown'],
  kimi: ['.chat-content-item-assistant .markdown', '.segment-assistant .markdown', '.markdown'],
};
const COMPARISON_MAX_ANSWER_CHARS = 20000;
const COMPARISON_SUMMARY_INPUT_CHARS = 4000;
const COMPARISON_REFRESH_INTERVAL_MS = 4000;
const COMPARISON_SUMMARY_POLL_MS = 2500;
const COMPARISON_SUMMARY_TIMEOUT_MS = 90000;

// Read the visible answer text from a provider page. Every site is different, so
// this is a best-effort last-message heuristic: provider-specific containers
// first, then generic assistant/markdown containers. It never touches the
// composer and it runs only after the host has verified the current origin.
function buildExtractAnswerScript(modelId) {
  const selectors = JSON.stringify(RESPONSE_SELECTORS[modelId] || []);
  return `(() => {
    const visible = (el) => Boolean(el && el.getClientRects().length > 0);
    const usable = (el) => {
      if (!visible(el)) return false;
      if (el.closest('textarea, input, [contenteditable="true"]')) return false;
      if (el.closest('aside, nav, header, [role="navigation"]')) return false;
      const rect = el.getBoundingClientRect();
      return rect.width >= 160 && rect.height >= 12;
    };
    const candidates = [];
    const collect = (selector, priority) => {
      let nodes = [];
      try { nodes = Array.from(document.querySelectorAll(selector)); } catch (error) { return; }
      for (const node of nodes) {
        if (!usable(node)) continue;
        const text = String(node.innerText || '').trim();
        if (text.length < 20) continue;
        candidates.push({ node, text, priority });
      }
    };
    ${selectors}.forEach((selector) => collect(selector, 1));
    if (!candidates.length) {
      [
        '[data-message-author-role="assistant"]',
        '[data-testid*="assistant" i]',
        '[class*="assistant" i]',
        '[class*="markdown" i]',
        'article'
      ].forEach((selector) => collect(selector, 0));
    }
    if (!candidates.length) {
      return { ok: false, reason: '未找到回答区域' };
    }
    candidates.sort((left, right) => {
      if (left.priority !== right.priority) return left.priority - right.priority;
      return left.node.compareDocumentPosition(right.node) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
    });
    const best = candidates[candidates.length - 1];
    return { ok: true, text: best.text.slice(-${COMPARISON_MAX_ANSWER_CHARS}), candidates: candidates.length };
  })()`;
}

function getSynchronizedScrollTop(sourceScrollTop, sourceScrollHeight, sourceClientHeight, targetScrollHeight, targetClientHeight) {
  const sourceMax = Math.max(0, sourceScrollHeight - sourceClientHeight);
  const targetMax = Math.max(0, targetScrollHeight - targetClientHeight);
  if (sourceMax <= 0 || targetMax <= 0) return 0;
  const ratio = Math.min(1, Math.max(0, sourceScrollTop / sourceMax));
  return Math.round(ratio * targetMax);
}

function buildDifferenceSummaryPrompt(answers, promptText = "") {
  const usable = (Array.isArray(answers) ? answers : [])
    .filter((answer) => answer?.ok && String(answer.text || "").trim())
    .slice(0, 4);
  if (usable.length < 2) {
    return null;
  }
  const lines = [
    "你是一个严谨的 AI 回答对比助手。下面是多个模型对同一问题的回答，请用中文简洁总结它们的差异，不要复述原文，不要编造未出现的信息。",
    "",
  ];
  if (promptText) {
    lines.push("【问题】", String(promptText).slice(0, 2000), "");
  }
  usable.forEach((answer, index) => {
    lines.push(
      `【回答 ${index + 1}｜${answer.label}】`,
      String(answer.text).slice(0, COMPARISON_SUMMARY_INPUT_CHARS),
      "",
    );
  });
  lines.push(
    "请按以下结构输出：",
    "1. 共识：这些回答一致的地方；",
    "2. 关键差异：结论、事实、侧重点或建议上的不同；",
    "3. 各自优劣：每个回答更擅长/更薄弱的地方；",
    "4. 一句结论：如果只能选一个，为什么。",
  );
  return lines.join("\n");
}

function setComparisonStatus(message, level = "info") {
  if (!comparisonStatus) return;
  comparisonStatus.textContent = message;
  comparisonStatus.dataset.level = level;
}

function getActiveComparisonPanels() {
  return panels.filter((panelState) => Boolean(panelState?.webview && panelState?.modelId));
}

function updateComparisonPrompt() {
  if (!comparisonPrompt) return;
  const text = String(comparisonLastPrompt || "").trim();
  comparisonPrompt.hidden = !text;
  comparisonPrompt.textContent = text ? `当前问题：${text.slice(0, 300)}` : "";
}

async function extractPanelAnswer(panelState) {
  const label = getPanelLabel(panelState);
  if (!panelState?.webview) {
    return { panelId: panelState?.id || "", label, ok: false, text: "", reason: "窗口尚未加载" };
  }
  if (!panelState.ready) {
    return { panelId: panelState.id, label, ok: false, text: "", reason: "页面尚未就绪" };
  }
  const config = modelRegistry.get(panelState.modelId);
  if (!config) {
    return { panelId: panelState.id, label, ok: false, text: "", reason: "模型配置不可用" };
  }
  const currentUrl = panelState.webview.getURL?.() || "";
  if (!isTrustedGuestUrl(currentUrl, config.injectableOrigins || [])) {
    return { panelId: panelState.id, label, ok: false, text: "", reason: "网页已跳转到未验证来源" };
  }
  try {
    const result = await panelState.webview.executeJavaScript(
      buildExtractAnswerScript(panelState.modelId),
      true,
    );
    if (!result?.ok || !String(result.text || "").trim()) {
      return { panelId: panelState.id, label, ok: false, text: "", reason: result?.reason || "未找到回答文本" };
    }
    return { panelId: panelState.id, label, ok: true, text: String(result.text).slice(-COMPARISON_MAX_ANSWER_CHARS) };
  } catch (error) {
    return { panelId: panelState.id, label, ok: false, text: "", reason: "读取回答失败" };
  }
}

function handleComparisonScroll(event) {
  if (!comparisonSyncScroll?.checked || comparisonSyncingScroll) return;
  const source = event.currentTarget;
  const panes = Array.from(comparisonAnswers.querySelectorAll(".comparison-answer-text"));
  comparisonSyncingScroll = true;
  try {
    for (const pane of panes) {
      if (pane === source) continue;
      pane.scrollTop = getSynchronizedScrollTop(
        source.scrollTop,
        source.scrollHeight,
        source.clientHeight,
        pane.scrollHeight,
        pane.clientHeight,
      );
    }
  } finally {
    requestAnimationFrame(() => {
      comparisonSyncingScroll = false;
    });
  }
}

function renderComparisonAnswers() {
  if (!comparisonAnswers) return;
  updateComparisonPrompt();
  comparisonAnswers.replaceChildren();
  comparisonAnswers.hidden = comparisonAnswersState.length === 0;
  comparisonEmpty.hidden = comparisonAnswersState.length > 0;
  for (const answer of comparisonAnswersState) {
    const pane = document.createElement("article");
    pane.className = "comparison-answer-pane";
    const header = document.createElement("header");
    header.className = "comparison-answer-header";
    const title = document.createElement("h4");
    title.textContent = answer.label;
    const state = document.createElement("span");
    state.className = "comparison-answer-state";
    state.dataset.level = answer.ok ? "success" : "warning";
    state.textContent = answer.ok ? `${answer.text.length} 字` : (answer.reason || "未读取");
    header.append(title, state);
    pane.appendChild(header);
    if (answer.ok) {
      const body = document.createElement("div");
      body.className = "comparison-answer-text";
      body.tabIndex = 0;
      body.textContent = answer.text;
      body.addEventListener("scroll", handleComparisonScroll);
      pane.appendChild(body);
    } else {
      const empty = document.createElement("p");
      empty.className = "comparison-answer-empty";
      empty.textContent = `${answer.reason || "未读取到回答"}。请确认该面板已完成回答后点“刷新回答”。`;
      pane.appendChild(empty);
    }
    comparisonAnswers.appendChild(pane);
  }
  populateComparisonSummarizer();
}

function populateComparisonSummarizer() {
  if (!comparisonSummarizer) return;
  const previous = comparisonSummarizer.value;
  const candidates = getActiveComparisonPanels().filter((panelState) => {
    const config = modelRegistry.get(panelState.modelId);
    return panelState.ready && config?.allowAutoSend === true;
  });
  comparisonSummarizer.replaceChildren();
  candidates.forEach((panelState) => {
    const option = document.createElement("option");
    option.value = panelState.id;
    option.textContent = getPanelLabel(panelState);
    comparisonSummarizer.appendChild(option);
  });
  if (previous && candidates.some((panelState) => panelState.id === previous)) {
    comparisonSummarizer.value = previous;
  } else if (appSettings.comparisonModelId !== "auto") {
    const preferred = candidates.find((panelState) => panelState.modelId === appSettings.comparisonModelId);
    if (preferred) comparisonSummarizer.value = preferred.id;
  }
  const readable = comparisonAnswersState.filter((answer) => answer.ok && answer.text.trim()).length;
  const canSummarize = readable >= 2 && candidates.length > 0 && !comparisonSummarizing;
  if (comparisonSummarize) comparisonSummarize.disabled = !canSummarize;
  if (comparisonSummarizer) comparisonSummarizer.disabled = candidates.length === 0 || comparisonSummarizing;
  comparisonSummarizer.title = candidates.length === 0
    ? "没有支持自动发送且已就绪的面板可用于总结"
    : "选择一个模型来生成差异总结";
}

async function refreshComparisonAnswers({ silent = false } = {}) {
  if (comparisonAnswersRefreshing) return;
  const active = getActiveComparisonPanels();
  if (!active.length) {
    comparisonAnswersState = [];
    renderComparisonAnswers();
    setComparisonStatus("当前没有活动面板。请先选择布局并等待网页加载。", "warning");
    return;
  }
  comparisonAnswersRefreshing = true;
  if (comparisonRefresh) comparisonRefresh.disabled = true;
  if (!silent) setComparisonStatus("正在读取各面板的最新回答…", "info");
  try {
    comparisonAnswersState = await Promise.all(active.map((panelState) => extractPanelAnswer(panelState)));
    renderComparisonAnswers();
    const readable = comparisonAnswersState.filter((answer) => answer.ok).length;
    if (!silent) {
      setComparisonStatus(
        readable > 0
          ? `已读取 ${readable}/${comparisonAnswersState.length} 个面板的回答。`
          : "未读取到回答；请确认网页中已有回答，或稍后重试。",
        readable > 0 ? "success" : "warning",
      );
    }
  } finally {
    comparisonAnswersRefreshing = false;
    if (!comparisonSummarizing && comparisonRefresh) comparisonRefresh.disabled = false;
  }
}

function startComparisonRefresh() {
  stopComparisonRefresh();
  comparisonRefreshTimer = setInterval(() => {
    if (!isComparisonDialogOpen() || document.hidden) return;
    if (comparisonAnswersFrozen || comparisonSummarizing || comparisonAnswersRefreshing) return;
    refreshComparisonAnswers({ silent: true });
  }, COMPARISON_REFRESH_INTERVAL_MS);
}

function stopComparisonRefresh() {
  if (comparisonRefreshTimer) {
    clearInterval(comparisonRefreshTimer);
    comparisonRefreshTimer = null;
  }
}

async function waitForSummaryAnswer(panelState, baselineText) {
  const startedAt = Date.now();
  let lastText = "";
  let stableReads = 0;
  while (Date.now() - startedAt < COMPARISON_SUMMARY_TIMEOUT_MS) {
    await new Promise((resolve) => setTimeout(resolve, COMPARISON_SUMMARY_POLL_MS));
    if (comparisonDialog?.hasAttribute("hidden")) return lastText;
    const result = await extractPanelAnswer(panelState);
    if (!result.ok || !result.text || result.text === baselineText) {
      comparisonSummaryText.textContent = `正在让 ${getPanelLabel(panelState)} 生成总结…（${Math.round((Date.now() - startedAt) / 1000)} 秒）`;
      continue;
    }
    if (result.text === lastText) {
      stableReads += 1;
      if (stableReads >= 1) return result.text;
    } else {
      lastText = result.text;
      stableReads = 0;
    }
    comparisonSummaryText.textContent = `正在生成总结…（${Math.round((Date.now() - startedAt) / 1000)} 秒）`;
  }
  return lastText;
}

async function summarizeComparisonDifferences() {
  if (comparisonSummarizing) return;
  const answers = comparisonAnswersState.filter((answer) => answer.ok && answer.text.trim());
  if (answers.length < 2) {
    setComparisonStatus("至少需要两个已读取的回答才能总结差异。", "warning");
    return;
  }
  const panelState = panels.find((candidate) => candidate.id === comparisonSummarizer?.value);
  if (!panelState?.webview) {
    setComparisonStatus("请选择一个可用的总结模型。", "warning");
    return;
  }
  const config = modelRegistry.get(panelState.modelId);
  const prompt = buildDifferenceSummaryPrompt(answers, comparisonLastPrompt);
  if (!config || !prompt) {
    setComparisonStatus("无法生成总结提示词。", "warning");
    return;
  }
  const label = getPanelLabel(panelState);
  if (appSettings.confirmSummary) {
    const confirmed = window.confirm(
      `将把 ${answers.length} 段回答发送给“${label}”生成差异总结。回答中可能包含敏感内容，确定继续？`,
    );
    if (!confirmed) return;
  }

  comparisonSummarizing = true;
  comparisonAnswersFrozen = true;
  stopComparisonRefresh();
  if (comparisonSummary) comparisonSummary.hidden = false;
  comparisonSummaryText.textContent = `正在让 ${label} 生成总结…`;
  setComparisonStatus("已发送总结请求，等待模型回答…", "info");
  populateComparisonSummarizer();
  try {
    const baseline = await extractPanelAnswer(panelState);
    const script = buildOriginGuardedScript(
      (config.composeMessageScript || buildGenericScript)(prompt, config.allowAutoSend ? true : false, []),
      config.injectableOrigins || [],
    );
    const result = await dispatchCoordinator.run(
      panelState.webview,
      () => panelState.webview.executeJavaScript(script, true),
    );
    if (!result || result.success !== true || result.skipped) {
      throw new Error("summary-send-failed");
    }
    const summary = await waitForSummaryAnswer(panelState, baseline.ok ? baseline.text : "");
    if (summary) {
      comparisonSummaryText.textContent = summary;
      setComparisonStatus("差异总结已生成；回答面板已冻结，点“刷新回答”可恢复实时读取。", "success");
    } else {
      comparisonSummaryText.textContent = "总结已发送，但未能自动读取结果；请切换到该面板查看。";
      setComparisonStatus("未能读取总结结果", "warning");
    }
  } catch (error) {
    comparisonSummaryText.textContent = "总结生成失败；请检查该面板的登录/加载状态后重试。";
    setComparisonStatus("总结生成失败", "error");
  } finally {
    comparisonSummarizing = false;
    populateComparisonSummarizer();
  }
}

function isComparisonDialogOpen() {
  return Boolean(comparisonDialog && !comparisonDialog.hasAttribute("hidden"));
}

function getComparisonFocusableElements() {
  if (!comparisonDialog) return [];
  return Array.from(comparisonDialog.querySelectorAll(
    'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  )).filter((element) => !element.hasAttribute("hidden") && !element.closest("[hidden]"));
}

function trapComparisonDialogFocus(event) {
  if (!isComparisonDialogOpen() || event.key !== "Tab") return;
  const focusable = getComparisonFocusableElements();
  if (!focusable.length) {
    event.preventDefault();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function openComparisonDialog() {
  if (!comparisonDialog) return;
  if (isModelAddDialogOpen()) closeModelAddDialog();
  comparisonLastFocus = document.activeElement;
  appShell?.setAttribute("inert", "");
  comparisonDialog.removeAttribute("hidden");
  comparisonDialog.removeAttribute("aria-hidden");
  comparisonAnswersFrozen = false;
  comparisonAnswersState = [];
  // Fresh comparison: apply the configured default model rather than carrying
  // over the selection from the previous dialog session.
  if (comparisonSummarizer) comparisonSummarizer.value = "";
  renderComparisonAnswers();
  refreshComparisonAnswers();
  startComparisonRefresh();
  setTimeout(() => comparisonClose?.focus(), 0);
}

function closeComparisonDialog() {
  if (!comparisonDialog) return;
  stopComparisonRefresh();
  comparisonDialog.setAttribute("hidden", "");
  comparisonDialog.setAttribute("aria-hidden", "true");
  appShell?.removeAttribute("inert");
  if (comparisonLastFocus instanceof HTMLElement) {
    comparisonLastFocus.focus();
  }
}

comparisonButton?.addEventListener("click", () => {
  openComparisonDialog();
});

comparisonClose?.addEventListener("click", () => {
  closeComparisonDialog();
});

comparisonDialog?.addEventListener("click", (event) => {
  if (event.target instanceof HTMLElement && event.target.dataset.comparisonDismiss !== undefined) {
    closeComparisonDialog();
  }
});

comparisonRefresh?.addEventListener("click", () => {
  comparisonAnswersFrozen = false;
  refreshComparisonAnswers();
});

comparisonSummarizer?.addEventListener("change", () => {
  populateComparisonSummarizer();
});

comparisonSummarize?.addEventListener("click", () => {
  summarizeComparisonDifferences();
});

function normalizeSendMode(value) {
  return SEND_MODE_VALUES.has(value) ? value : "send";
}

function canQueueMessage(text, attachmentCount = 0) {
  return Boolean(String(text || "").trim()) && attachmentCount === 0;
}

function getAnswerWaitState(state, { text = "", generating = false } = {}) {
  const baseline = state?.baseline || "";
  const normalized = String(text || "");
  if (!normalized || normalized === baseline) {
    return { ...state, lastText: normalized, stable: 0, lastGenerating: generating };
  }
  if (normalized === state?.lastText) {
    return {
      ...state,
      lastText: normalized,
      stable: Number(state?.stable || 0) + 1,
      lastGenerating: generating,
    };
  }
  return { ...state, lastText: normalized, stable: 0, lastGenerating: generating };
}

function isAnswerWaitDone(state, stablePolls = QUEUE_ANSWER_STABLE_POLLS) {
  const stable = Number(state?.stable || 0);
  // Text stability is the primary signal. A visible stop control only asks for
  // one more confirmation poll; some sites keep a hidden/stale stop button in
  // the DOM and would otherwise stall the queue forever.
  return stable >= (state?.lastGenerating === true ? stablePolls + 1 : stablePolls);
}

function buildGeneratingCheckScript() {
  return `(() => {
    const visible = (element) => Boolean(element && element.getClientRects().length > 0);
    const candidates = Array.from(document.querySelectorAll('button, [role="button"]'));
    const stop = candidates.find((element) => {
      if (!visible(element) || element.disabled) return false;
      if (element.getAttribute('aria-disabled') === 'true') return false;
      const label = [
        element.getAttribute('aria-label'),
        element.getAttribute('data-testid'),
        element.getAttribute('title'),
        element.innerText,
      ].filter(Boolean).join(' ').toLowerCase();
      return /(停止|中止|stop|cancel)/i.test(label)
        && /(生成|回答|响应|停止|stop|response|generat|stream)/i.test(label);
    });
    return { generating: Boolean(stop) };
  })()`;
}

async function isPanelGenerating(panelState) {
  if (!panelState?.webview || !panelState.ready) return false;
  const config = modelRegistry.get(panelState.modelId);
  if (!config) return false;
  const currentUrl = panelState.webview.getURL?.() || "";
  if (!isTrustedGuestUrl(currentUrl, config.injectableOrigins || [])) return false;
  try {
    const result = await panelState.webview.executeJavaScript(buildGeneratingCheckScript(), true);
    return result?.generating === true;
  } catch (error) {
    return false;
  }
}

async function areAnyPanelsGenerating(panelStates) {
  const results = await Promise.all((Array.isArray(panelStates) ? panelStates : []).map((panelState) => isPanelGenerating(panelState)));
  return results.some(Boolean);
}

async function waitForPanelsIdle(panelStates, onProgress) {
  queueSkipWaitRequested = false;
  const states = new Map((Array.isArray(panelStates) ? panelStates : []).map((panelState) => [
    panelState.id,
    { lastText: null, stable: 0, unreadable: 0, idle: false },
  ]));
  const startedAt = Date.now();
  while (Date.now() - startedAt < QUEUE_ANSWER_TIMEOUT_MS) {
    if (queueSkipWaitRequested) {
      return "skipped";
    }
    let busy = 0;
    await Promise.all((Array.isArray(panelStates) ? panelStates : []).map(async (panelState) => {
      const state = states.get(panelState.id);
      if (!state || state.idle) return;
      const [answer, generating] = await Promise.all([
        extractPanelAnswer(panelState),
        isPanelGenerating(panelState),
      ]);
      if (!answer.ok) {
        state.unreadable += 1;
        if (!generating && state.unreadable >= QUEUE_UNREADABLE_POLLS) state.idle = true;
      } else {
        state.unreadable = 0;
        if (answer.text === state.lastText) {
          state.stable += 1;
        } else {
          state.lastText = answer.text;
          state.stable = 0;
        }
        // A stop control asks for a couple more confirmations, but stable text
        // wins so a stale/hidden stop button can never pin the queue forever.
        if (state.stable >= 1 && !generating) {
          state.idle = true;
        } else if (state.stable >= 3) {
          state.idle = true;
        }
      }
      if (!state.idle) busy += 1;
    }));
    onProgress?.(busy);
    if (busy === 0) {
      return "idle";
    }
    await new Promise((resolve) => setTimeout(resolve, QUEUE_ANSWER_POLL_MS));
  }
  return "timeout";
}

function getQueueItemLabel(item) {
  const text = String(item?.text || "").replace(/\s+/g, " ").trim();
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}

function clearQueueDropIndicators() {
  messageQueueList?.querySelectorAll(".message-queue-item").forEach((row) => {
    row.classList.remove("is-drop-before", "is-drop-after");
  });
}

function moveQueueItem(items, draggedId, targetId, after = false) {
  const list = Array.isArray(items) ? [...items] : [];
  const fromIndex = list.findIndex((item) => item.id === draggedId);
  const targetIndex = list.findIndex((item) => item.id === targetId);
  if (fromIndex < 0 || targetIndex < 0 || fromIndex === targetIndex) {
    return list;
  }
  const [moved] = list.splice(fromIndex, 1);
  const insertIndex = list.findIndex((item) => item.id === targetId);
  list.splice(after ? insertIndex + 1 : insertIndex, 0, moved);
  return list;
}

function reorderQueuedItem(draggedId, targetId, after = false) {
  if (!draggedId || !targetId || draggedId === targetId) return false;
  const dragged = queuedMessages.find((item) => item.id === draggedId);
  const target = queuedMessages.find((item) => item.id === targetId);
  if (!dragged || !target || dragged === queueCurrentItem) return false;
  let next = moveQueueItem(queuedMessages, draggedId, targetId, after);
  if (queueCurrentItem) {
    // The message being sent/waiting stays pinned to the front of the queue.
    next = [queueCurrentItem, ...next.filter((item) => item !== queueCurrentItem)];
  }
  const before = queuedMessages.map((item) => item.id).join("|");
  const afterIds = next.map((item) => item.id).join("|");
  if (before === afterIds) return false;
  queuedMessages = next;
  renderMessageQueue();
  logStatus("已调整排队顺序", "info");
  return true;
}

function movePendingQueueItem(itemId, offset) {
  if (!itemId || !offset) return;
  const index = queuedMessages.findIndex((item) => item.id === itemId);
  if (index < 0 || queuedMessages[index] === queueCurrentItem) return;
  const minIndex = queueCurrentItem ? 1 : 0;
  const targetIndex = Math.max(minIndex, Math.min(queuedMessages.length - 1, index + offset));
  if (targetIndex === index) return;
  const [moved] = queuedMessages.splice(index, 1);
  queuedMessages.splice(targetIndex, 0, moved);
  renderMessageQueue();
  logStatus("已调整排队顺序", "info");
}

function startQueueEdit(item) {
  if (!item || item === queueCurrentItem) return;
  queueEditingId = item.id;
  renderMessageQueue({ force: true });
  const input = messageQueueList?.querySelector(`.message-queue-edit-input[data-queue-id="${item.id}"]`);
  input?.focus();
  input?.select();
}

function cancelQueueEdit() {
  if (!queueEditingId) return;
  queueEditingId = null;
  renderMessageQueue();
}

function saveQueueEdit(item, value) {
  const nextText = String(value || "").trim();
  if (!item || !queuedMessages.includes(item)) {
    queueEditingId = null;
    renderMessageQueue();
    return;
  }
  if (item === queueCurrentItem) {
    logStatus("该条消息已开始发送，无法修改", "error");
    queueEditingId = null;
    renderMessageQueue();
    return;
  }
  if (!nextText) {
    logStatus("排队消息不能为空；已保留原文", "error");
    const input = messageQueueList?.querySelector(`.message-queue-edit-input[data-queue-id="${item.id}"]`);
    input?.focus();
    return;
  }
  if (nextText === item.text) {
    cancelQueueEdit();
    return;
  }
  item.text = nextText;
  queueEditingId = null;
  renderMessageQueue();
  logStatus("已更新排队消息", "success");
}

function buildQueueDragHandle() {
  const handle = document.createElement("span");
  handle.className = "message-queue-drag";
  handle.setAttribute("aria-hidden", "true");
  handle.title = "拖动排序（Alt + ↑/↓）";
  handle.innerHTML = `<svg viewBox="0 0 12 16" width="10" height="14" focusable="false">
    <g fill="currentColor">
      <circle cx="3" cy="3" r="1.15"/><circle cx="9" cy="3" r="1.15"/>
      <circle cx="3" cy="8" r="1.15"/><circle cx="9" cy="8" r="1.15"/>
      <circle cx="3" cy="13" r="1.15"/><circle cx="9" cy="13" r="1.15"/>
    </g>
  </svg>`;
  return handle;
}

function buildQueueEditButton(item, index) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "message-queue-icon-button message-queue-edit";
  button.dataset.queueEdit = item.id;
  button.setAttribute("aria-label", `编辑排队消息 ${index + 1}`);
  button.title = "编辑消息";
  button.innerHTML = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M4 20h4l10-10-4-4L4 16v4Z"/><path d="m14 6 4 4"/>
  </svg>`;
  return button;
}

function buildQueueRemoveButton(item, index) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "message-queue-icon-button message-queue-remove";
  button.dataset.queueRemove = item.id;
  button.setAttribute("aria-label", `删除排队消息 ${index + 1}`);
  button.title = "删除消息";
  button.textContent = "×";
  return button;
}

function renderMessageQueue({ force = false } = {}) {
  if (!messageQueueEl) return;
  const visible = queuedMessages.length > 0 || Boolean(queueCurrentItem);
  messageQueueEl.hidden = !visible;
  if (!visible) {
    queueEditingId = null;
    queueDraggingId = null;
    messageQueueList?.replaceChildren();
    return;
  }
  const total = queuedMessages.length;
  if (messageQueueTitle) {
    messageQueueTitle.textContent = `发送队列 · ${total} 条`;
  }
  if (messageQueueHint) {
    messageQueueHint.textContent = queueCurrentItem
      ? (queueCurrentItem.statusText || "准备发送…")
      : "按发送键继续加入队列";
  }
  if (queueSkipWait) {
    queueSkipWait.hidden = !(queueCurrentItem?.waiting);
  }
  if (queueClear) {
    queueClear.disabled = !(queueCurrentItem ? queuedMessages.length > 1 : queuedMessages.length > 0);
  }
  if (!messageQueueList) return;
  if (!queuedMessages.some((item) => item.id === queueEditingId)) {
    queueEditingId = null;
  }
  // Keep the edited row / dragged row alive while background progress updates
  // the header; replacing the list mid-edit would steal focus or cancel a drag.
  if ((queueEditingId || queueDraggingId) && !force) {
    return;
  }
  messageQueueList.replaceChildren();
  queuedMessages.forEach((item, index) => {
    const isCurrent = item === queueCurrentItem;
    const isEditing = item.id === queueEditingId;
    const row = document.createElement("li");
    row.className = "message-queue-item";
    row.dataset.queueId = item.id;
    row.classList.toggle("is-current", isCurrent);
    row.classList.toggle("is-editing", isEditing);
    row.draggable = !isCurrent && !isEditing;
    row.tabIndex = isCurrent ? -1 : 0;
    row.title = isCurrent ? "正在发送，无法编辑" : "拖动排序（Alt + ↑/↓）";

    const rank = document.createElement("span");
    rank.className = "message-queue-rank";
    rank.textContent = String(index + 1);

    if (!isCurrent) {
      row.appendChild(buildQueueDragHandle());
    }
    row.appendChild(rank);

    if (isEditing) {
      const input = document.createElement("textarea");
      input.className = "message-queue-edit-input";
      input.rows = 1;
      input.value = item.text;
      input.dataset.queueId = item.id;
      input.setAttribute("aria-label", `编辑排队消息 ${index + 1}`);
      const save = document.createElement("button");
      save.type = "button";
      save.className = "message-queue-icon-button message-queue-save";
      save.dataset.queueSave = item.id;
      save.setAttribute("aria-label", "保存修改");
      save.title = "保存（Enter）";
      save.textContent = "✓";
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "message-queue-icon-button message-queue-cancel";
      cancel.dataset.queueCancel = item.id;
      cancel.setAttribute("aria-label", "取消修改");
      cancel.title = "取消（Esc）";
      cancel.textContent = "×";
      row.append(input, save, cancel);
    } else {
      const text = document.createElement("span");
      text.className = "message-queue-text";
      text.textContent = getQueueItemLabel(item);
      text.title = item.text;
      const state = document.createElement("small");
      state.className = "message-queue-state";
      state.textContent = isCurrent ? (item.statusText || "发送中…") : "排队中";
      row.append(text, state);
      if (!isCurrent) {
        const actions = document.createElement("span");
        actions.className = "message-queue-actions";
        actions.append(
          buildQueueEditButton(item, index),
          buildQueueRemoveButton(item, index),
        );
        row.appendChild(actions);
      }
    }

    row.addEventListener("dragstart", (event) => {
      if (isCurrent || isEditing) {
        event.preventDefault();
        return;
      }
      queueDraggingId = item.id;
      row.classList.add("is-dragging");
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", item.id);
    });
    row.addEventListener("dragend", () => {
      queueDraggingId = null;
      clearQueueDropIndicators();
      messageQueueList.querySelectorAll(".message-queue-item.is-dragging").forEach((element) => element.classList.remove("is-dragging"));
      renderMessageQueue();
    });
    row.addEventListener("dragover", (event) => {
      if (!queueDraggingId || queueDraggingId === item.id) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      const rect = row.getBoundingClientRect();
      const after = event.clientY > rect.top + rect.height / 2;
      clearQueueDropIndicators();
      row.classList.add(after ? "is-drop-after" : "is-drop-before");
    });
    row.addEventListener("dragleave", () => {
      row.classList.remove("is-drop-before", "is-drop-after");
    });
    row.addEventListener("drop", (event) => {
      if (!queueDraggingId) return;
      event.preventDefault();
      const after = row.classList.contains("is-drop-after");
      const draggedId = queueDraggingId;
      queueDraggingId = null;
      clearQueueDropIndicators();
      reorderQueuedItem(draggedId, item.id, after);
    });
    row.addEventListener("keydown", (event) => {
      if (isCurrent || isEditing) return;
      if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
      event.preventDefault();
      movePendingQueueItem(item.id, event.key === "ArrowUp" ? -1 : 1);
    });
    messageQueueList.appendChild(row);
  });
}

function enqueueMessage(text) {
  const normalized = String(text || "").trim();
  if (!canQueueMessage(normalized, attachments.size)) {
    logStatus("排队发送暂不支持附件；请移除附件或改用立即发送", "error");
    return false;
  }
  if (queuedMessages.length >= QUEUE_LIMIT) {
    logStatus(`发送队列最多 ${QUEUE_LIMIT} 条，请等待或清空后重试`, "error");
    return false;
  }
  queueSequence += 1;
  queuedMessages.push({
    id: `queue-${Date.now()}-${queueSequence}`,
    text: normalized,
    statusText: "排队中",
    snapshot: null,
    baselines: new Map(),
    results: null,
    waiting: false,
  });
  logStatus(`已加入发送队列（${queuedMessages.length} 条）`, "info");
  renderMessageQueue();
  void processMessageQueue();
  return true;
}

async function captureAnswerBaselines(recipients) {
  const baselines = new Map();
  await Promise.all((Array.isArray(recipients) ? recipients : []).map(async (recipient) => {
    const panelState = recipient?.panelState;
    if (!panelState) return;
    const answer = await extractPanelAnswer(panelState);
    baselines.set(panelState.id, answer.ok ? answer.text : "");
  }));
  return baselines;
}

async function dispatchSnapshotToPanels(snapshot, { fillOnly = false } = {}) {
  return settleBroadcastTasks(
    snapshot.recipients,
    (recipient) => {
      const panelState = recipient?.panelState;
      if (!panelState || panelState.modelId !== recipient.modelId || panelState.webview !== recipient.webview) {
        return Promise.resolve({
          panel: recipient?.label || getPanelLabel(panelState),
          status: "error",
          message: "发送目标已变化；为保护内容已取消本次发送",
        });
      }
      return dispatchMessage(panelState, snapshot.text, snapshot.attachments, { fillOnly });
    },
    undefined,
    (recipient) => dispatchCoordinator.reset(recipient?.webview),
  );
}

async function waitForQueuedAnswers(item) {
  if (!item?.snapshot || !Array.isArray(item.results)) return;
  const waitTargets = item.snapshot.recipients
    .map((recipient, index) => ({ recipient, result: item.results[index] }))
    .filter(({ result }) => result?.attemptedAutoSend === true);
  if (!waitTargets.length) {
    return;
  }
  queueSkipWaitRequested = false;
  const states = new Map(waitTargets.map(({ recipient }) => [
    recipient.panelState?.id || recipient.modelId,
    {
      baseline: item.baselines.get(recipient.panelState?.id) || "",
      lastText: "",
      stable: 0,
      unreadable: 0,
      done: false,
    },
  ]));
  const startedAt = Date.now();
  while (Date.now() - startedAt < QUEUE_ANSWER_TIMEOUT_MS) {
    if (queueSkipWaitRequested) {
      logStatus("队列：已跳过等待，继续下一条", "info");
      item.statusText = "已跳过等待";
      renderMessageQueue();
      return;
    }
    let pending = 0;
    const pendingLabels = [];
    await Promise.all(waitTargets.map(async ({ recipient }) => {
      const key = recipient.panelState?.id || recipient.modelId;
      const state = states.get(key);
      if (!state || state.done) return;
      const panelState = recipient.panelState;
      if (!panelState || panelState.webview !== recipient.webview || panelState.modelId !== recipient.modelId) {
        state.done = true;
        return;
      }
      const [answer, generating] = await Promise.all([
        extractPanelAnswer(panelState),
        isPanelGenerating(panelState),
      ]);
      if (!answer.ok) {
        state.unreadable += 1;
        // If a site cannot expose answer text, don't stall the whole queue:
        // give it a few polls after streaming stopped, then move on.
        if (!generating && state.unreadable >= QUEUE_UNREADABLE_POLLS) {
          state.done = true;
        }
      } else {
        state.unreadable = 0;
        Object.assign(state, getAnswerWaitState(state, { text: answer.text, generating }));
        if (isAnswerWaitDone(state)) {
          state.done = true;
        }
      }
      if (!state.done) {
        pending += 1;
        pendingLabels.push(recipient.label || getPanelLabel(panelState));
      }
    }));
    const pendingNames = pendingLabels.slice(0, 2).join("、") + (pendingLabels.length > 2 ? " 等" : "");
    item.statusText = pending > 0
      ? `已发送，等待 ${pendingNames || `${pending} 个面板`} 回答完成…`
      : "回答完成";
    renderMessageQueue();
    if (pending === 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, QUEUE_ANSWER_POLL_MS));
  }
  item.statusText = "等待回答超时，继续下一条";
  renderMessageQueue();
  logStatus("队列：等待回答超时，继续发送下一条", "warning");
}

async function processMessageQueue() {
  if (queueProcessing) return;
  queueProcessing = true;
  renderMessageQueue();
  try {
    while (queuedMessages.length > 0) {
      const item = queuedMessages[0];
      queueCurrentItem = item;
      item.statusText = "发送中…";
      item.waiting = false;
      renderMessageQueue();
      try {
        if (!panels.length || activePanelCount <= 0) {
          logStatus("队列：当前没有活动面板，跳过该条消息", "error");
        } else {
          comparisonLastPrompt = item.text;
          const activePanels = panels.slice(0, activePanelCount);
          if (await areAnyPanelsGenerating(activePanels)) {
            item.waiting = true;
            item.statusText = "等待当前回答完成…";
            renderMessageQueue();
            logStatus("队列：当前仍有面板在回答，等待全部完成后再发送", "info");
            const idleResult = await waitForPanelsIdle(activePanels, (busy) => {
              item.statusText = busy > 0 ? "等待当前回答完成…" : "准备发送…";
              renderMessageQueue();
            });
            item.waiting = false;
            if (idleResult === "timeout") {
              logStatus("队列：等待当前回答超时，仍继续发送该条", "warning");
            } else if (idleResult === "skipped") {
              logStatus("队列：已跳过当前等待，立即发送该条", "info");
            }
          }
          const snapshot = createBroadcastSnapshot(panels, activePanelCount, item.text, []);
          item.snapshot = snapshot;
          item.baselines = await captureAnswerBaselines(snapshot.recipients);
          logStatus(`队列：正在发送“${getQueueItemLabel(item)}”…`, "info");
          const results = await dispatchSnapshotToPanels(snapshot);
          item.results = results;
          presentResults(results);
          logBroadcastSummary(results);
          item.waiting = true;
          item.statusText = "已发送，等待回答完成…";
          renderMessageQueue();
          await waitForQueuedAnswers(item);
          item.waiting = false;
          if (queuedMessages.length > 1) {
            logStatus("队列：本条已完成，准备发送下一条", "success");
          }
        }
      } catch (error) {
        logStatus("队列：本条发送失败，已跳过", "error");
      }
      queuedMessages.shift();
      queueCurrentItem = null;
      renderMessageQueue();
    }
  } finally {
    queueProcessing = false;
    queueCurrentItem = null;
    renderMessageQueue();
  }
}

function setSendMode(value, { persist = false } = {}) {
  sendModeValue = normalizeSendMode(value);
  if (persist) {
    appSettings = { ...appSettings, sendMode: sendModeValue };
    persistSettings();
  }
  sendModeEl?.setAttribute("data-mode", sendModeValue);
  sendModeOptions.forEach((option) => {
    option.setAttribute("aria-checked", String(option.dataset.sendMode === sendModeValue));
  });
  if (sendButton) {
    const labels = {
      send: "发送消息",
      queue: "加入发送队列",
      fill: "仅填入网页输入框",
    };
    sendButton.setAttribute("aria-label", labels[sendModeValue]);
    sendButton.title = `${labels[sendModeValue]} (Enter)`;
  }
}

function openSendModeMenu() {
  if (!sendModeMenu) return;
  clearTimeout(sendModeCloseTimer);
  sendModeMenu.hidden = false;
  sendButton?.setAttribute("aria-expanded", "true");
}

function closeSendModeMenu() {
  if (!sendModeMenu) return;
  sendModeMenu.hidden = true;
  sendButton?.setAttribute("aria-expanded", "false");
}

function scheduleCloseSendModeMenu() {
  clearTimeout(sendModeCloseTimer);
  sendModeCloseTimer = setTimeout(closeSendModeMenu, 240);
}

sendModeEl?.addEventListener("pointerenter", openSendModeMenu);
sendModeEl?.addEventListener("pointerleave", scheduleCloseSendModeMenu);
sendModeEl?.addEventListener("focusin", openSendModeMenu);
sendModeEl?.addEventListener("focusout", scheduleCloseSendModeMenu);
sendModeMenu?.addEventListener("pointerenter", openSendModeMenu);
sendModeMenu?.addEventListener("pointerleave", scheduleCloseSendModeMenu);

sendModeOptions.forEach((option) => {
  option.addEventListener("click", () => {
    setSendMode(option.dataset.sendMode, { persist: true });
    closeSendModeMenu();
    logStatus(`发送方式已切换为“${option.querySelector(".send-mode-name")?.textContent || option.dataset.sendMode}”`, "info");
  });
});

sendButton?.addEventListener("keydown", (event) => {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  event.preventDefault();
  openSendModeMenu();
  const options = sendModeOptions;
  (event.key === "ArrowDown" ? options[0] : options[options.length - 1])?.focus();
});

sendModeMenu?.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.preventDefault();
    closeSendModeMenu();
    sendButton?.focus();
    return;
  }
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  event.preventDefault();
  const currentIndex = sendModeOptions.indexOf(document.activeElement);
  const direction = event.key === "ArrowDown" ? 1 : -1;
  const nextIndex = (currentIndex + direction + sendModeOptions.length) % sendModeOptions.length;
  sendModeOptions[nextIndex]?.focus();
});

document.addEventListener("pointerdown", (event) => {
  if (sendModeEl && event.target instanceof Node && !sendModeEl.contains(event.target)) {
    closeSendModeMenu();
  }
});

queueSkipWait?.addEventListener("click", () => {
  queueSkipWaitRequested = true;
  logStatus("队列：正在跳过当前等待", "info");
});

queueClear?.addEventListener("click", () => {
  const pending = queueCurrentItem ? queuedMessages.slice(1) : queuedMessages.slice();
  if (!pending.length) return;
  queuedMessages = queueCurrentItem ? [queueCurrentItem] : [];
  if (!queuedMessages.some((item) => item.id === queueEditingId)) {
    queueEditingId = null;
  }
  renderMessageQueue();
  logStatus("已清空排队消息", "info");
});

messageQueueList?.addEventListener("click", (event) => {
  const button = event.target instanceof HTMLButtonElement ? event.target : null;
  if (!button) return;
  if (button.dataset.queueEdit) {
    const item = queuedMessages.find((entry) => entry.id === button.dataset.queueEdit);
    startQueueEdit(item);
    return;
  }
  if (button.dataset.queueSave) {
    const item = queuedMessages.find((entry) => entry.id === button.dataset.queueSave);
    const input = button.closest(".message-queue-item")?.querySelector(".message-queue-edit-input");
    if (item && input) saveQueueEdit(item, input.value);
    return;
  }
  if (button.dataset.queueCancel) {
    cancelQueueEdit();
    return;
  }
  if (button.dataset.queueRemove) {
    const queueId = button.dataset.queueRemove;
    const item = queuedMessages.find((entry) => entry.id === queueId);
    if (!item || item === queueCurrentItem) return;
    queuedMessages = queuedMessages.filter((entry) => entry.id !== queueId);
    if (queueEditingId === queueId) queueEditingId = null;
    renderMessageQueue();
    logStatus("已删除一条排队消息", "info");
  }
});

messageQueueList?.addEventListener("keydown", (event) => {
  const input = event.target instanceof HTMLElement
    ? event.target.closest(".message-queue-edit-input")
    : null;
  if (!input) return;
  const item = queuedMessages.find((entry) => entry.id === input.dataset.queueId);
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    if (item) saveQueueEdit(item, input.value);
    return;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    cancelQueueEdit();
  }
});

setSendMode(sendModeValue);
applyWindowPreferences();

function selectLayout(layoutId) {
  const preset = normalizeLayoutPreset(layoutId);
  currentLayout = preset.id;
  persistLayout(currentLayout);
  synchronizeLayoutControls(preset.id);
  setPanelsLayoutGeometry(preset);
  ensurePanelCount(preset.count);
  syncAutomaticPanelZoom();
  traceLayoutState("selected");

}

layoutButtons.forEach((button) => {
  button.addEventListener("click", () => {
    selectLayout(button.dataset.layout);
  });
});

function isEditableShortcutTarget(target) {
  return target instanceof Element
    && Boolean(target.closest('input, textarea, select, [contenteditable="true"]'));
}

function isSendShortcut(event) {
  if (event.repeat || event.isComposing) return false;
  if (event.key !== "Enter" || event.shiftKey) return false;
  const mode = appSettings.shortcuts.send;
  if (mode === "enter") {
    return !event.metaKey && !event.ctrlKey && !event.altKey;
  }
  if (mode === "mod-enter") {
    return Boolean(event.metaKey || event.ctrlKey) && !event.altKey;
  }
  if (mode === "ctrl-enter") {
    return Boolean(event.ctrlKey) && !event.metaKey && !event.altKey;
  }
  return false;
}

function matchesLayoutShortcut(event) {
  const mode = appSettings.shortcuts.layout;
  if (mode === "disabled") return false;
  if (!event.altKey || event.repeat || event.isComposing) return false;
  if (mode === "alt-arrows") {
    return !event.metaKey && !event.ctrlKey;
  }
  if (mode === "mod-alt-arrows") {
    return Boolean(event.metaKey || event.ctrlKey);
  }
  return false;
}

function matchesComparisonShortcut(event) {
  const mode = appSettings.shortcuts.comparison;
  if (mode === "disabled" || event.repeat || event.isComposing) return false;
  const key = String(event.key || "").toLowerCase();
  if (key !== "c") return false;
  if (mode === "mod-shift-c") {
    return Boolean(event.shiftKey) && Boolean(event.metaKey || event.ctrlKey) && !event.altKey;
  }
  if (mode === "alt-c") {
    return Boolean(event.altKey) && !event.metaKey && !event.ctrlKey;
  }
  return false;
}

document.addEventListener("keydown", (event) => {
  if (isModelAddDialogOpen() || isComparisonDialogOpen()) {
    return;
  }
  if (isSettingsDialogOpen()) {
    return;
  }
  if (!matchesLayoutShortcut(event)) {
    return;
  }
  // Option+Arrow is macOS word navigation inside any text field; hijacking it
  // there would make typing in the composer feel broken. Use the sidebar layout
  // buttons while a website panel has focus.
  if (isEditableShortcutTarget(event.target)) {
    return;
  }
  const target = layoutButtons.find((button) => button.dataset.layout === currentLayout);
  if (!target) {
    return;
  }
  const index = layoutButtons.indexOf(target);
  const direction = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
  if (direction === 0) {
    return;
  }
  event.preventDefault();
  const nextIndex = (index + direction + layoutButtons.length) % layoutButtons.length;
  selectLayout(layoutButtons[nextIndex].dataset.layout);
});

sidebarToggle.addEventListener("click", () => {
  const collapsed = controlPanel.dataset.collapsed === "true";
  const next = !collapsed;
  controlPanel.dataset.collapsed = String(next);
  sidebarToggle.setAttribute("aria-expanded", String(!next));
  sidebarToggle.setAttribute("aria-label", next ? "展开侧边栏" : "折叠侧边栏");
});

if (modelAddButton) {
  modelAddButton.addEventListener("click", () => {
    openModelAddDialog();
  });
} else {
  console.error("找不到modelAddButton元素");
}

if (modelRestoreDefaultsButton) {
  modelRestoreDefaultsButton.addEventListener("click", () => {
    restoreDefaultModels();
  });
}

if (modelAddCancel) {
  modelAddCancel.addEventListener("click", () => {
    closeModelAddDialog();
  });
}

if (modelAddDialog) {
  modelAddDialog.addEventListener("click", (event) => {
    const target = event.target;
    if (target instanceof HTMLElement && target.dataset.dismiss !== undefined) {
      closeModelAddDialog();
    }
  });
}

if (modelAddForm) {
  modelAddForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const label = modelAddNameInput?.value.trim() || "";
    if (!label) {
      logStatus("模型名称不能为空", "error");
      modelAddNameInput?.focus();
      return;
    }

    const urlInput = modelAddUrlInput?.value.trim() || "";
    if (!urlInput) {
      logStatus("网站链接不能为空", "error");
      modelAddUrlInput?.focus();
      return;
    }

    let parsedUrl;
    try {
      parsedUrl = new URL(urlInput);
    } catch (error) {
      logStatus("请输入有效的 HTTPS 网址", "error");
      modelAddUrlInput?.focus();
      return;
    }

    if (parsedUrl.protocol !== "https:") {
      logStatus("仅支持 HTTPS 链接", "error");
      modelAddUrlInput?.focus();
      return;
    }

    if (isRestrictedCustomProviderUrl(parsedUrl)) {
      logStatus("不能将 GitHub 站点注册为 AI 模型，以保护本地 GitHub 信息", "error");
      modelAddUrlInput?.focus();
      return;
    }

    const id = normalizeId(label);
    const newModel = {
      id,
      label,
      url: parsedUrl.toString(),
      partition: `persist:${id}`,
      composeMessageScript: buildGenericScript,
      allowAutoSend: Boolean(modelAddAutoSendInput?.checked),
    };

    if (!registerModel(newModel)) {
      modelAddNameInput?.focus();
      return;
    }

    logStatus(`${label} 已成功添加到模型列表`, "success");
    closeModelAddDialog();
  });
}

if (settingsButton) {
  settingsButton.addEventListener("click", openSettingsDialog);
}
if (collapsedSettingsButton) {
  collapsedSettingsButton.addEventListener("click", openSettingsDialog);
}
if (settingsClose) {
  settingsClose.addEventListener("click", () => closeSettingsDialog());
}
if (settingsCancel) {
  settingsCancel.addEventListener("click", () => closeSettingsDialog());
}
if (settingsDialog) {
  settingsDialog.addEventListener("click", (event) => {
    const target = event.target;
    if (target instanceof HTMLElement && target.dataset.settingsDismiss !== undefined) {
      closeSettingsDialog();
    }
  });
}
if (settingsReset) {
  settingsReset.addEventListener("click", resetSettingsForm);
}

async function openSettingsExternal(url) {
  try {
    const opened = await window.qask?.app?.openExternal?.(url);
    if (settingsAboutStatus) {
      settingsAboutStatus.textContent = opened ? "已在系统浏览器中打开" : "无法打开该链接";
    }
  } catch (error) {
    if (settingsAboutStatus) settingsAboutStatus.textContent = "无法打开该链接";
  }
}

settingsOpenRepo?.addEventListener("click", () => openSettingsExternal("https://github.com/CYK16688/Qask"));
settingsOpenReleases?.addEventListener("click", () => openSettingsExternal("https://github.com/CYK16688/Qask/releases"));
settingsOpenData?.addEventListener("click", async () => {
  try {
    const opened = await window.qask?.app?.openUserData?.();
    if (settingsAboutStatus) {
      settingsAboutStatus.textContent = opened ? "已打开本地数据目录" : "无法打开本地数据目录";
    }
  } catch (error) {
    if (settingsAboutStatus) settingsAboutStatus.textContent = "无法打开本地数据目录";
  }
});
if (settingsForm) {
  settingsForm.addEventListener("submit", (event) => {
    event.preventDefault();
    appSettings = normalizeSettings({
      ...appSettings,
      sendMode: settingsSendMode?.value,
      comparisonModelId: settingsComparisonModel?.value,
      confirmSummary: Boolean(settingsConfirmSummary?.checked),
      autoUploadAttachments: Boolean(settingsAutoUpload?.checked),
      autoPanelZoom: Boolean(settingsAutoZoom?.checked),
      alwaysOnTop: Boolean(settingsAlwaysOnTop?.checked),
      launchAtLogin: Boolean(settingsLaunchAtLogin?.checked),
      showStatusBar: Boolean(settingsShowStatus?.checked),
      shortcuts: {
        send: settingsSendShortcut?.value,
        layout: settingsLayoutShortcut?.value,
        comparison: settingsComparisonShortcut?.value,
      },
    });
    persistSettings();
    setSendMode(appSettings.sendMode);
    themeMode = THEME_MODES.has(settingsTheme?.value) ? settingsTheme.value : "system";
    applyTheme({ persist: true });
    applyWindowPreferences();
    syncAutomaticPanelZoom();
    renderAttachmentPreview();
    applyStatusBarVisibility();
    closeSettingsDialog();
    logStatus("设置已保存", "success");
  });
}

// 添加附件按钮事件
if (addAttachmentBtn) {
  addAttachmentBtn.addEventListener('click', () => {
    attachmentInput.click();
  });
}

broadcastForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  closeSendModeMenu();
  if (isBroadcasting) return;
  const broadcastBlockReason = getBroadcastBlockReason();
  if (broadcastBlockReason) {
    logStatus(broadcastBlockReason, "info");
    return;
  }
  const text = broadcastInput.value.trim();
  if (!text && attachments.size === 0) {
    logStatus("请输入内容或选择附件", "error");
    return;
  }
  if (!text && attachments.size > 0) {
    updateAttachmentLocalHint("请先输入文字再发送；附件会尝试自动填入网页上传控件。");
    broadcastInput.focus();
    logStatus("附件需要配合文字发送；请输入文字后再点发送。", "warning");
    return;
  }
  if (sendModeValue === "queue") {
    if (attachments.size > 0) {
      logStatus("排队发送暂不支持附件；请移除附件或改用立即发送", "error");
      return;
    }
    if (!text) {
      logStatus("请输入内容后再加入队列", "error");
      return;
    }
    if (enqueueMessage(text)) {
      broadcastInput.value = "";
      draftRevision += 1;
      pendingBroadcastTurn = null;
      autoResize(broadcastInput);
    }
    return;
  }
  const fillOnly = sendModeValue === "fill";
  const draftSnapshot = { text: broadcastInput.value, revision: draftRevision };
  const pendingAction = getPendingBroadcastAction(pendingBroadcastTurn, {
    value: broadcastInput.value,
    revision: draftRevision,
  }, activePanelCount, getRankedModelIds(modelOrder, activePanelCount));
  if (pendingAction.mode === "hold") {
    logStatus("该消息已填入网页，请先在网页中确认或修改草稿后再发送", "info");
    return;
  }

  comparisonLastPrompt = text;
  isBroadcasting = true;
  syncComposerState();
  // 显示发送状态
  logStatus(`正在发送消息到 ${activePanelCount} 个模型...`, "info");

  try {
  const localAttachments = Array.from(attachments.values());
  const attachmentPayload = buildAttachmentPayloads(localAttachments);

    const snapshot = pendingAction.mode === "retry"
      ? {
        text,
        attachments: pendingAction.attachments,
        recipients: pendingAction.recipients,
      }
      : createBroadcastSnapshot(panels, activePanelCount, text, attachmentPayload);
    const results = await dispatchSnapshotToPanels(snapshot, { fillOnly });
    presentResults(results);
    const completedSnapshot = pendingAction.mode === "retry" && pendingBroadcastTurn
      ? pendingBroadcastTurn
      : snapshot;
    const completedResults = pendingAction.mode === "retry" && pendingBroadcastTurn
      ? mergePendingBroadcastResults(pendingBroadcastTurn, snapshot.recipients, results)
      : results;
    pendingBroadcastTurn = createPendingBroadcastTurn(
      completedSnapshot,
      draftSnapshot,
      activePanelCount,
      completedResults,
    );

    logBroadcastSummary(results);

    if (attachmentPayload.length > 0) {
      const uploadFailures = results.filter((entry) => entry.attachmentUploadFailed === true);
      const uploadedCount = results.filter((entry) => entry.attachmentUploaded === true).length;
      if (uploadFailures.length) {
        updateAttachmentLocalHint("有附件上传失败；请在这些网页中手动上传后再试。");
      }
      logStatus(
        uploadFailures.length
          ? "部分附件上传失败；请在各网页自己的上传界面中选择、确认并手动上传。"
          : uploadedCount > 0
            ? "附件已填入网页上传控件；请确认各网页的附件预览后再发送。"
            : "附件未自动上传；请在各网页自己的上传界面中选择、确认并手动上传。",
        uploadFailures.length ? "warning" : "info",
      );
    }

    if (shouldClearBroadcastDraft(draftSnapshot, {
      value: broadcastInput.value,
      revision: draftRevision,
    }, results)) {
      broadcastInput.value = "";
      draftRevision += 1;
      pendingBroadcastTurn = null;
      autoResize(broadcastInput);
    }
    restoreComposerFocusAfterBroadcast();
  } finally {
    isBroadcasting = false;
    syncComposerState();
    restoreComposerFocusAfterBroadcast();
  }
});

broadcastInput.addEventListener("keydown", (event) => {
  if (event.isComposing || event.keyCode === 229) {
    return;
  }
  if (isSendShortcut(event)) {
    event.preventDefault();
    if (isBroadcasting) return;
    const blockReason = getBroadcastBlockReason();
    if (blockReason) {
      logStatus(blockReason, "info");
      return;
    }
    broadcastForm.requestSubmit();
  }
});

// 键盘快捷键支持
document.addEventListener('keydown', (event) => {
  trapModelAddDialogFocus(event);
  trapComparisonDialogFocus(event);
  trapSettingsDialogFocus(event);
  if (event.key === 'Escape' && isSettingsDialogOpen()) {
    event.preventDefault();
    closeSettingsDialog();
    return;
  }
  if (event.key === 'Escape' && isComparisonDialogOpen()) {
    event.preventDefault();
    closeComparisonDialog();
    return;
  }
  if (event.key === 'Escape' && keyboardDraggedModelId && !isModelAddDialogOpen()) {
    event.preventDefault();
    cancelKeyboardModelDrag();
    return;
  }
  if (event.key === 'Escape' && isModelAddDialogOpen()) {
    event.preventDefault();
    closeModelAddDialog();
    return;
  }


  // Ctrl/Cmd + ,: 打开设置
  const isCommaShortcut = event.key === ',' || event.code === 'Comma';
  if ((event.ctrlKey || event.metaKey) && isCommaShortcut && !isModelAddDialogOpen() && !isComparisonDialogOpen()) {
    event.preventDefault();
    if (isSettingsDialogOpen()) {
      closeSettingsDialog();
    } else {
      openSettingsDialog();
    }
    return;
  }

  // Configurable comparison shortcut.
  if (!isModelAddDialogOpen() && !isComparisonDialogOpen() && !isSettingsDialogOpen()
    && matchesComparisonShortcut(event)
    && !isEditableShortcutTarget(event.target)) {
    event.preventDefault();
    openComparisonDialog();
    return;
  }

  // Ctrl/Cmd + /: 显示快捷键帮助
  if ((event.ctrlKey || event.metaKey) && event.key === '/') {
    event.preventDefault();
    showShortcutHelp();
  }
});

function showShortcutHelp() {
  // Keep this list identical to the implemented handlers; the status strip is
  // the feedback channel, so no blocking alert is needed.
  const sendLine = appSettings.shortcuts.send === "enter"
    ? "• Enter：发送消息"
    : appSettings.shortcuts.send === "mod-enter"
      ? "• ⌘/Ctrl + Enter：发送消息"
      : "• Ctrl + Enter：发送消息";
  const layoutLine = appSettings.shortcuts.layout === "alt-arrows"
    ? "• Alt + ←/→：切换布局（可在设置中修改）"
    : appSettings.shortcuts.layout === "mod-alt-arrows"
      ? "• ⌘/Ctrl + Alt + ←/→：切换布局"
      : "• 切换布局：未设置快捷键";
  const comparisonLine = appSettings.shortcuts.comparison === "mod-shift-c"
    ? "• ⌘/Ctrl + Shift + C：打开回答对比"
    : appSettings.shortcuts.comparison === "alt-c"
      ? "• Alt + C：打开回答对比"
      : "• 打开回答对比：未设置快捷键";
  [
    "快捷键帮助：",
    sendLine,
    "• Shift + Enter：换行",
    layoutLine,
    comparisonLine,
    "• Ctrl/Cmd + /：显示此帮助",
    "• ⌘/Ctrl + ,：打开设置",
    "• 悬停发送按钮：立即发送 / 排队发送 / 仅填入",
  ].forEach((line) => logStatus(line, "info"));
  // Help is an explicit request; surface the transcript even when the status
  // bar is normally hidden.
  if (!appSettings.showStatusBar && broadcastStatus && broadcastStatusList?.children.length) {
    broadcastStatus.hidden = false;
    broadcastStatus.scrollTop = broadcastStatus.scrollHeight;
  }
}

// 更新日期时间显示
function updateDateTime() {
  if (!collapsedDateEl || !collapsedTimeEl) return;

  const now = new Date();

  // 格式化日期：MM/DD
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  collapsedDateEl.textContent = `${month}/${day}`;

  // 格式化时间：HH:MM
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  collapsedTimeEl.textContent = `${hours}:${minutes}`;
}

// 每秒更新时间
setInterval(updateDateTime, 1000);
updateDateTime(); // 立即更新一次

// 折叠布局按钮事件
collapsedLayoutButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    const layout = btn.dataset.layout;
    selectLayout(layout);
  });
});


// 截图功能
if (screenshotBtn && window.qask && window.qask.screenshot) {
  // 注册截图回调
  window.qask.screenshot.onSaved(() => {
    logStatus("截图已保存到本地", "success");
  });

  window.qask.screenshot.onCancelled(() => {
    logStatus("已取消截图", "info");
  });

  // 点击截图按钮
  screenshotBtn.addEventListener("click", () => {
    try {
      window.qask.screenshot.take();
    } catch {
      logStatus("截图功能暂不可用", "error");
    }
  });
}

DEFAULT_MODELS.forEach((model) => {
  if (!hiddenDefaultModelIds.has(model.id)) {
    registerModel(model, { replace: true });
  }
});
let removedUnsafeCustomModel = false;
persistedCustomModels.forEach((model) => {
  if (!model || !model.id || !model.url) {
    removedUnsafeCustomModel = true;
    return;
  }
  if (isRestrictedCustomProviderUrl(model.url)) {
    removedUnsafeCustomModel = true;
    return;
  }
  const registered = registerModel(
    {
      ...model,
      composeMessageScript: buildGenericScript,
      origin: "custom",
      partition: model.partition || `persist:${model.id}`,
      allowAutoSend: Boolean(model.allowAutoSend),
    },
    { replace: true }
  );
  if (!registered) {
    removedUnsafeCustomModel = true;
  }
});
if (removedUnsafeCustomModel) {
  persistCustomModels();
}
modelOrder = normalizeModelOrder(persistedModelOrder, Array.from(modelRegistry.keys()));
persistModelOrder();
refreshModelList();
selectLayout(currentLayout);
logStatus("Qask 多模型桥接器已启动，请先登录各模型平台", "success");
