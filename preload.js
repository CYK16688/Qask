const { contextBridge, ipcRenderer } = require("electron");
const { webUtils } = require("electron");

contextBridge.exposeInMainWorld("qask", {
  screenshot: {
    take: () => ipcRenderer.send('take-screenshot'),
    onSaved: (callback) => ipcRenderer.on('screenshot-saved', () => callback()),
    onCancelled: (callback) => ipcRenderer.on('screenshot-cancelled', () => callback()),
  },
  theme: {
    set: (mode) => ipcRenderer.invoke("theme:set", mode),
  },
  app: {
    info: () => ipcRenderer.invoke("app:info"),
    openExternal: (url) => ipcRenderer.invoke("app:open-external", url),
    openUserData: () => ipcRenderer.invoke("app:open-user-data"),
    setLaunchAtLogin: (enabled) => ipcRenderer.invoke("app:set-launch-at-login", enabled),
  },
  window: {
    setAlwaysOnTop: (enabled) => ipcRenderer.invoke("window:set-always-on-top", enabled),
  },
  microphone: {
    requestAccess: () => ipcRenderer.invoke("microphone:request-access"),
    renewAccess: (leaseId) => ipcRenderer.invoke("microphone:renew-access", leaseId),
    releaseAccess: (leaseId) => ipcRenderer.invoke("microphone:release-access", leaseId),
  },
  attachments: {
    inspect: (file) => {
      const filePath = webUtils.getPathForFile(file);
      return ipcRenderer.invoke("attachments:inspect", filePath);
    },
    persist: (payload) => ipcRenderer.invoke("attachments:persist", payload),
    reveal: (fileName) => ipcRenderer.invoke("attachments:reveal", fileName),
    uploadToGuest: (payload) => ipcRenderer.invoke("attachments:upload-to-guest", payload),
  },
  diagnostics: {
    layoutLifecycleTraceEnabled: process.env.QASK_TRACE_LAYOUT_LIFECYCLE === "1",
  },
});
