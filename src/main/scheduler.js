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
let reactivateQueue = []; // existing pairs to warm up first after Start
const nextAt = new Map(); // deviceId -> timestamp when the account may converse again

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

// fraction of the active-hours window elapsed so far today (0..1)
function activeFraction(cfg) {
  const now = new Date();
  const mins = now.getHours() * 60 + now.getMinutes();
  const s = cfg.activeStartHour * 60;
  const e = cfg.activeEndHour * 60;
  if (s === e) return mins / 1440;
  if (s < e) { if (mins <= s) return 0; if (mins >= e) return 1; return (mins - s) / (e - s); }
  const total = 1440 - s + e; // overnight window
  if (mins >= s) return Math.min(1, (mins - s) / total);
  if (mins < e) return Math.min(1, (1440 - s + mins) / total);
  return 0;
}

// Anti-spike: an account's allowance grows smoothly from ~1 to its daily cap
// across the active window, so volume ramps up gradually instead of spiking.
function pacedAllowance(acc, cfg) {
  return Math.max(1, Math.ceil(effectiveCap(acc, cfg) * activeFraction(cfg)));
}

// "отлёжка": a freshly linked account waits before it starts warming
function isSettled(acc, cfg) {
  const h = Math.max(0, cfg.settleHours || 0);
  if (h === 0) return true;
  return Date.now() - (acc.addedAt || 0) >= h * 3600000;
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
        // try to auto-recover before declaring a logout/ban
        let recovered = false;
        try {
          await client.reconnect(a.deviceId);
          await sleep(2000);
          const st2 = await client.status(a.deviceId);
          const r2 = st2.results || st2;
          if (r2.is_logged_in) {
            store.setConnected(a.deviceId, true, r2.jid, r2.jid ? String(r2.jid).split('@')[0].split(':')[0] : undefined);
            log.info('warming', `аккаунт "${a.label}" переподключён`);
            recovered = true;
          }
        } catch { /* ignore */ }
        if (!recovered) {
          log.warn('warming', `аккаунт "${a.label}" отключился (logout/бан)`);
          events.emit('loggedOut', { deviceId: a.deviceId, label: a.label });
        }
      }
    } catch {
      if (was) {
        store.setConnected(a.deviceId, false);
        events.emit('loggedOut', { deviceId: a.deviceId, label: a.label });
      }
    }
  });
  activeCache = store.all().filter((a) => a.connected && a.phone && !a.paused && isSettled(a, config));
  return activeCache;
}

async function pollLoop() {
  while (running) {
    try { await refreshActive(); } catch (e) { log.warn('warming', `poll: ${e.message}`); }
    events.emit('accountsChanged');
    await sleep(30000);
  }
}

// how many distinct chat partners an account may have on its current warming day
function maxPartners(acc, cfg, activeCount) {
  const per = Math.max(1, cfg.daysPerPartner || 2);
  const allowed = 1 + Math.floor((store.daysWarming(acc) - 1) / per);
  return Math.min(allowed, Math.max(1, activeCount - 1));
}

// all existing (persisted) relationships as unique pairs, in random order
function buildReactivateQueue() {
  const seen = new Set();
  const q = [];
  for (const a of store.all()) {
    for (const pid of store.partnersOf(a.deviceId)) {
      const key = [a.deviceId, pid].sort().join('|');
      if (!seen.has(key)) { seen.add(key); q.push([a.deviceId, pid]); }
    }
  }
  for (let i = q.length - 1; i > 0; i--) { const j = randInt(0, i); [q[i], q[j]] = [q[j], q[i]]; }
  return q;
}

// ---- pair selection: gradual partner growth, fair, avoids busy accounts.
// After Start, first warms up EXISTING chats (reactivateQueue); once drained,
// prefers existing chats and opens a NEW chat only when an account has "grown".
// Synchronous: caller marks the pair busy immediately after.
function pickPair(cfg) {
  const now = Date.now();
  const ready = (id) => !busy.has(id) && (nextAt.get(id) || 0) <= now; // not busy & past its own rhythm
  const free = activeCache.filter((a) => ready(a.deviceId));
  if (free.length < 2) return null;
  const freeIds = new Set(free.map((a) => a.deviceId));
  const activeCount = activeCache.length;

  // 0) reactivation phase — run through existing pairs before anything new
  if (reactivateQueue.length) {
    for (let i = 0; i < reactivateQueue.length; i++) {
      const [x, y] = reactivateQueue[i];
      const A = activeCache.find((a) => a.deviceId === x);
      const B = activeCache.find((a) => a.deviceId === y);
      if (!A || !B) { reactivateQueue.splice(i, 1); i--; continue; } // partner gone → drop
      if (ready(x) && ready(y)) { reactivateQueue.splice(i, 1); return [A, B]; }
    }
    return null; // queued pairs exist but not ready yet — wait, don't open new chats
  }

  const senders = free
    .filter((s) => store.sentToday(s.deviceId) < pacedAllowance(s, cfg))
    .sort((x, y) => store.sentToday(x.deviceId) - store.sentToday(y.deviceId)); // fair: least active first

  for (const sender of senders) {
    const partners = store.partnersOf(sender.deviceId);

    // 1) if the account is still under its (day-based) chat budget, open a NEW chat
    const canGrow = partners.length < maxPartners(sender, cfg, activeCount);
    if (canGrow || partners.length === 0) {
      const notYet = free.filter((c) => c.deviceId !== sender.deviceId && !partners.includes(c.deviceId));
      // respect the candidate's own budget; relax only to guarantee everyone gets ≥1 chat
      const withRoom = notYet.filter((c) => store.partnersOf(c.deviceId).length < maxPartners(c, cfg, activeCount));
      const pool = withRoom.length ? withRoom : (partners.length === 0 ? notYet : []);
      if (pool.length) {
        pool.sort((x, y) => store.partnersOf(x.deviceId).length - store.partnersOf(y.deviceId).length);
        const partner = pool[0];
        store.linkPartners(sender.deviceId, partner.deviceId);
        log.warming(`новый чат: ${sender.label} ↔ ${partner.label}`);
        return [sender, partner];
      }
    }

    // 2) otherwise chat within an already-established relationship (if the partner is free)
    const existingFree = partners.filter((id) => freeIds.has(id) && id !== sender.deviceId);
    if (existingFree.length) {
      const rid = existingFree[randInt(0, existingFree.length - 1)];
      const found = activeCache.find((a) => a.deviceId === rid);
      if (found) return [sender, found];
    }
    // else this sender has no available partner right now — try the next
  }
  return null;
}

// ---- one message with typing, optional quote, typo+edit, read receipt ----
const msgId = (res) => res?.results?.message_id || res?.results?.id || null;
const REACT = ['👍', '❤️', '😂', '🔥', '👌', '😮', '🙏', '💯'];

function introduceTypo(s) {
  if (s.length < 5) return s;
  const i = randInt(1, s.length - 2);
  const a = s.split('');
  [a[i], a[i + 1]] = [a[i + 1], a[i]];
  return a.join('');
}

// returns { type, id } (id = sent message id, for quoting/reactions) or null/'empty'
async function sendTurn(sender, receiver, cfg, replyId) {
  const item = content.pick(cfg, new Set(recentTexts));
  if (!item) return 'empty';
  remember(item.sourceText);

  // typing indicator paced by text length (for text-like items)
  const typTarget = item.message || item.caption || '';
  if (typTarget) {
    const typMs = Math.min(8000, Math.max(1500, typTarget.length * randInt(45, 90)));
    try { await client.chatPresence(sender.deviceId, receiver.phone, 'start'); } catch { /* best */ }
    await sleep(typMs);
    try { await client.chatPresence(sender.deviceId, receiver.phone, 'stop'); } catch { /* best */ }
  }
  if (!running) return null;

  let res;
  let sentType = item.type;
  if (item.type === 'image') res = await client.sendImage(sender.deviceId, receiver.phone, item.filePath, item.caption);
  else if (item.type === 'voice') res = await client.sendAudio(sender.deviceId, receiver.phone, item.filePath);
  else {
    // text: occasionally send with a typo, then edit to fix (very human)
    const doTypo = item.message.length > 6 && chance(0.12);
    const firstText = doTypo ? introduceTypo(item.message) : item.message;
    res = await client.sendMessage(sender.deviceId, receiver.phone, firstText, replyId);
    const id0 = msgId(res);
    if (doTypo && id0) {
      await sleep(randInt(1500, 3500));
      try { await client.updateMessage(sender.deviceId, id0, receiver.phone, item.message); } catch { /* best */ }
      sentType = 'text✎';
    }
  }
  store.bumpSent(sender.deviceId);
  store.bumpReceived(receiver.deviceId);

  const id = msgId(res);
  if (id) {
    (async () => {
      await sleep(randInt(1200, 4000));
      try { await client.markRead(receiver.deviceId, id, sender.phone); } catch { /* best */ }
      if (chance(0.2)) { // receiver reacts to the message
        try { await client.reaction(receiver.deviceId, id, sender.phone, REACT[randInt(0, REACT.length - 1)]); } catch { /* best */ }
      }
    })();
  }

  events.emit('tick', { ts: Date.now(), from: sender.label, to: receiver.label, type: sentType, ok: true });
  return { type: sentType, id };
}

async function runConversation(a, b, cfg) {
  const turns = randInt(2, 6);
  for (const dev of [a, b]) { try { await client.presence(dev.deviceId, 'available'); } catch { /* best */ } }
  let sender = a; let receiver = b; let lastId = null;
  for (let i = 0; i < turns && running; i++) {
    if (store.sentToday(sender.deviceId) >= effectiveCap(sender, cfg)) break;
    try {
      const replyId = i > 0 && lastId && chance(0.35) ? lastId : undefined; // sometimes quote the previous message
      const r = await sendTurn(sender, receiver, cfg, replyId);
      if (r === null) break;
      if (r === 'empty') { log.warn('warming', 'нет контента — добавьте тексты в messages.txt'); break; }
      lastId = r.id;
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

    const pair = pickPair(config); // synchronous grab (already gated by per-account rhythm)
    if (!pair) { await sleep(randInt(3000, 8000)); continue; }
    const [a, b] = pair;
    busy.add(a.deviceId); busy.add(b.deviceId);
    events.emit('accountsChanged'); // reflect "в диалоге" promptly
    try {
      log.warming(`${a.label} ⇄ ${b.label}`);
      await runConversation(a, b, config);
    } catch (e) {
      log.error('warming', `диалог: ${e.message}`);
    } finally {
      busy.delete(a.deviceId); busy.delete(b.deviceId);
      // give each participant its own human-like pause before it converses again
      const gap = () => {
        let g = randInt(config.minDelayMin, config.maxDelayMin) * 60000 + randInt(0, 4000);
        if (chance(0.15)) g *= randInt(2, 4);
        return Date.now() + g;
      };
      nextAt.set(a.deviceId, gap());
      nextAt.set(b.deviceId, gap());
      events.emit('accountsChanged');
    }
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
  reactivateQueue = buildReactivateQueue();
  running = true;
  log.warming(`прогрев запущен (до ${workerCount(config)} диалогов параллельно)`);
  if (reactivateQueue.length) log.warming(`сначала оживляю ${reactivateQueue.length} существующих чат(ов)`);
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
  nextAt.clear();
  reactivateQueue = [];
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
    chats: store.partnersOf(a.deviceId).length,
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

module.exports = {
  events, start, stop, stats,
  isRunning: () => running,
  isBusy: (id) => busy.has(id),
  nextActionAt: (id) => nextAt.get(id) || 0,
};
