const { app, BrowserWindow, ipcMain, globalShortcut, session, systemPreferences } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { randomUUID } = require("node:crypto");
const Screenshots = require("electron-screenshots");
const { inspectAttachmentPath } = require("./local-data-boundary.cjs");

const QASK_SHELL_URL = new URL(`file://${path.join(__dirname, "src", "index.html")}`).toString();
const PROVIDER_PARTITION_PREFIX = "persist:";
const MICROPHONE_LEASE_DURATION_MS = 30_000;
const PROVIDER_ORIGIN_ALLOWLIST = {
  chatgpt: ["https://chat.openai.com", "https://chatgpt.com", "https://auth.openai.com"],
  gemini: ["https://gemini.google.com", "https://accounts.google.com"],
  doubao: ["https://www.doubao.com"],
  claude: ["https://claude.ai", "https://claude.com", "https://accounts.google.com"],
  copilot: ["https://copilot.microsoft.com", "https://login.microsoftonline.com", "https://login.live.com"],
  deepseek: ["https://chat.deepseek.com"],
  kimi: ["https://kimi.moonshot.cn", "https://www.kimi.com"],
};

let mainWindow = null;
let screenshots = null;

let microphoneLease = null;
const providerSessionPolicies = new WeakMap();
const hasSingleInstanceLock = app.requestSingleInstanceLock();
const layoutLifecycleTraceEnabled = process.env.QASK_TRACE_LAYOUT_LIFECYCLE === "1";

function inspectShellAttachmentPath(filePath) {
  return inspectAttachmentPath(filePath, {
    homeDir: app.getPath("home"),
    userDataDir: app.getPath("userData"),
    resolvePath: (value) => fs.realpathSync(value),
    isRegularFile: (value) => fs.statSync(value).isFile(),
  });
}

if (!hasSingleInstanceLock) {
  app.quit();
}

function isHttpsUrl(value) {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function getProviderIdFromPartition(partition) {
  if (typeof partition !== "string" || !partition.startsWith(PROVIDER_PARTITION_PREFIX)) {
    return null;
  }
  return partition.slice(PROVIDER_PARTITION_PREFIX.length) || null;
}

function createProviderNavigationPolicy(partition, initialUrl) {
  try {
    const url = new URL(initialUrl);
    if (url.protocol !== "https:") return null;
    const providerId = getProviderIdFromPartition(partition);
    if (!providerId) return null;
    const builtInOrigins = PROVIDER_ORIGIN_ALLOWLIST[providerId];
    const allowedOrigins = Array.isArray(builtInOrigins)
      ? builtInOrigins
      : [url.origin];
    if (!allowedOrigins.includes(url.origin)) return null;
    return {
      partition,
      providerId,
      initialOrigin: url.origin,
      allowedOrigins,
      isCustom: !Array.isArray(builtInOrigins),
    };
  } catch {
    return null;
  }
}

function getProviderNavigationPolicy(providerSession) {
  return providerSession ? providerSessionPolicies.get(providerSession) || null : null;
}

function isAllowedProviderUrl(policy, value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && Array.isArray(policy?.allowedOrigins)
      && policy.allowedOrigins.includes(url.origin);
  } catch {
    return false;
  }
}

function policiesMatch(existingPolicy, nextPolicy) {
  if (!existingPolicy || !nextPolicy) return false;
  if (existingPolicy.partition !== nextPolicy.partition || existingPolicy.providerId !== nextPolicy.providerId) return false;
  if (existingPolicy.isCustom || nextPolicy.isCustom) {
    return existingPolicy.isCustom === nextPolicy.isCustom
      && existingPolicy.initialOrigin === nextPolicy.initialOrigin;
  }
  return existingPolicy.allowedOrigins.length === nextPolicy.allowedOrigins.length
    && existingPolicy.allowedOrigins.every((origin) => nextPolicy.allowedOrigins.includes(origin));
}

function configureProviderSession(partition, initialUrl) {
  const nextPolicy = createProviderNavigationPolicy(partition, initialUrl);
  if (!nextPolicy) return null;

  const providerSession = session.fromPartition(partition);
  const existingPolicy = getProviderNavigationPolicy(providerSession);
  if (existingPolicy) {
    return policiesMatch(existingPolicy, nextPolicy) ? providerSession : null;
  }

  providerSession.setPermissionCheckHandler(() => false);
  providerSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  providerSession.on("will-download", (event) => event.preventDefault());
  providerSessionPolicies.set(providerSession, nextPolicy);
  return providerSession;
}

function hasActiveMicrophoneLease() {
  if (!microphoneLease) {
    return false;
  }
  if (Date.now() >= microphoneLease.expiresAt) {
    microphoneLease = null;
    return false;
  }
  return true;
}

function grantMicrophoneLease() {
  const leaseId = randomUUID();
  microphoneLease = {
    id: leaseId,
    expiresAt: Date.now() + MICROPHONE_LEASE_DURATION_MS,
  };
  return leaseId;
}

function revokeMicrophoneLease(leaseId) {
  if (typeof leaseId !== "string" || leaseId !== microphoneLease?.id) {
    return false;
  }
  microphoneLease = null;
  return true;
}

function isTrustedShellWebContents(contents) {
  return !!mainWindow
    && contents === mainWindow.webContents
    && contents.getURL() === QASK_SHELL_URL;
}

function isAudioOnlyShellCheck(contents, permission, details) {
  return isTrustedShellWebContents(contents)
    && permission === "media"
    && details?.isMainFrame
    && details.mediaType === "audio"
    && hasActiveMicrophoneLease();
}

function isAudioOnlyShellRequest(contents, permission, details) {
  return isTrustedShellWebContents(contents)
    && permission === "media"
    && details?.isMainFrame
    && details.mediaTypes?.length === 1
    && details.mediaTypes[0] === "audio"
    && hasActiveMicrophoneLease();
}

function configureShellSession() {
  const shellSession = session.defaultSession;
  shellSession.setPermissionCheckHandler((contents, permission, _origin, details) => (
    isAudioOnlyShellCheck(contents, permission, details)
  ));
  shellSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(isAudioOnlyShellRequest(contents, permission, details));
  });
}

function enforceProviderNavigation(contents) {
  const preventUntrustedNavigation = (event, url) => {
    const policy = getProviderNavigationPolicy(contents.session);
    if (!policy) return;
    if (!isAllowedProviderUrl(policy, url)) {
      event.preventDefault();
    }
  };
  contents.on("will-navigate", (event, url) => {
    preventUntrustedNavigation(event, url);
  });
  contents.on("will-redirect", (event, url) => {
    preventUntrustedNavigation(event, url);
  });
}

function configureShellLifecycleTrace(contents) {
  if (!layoutLifecycleTraceEnabled || contents !== mainWindow?.webContents) return;
  contents.on("console-message", (details) => {
    if (typeof details.message === "string" && details.message.startsWith("[qask-layout-trace]")) {
      console.info(details.message);
    }
  });
}

function configureWebContents(contents) {
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  enforceProviderNavigation(contents);

  contents.on("will-attach-webview", (event, webPreferences, params) => {
    const providerSession = configureProviderSession(params.partition, params.src);
    if (!providerSession) {
      event.preventDefault();
      return;
    }

    delete webPreferences.preload;
    delete webPreferences.preloadURL;
    webPreferences.nodeIntegration = false;
    webPreferences.nodeIntegrationInSubFrames = false;
    webPreferences.nodeIntegrationInWorker = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    webPreferences.webSecurity = true;
    webPreferences.allowRunningInsecureContent = false;
  });
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 900,
    minWidth: 1200,
    minHeight: 720,
    title: "Qask Multi-Agent Bridge",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webviewTag: true,
      spellcheck: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });
  configureShellLifecycleTrace(mainWindow.webContents);

  if (layoutLifecycleTraceEnabled) {
    mainWindow.webContents.openDevTools({ mode: "detach", activate: false });
  }
  mainWindow.loadFile(path.join(__dirname, "src", "index.html"));
  return mainWindow;
}

function isTrustedShellSender(event) {
  return !!mainWindow
    && event.sender === mainWindow.webContents
    && event.senderFrame?.url === QASK_SHELL_URL;
}

async function requestMicrophoneAccess(event) {
  if (!isTrustedShellSender(event)) {
    return { granted: false, reason: "untrusted-sender" };
  }

  if (process.platform === "darwin") {
    const status = systemPreferences.getMediaAccessStatus("microphone");
    if (status === "denied" || status === "restricted") {
      return { granted: false, reason: status };
    }
    if (status === "not-determined") {
      const granted = await systemPreferences.askForMediaAccess("microphone");
      if (!granted) {
        return { granted: false, reason: "denied" };
      }
    } else if (status !== "granted") {
      return { granted: false, reason: status };
    }
  }

  return { granted: true, leaseId: grantMicrophoneLease() };
}

function createScreenshotCompletionHandler({ handleScreenshot, endCapture, reportError }) {
  let completionInProgress = false;

  return async (event, buffer) => {
    event.preventDefault();
    if (completionInProgress) {
      return;
    }
    completionInProgress = true;
    try {
      handleScreenshot(event, buffer);
    } catch (error) {
      reportError("Unable to save screenshot");
    } finally {
      try {
        await endCapture();
      } catch (error) {
        reportError("Unable to close screenshot overlay");
      }
      completionInProgress = false;
    }
  };
}

function saveScreenshot(buffer) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const fileName = `Qask-Screenshot-${timestamp}-${randomUUID()}.png`;
  const qaskFolder = path.join(app.getPath("pictures"), "Qask Screenshots");
  fs.mkdirSync(qaskFolder, { recursive: true });
  const filePath = path.join(qaskFolder, fileName);
  fs.writeFileSync(filePath, buffer);
  return filePath;
}

app.on("web-contents-created", (_event, contents) => {
  configureWebContents(contents);
});

app.on("second-instance", () => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.focus();
});

app.whenReady().then(() => {
  configureShellSession();
  createMainWindow();

  screenshots = new Screenshots({ singleWindow: true, logger: () => {} });
  screenshots.on("windowCreated", () => {
    globalShortcut.register("Esc", () => {
      if (screenshots.$win?.isFocused()) {
        screenshots.endCapture();
      }
    });
  });
  screenshots.on("windowClosed", () => globalShortcut.unregister("Esc"));

  const handleScreenshot = (_event, buffer) => {
    saveScreenshot(buffer);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("screenshot-saved");
    }
  };
  const completeScreenshot = createScreenshotCompletionHandler({
    handleScreenshot,
    endCapture: () => screenshots.endCapture(),
    reportError: (message) => console.error(message),
  });
  screenshots.on("ok", completeScreenshot);
  screenshots.on("save", completeScreenshot);
  screenshots.on("cancel", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("screenshot-cancelled");
    }
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("will-quit", () => globalShortcut.unregisterAll());

ipcMain.handle("microphone:request-access", requestMicrophoneAccess);
ipcMain.handle("microphone:release-access", (event, leaseId) => {
  if (!isTrustedShellSender(event)) {
    return false;
  }
  return revokeMicrophoneLease(leaseId);
});
ipcMain.handle("attachments:inspect", (event, filePath) => {
  if (!isTrustedShellSender(event)) {
    return { allowed: false, reason: "untrusted-sender" };
  }
  return inspectShellAttachmentPath(filePath);
});

ipcMain.on("take-screenshot", (event) => {
  if (!isTrustedShellSender(event) || !screenshots) {
    return;
  }
  screenshots.startCapture().catch(() => {
    console.error("Unable to start screenshot capture");
  });
});