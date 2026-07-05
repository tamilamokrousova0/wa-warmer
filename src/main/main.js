'use strict';
const path = require('node:path');
const { app, BrowserWindow, shell } = require('electron');
const gowa = require('./gowaManager');
const ipc = require('./ipc');
const scheduler = require('./scheduler');
const client = require('./gowaClient');
const store = require('./accountStore');
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

// After GOWA is ready, re-verify stored sessions (GOWA restores them from SQLite).
async function reconnectAccounts() {
  for (const a of store.all()) {
    try {
      const st = await client.status(a.deviceId);
      const r = st.results || st;
      const phone = r.jid ? String(r.jid).split('@')[0].split(':')[0] : a.phone;
      store.setConnected(a.deviceId, !!r.is_logged_in, r.jid, phone);
    } catch {
      store.setConnected(a.deviceId, false);
    }
  }
}

async function boot() {
  ipc.register(getWindow);
  createWindow();
  try {
    await gowa.start();
    await reconnectAccounts();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('accounts:updated', ipc.accountsView());
    }
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
