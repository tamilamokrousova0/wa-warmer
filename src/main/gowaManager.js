'use strict';
// Spawns and supervises a POOL of embedded GOWA (whatsapp rest) child
// processes — one per country group. Each engine gets its own free port,
// basic-auth credentials, outbound proxy and SQLite session DB, so groups are
// fully isolated (a bad proxy in one group can't take the others down). The
// legacy single-process supervision (log piping, readiness wait, exit/restart
// with backoff, graceful stop) is preserved per-group, keyed by group.id.
const { spawn, spawnSync } = require('node:child_process');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const paths = require('./paths');
const client = require('./gowaClient');
const webhook = require('./webhookServer');
const store = require('./accountStore');
const log = require('./logbus');

const state = new EventEmitter();
// groupId -> { child, port, user, pass, auth, ready, restarts, dbPath, group,
//              restartTimer, stopping }
const engines = new Map();
let shuttingDown = false;
let webhookStarted = false;

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

function setReady(groupId, v) {
  const e = engines.get(groupId);
  if (e) e.ready = v;
  state.emit('state', { groupId, ready: v, restarts: e ? e.restarts : 0, port: e ? e.port : undefined });
}

function prepareBinary(binPath) {
  if (!fs.existsSync(binPath)) {
    throw new Error(`GOWA binary not found at ${binPath}. Run "npm run build-gowa".`);
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

// The `ua` group reuses the historical DB path for session continuity (no
// relogin after this refactor). Other groups get an isolated subdirectory.
function dbPathFor(groupId) {
  if (groupId === 'ua') return paths.gowaDbPath();
  const dir = path.join(paths.dataDir(), 'gowa', groupId);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'whatsapp.db');
}

const keysDbPathFor = (dbPath) => dbPath.replace(/whatsapp\.db$/, 'keys.db');

// Direct readiness probe — deliberately NOT via gowaClient/engineRouter: this
// engine isn't registered in `engines` yet, so the router couldn't resolve it
// anyway. Any HTTP response (even 4xx) proves the REST server on this port is up.
async function probeUp(port, auth) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/devices`, { headers: { Authorization: auth } });
    return res.status >= 200 && res.status < 500;
  } catch {
    return false;
  }
}

async function waitReady(port, auth, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probeUp(port, auth)) return true;
    await sleep(400);
  }
  return false;
}

// The webhook receiver is global (one for the whole pool). Start it lazily the
// first time any engine becomes ready.
async function ensureWebhook() {
  if (webhookStarted) return;
  webhookStarted = true;
  try {
    await webhook.start();
  } catch (e) {
    webhookStarted = false;
    log.warn('webhook', `start failed: ${e.message}`);
  }
}

async function spawnGroup(group) {
  const binPath = paths.gowaBinaryPath();
  prepareBinary(binPath);

  const port = await getFreePort();
  const user = 'warmer';
  const pass = crypto.randomBytes(18).toString('base64url');
  const auth = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
  const dbPath = dbPathFor(group.id);

  const env = {
    ...process.env,
    APP_PORT: String(port),
    APP_BASIC_AUTH: `${user}:${pass}`,
    DB_URI: `file:${dbPath}`,
    DB_KEYS_URI: `file:${keysDbPathFor(dbPath)}`,
  };

  // Optional outbound proxy for the WhatsApp WebSocket (socks5/http/https).
  // GOWA applies it process-wide via whatsmeow's SetProxyAddress — but each
  // group now runs in its own process, so the proxy is scoped to that group.
  const args = ['rest', '--port', String(port), '-b', `${user}:${pass}`];
  const proxy = String(group.proxy || '').trim();
  if (proxy) {
    env.WHATSAPP_PROXY = proxy;
    args.push('--whatsapp-proxy', proxy);
  }

  log.gowa(`[${group.id}] starting on 127.0.0.1:${port} (db: ${dbPath})${proxy ? ' via proxy' : ''}`);
  const child = spawn(binPath, args, { env, cwd: paths.dataDir(), windowsHide: true });

  // Preserve the restart counter across respawns of the same group.
  const prev = engines.get(group.id);
  const eng = {
    child,
    port,
    user,
    pass,
    auth,
    ready: false,
    restarts: prev ? prev.restarts || 0 : 0,
    dbPath,
    group,
    restartTimer: null,
    stopping: false,
  };
  engines.set(group.id, eng);

  const pipe = (buf) => String(buf).split(/\r?\n/).filter(Boolean).forEach((l) => log.gowa(`[${group.id}] ${l}`));
  child.stdout.on('data', pipe);
  child.stderr.on('data', pipe);

  child.on('exit', (code, signal) => {
    const e = engines.get(group.id);
    // Only the CURRENT child drives supervision. A stale (replaced) child's
    // late exit would otherwise null/reschedule the live engine and spawn a
    // duplicate — ignore it.
    if (!e || e.child !== child) return;
    setReady(group.id, false);
    e.child = null;
    if (shuttingDown || e.stopping) return;
    log.error('gowa', `[${group.id}] process exited (code=${code}, signal=${signal})`);
    scheduleRestart(group.id);
  });

  const ok = await waitReady(port, auth);
  if (!ok) {
    // Detach this child from the engine before killing so the exit handler's
    // `e.child !== child` guard short-circuits — this deliberate kill must not
    // schedule a restart. Leaves no unsupervised lingering process.
    eng.child = null;
    try { child.kill('SIGTERM'); } catch { /* ignore */ }
    throw new Error(`GOWA [${group.id}] did not become ready in time`);
  }
  eng.restarts = 0;
  setReady(group.id, true);
  log.gowa(`[${group.id}] ready`);
  await ensureWebhook();
}

function scheduleRestart(groupId) {
  if (shuttingDown) return;
  const eng = engines.get(groupId);
  if (!eng || eng.stopping) return;
  eng.restarts = (eng.restarts || 0) + 1;
  if (eng.restarts > 6) {
    log.error('gowa', `[${groupId}] giving up after 6 restart attempts`);
    state.emit('state', { groupId, ready: false, restarts: eng.restarts, fatal: true });
    return;
  }
  const backoff = Math.min(30000, 1000 * 2 ** (eng.restarts - 1));
  log.warn('gowa', `[${groupId}] restarting in ${backoff / 1000}s (attempt ${eng.restarts})`);
  state.emit('state', { groupId, ready: false, restarts: eng.restarts, restarting: true });
  clearTimeout(eng.restartTimer);
  eng.restartTimer = setTimeout(() => {
    const gr = store.loadConfig().groups.find((g) => g.id === groupId) || eng.group;
    spawnGroup(gr).catch((e) => {
      log.error('gowa', `[${groupId}] restart failed: ${e.message}`);
      scheduleRestart(groupId);
    });
  }, backoff);
}

async function stopGroup(groupId) {
  const eng = engines.get(groupId);
  if (!eng) return;
  eng.stopping = true;
  clearTimeout(eng.restartTimer);
  eng.ready = false;
  const proc = eng.child;
  eng.child = null;
  if (!proc) return;
  await new Promise((resolve) => {
    proc.once('exit', () => resolve());
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

// Spawn every configured group. A group whose proxy is unreachable may fail
// readiness — log it and carry on with the rest (never throw out of startAll).
async function startAll() {
  shuttingDown = false;
  const cfg = store.loadConfig();
  for (const gr of cfg.groups) {
    // eslint-disable-next-line no-await-in-loop
    await spawnGroup(gr).catch((e) => {
      log.error('gowa', `[${gr.id}] start failed: ${e.message}`);
      // Промах окна готовности/сбой спавна: назначаем повтор с капнутым
      // бэкоффом, иначе группа осталась бы лежать навсегда (exit-guard уже
      // обнулил eng.child, а maintainConnections пропускает недоступные группы).
      // scheduleRestart сам уважает shuttingDown/stopping, двойного спавна нет.
      scheduleRestart(gr.id);
    });
  }
}

async function stopAll() {
  shuttingDown = true;
  await Promise.all([...engines.keys()].map((id) => stopGroup(id)));
}

// Restart a single group's engine (e.g. after its proxy changed) without
// disturbing the others.
async function restartGroup(groupId) {
  await stopGroup(groupId);
  const gr = store.loadConfig().groups.find((g) => g.id === groupId);
  if (!gr) return;
  const eng = engines.get(groupId);
  if (eng) { eng.stopping = false; eng.restarts = 0; }
  await spawnGroup(gr).catch((e) => log.error('gowa', `[${groupId}] restart failed: ${e.message}`));
}

// Point a logged-in device's webhook at our local receiver (best-effort).
// gowaClient resolves the device's own group engine internally, so this
// always hits the right process.
async function registerWebhook(deviceId) {
  const url = webhook.getUrl();
  if (!url) return;
  try { await client.setWebhook(deviceId, url); } catch (e) { log.warn('webhook', `register ${deviceId}: ${e.message}`); }
}

const engine = (groupId) => {
  const e = engines.get(groupId);
  return e ? { port: e.port, user: e.user, pass: e.pass, ready: e.ready } : null;
};

// Test seam: inject a fake engine so router/other units can resolve it without
// spawning a real GOWA process.
function __setEngineForTest(groupId, e) {
  engines.set(groupId, { ...e, child: null, group: { id: groupId } });
}

module.exports = {
  startAll,
  stopAll,
  restartGroup,
  engine,
  state,
  registerWebhook,
  __setEngineForTest,
  isReady: (groupId) => !!(engines.get(groupId) && engines.get(groupId).ready),
  info: () => [...engines].map(([id, e]) => ({ id, ready: e.ready, port: e.port })),
};
