'use strict';
// Warming engine. Instead of isolated messages it runs realistic back-and-forth
// conversations between account pairs: typing indicators, read receipts, online
// presence, text variation, and human-like pacing (random gaps, occasional
// longer breaks, lighter weekends). Also detects logout/ban of accounts.
const { EventEmitter } = require('node:events');
const client = require('./gowaClient');
const store = require('./accountStore');
const content = require('./contentPack');
const log = require('./logbus');

const events = new EventEmitter();

let running = false;
let config = null;
let loopPromise = null;
let wakeUp = null;
const recentTexts = []; // rolling memory to avoid repeating the same line

const randInt = (min, max) => Math.floor(min + Math.random() * (max - min + 1));
const chance = (p) => Math.random() < p;

function abortableSleep(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(() => { wakeUp = null; resolve(); }, ms);
    wakeUp = () => { clearTimeout(t); wakeUp = null; resolve(); };
  });
}

function inActiveHours(cfg) {
  const h = new Date().getHours();
  const { activeStartHour: s, activeEndHour: e } = cfg;
  if (s === e) return true;
  return s < e ? h >= s && h < e : h >= s || h < e; // supports overnight windows
}

function effectiveCap(acc, cfg) {
  const ramp = Math.max(1, cfg.rampUpDays || 1);
  const day = Math.min(store.daysWarming(acc), ramp);
  let cap = Math.round((cfg.dailyCap || 1) * (day / ramp));
  const dow = new Date().getDay();
  if (dow === 0 || dow === 6) cap = Math.round(cap * 0.7); // lighter weekends
  return Math.max(1, cap);
}

const remember = (src) => {
  if (!src) return;
  recentTexts.push(src);
  while (recentTexts.length > 8) recentTexts.shift();
};

// Re-verify connection state; detect connected -> disconnected (logout/ban).
async function refreshActive() {
  const active = [];
  for (const a of store.all()) {
    const wasConnected = !!a.connected;
    try {
      const st = await client.status(a.deviceId);
      const r = st.results || st;
      const loggedIn = !!r.is_logged_in;
      const phone = r.jid ? String(r.jid).split('@')[0].split(':')[0] : undefined;
      if (loggedIn !== wasConnected || (r.jid && r.jid !== a.jid) || (phone && phone !== a.phone)) {
        store.setConnected(a.deviceId, loggedIn, r.jid, phone);
      }
      if (wasConnected && !loggedIn) {
        log.warn('warming', `аккаунт "${a.label}" отключился (возможен logout/бан)`);
        events.emit('loggedOut', { deviceId: a.deviceId, label: a.label });
      }
      if (loggedIn) active.push(store.get(a.deviceId));
    } catch {
      if (wasConnected) {
        store.setConnected(a.deviceId, false);
        events.emit('loggedOut', { deviceId: a.deviceId, label: a.label });
      }
    }
  }
  return active;
}

const msgId = (res) => res?.results?.message_id || res?.results?.id || null;

// Send one message with a typing indicator; receiver reads it. Returns type sent.
async function sendTurn(sender, receiver, cfg) {
  const item = content.pick(cfg, new Set(recentTexts));
  if (!item) { log.warn('warming', 'нет контента для отправки (добавьте текст в messages.txt)'); return null; }
  remember(item.sourceText);

  // typing indicator, paced by text length
  const typTarget = item.message || item.caption || '';
  const typMs = Math.min(8000, Math.max(1500, typTarget.length * randInt(45, 90)));
  try { await client.chatPresence(sender.deviceId, receiver.phone, 'start'); } catch { /* best effort */ }
  await abortableSleep(typMs);
  try { await client.chatPresence(sender.deviceId, receiver.phone, 'stop'); } catch { /* best effort */ }
  if (!running) return null;

  let res;
  if (item.type === 'image') {
    res = await client.sendImage(sender.deviceId, receiver.phone, item.filePath, item.caption);
  } else {
    res = await client.sendMessage(sender.deviceId, receiver.phone, item.message);
  }
  store.bumpSent(sender.deviceId);
  store.bumpReceived(receiver.deviceId);

  // receiver reads it after a short delay
  const id = msgId(res);
  if (id) {
    (async () => {
      await abortableSleep(randInt(1200, 4000));
      try { await client.markRead(receiver.deviceId, id, sender.phone); } catch { /* best effort */ }
    })();
  }

  log.warming(`${sender.label} → ${receiver.label}: ${item.type}`);
  events.emit('tick', { ts: Date.now(), from: sender.label, to: receiver.label, type: item.type, ok: true });
  return item.type;
}

// A conversation: several alternating turns between A and B.
async function runConversation(a, b, cfg) {
  const turns = randInt(2, 6);
  for (const dev of [a, b]) {
    try { await client.presence(dev.deviceId, 'available'); } catch { /* best effort */ }
  }
  let sender = a;
  let receiver = b;
  for (let i = 0; i < turns && running; i++) {
    if (store.sentToday(sender.deviceId) >= effectiveCap(sender, cfg)) break; // sender hit cap
    try {
      const ok = await sendTurn(sender, receiver, cfg);
      if (ok === null) break;
    } catch (e) {
      log.error('warming', `отправка ${sender.label}→${receiver.label}: ${e.message}`);
      break;
    }
    [sender, receiver] = [receiver, sender]; // alternate direction
    if (i < turns - 1 && running) await abortableSleep(randInt(2500, 7000)); // inter-turn pause
  }
  for (const dev of [a, b]) {
    try { await client.presence(dev.deviceId, 'unavailable'); } catch { /* best effort */ }
  }
  events.emit('accountsChanged');
}

async function loop() {
  while (running) {
    if (!inActiveHours(config)) {
      log.warming('вне активных часов, пауза');
      await abortableSleep(60000);
      continue;
    }

    const active = await refreshActive();
    events.emit('accountsChanged');
    if (active.length < 2) {
      log.warming(`нужно ≥2 подключённых аккаунта (сейчас ${active.length}), жду`);
      await abortableSleep(15000);
      continue;
    }

    const eligible = active.filter((s) => store.sentToday(s.deviceId) < effectiveCap(s, config));
    if (eligible.length === 0) {
      log.warming('все аккаунты достигли дневного лимита, жду');
      await abortableSleep(60000);
      continue;
    }

    const a = eligible[randInt(0, eligible.length - 1)];
    const partners = active.filter((x) => x.deviceId !== a.deviceId && x.phone);
    if (partners.length === 0) { await abortableSleep(5000); continue; }
    const b = partners[randInt(0, partners.length - 1)];

    await runConversation(a, b, config);
    if (!running) break;

    // human-like gap between conversations (minutes), with occasional longer break
    let gapMs = randInt(config.minDelayMin, config.maxDelayMin) * 60000 + randInt(0, 4000);
    if (chance(0.15)) gapMs *= randInt(2, 4);
    log.warming(`следующий диалог через ~${Math.round(gapMs / 60000)} мин`);
    await abortableSleep(gapMs);
  }
}

function start(cfg) {
  if (running) return { running: true };
  config = { ...store.loadConfig(), ...(cfg || {}) };
  content.reload();
  running = true;
  log.warming('прогрев запущен');
  events.emit('state', { running: true });
  loopPromise = loop().finally(() => {
    running = false;
    events.emit('state', { running: false });
  });
  return { running: true };
}

function stop() {
  if (!running) return { running: false };
  running = false;
  if (wakeUp) wakeUp();
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
  return { running, connected, pairsCount: connected * (connected - 1), perAccount };
}

module.exports = { events, start, stop, stats, isRunning: () => running };
