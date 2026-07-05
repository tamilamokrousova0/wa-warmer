'use strict';
// Wires ipcMain handlers (renderer -> main) and forwards main-side events
// (login/log/warming/gowa) to the renderer.
const fs = require('node:fs');
const path = require('node:path');
const { ipcMain, dialog } = require('electron');
const store = require('./accountStore');
const client = require('./gowaClient');
const loginFlow = require('./loginFlow');
const scheduler = require('./scheduler');
const gowa = require('./gowaManager');
const content = require('./contentPack');
const paths = require('./paths');
const log = require('./logbus');

function accountsView() {
  return store.all().map((a) => ({
    deviceId: a.deviceId,
    label: a.label,
    phone: a.phone,
    jid: a.jid,
    connected: !!a.connected,
    sentToday: store.sentToday(a.deviceId),
    days: store.daysWarming(a),
    sent: a.sentTotal || 0,
    received: a.receivedTotal || 0,
    addedAt: a.addedAt,
  }));
}

function register(getWindow) {
  const send = (channel, payload) => {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  };

  // ---- renderer -> main ----
  ipcMain.handle('accounts:list', () => accountsView());

  ipcMain.handle('login:start', async (_e, { label }) => {
    const r = await loginFlow.startLogin(label);
    send('accounts:updated', accountsView());
    return r;
  });

  ipcMain.handle('login:cancel', (_e, { deviceId }) => {
    loginFlow.cancel(deviceId);
    return { ok: true };
  });

  ipcMain.handle('account:logout', async (_e, { deviceId }) => {
    try {
      await client.logout(deviceId);
    } catch (e) {
      log.warn('account', `logout error: ${e.message}`);
    }
    try {
      await client.deleteDevice(deviceId);
    } catch (e) {
      log.warn('account', `deleteDevice error: ${e.message}`);
    }
    store.remove(deviceId);
    send('accounts:updated', accountsView());
    return { ok: true };
  });

  ipcMain.handle('warming:start', (_e, { config }) => scheduler.start(config));
  ipcMain.handle('warming:stop', () => scheduler.stop());
  ipcMain.handle('warming:getConfig', () => store.loadConfig());
  ipcMain.handle('warming:setConfig', (_e, { config }) => store.saveConfig(config));
  ipcMain.handle('warming:stats', () => scheduler.stats());
  ipcMain.handle('gowa:status', () => gowa.info());
  ipcMain.handle('log:history', () => log.history());

  // ---- content management ----
  ipcMain.handle('content:counts', () => content.counts());
  ipcMain.handle('content:reload', () => content.reload() && content.counts());
  ipcMain.handle('content:openFolder', () => content.openFolder());
  ipcMain.handle('content:addImages', async () => {
    const win = getWindow();
    const res = await dialog.showOpenDialog(win, {
      title: 'Выберите картинки для пересылки',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Изображения', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif'] }],
    });
    if (res.canceled) return content.counts();
    const dir = paths.contentImagesDir();
    fs.mkdirSync(dir, { recursive: true });
    for (const src of res.filePaths) {
      try { fs.copyFileSync(src, path.join(dir, path.basename(src))); } catch (e) { log.warn('content', e.message); }
    }
    content.reload();
    return content.counts();
  });

  // ---- main -> renderer ----
  log.on((line) => send('log:line', line));

  loginFlow.events.on('qr', (p) => send('login:qr', p));
  loginFlow.events.on('success', (p) => { send('login:success', p); send('accounts:updated', accountsView()); });
  loginFlow.events.on('timeout', (p) => send('login:timeout', p));
  loginFlow.events.on('cancel', (p) => send('login:cancel', p));

  scheduler.events.on('tick', (p) => send('warming:tick', p));
  scheduler.events.on('state', (p) => send('warming:state', p));
  scheduler.events.on('accountsChanged', () => send('accounts:updated', accountsView()));
  scheduler.events.on('loggedOut', (p) => { send('account:loggedOut', p); send('accounts:updated', accountsView()); });

  gowa.state.on('state', (p) => send('gowa:state', p));
}

module.exports = { register, accountsView };
