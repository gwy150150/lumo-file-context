'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lumo', {
  load: () => ipcRenderer.invoke('data:load'),
  save: (data) => ipcRenderer.invoke('data:save', data),

  chat: (payload) => ipcRenderer.invoke('chat:start', payload),
  abort: (requestId) => ipcRenderer.invoke('chat:abort', requestId),
  onChatEvent: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('chat:event', handler);
    return () => ipcRenderer.removeListener('chat:event', handler);
  },

  listModels: (provider) => ipcRenderer.invoke('models:list', provider),

  pickFiles: () => ipcRenderer.invoke('file:pick'),
  extractFile: (name, buffer) => ipcRenderer.invoke('file:extract', { name, buffer }),

  chooseDataDir: () => ipcRenderer.invoke('data:choose-dir'),
  resetDataDir: () => ipcRenderer.invoke('data:reset-dir'),
  openDataDir: () => ipcRenderer.invoke('data:open-dir'),

  setOverlay: (opts) => ipcRenderer.invoke('win:set-overlay', opts),
  minimize: () => ipcRenderer.invoke('win:minimize'),
  maximize: () => ipcRenderer.invoke('win:maximize'),
  close: () => ipcRenderer.invoke('win:close'),

  openExternal: (url) => ipcRenderer.invoke('shell:open', url),
  info: () => ipcRenderer.invoke('app:info'),
});
