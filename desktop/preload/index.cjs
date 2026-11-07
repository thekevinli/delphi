/**
 * The onboarding window's only bridge.
 *
 * Deliberately two calls and no general-purpose surface: this preload is loaded
 * into a window that takes an API key, so anything else it exposed would be a
 * way to read one back out. The reader itself gets no preload at all — it is
 * delphi's own web app and talks to the backend over HTTP, exactly as it does
 * in a browser.
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("delphi", {
  saveSetup: (setup) => ipcRenderer.invoke("delphi:save-setup", setup),
  connection: (command) => ipcRenderer.invoke("delphi:connection", command),
});
