const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('lagentConnection', Object.freeze({
  connect: serverUrl => ipcRenderer.invoke('lagent:connect', serverUrl),
}));
