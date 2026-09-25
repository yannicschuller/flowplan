// Only the app's own pages (server setup, offline) use this bridge; the
// Flowplan web app runs without extra rights.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("flowplanDesktop", {
  platform: process.platform,
  getServer: () => ipcRenderer.invoke("flowplan:get-server"),
  setServer: (url) => ipcRenderer.invoke("flowplan:set-server", url),
  retry: () => ipcRenderer.invoke("flowplan:retry"),
  changeServer: () => ipcRenderer.invoke("flowplan:change-server"),
});
