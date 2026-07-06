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
  const typTarget = item.message || item.caption || item.poll?.question || '';
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
  else if (item.type === 'sticker') res = await client.sendSticker(sender.deviceId, receiver.phone, item.filePath);
  else if (item.type === 'poll') res = await client.sendPoll(sender.deviceId, receiver.phone, item.poll.question, item.poll.options);
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
