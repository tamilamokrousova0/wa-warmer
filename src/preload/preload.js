'use strict';
const { contextBridge, ipcRenderer } = require('electron');

function on(channel, fn) {
  const wrapped = (_e, payload) => fn(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.off(channel, wrapped);
}

contextBridge.exposeInMainWorld('api', {
  // invoke (renderer -> main)
  listAccounts: () => ipcRenderer.invoke('accounts:list'),
  startLogin: (label) => ipcRenderer.invoke('login:start', { label }),
  cancelLogin: (deviceId) => ipcRenderer.invoke('login:cancel', { deviceId }),
  logoutAccount: (deviceId) => ipcRenderer.invoke('account:logout', { deviceId }),
  startWarming: (config) => ipcRenderer.invoke('warming:start', { config }),
  stopWarming: () => ipcRenderer.invoke('warming:stop'),
  getConfig: () => ipcRenderer.invoke('warming:getConfig'),
  setConfig: (config) => ipcRenderer.invoke('warming:setConfig', { config }),
  getStats: () => ipcRenderer.invoke('warming:stats'),
  gowaStatus: () => ipcRenderer.invoke('gowa:status'),
  logHistory: () => ipcRenderer.invoke('log:history'),

  contentCounts: () => ipcRenderer.invoke('content:counts'),
  contentReload: () => ipcRenderer.invoke('content:reload'),
  contentOpenFolder: () => ipcRenderer.invoke('content:openFolder'),
  contentAddImages: () => ipcRenderer.invoke('content:addImages'),

  // events (main -> renderer); each returns an unsubscribe fn
  onQr: (fn) => on('login:qr', fn),
  onLoginSuccess: (fn) => on('login:success', fn),
  onLoginTimeout: (fn) => on('login:timeout', fn),
  onLoginCancel: (fn) => on('login:cancel', fn),
  onAccountsUpdated: (fn) => on('accounts:updated', fn),
  onLogLine: (fn) => on('log:line', fn),
  onWarmingTick: (fn) => on('warming:tick', fn),
  onWarmingState: (fn) => on('warming:state', fn),
  onGowaState: (fn) => on('gowa:state', fn),
  onLoggedOut: (fn) => on('account:loggedOut', fn),
});
