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
    chats: (a.partners || []).length,
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

  ipcMain.handle('login:startCode', async (_e, { label, phone }) => {
    const r = await loginFlow.startLoginWithCode(label, phone);
    send('accounts:updated', accountsView());
    return r;
  });

  ipcMain.handle('login:bulkCode', async (_e, { phones, prefix }) => {
    const out = [];
    let i = 0;
    for (const phone of phones) {
      i += 1;
      const r = await loginFlow.startLoginWithCode(`${prefix || 'Аккаунт'} ${i}`, phone);
      out.push({ phone, code: r.code || null, deviceId: r.deviceId || null, error: r.error || null });
      send('accounts:updated', accountsView());
    }
    return out;
  });

  ipcMain.handle('login:refreshQr', (_e, { deviceId }) => loginFlow.forceRefresh(deviceId));

  ipcMain.handle('login:cancel', (_e, { deviceId }) => {
    loginFlow.cancel(deviceId);
    return { ok: true };
  });

  ipcMain.handle('account:reconnect', async (_e, { deviceId }) => {
    try { await client.reconnect(deviceId); } catch { /* ignore */ }
    await new Promise((r) => setTimeout(r, 1800));
    let loggedIn = false; let jid; let phone;
    try {
      const st = await client.status(deviceId);
      const r = st.results || st;
      loggedIn = !!r.is_logged_in;
      jid = r.jid;
      phone = r.jid ? String(r.jid).split('@')[0].split(':')[0] : undefined;
    } catch { /* ignore */ }
    if (loggedIn) {
      store.setConnected(deviceId, true, jid, phone);
      gowa.registerWebhook(deviceId);
      send('accounts:updated', accountsView());
      return { connected: true };
    }
    await loginFlow.relogin(deviceId); // session lost -> show QR for the same device
    return { connected: false, relogin: true, deviceId };
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

  ipcMain.handle('stats:full', () => {
    const s = scheduler.stats();
    return {
      totals: { accounts: s.total, connected: s.connected, sent: s.sentTotal, received: s.receivedTotal, running: s.running },
      perAccount: s.perAccount,
      history: store.historyDays(14),
    };
  });
  ipcMain.handle('stats:exportCsv', async () => {
    const win = getWindow();
    const res = await dialog.showSaveDialog(win, {
      title: 'Экспорт статистики',
      defaultPath: 'wa-warmer-stats.csv',
      filters: [{ name: 'CSV', extensions: ['csv'] }],
    });
    if (res.canceled) return { canceled: true };
    const rows = [['label', 'phone', 'days', 'sent', 'received', 'sentToday', 'cap']];
    for (const a of scheduler.stats().perAccount) {
      const acc = store.get(a.deviceId);
      rows.push([a.label, acc?.phone || '', a.days, a.sent, a.received, a.sentToday, a.cap]);
    }
    const csv = rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
    fs.writeFileSync(res.filePath, '﻿' + csv);
    return { path: res.filePath };
  });

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
  loginFlow.events.on('code', (p) => send('login:code', p));
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
