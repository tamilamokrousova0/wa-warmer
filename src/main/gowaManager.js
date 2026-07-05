'use strict';
// Spawns and supervises the embedded GOWA (whatsapp rest) child process.
const { spawn, spawnSync } = require('node:child_process');
const net = require('node:net');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const paths = require('./paths');
const client = require('./gowaClient');
const log = require('./logbus');

const state = new EventEmitter();
let child = null;
let shuttingDown = false;
let restarts = 0;
let ready = false;
let current = null; // { port, user, pass }

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function setReady(v) {
  ready = v;
  state.emit('state', { ready, restarts, port: current?.port });
}

function prepareBinary(binPath) {
  if (!fs.existsSync(binPath)) {
    throw new Error(`GOWA binary not found at ${binPath}. Run "npm run fetch-gowa".`);
  }
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(binPath, 0o755);
    } catch (e) {
      log.warn('gowa', `chmod failed: ${e.message}`);
    }
  }
  if (process.platform === 'darwin') {
    // Best-effort: clear quarantine so Gatekeeper doesn't kill the child.
    try {
      spawnSync('xattr', ['-dr', 'com.apple.quarantine', binPath], { timeout: 5000 });
    } catch {
      /* ignore */
    }
  }
}

async function waitReady(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await client.listDevices();
      return true;
    } catch (e) {
      // any HTTP response (even 4xx) proves the server is up.
      if (e.status && e.status >= 200 && e.status < 500) return true;
    }
    await sleep(400);
  }
  return false;
}

async function spawnOnce() {
  const binPath = paths.gowaBinaryPath();
  prepareBinary(binPath);

  const port = await getFreePort();
  const user = 'warmer';
  const pass = crypto.randomBytes(18).toString('base64url');
  current = { port, user, pass };
  client.configure({ port, user, pass });

  const dbPath = paths.gowaDbPath();
  const env = {
    ...process.env,
    APP_PORT: String(port),
    APP_BASIC_AUTH: `${user}:${pass}`,
    DB_URI: `file:${dbPath}`,
    DB_KEYS_URI: `file:${paths.gowaKeysDbPath()}`,
  };

  log.gowa(`starting on 127.0.0.1:${port} (db: ${dbPath})`);
  child = spawn(binPath, ['rest', '--port', String(port), '-b', `${user}:${pass}`], {
    env,
    cwd: paths.dataDir(),
    windowsHide: true,
  });

  const pipe = (buf) => String(buf).split(/\r?\n/).filter(Boolean).forEach((l) => log.gowa(l));
  child.stdout.on('data', pipe);
  child.stderr.on('data', pipe);

  child.on('exit', (code, signal) => {
    setReady(false);
    child = null;
    if (shuttingDown) return;
    log.error('gowa', `process exited (code=${code}, signal=${signal})`);
    scheduleRestart();
  });

  const ok = await waitReady();
  if (!ok) throw new Error('GOWA did not become ready in time');
  restarts = 0;
  setReady(true);
  log.gowa('ready');
}

let restartTimer = null;
async function scheduleRestart() {
  if (shuttingDown) return;
  restarts += 1;
  if (restarts > 6) {
    log.error('gowa', 'giving up after 6 restart attempts');
    state.emit('state', { ready: false, restarts, fatal: true });
    return;
  }
  const backoff = Math.min(30000, 1000 * 2 ** (restarts - 1));
  log.warn('gowa', `restarting in ${backoff / 1000}s (attempt ${restarts})`);
  state.emit('state', { ready: false, restarts, restarting: true });
  clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    spawnOnce().catch((e) => {
      log.error('gowa', `restart failed: ${e.message}`);
      scheduleRestart();
    });
  }, backoff);
}

async function start() {
  shuttingDown = false;
  await spawnOnce();
}

async function stop() {
  shuttingDown = true;
  clearTimeout(restartTimer);
  if (!child) return;
  const proc = child;
  return new Promise((resolve) => {
    const done = () => resolve();
    proc.once('exit', done);
    try {
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/pid', String(proc.pid), '/t', '/f']);
      } else {
        proc.kill('SIGTERM');
      }
    } catch {
      /* ignore */
    }
    setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch { /* ignore */ }
      resolve();
    }, 4000);
  });
}

module.exports = {
  start,
  stop,
  state,
  isReady: () => ready,
  info: () => ({ ready, restarts, port: current?.port }),
};
