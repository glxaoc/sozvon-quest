'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const EVENTS = ['transcript', 'thesis', 'match', 'status', 'finished', 'log', 'demo', 'replay-done', 'nudge', 'models-progress'];

contextBridge.exposeInMainWorld('api', {
  args: () => ipcRenderer.invoke('args'),
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (patch) => ipcRenderer.invoke('config:set', patch),
  startSession: (payload) => ipcRenderer.invoke('session:start', payload),
  finishSession: () => ipcRenderer.invoke('session:finish'),
  snapshot: () => ipcRenderer.invoke('session:snapshot'),
  historyList: () => ipcRenderer.invoke('history:list'),
  historyLoad: (folder) => ipcRenderer.invoke('history:load', folder),
  historyBest: () => ipcRenderer.invoke('history:best'),
  toggleThesis: (id) => ipcRenderer.invoke('session:toggle', id),
  mockSay: (channel, text) => ipcRenderer.invoke('session:mock-say', { channel, text }),
  pushAudio: (channel, arrayBuffer) => ipcRenderer.send('audio', channel, arrayBuffer),
  openPath: (p) => ipcRenderer.invoke('shell:open', p),
  showInFolder: (p) => ipcRenderer.invoke('shell:show', p),
  setAlwaysOnTop: (flag) => ipcRenderer.invoke('window:top', flag),
  quit: () => ipcRenderer.invoke('app:quit'),
  callTypes: () => ipcRenderer.invoke('types:list'),
  templatesList: () => ipcRenderer.invoke('templates:list'),
  templatesSave: (t) => ipcRenderer.invoke('templates:save', t),
  templatesRemove: (id) => ipcRenderer.invoke('templates:remove', id),
  setCompact: (flag) => ipcRenderer.invoke('window:compact', flag),
  modelsStatus: () => ipcRenderer.invoke('models:status'),
  modelsDownload: (ids) => ipcRenderer.invoke('models:download', ids),
  modelsCancel: () => ipcRenderer.invoke('models:cancel'),
  modelsCheck: () => ipcRenderer.invoke('models:check'),
  openUrl: (url) => ipcRenderer.invoke('shell:url', url),
  checkKey: (provider, key) => ipcRenderer.invoke('keys:check', { provider, key }),
  pickReplay: () => ipcRenderer.invoke('replay:pick'),
  loadReplay: (p) => ipcRenderer.invoke('replay:load', p),
  diarizeReplay: (p) => ipcRenderer.invoke('replay:diarize', p),
  startTranscriptReplay: (payload) => ipcRenderer.invoke('replay:start', payload),
  on: (event, cb) => {
    if (!EVENTS.includes(event)) throw new Error(`unknown event ${event}`);
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on(event, handler);
    return () => ipcRenderer.removeListener(event, handler);
  },
});
