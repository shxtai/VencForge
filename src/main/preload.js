// VencForge — preload: мост между renderer и main
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('vf', {
  invoke: (channel, payload) => ipcRenderer.invoke(channel, payload),
  on: (event, cb) => {
    ipcRenderer.on(event, (_e, data) => cb(data));
  },
});
