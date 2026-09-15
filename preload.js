const { contextBridge, ipcRenderer } = require("electron");
const { webUtils } = require("electron");

contextBridge.exposeInMainWorld("qask", {
  screenshot: {
    take: () => ipcRenderer.send('take-screenshot'),
    onSaved: (callback) => ipcRenderer.on('screenshot-saved', () => callback()),
    onCancelled: (callback) => ipcRenderer.on('screenshot-cancelled', () => callback()),
  },
  microphone: {
    requestAccess: () => ipcRenderer.invoke("microphone:request-access"),
    releaseAccess: (leaseId) => ipcRenderer.invoke("microphone:release-access", leaseId),
  },
  attachments: {
    inspect: (file) => {
      const filePath = webUtils.getPathForFile(file);
      return ipcRenderer.invoke("attachments:inspect", filePath);
    },
  },
  diagnostics: {
    layoutLifecycleTraceEnabled: process.env.QASK_TRACE_LAYOUT_LIFECYCLE === "1",
  },
});
