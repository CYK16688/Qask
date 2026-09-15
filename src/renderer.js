const escapeForScript = (value) => JSON.stringify(value ?? "");
const boolLiteral = (value) => (value ? "true" : "false");
const ORIGIN_GUARD_FAILURE = "if (typeof qaskOriginAllowed === 'function' && !qaskOriginAllowed()) return { success: false, reason: '网页已跳转到未验证来源；为保护内容已取消发送', autoSent: false };";
const layoutLifecycleTraceEnabled = typeof window !== "undefined"
  && window.qask?.diagnostics?.layoutLifecycleTraceEnabled === true;

const STORAGE_KEYS = {
  layout: "qask.layout",
  customModels: "qask.customModels",
  modelOrder: "qask.modelOrder",
};

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

function shouldClearAttachmentsForResults(results, attachmentCount) {
  // A third-party page's DOM signal cannot prove the provider uploaded or read a file.
  // Keep host attachments until the user explicitly removes them.
  return attachmentCount === 0;
}

function shouldAutoSendAttachmentMessage(localAttachmentCount, attachmentReadFailureCount) {
  // Qask deliberately does not inject local file bytes into a provider page.
  return localAttachmentCount === 0 && attachmentReadFailureCount === 0;
}

function getAttachmentDispatchStatus(report = {}) {
  const requested = Number(report.requested) || 0;
  if (requested === 0) return "success";
  const assigned = Number(report.assigned) || 0;
  return assigned > 0 ? "partial" : "error";
}

function getBroadcastResultLevel(results = []) {
  const statuses = Array.isArray(results) ? results.map((entry) => entry?.status) : [];
  if (statuses.includes("error")) return "error";
  if (statuses.includes("partial")) return "warning";
  if (statuses.includes("success")) return "success";
  return "error";
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
  // an attachment-bearing turn automatically.
  if (snapshot.attachments.length > 0) return null;
  const retryRecipients = snapshot.recipients.filter((recipient, index) => (
    results[index]?.attemptedAutoSend !== true
    && results[index]?.status === "error"
  ));
  const hasManualFill = results.some((result) => (
    result?.status === "success" && result?.attemptedAutoSend !== true
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
  };
}

function mergePendingBroadcastResults(pendingTurn, retryRecipients, retryResults) {
  if (!pendingTurn) return Array.isArray(retryResults) ? retryResults : [];
  return pendingTurn.recipients.map((recipient, index) => {
    const retryIndex = retryRecipients.indexOf(recipient);
    return retryIndex >= 0 ? retryResults[retryIndex] : pendingTurn.results[index];
  });
}

function getPendingBroadcastAction(pendingTurn, currentDraft, activeCount) {
  if (!pendingTurn) return { mode: "new" };
  if (pendingTurn.text !== currentDraft?.value || pendingTurn.revision !== currentDraft?.revision) {
    return { mode: "new" };
  }
  if (pendingTurn.activeCount !== activeCount) return { mode: "new" };
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
    run(webview, operation) {
      if (!webview || inFlight.has(webview)) {
        return Promise.resolve({ skipped: true });
      }
      const task = Promise.resolve().then(operation);
      inFlight.set(webview, task);
      task.finally(() => {
        if (inFlight.get(webview) === task) {
          inFlight.delete(webview);
        }
      }).catch(() => {});
      return task;
    },
  };
}

async function settleBroadcastTasks(recipients, dispatch, timeoutMs = 15_000) {
  const boundedTimeout = Math.max(1, Number(timeoutMs) || 15_000);
  return Promise.all((Array.isArray(recipients) ? recipients : []).map(async (recipient) => {
    const fallbackLabel = recipient?.label || "网页面板";
    let timerId;
    const timeout = new Promise((resolve) => {
      timerId = setTimeout(() => {
        resolve({ panel: fallbackLabel, status: "error", message: "发送等待超时；请检查该网页后重试" });
      }, boundedTimeout);
    });
    try {
      return await Promise.race([
        Promise.resolve().then(() => dispatch(recipient)),
        timeout,
      ]);
    } catch {
      return { panel: fallbackLabel, status: "error", message: "发送失败" };
    } finally {
      clearTimeout(timerId);
    }
  }));
}

async function buildAttachmentPayloads(entries) {
  const payload = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    payload.push({
      id: entry.id,
      kind: entry.kind,
      name: entry.file.name,
      type: entry.file.type,
      size: entry.file.size,
      source: entry.source,
    });
  }
  return { payload, failures: [] };
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

function getRecordingStopAction(recorder) {
  if (!recorder) return "cleanup";
  return recorder.state === "inactive" ? "draining" : "stop";
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
  };
}

function requestRecordingStop(session, { discard = false, message = "" } = {}) {
  if (!session || session.finalized) return "cleanup";
  session.discard = session.discard || discard;
  if (message) session.stopMessage = message;
  if (session.stopRequested) {
    session.stopRequested = true;
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

function getPanelPlacementPlan(currentModelIds, order, activeCount) {
  const currentIds = Array.isArray(currentModelIds) ? currentModelIds : [];
  const desiredIds = getRankedModelIds(order, activeCount);
  const sourceIndexes = desiredIds.map((modelId) => (modelId ? currentIds.indexOf(modelId) : -1));
  const reservedIndexes = new Set(sourceIndexes.filter((index) => index >= 0));
  const availableIndexes = currentIds
    .map((_, index) => index)
    .filter((index) => !reservedIndexes.has(index));

  return desiredIds.map((modelId, index) => {
    const sourceIndex = sourceIndexes[index];
    const panelIndex = sourceIndex >= 0 ? sourceIndex : availableIndexes.shift();
    if (!Number.isInteger(panelIndex)) {
      return { action: modelId ? "load" : "clear", index, modelId: modelId || null, panelIndex: null };
    }
    if (!modelId) {
      return { action: "clear", index, modelId: null, panelIndex };
    }
    if (sourceIndex >= 0) {
      return {
        action: sourceIndex === index ? "keep" : "move",
        index,
        modelId,
        sourceIndex,
        panelIndex,
      };
    }
    return { action: "load", index, modelId, panelIndex };
  });
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
    const button = form ? form.querySelector('button[type="submit"]') : null;
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
  `
    : "let attemptedAutoSend = false;";
  return `(async () => {
    const target = document.querySelector('textarea[data-id="prompt-textarea"]');
    if (!target) {
      return { success: false, reason: "输入框尚未出现" };
    }
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
    setter.call(target, ${payload});
    target.dispatchEvent(new Event("input", { bubbles: true }));
    if (typeof InputEvent === 'function') {
      target.dispatchEvent(new InputEvent('input', { bubbles: true, data: ${payload}, inputType: 'insertFromPaste', cancelable: true, composed: true }));
    }
    target.dispatchEvent(new Event("change", { bubbles: true }));
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
    if (typeof InputEvent === 'function') {
      editable.dispatchEvent(new InputEvent('input', { bubbles: true, data: ${payload}, inputType: 'insertFromPaste', cancelable: true, composed: true }));
    }
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
  `
    : "let attemptedAutoSend = false;";
  return `(async () => {
    const textarea = document.querySelector('textarea');
    const editable = document.querySelector('[contenteditable="true"]');
    const inputTarget = textarea || editable;
    if (!inputTarget) {
      return { success: false, reason: "输入框尚未出现" };
    }
    if (textarea) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
      setter.call(textarea, ${payload});
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      if (typeof InputEvent === 'function') {
        textarea.dispatchEvent(new InputEvent('input', { bubbles: true, data: ${payload}, inputType: 'insertFromPaste', cancelable: true, composed: true }));
      }
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
      if (typeof InputEvent === 'function') {
        editable.dispatchEvent(new InputEvent('input', { bubbles: true, data: ${payload}, inputType: 'insertFromPaste', cancelable: true, composed: true }));
      }
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
    if (sendButton && !sendButton.disabled && sendButton.getAttribute?.('aria-disabled') !== 'true' && typeof sendButton.click === 'function') {
      sendButton.click();
      attemptedAutoSend = true;
    } else if (!sendButton && editable) {
      const keyEventInit = ${KEY_EVENT_INIT};
      editable.dispatchEvent(new KeyboardEvent('keydown', keyEventInit));
      editable.dispatchEvent(new KeyboardEvent('keypress', keyEventInit));
      editable.dispatchEvent(new KeyboardEvent('keyup', keyEventInit));
      attemptedAutoSend = true;
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
    if (typeof InputEvent === 'function') {
      editable.dispatchEvent(new InputEvent('input', { bubbles: true, data: ${payload}, inputType: 'insertFromPaste', cancelable: true, composed: true }));
    }
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
    if (sendButton && !sendButton.disabled && sendButton.getAttribute?.('aria-disabled') !== 'true' && typeof sendButton.click === 'function') {
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
    `
    : "let attemptedAutoSend = false;";

  return `(async () => {
    const textarea = document.querySelector('textarea[aria-label*="Copilot" i], textarea[aria-label*="输入"], textarea');
    const editable = !textarea ? document.querySelector('[contenteditable="true"][role="textbox"], div[contenteditable="true"][aria-label]') : null;
    const target = textarea || editable;
    if (!target) {
      return { success: false, reason: "输入框尚未出现" };
    }
    if (textarea) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
      setter.call(textarea, ${payload});
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      if (typeof InputEvent === 'function') {
        textarea.dispatchEvent(new InputEvent('input', { bubbles: true, data: ${payload}, inputType: 'insertFromPaste', cancelable: true, composed: true }));
      }
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
      if (typeof InputEvent === 'function') {
        editable.dispatchEvent(new InputEvent('input', { bubbles: true, data: ${payload}, inputType: 'insertFromPaste', cancelable: true, composed: true }));
      }
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
    if (sendButton && !sendButton.disabled && sendButton.getAttribute?.('aria-disabled') !== 'true' && typeof sendButton.click === 'function') {
      sendButton.click();
      attemptedAutoSend = true;
    } else if (!sendButton && target) {
      const keyEventInit = ${KEY_EVENT_INIT};
      target.dispatchEvent(new KeyboardEvent('keydown', keyEventInit));
      target.dispatchEvent(new KeyboardEvent('keypress', keyEventInit));
      target.dispatchEvent(new KeyboardEvent('keyup', keyEventInit));
      attemptedAutoSend = true;
    }
    `
    : "let attemptedAutoSend = false;";

  return `(async () => {
    const selectors = [
      'textarea',
      '[contenteditable="true"][data-placeholder]',
      'div[contenteditable="true"][role="textbox"]'
    ];
    const target = selectors.map((selector) => document.querySelector(selector)).find(Boolean);
    if (!target) {
      return { success: false, reason: "输入框尚未出现" };
    }
    if (target instanceof HTMLTextAreaElement) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
      setter.call(target, ${payload});
      target.dispatchEvent(new Event('input', { bubbles: true }));
      if (typeof InputEvent === 'function') {
        target.dispatchEvent(new InputEvent('input', { bubbles: true, data: ${payload}, inputType: 'insertFromPaste', cancelable: true, composed: true }));
      }
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
      if (typeof InputEvent === 'function') {
        target.dispatchEvent(new InputEvent('input', { bubbles: true, data: ${payload}, inputType: 'insertFromPaste', cancelable: true, composed: true }));
      }
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
    let attemptedAutoSend = false;
    const sendButton = document.querySelector('button[data-testid="chat-send"], button[aria-label*="发送"], button[data-icon="send"], button[type="submit"]');
    if (sendButton && !sendButton.disabled && sendButton.getAttribute?.('aria-disabled') !== 'true' && typeof sendButton.click === 'function') {
      sendButton.click();
      attemptedAutoSend = true;
    } else if (!sendButton && target) {
      const keyEventInit = ${KEY_EVENT_INIT};
      target.dispatchEvent(new KeyboardEvent('keydown', keyEventInit));
      target.dispatchEvent(new KeyboardEvent('keypress', keyEventInit));
      target.dispatchEvent(new KeyboardEvent('keyup', keyEventInit));
      attemptedAutoSend = true;
    }
    `
    : "let attemptedAutoSend = false;";

  return `(async () => {
    const textarea = document.querySelector('textarea, textarea[aria-label], textarea[placeholder]');
    const editable = !textarea ? document.querySelector('[contenteditable="true"][role="textbox"], div[contenteditable="true"][aria-label]') : null;
    const target = textarea || editable;
    if (!target) {
      return { success: false, reason: "输入框尚未出现" };
    }
    if (textarea) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
      setter.call(textarea, ${payload});
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      if (typeof InputEvent === 'function') {
        textarea.dispatchEvent(new InputEvent('input', { bubbles: true, data: ${payload}, inputType: 'insertFromPaste', cancelable: true, composed: true }));
      }
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
      if (typeof InputEvent === 'function') {
        editable.dispatchEvent(new InputEvent('input', { bubbles: true, data: ${payload}, inputType: 'insertFromPaste', cancelable: true, composed: true }));
      }
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
        if (typeof InputEvent === 'function') {
          el.dispatchEvent(new InputEvent('input', { bubbles: true, data: ${payload}, inputType: 'insertFromPaste', cancelable: true, composed: true }));
        }
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
        if (typeof InputEvent === 'function') {
          el.dispatchEvent(new InputEvent('input', { bubbles: true, data: ${payload}, inputType: 'insertFromPaste', cancelable: true, composed: true }));
        }
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
    if (sendButton && !sendButton.disabled && sendButton.getAttribute?.('aria-disabled') !== 'true' && typeof sendButton.click === 'function') {
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

const storedCustomModels = loadFromStorage(STORAGE_KEYS.customModels, []);
const persistedCustomModels = Array.isArray(storedCustomModels) ? storedCustomModels : [];
const storedModelOrder = loadFromStorage(STORAGE_KEYS.modelOrder, []);
const persistedModelOrder = Array.isArray(storedModelOrder) ? storedModelOrder : [];
let currentLayout = loadFromStorage(STORAGE_KEYS.layout, "dual");
if (!LAYOUT_PRESETS[currentLayout]) {
  currentLayout = "dual";
}

const controlPanel = document.querySelector(".control-panel");
const sidebarToggle = document.getElementById("sidebarToggle");
const layoutControls = document.getElementById("layoutControls");
const layoutButtons = Array.from(layoutControls.querySelectorAll("[data-layout]"));
const modelList = document.getElementById("modelList");
const modelAddButton = document.getElementById("modelAddButton");
const appShell = document.querySelector(".app-shell");
const modelAddDialog = document.getElementById("modelAddDialog");
const modelAddForm = document.getElementById("modelAddForm");
const modelAddNameInput = document.getElementById("modelAddName");
const modelAddUrlInput = document.getElementById("modelAddUrl");
const modelAddAutoSendInput = document.getElementById("modelAddAutoSend");
const modelAddCancel = document.getElementById("modelAddCancel");
const panelsContainer = document.getElementById("panelsContainer");
const broadcastForm = document.getElementById("broadcastForm");
const broadcastInput = document.getElementById("broadcastInput");
const attachmentInput = document.getElementById("attachmentInput");
const attachmentPreview = document.getElementById("attachmentPreview");
const sendButton = document.getElementById("sendButton");
const addAttachmentBtn = document.getElementById("addAttachment");
const recordAudioButton = document.getElementById("recordAudioButton");
const stopRecordingButton = document.getElementById("stopRecordingButton");
const cancelRecordingButton = document.getElementById("cancelRecordingButton");

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

  const { approved, rejected } = await inspectSelectedAttachments(imageFiles);
  if (rejected.length) {
    logStatus(`为保护本地 GitHub 与凭据数据，已拒绝 ${rejected.length} 个敏感或不可验证附件`, "error");
  }
  const entries = await Promise.all(approved.map((file) => addAttachment(file, 'clipboard')));
  const added = entries.filter(Boolean);
  if (added.length) {
    renderAttachmentPreview();
    logStatus(`粘贴了 ${added.length} 张图片`, "info");
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
const dispatchCoordinator = createDispatchCoordinator();

function getAttachmentManifest() {
  return Array.from(attachments.values()).map(({ id, file, source, kind }) => ({
    id,
    name: file.name,
    type: file.type,
    size: file.size,
    source,
    kind,
  }));
}

async function inspectSelectedAttachments(files) {
  const approved = [];
  const rejected = [];
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
      } else {
        rejected.push({ file, reason: inspection?.reason || "local-data-boundary" });
      }
    } catch {
      rejected.push({ file, reason: "local-data-boundary" });
    }
  }
  return { approved, rejected };
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

function releaseMicrophoneLease(leaseId) {
  if (!leaseId) return;
  window.qask?.microphone?.releaseAccess?.(leaseId).catch(() => {});
}

function clearRecordingTimers(session) {
  if (!session) return;
  if (session.timer) clearInterval(session.timer);
  if (session.limitTimer) clearTimeout(session.limitTimer);
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
  const entry = await addAttachment(file, "recording");
  if (entry) {
    renderAttachmentPreview();
  }
}

async function addAttachment(file, source = "local") {
  const validation = validateAttachmentMeta(file, Array.from(attachments.values()));
  if (!validation.valid) {
    logStatus(validation.reason, "error");
    return null;
  }

  const id = `att-${attachmentCounter++}`;
  const entry = { id, file, source, kind: validation.kind };
  attachments.set(id, entry);
  return entry;
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

function logStatus(message, level = "info") {
  const prefix = level === "error" ? "[错误]" : level === "success" ? "[完成]" : "[提示]";
  const method = level === "error" ? console.error : console.info;
  method(`${prefix} ${message}`);
}


function getBroadcastBlockReason() {
  if (activeRecorder || recordingStartPending) {
    return "请先停止或取消录音，再发送消息";
  }
  return "";
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

function registerModel(model, { replace = false } = {}) {
  if (!replace && modelRegistry.has(model.id)) {
    logStatus(`${model.label} 已存在`, "error");
    return false;
  }
  if (model.origin !== "default" && isRestrictedCustomProviderUrl(model.url)) {
    logStatus("不能将 GitHub 站点注册为 AI 模型，以保护本地 GitHub 信息", "error");
    return false;
  }
  const normalized = {
    ...model,
    origin: model.origin || "custom",
    composeMessageScript: model.composeMessageScript || buildGenericScript,
    allowAutoSend: model.origin === "default" || Boolean(model.allowAutoSend),
  };
  normalized.allowedOrigins = getAllowedOrigins(normalized);
  if (!normalized.allowedOrigins.length) {
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
  const label = modelRegistry.get(modelId)?.label ?? modelId;
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
    dragHandle.textContent = "⠿";
    dragHandle.setAttribute("aria-label", `拖动排序 ${model.label}`);
    dragHandle.title = "拖动排序";
    dragHandle.setAttribute("aria-pressed", "false");
    dragHandle.addEventListener("dragstart", (event) => {
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
        const selectedHandle = modelList.querySelector(`[data-model-id="${model.id}"] .model-drag-handle`);
        selectedHandle?.focus();
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
      const nextHandle = modelList.querySelector(`[data-model-id="${model.id}"] .model-drag-handle`);
      nextHandle?.focus();
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

  root.append(viewWrapper);

  const panelState = {
    id: `panel-${index}`,
    root,
    viewWrapper,
    webview: null,
    modelId: null,
    ready: false,
    loadState: PANEL_LOAD_STATES.loading,
    zoomFactor: getAutomaticPanelZoom(currentLayout),
  };
  return panelState;
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
    panelState.zoomFactor = getAutomaticPanelZoom(currentLayout);
    applyPanelZoom(panelState);
  });
}

function swapWebview(panelState, newWebview) {
  if (panelState.webview) {
    panelState.webview.remove();
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
    const previousLoadState = panelState.loadState;
    updatePanelLoadState(panelState, "ready");
    traceLifecycle("dom-ready");
    applyPanelZoom(panelState);
    if (!shouldRunPanelReadyEffects(previousLoadState, panelState.loadState)) {
      return;
    }
    logStatus(`${config.label} 已就绪，可以填充内容`, "success");
    const currentUrl = webview.getURL?.() || "";
    if (!isTrustedGuestUrl(currentUrl, config.allowedOrigins || [])) {
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
    updatePanelLoadState(panelState, "start");
    traceLifecycle("did-start-navigation");
  });

  webview.addEventListener("did-start-loading", () => {
    if (panelState.webview !== webview) return;
    traceLifecycle("did-start-loading");
  });

  webview.addEventListener("did-finish-load", () => {
    if (panelState.webview !== webview) return;
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
    traceLifecycle("did-fail-load", { errorCode: event.errorCode });
    logStatus(`${config.label} 加载失败，请检查网络`, "error");
  });

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

async function dispatchMessage(panelState, text, attachmentManifest = []) {
  if (!panelState.modelId) {
    return { panel: getPanelLabel(panelState), status: "error", message: "未选择模型" };
  }
  if (!panelState.webview) {
    return { panel: getPanelLabel(panelState), status: "error", message: "窗口尚未加载" };
  }
  if (!panelState.ready) {
    return { panel: getPanelLabel(panelState), status: "error", message: "请等待页面加载完成" };
  }
  if (dispatchCoordinator.isBusy(panelState.webview)) {
    return { panel: getPanelLabel(panelState), status: "error", message: "上一轮消息仍在该网页中处理" };
  }

  const config = modelRegistry.get(panelState.modelId);
  if (!config) {
    return { panel: getPanelLabel(panelState), status: "error", message: "模型配置不可用", attachments: { requested: attachmentManifest.length, confirmed: 0 } };
  }
  const currentUrl = panelState.webview.getURL?.() || "";
  if (!isTrustedGuestUrl(currentUrl, config.allowedOrigins || [])) {
    return {
      panel: config.label,
      status: "error",
      message: "网页已跳转到未验证来源；为保护附件已取消发送",
      attachments: { requested: attachmentManifest.length, confirmed: 0, unverified: [], manualRequired: [] },
    };
  }
  const hasAttachments = attachmentManifest.length > 0;
  if (hasAttachments) {
    return {
      panel: config.label,
      status: "partial",
      message: `${config.label} 的附件仍保留在本地；请在该网页中手动选择并上传后再发送`,
      autoSent: false,
      attemptedAutoSend: false,
      attachments: {
        requested: attachmentManifest.length,
        assigned: 0,
        confirmed: 0,
        unverified: [],
        manualRequired: attachmentManifest.map((item) => ({ id: item.id, name: item.name, reason: "manual-required" })),
      },
    };
  }
  const usingFallback = (config.composeMessageScript === buildGenericScript);
  const script = buildOriginGuardedScript(
    (config.composeMessageScript || buildGenericScript)(text, config.allowAutoSend ? true : false, []),
    config.allowedOrigins || [],
  );

  try {
    const result = await dispatchCoordinator.run(
      panelState.webview,
      () => panelState.webview.executeJavaScript(script, true),
    );
    if (result?.skipped) {
      return { panel: config.label, status: "error", message: "上一轮消息仍在该网页中处理" };
    }
    if (result && result.success) {
      const autoSentText = result.autoSent ? "已尝试触发网页发送" : "已填充输入框";
      const attachmentReport = result.attachmentReport || { requested: 0, assigned: 0, confirmed: 0, unverified: [], manualRequired: [] };
      const status = hasAttachments ? getAttachmentDispatchStatus(attachmentReport) : "success";
      const attachmentMessage = attachmentReport.assigned > 0
        ? `${config.label} 已填入文字并尝试附加 ${attachmentReport.assigned}/${attachmentReport.requested} 个文件；请在网页中确认附件后手动发送`
        : `${config.label} 未能自动附加文件；请使用该网页自己的上传操作`;
      return {
        panel: config.label,
        status,
        message: hasAttachments
          ? attachmentMessage
          : `${config.label} ${autoSentText}${usingFallback ? " (通用策略)" : ""}`,
        autoSent: result.autoSent === true,
        attemptedAutoSend: result.autoSent === true,
        attachments: attachmentReport,
      };
    }
    return {
      panel: config.label,
      status: "error",
      message: `网页操作失败${usingFallback ? " (通用策略)" : ""}`,
      attachments: result?.attachmentReport || { requested: attachmentManifest.length, confirmed: 0, unverified: [], manualRequired: [] },
    };
  } catch (error) {
    return {
      panel: config.label,
      status: "error",
      message: `网页操作失败${usingFallback ? " (通用策略)" : ""}`,
      attachments: { requested: attachmentManifest.length, confirmed: 0, unverified: [], manualRequired: [] },
    };
  }
}

function presentResults(results) {
  results.forEach((entry) => {
    logStatus(`${entry.panel}: ${entry.message}`, entry.status);
  });
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
    const removeButton = document.createElement("button");
    removeButton.type = "button";
    removeButton.dataset.attachmentId = id;
    removeButton.textContent = "×";
    removeButton.disabled = isBroadcasting;
    removeButton.setAttribute("aria-label", `移除 ${item.file.name}`);
    removeButton.title = `移除 ${item.file.name}`;

    li.append(kindSpan, nameSpan, sizeSmall, removeButton);
    attachmentPreview.appendChild(li);
  });
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

attachmentInput.addEventListener("change", async (event) => {
  const files = Array.from(event.target.files || []);
  if (!files.length) {
    return;
  }
  const { approved, rejected } = await inspectSelectedAttachments(files);
  if (rejected.length) {
    logStatus(`为保护本地 GitHub 与凭据数据，已拒绝 ${rejected.length} 个敏感或不可验证附件`, "error");
  }
  const entries = await Promise.all(approved.map((file) => addAttachment(file, 'local')));
  const added = entries.filter(Boolean);
  if (added.length) {
    renderAttachmentPreview();
    logStatus(`已添加 ${added.length} 个附件`, "info");
  }
  attachmentInput.value = "";
});

attachmentPreview.addEventListener("click", (event) => {
  if (isBroadcasting) return;
  if (!(event.target instanceof HTMLButtonElement)) {
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

document.addEventListener("keydown", (event) => {
  if (isModelAddDialogOpen()) {
    return;
  }
  if (!event.altKey) {
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

// 添加附件按钮事件
if (addAttachmentBtn) {
  addAttachmentBtn.addEventListener('click', () => {
    attachmentInput.click();
  });
}

broadcastForm.addEventListener("submit", async (event) => {
  event.preventDefault();
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
  const draftSnapshot = { text: broadcastInput.value, revision: draftRevision };
  const pendingAction = getPendingBroadcastAction(pendingBroadcastTurn, {
    value: broadcastInput.value,
    revision: draftRevision,
  }, activePanelCount);
  if (pendingAction.mode === "hold") {
    logStatus("该消息已填入网页，请先在网页中确认或修改草稿后再发送", "info");
    return;
  }

  isBroadcasting = true;
  syncComposerState();
  // 显示发送状态
  logStatus(`正在发送消息到 ${activePanelCount} 个模型...`, "info");

  try {
  const localAttachments = Array.from(attachments.values());
  const { payload: attachmentPayload, failures: attachmentReadFailures } = await buildAttachmentPayloads(localAttachments);
  if (attachmentReadFailures.length) {
    logStatus(`${attachmentReadFailures.length} 个附件无法读取，已保留以便重试`, "error");
    return;
  }

    const snapshot = pendingAction.mode === "retry"
      ? {
        text,
        attachments: pendingAction.attachments,
        recipients: pendingAction.recipients,
      }
      : createBroadcastSnapshot(panels, activePanelCount, text, attachmentPayload);
    const results = await settleBroadcastTasks(
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
        return dispatchMessage(panelState, snapshot.text, snapshot.attachments);
      },
    );
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

    // 统计发送结果
    const attemptedCount = results.filter((result) => result.attemptedAutoSend === true).length;
    const filledCount = results.filter((result) => result.status === "success" && result.attemptedAutoSend !== true).length;
    const errorCount = results.filter((result) => result.status === "error").length;

    if (attemptedCount > 0) {
      logStatus(`已尝试触发 ${attemptedCount} 个网页发送`, "success");
    }
    if (filledCount > 0) {
      logStatus(`已填充 ${filledCount} 个网页输入框，请在网页中确认发送`, "info");
    }
    if (errorCount > 0) {
      logStatus(`${errorCount} 个模型发送失败`, "error");
    }

    if (attachmentPayload.length > 0 || attachmentReadFailures.length > 0) {
      if (attachmentReadFailures.length === 0 && shouldClearAttachmentsForResults(results, attachmentPayload.length)) {
        clearAttachments();
          logStatus("已清除本地附件", "success");
      } else {
          logStatus("附件保留在本地；请在每个网页自己的上传界面中选择、确认并手动发送。", "info");
      }
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
    setTimeout(() => {
      broadcastInput.focus({ preventScroll: true });
    }, 0);
  } finally {
    isBroadcasting = false;
    syncComposerState();
    if (!document.activeElement || document.activeElement !== broadcastInput) {
      setTimeout(() => {
        broadcastInput.focus({ preventScroll: true });
      }, 0);
    }
  }
});

broadcastInput.addEventListener("keydown", (event) => {
  if (event.isComposing || event.keyCode === 229) {
    return;
  }
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    if (isBroadcasting || getBroadcastBlockReason()) return;
    broadcastForm.requestSubmit();
  }
});

// 键盘快捷键支持
document.addEventListener('keydown', (event) => {
  trapModelAddDialogFocus(event);
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


  // Ctrl/Cmd + /: 显示快捷键帮助
  if ((event.ctrlKey || event.metaKey) && event.key === '/') {
    event.preventDefault();
    showShortcutHelp();
  }
});

function showShortcutHelp() {
  const helpText = `
快捷键帮助:
• Ctrl/Cmd + Enter: 发送消息
• Alt + ←/→: 切换布局
• Ctrl/Cmd + /: 显示此帮助
  `.trim();

  alert(helpText);
  logStatus("快捷键帮助", "info");
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

DEFAULT_MODELS.forEach((model) => registerModel(model, { replace: true }));
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
