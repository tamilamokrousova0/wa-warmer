'use strict';
// Warming engine, built to scale to many accounts (20/50/100+). Multiple
// conversations run in parallel (workers), an account is never in two at once
// (busy set), sender/partner are chosen fairly (least active first), and
// connection state is polled in parallel on a separate timer.
const { EventEmitter } = require('node:events');
const client = require('./gowaClient');
const store = require('./accountStore');
const content = require('./contentPack');
const log = require('./logbus');

const events = new EventEmitter();

let running = false;
let config = null;
let activeCache = []; // logged-in accounts, refreshed by the poller
const busy = new Set(); // deviceIds currently in a conversation
const recentTexts = [];

const stopBus = new EventEmitter();
stopBus.setMaxListeners(200);

const randInt = (min, max) => Math.floor(min + Math.random() * (max - min + 1));
const chance = (p) => Math.random() < p;

// sleep that wakes early when warming stops (safe for many parallel callers)
function sleep(ms) {
  return new Promise((resolve) => {
    const done = () => { clearTimeout(t); stopBus.off('stop', done); resolve(); };
    const t = setTimeout(done, ms);
    stopBus.once('stop', done);
  });
}

async function mapLimit(items, limit, fn) {
  let i = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length && running) { const idx = i++; await fn(items[idx], idx); }
  });
  await Promise.all(runners);
}

function inActiveHours(cfg) {
  const h = new Date().getHours();
  const { activeStartHour: s, activeEndHour: e } = cfg;
  if (s === e) return true;
  return s < e ? h >= s && h < e : h >= s || h < e;
}

function effectiveCap(acc, cfg) {
  const ramp = Math.max(1, cfg.rampUpDays || 1);
  const day = Math.min(store.daysWarming(acc), ramp);
  let cap = Math.round((cfg.dailyCap || 1) * (day / ramp));
  const dow = new Date().getDay();
  if (dow === 0 || dow === 6) cap = Math.round(cap * 0.7);
  return Math.max(1, cap);
}

const remember = (src) => { if (src) { recentTexts.push(src); while (recentTexts.length > 12) recentTexts.shift(); } };

// ---- connection polling (parallel, on a timer) ----
async function refreshActive() {
  const all = store.all();
  await mapLimit(all, 20, async (a) => {
    const was = !!a.connected;
    try {
      const st = await client.status(a.deviceId);
      const r = st.results || st;
      const loggedIn = !!r.is_logged_in;
      const phone = r.jid ? String(r.jid).split('@')[0].split(':')[0] : undefined;
      if (loggedIn !== was || (r.jid && r.jid !== a.jid) || (phone && phone !== a.phone)) {
        store.setConnected(a.deviceId, loggedIn, r.jid, phone);
      }
      if (was && !loggedIn) {
        log.warn('warming', `аккаунт "${a.label}" отключился (logout/бан)`);
        events.emit('loggedOut', { deviceId: a.deviceId, label: a.label });
      }
    } catch {
      if (was) {
        store.setConnected(a.deviceId, false);
        events.emit('loggedOut', { deviceId: a.deviceId, label: a.label });
      }
    }
  });
  activeCache = store.all().filter((a) => a.connected && a.phone);
  return activeCache;
}

async function pollLoop() {
  while (running) {
    try { await refreshActive(); } catch (e) { log.warn('warming', `poll: ${e.message}`); }
    events.emit('accountsChanged');
    await sleep(30000);
  }
}

// ---- pair selection (fair + avoids busy accounts). Synchronous: caller marks busy. ----
function pickPair(cfg) {
  const free = activeCache.filter((a) => !busy.has(a.deviceId));
  if (free.length < 2) return null;
  const eligible = free
    .filter((s) => store.sentToday(s.deviceId) < effectiveCap(s, cfg))
    .sort((x, y) => store.sentToday(x.deviceId) - store.sentToday(y.deviceId));
  if (eligible.length === 0) return null;
  const sender = eligible[0]; // fewest sent today
  const partners = free
    .filter((a) => a.deviceId !== sender.deviceId)
    .sort((x, y) => (x.receivedTotal || 0) - (y.receivedTotal || 0));
  if (partners.length === 0) return null;
  const partner = partners[randInt(0, Math.min(2, partners.length - 1))]; // among 3 least-received
  return [sender, partner];
}

// ---- one message with typing + read receipt ----
const msgId = (res) => res?.results?.message_id || res?.results?.id || null;

async function sendTurn(sender, receiver, cfg) {
  const item = content.pick(cfg, new Set(recentTexts));
  if (!item) return 'empty';
  remember(item.sourceText);

  const typTarget = item.message || item.caption || '';
  const typMs = Math.min(8000, Math.max(1500, typTarget.length * randInt(45, 90)));
  try { await client.chatPresence(sender.deviceId, receiver.phone, 'start'); } catch { /* best effort */ }
  await sleep(typMs);
  try { await client.chatPresence(sender.deviceId, receiver.phone, 'stop'); } catch { /* best effort */ }
  if (!running) return null;

  let res;
  if (item.type === 'image') res = await client.sendImage(sender.deviceId, receiver.phone, item.filePath, item.caption);
  else res = await client.sendMessage(sender.deviceId, receiver.phone, item.message);
  store.bumpSent(sender.deviceId);
  store.bumpReceived(receiver.deviceId);

  const id = msgId(res);
  if (id) {
    (async () => {
      await sleep(randInt(1200, 4000));
      try { await client.markRead(receiver.deviceId, id, sender.phone); } catch { /* best effort */ }
    })();
  }

  events.emit('tick', { ts: Date.now(), from: sender.label, to: receiver.label, type: item.type, ok: true });
  return item.type;
}

async function runConversation(a, b, cfg) {
  const turns = randInt(2, 6);
  for (const dev of [a, b]) { try { await client.presence(dev.deviceId, 'available'); } catch { /* best */ } }
  let sender = a; let receiver = b;
  for (let i = 0; i < turns && running; i++) {
    if (store.sentToday(sender.deviceId) >= effectiveCap(sender, cfg)) break;
    try {
      const r = await sendTurn(sender, receiver, cfg);
      if (r === null) break;
      if (r === 'empty') { log.warn('warming', 'нет контента — добавьте тексты в messages.txt'); break; }
    } catch (e) {
      log.error('warming', `отправка ${sender.label}→${receiver.label}: ${e.message}`);
      break;
    }
    [sender, receiver] = [receiver, sender];
    if (i < turns - 1 && running) await sleep(randInt(2500, 7000));
  }
  for (const dev of [a, b]) { try { await client.presence(dev.deviceId, 'unavailable'); } catch { /* best */ } }
}

// ---- worker: repeatedly grab a free pair and run a conversation ----
async function worker() {
  while (running) {
    if (!inActiveHours(config)) { await sleep(60000); continue; }
    if (activeCache.length < 2) { await sleep(10000); continue; }

    const pair = pickPair(config); // synchronous grab
    if (!pair) { await sleep(randInt(4000, 12000)); continue; }
    const [a, b] = pair;
    busy.add(a.deviceId); busy.add(b.deviceId);
    try {
      log.warming(`${a.label} ⇄ ${b.label}`);
      await runConversation(a, b, config);
    } catch (e) {
      log.error('warming', `диалог: ${e.message}`);
    } finally {
      busy.delete(a.deviceId); busy.delete(b.deviceId);
      events.emit('accountsChanged');
    }
    if (!running) break;
    let gap = randInt(config.minDelayMin, config.maxDelayMin) * 60000 + randInt(0, 4000);
    if (chance(0.15)) gap *= randInt(2, 4);
    await sleep(gap);
  }
}

function workerCount(cfg) {
  const want = Math.max(1, cfg.maxConcurrent || 4);
  return Math.min(want, 24); // hard cap; workers self-limit when few accounts are free
}

function start(cfg) {
  if (running) return { running: true };
  config = { ...store.loadConfig(), ...(cfg || {}) };
  content.reload();
  running = true;
  log.warming(`прогрев запущен (до ${workerCount(config)} диалогов параллельно)`);
  events.emit('state', { running: true });

  refreshActive()
    .then(() => {
      const workers = Array.from({ length: workerCount(config) }, () => worker());
      Promise.all([pollLoop(), ...workers]).finally(() => {
        running = false;
        events.emit('state', { running: false });
      });
    })
    .catch((e) => { log.error('warming', `старт: ${e.message}`); running = false; events.emit('state', { running: false }); });

  return { running: true };
}

function stop() {
  if (!running) return { running: false };
  running = false;
  stopBus.emit('stop');
  busy.clear();
  log.warming('прогрев остановлен');
  events.emit('state', { running: false });
  return { running: false };
}

function stats() {
  const cfg = config || store.loadConfig();
  const accounts = store.all();
  const perAccount = accounts.map((a) => ({
    deviceId: a.deviceId,
    label: a.label,
    days: store.daysWarming(a),
    sent: a.sentTotal || 0,
    received: a.receivedTotal || 0,
    sentToday: store.sentToday(a.deviceId),
    cap: effectiveCap(a, cfg),
  }));
  const connected = accounts.filter((a) => a.connected).length;
  const sentTotal = accounts.reduce((s, a) => s + (a.sentTotal || 0), 0);
  const receivedTotal = accounts.reduce((s, a) => s + (a.receivedTotal || 0), 0);
  return { running, connected, total: accounts.length, active: busy.size / 2, sentTotal, receivedTotal, perAccount };
}

module.exports = { events, start, stop, stats, isRunning: () => running };
