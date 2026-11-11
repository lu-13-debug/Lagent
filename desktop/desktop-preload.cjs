const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('lagentDesktop', {
  setTheme: theme => ipcRenderer.send('appearance:set-theme', theme),
  onSystemThemeChanged: callback => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, dark) => callback(Boolean(dark));
    ipcRenderer.on('appearance:system-theme', listener);
    return () => ipcRenderer.removeListener('appearance:system-theme', listener);
  },
  setTrayState: state => ipcRenderer.invoke('lagent:tray-state', state),
  showWindow: () => ipcRenderer.invoke('lagent:show-window'),
  pickFolder: () => ipcRenderer.invoke('lagent:pick-folder'),
  setTaskSummaries: summaries => ipcRenderer.invoke('lagent:tray-summary', summaries),
  onNewAnalysis: callback => {
    if (typeof callback !== 'function') return () => {};
    const listener = () => callback();
    ipcRenderer.on('lagent:tray-new', listener);
    return () => ipcRenderer.removeListener('lagent:tray-new', listener);
  },
});
