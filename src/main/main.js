'use strict';
const path = require('node:path');
const { app, BrowserWindow, shell, Notification } = require('electron');
const gowa = require('./gowaManager');
const ipc = require('./ipc');
const scheduler = require('./scheduler');
const content = require('./contentPack');
const client = require('./gowaClient');
const store = require('./accountStore');
const webhook = require('./webhookServer');
const paths = require('./paths');
const log = require('./logbus');

let mainWindow = null;
const getWindow = () => mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 980,
    height: 720,
    minWidth: 760,
    minHeight: 560,
    title: 'WA Warmer',
    backgroundColor: '#0f1720',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // open external links in the OS browser, never in-app
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Check live connection status of every account, update store + webhook + UI.
async function refreshStatuses() {
  for (const a of store.all()) {
    try {
      const st = await client.status(a.deviceId);
      const r = st.results || st;
      const phone = r.jid ? String(r.jid).split('@')[0].split(':')[0] : a.phone;
      store.setConnected(a.deviceId, !!r.is_logged_in, r.jid, phone);
      if (r.is_logged_in) gowa.registerWebhook(a.deviceId);
    } catch {
      store.setConnected(a.deviceId, false);
    }
  }
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('accounts:updated', ipc.accountsView());
}

// After GOWA is ready, actively restore sessions (they can take a few seconds),
// then refresh a couple of times as they come online.
async function reconnectAccounts() {
  for (const a of store.all()) { try { await client.reconnect(a.deviceId); } catch { /* ignore */ } }
  for (const delay of [3000, 5000, 8000]) { await sleep(delay); await refreshStatuses(); }
}

// Periodic maintenance: auto-recover accounts that dropped (were logged in but
// went offline). Quick retries first, then a gentle back-off; never fully gives
// up. Accounts that never logged in (no jid) need a QR and are left alone.
const reconnectAttempts = new Map();
async function maintainConnections() {
  // one call gives every device's state + jid; jid present = GOWA still holds the session
  let devMap;
  try {
    const list = await client.listDevices();
    devMap = new Map((list.results || []).map((d) => [d.id, d]));
  } catch {
    return; // engine not reachable this cycle
  }

  for (const a of store.all()) {
    const dev = devMap.get(a.deviceId);
    const loggedIn = !!dev && dev.state === 'logged_in';
    const hasSession = !!dev && (!!dev.jid || loggedIn);

    if (a.paused) {
      // manual hold: reflect status for display but never auto-reconnect
      reconnectAttempts.delete(a.deviceId);
      store.setConnected(a.deviceId, loggedIn, dev?.jid || a.jid, a.phone);
      continue;
    }

    if (loggedIn) {
      reconnectAttempts.delete(a.deviceId);
      const phone = dev.jid ? String(dev.jid).split('@')[0].split(':')[0] : a.phone;
      if (!a.connected) log.info('account', `аккаунт "${a.label}" онлайн`);
      store.setConnected(a.deviceId, true, dev.jid || a.jid, phone);
      gowa.registerWebhook(a.deviceId);
      continue;
    }

    if (!a.jid) { store.setConnected(a.deviceId, false); continue; } // never linked → needs QR

    if (a.jid && !hasSession) {
      // account had a session, but GOWA no longer holds it → session lost.
      // Try a couple of reconnects first (grace for slow restore), then mark it.
      const tries = reconnectAttempts.get(a.deviceId) || 0;
      reconnectAttempts.set(a.deviceId, tries + 1);
      store.setConnected(a.deviceId, false);
      if (tries < 2) { try { await client.reconnect(a.deviceId); } catch { /* ignore */ } }
      else {
        store.setSessionLost(a.deviceId, true);
        if (tries === 2) log.warn('account', `аккаунт "${a.label}": сессия потеряна в движке — нужен ре-логин`);
      }
      continue;
    }

    // has a valid session but the socket is down → recoverable: retry with back-off
    store.setConnected(a.deviceId, false);
    store.setSessionLost(a.deviceId, false);
    const tries = reconnectAttempts.get(a.deviceId) || 0;
    reconnectAttempts.set(a.deviceId, tries + 1);
    if (tries > 8 && tries % 10 !== 0) continue;
    try { await client.reconnect(a.deviceId); } catch { /* ignore */ }
  }
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('accounts:updated', ipc.accountsView());
}

// React to genuinely delivered inbound messages (best-effort; payload varies).
function handleInbound(data) {
  try {
    const p = (data && (data.payload || data.results)) || data || {};
    const deviceId = data.device_id || data.deviceId || p.device_id;
    const fromMe = p.from_me ?? p.fromMe ?? data.from_me;
    const from = p.from || p.chat_id || p.sender || data.from || '';
    const messageId = p.id || p.message_id || (p.message && p.message.id) || data.message_id;
    if (fromMe || !deviceId || !messageId || !from) return;
    log.info('webhook', `📨 входящее для ${String(deviceId).slice(0, 8)} от ${String(from).split('@')[0]}`);
    if (!scheduler.isRunning()) return;
    client.markRead(deviceId, messageId, from).catch(() => {});
  } catch { /* ignore malformed */ }
}

function notify(title, body) {
  try {
    if (Notification.isSupported()) new Notification({ title, body }).show();
  } catch { /* ignore */ }
}

async function boot() {
  log.info('app', `папка данных: ${paths.dataDir()}`);
  content.ensure(); // create data/content-pack/ with empty messages.txt, links.txt, images/
  ipc.register(getWindow);
  scheduler.events.on('loggedOut', ({ label }) => {
    notify('WA Warmer — аккаунт отключён', `"${label}" вышел из сети (возможен logout или бан).`);
  });
  webhook.events.on('inbound', handleInbound);
  createWindow();
  try {
    await gowa.start();
    await reconnectAccounts();
    // periodic maintenance: auto-recover dropped accounts + keep status fresh
    setInterval(() => { maintainConnections().catch(() => {}); }, 30000);
  } catch (e) {
    log.error('gowa', `failed to start engine: ${e.message}`);
  }
}

const singleLock = app.requestSingleInstanceLock();
if (!singleLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(boot);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  app.on('window-all-closed', () => {
    app.quit(); // quit on all platforms; engine is useless without the UI
  });

  app.on('before-quit', async (e) => {
    if (app._cleanupDone) return;
    e.preventDefault();
    app._cleanupDone = true;
    log.info('app', 'shutting down...');
    try { scheduler.stop(); } catch { /* ignore */ }
    try { await gowa.stop(); } catch { /* ignore */ }
    app.quit();
  });
}
