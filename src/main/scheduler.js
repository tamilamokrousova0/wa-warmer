'use strict';
// The warming engine. Picks sender->receiver pairs among connected accounts and
// sends randomized content with human-like delays, respecting daily caps,
// ramp-up and active hours (anti-ban).
const { EventEmitter } = require('node:events');
const client = require('./gowaClient');
const store = require('./accountStore');
const content = require('./contentPack');
const log = require('./logbus');

const events = new EventEmitter();

let running = false;
let config = null;
let loopPromise = null;
let wakeUp = null; // resolver to abort the current sleep

const randInt = (min, max) => Math.floor(min + Math.random() * (max - min + 1));

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

function daysSinceAdded(acc) {
  const ms = Date.now() - (acc.addedAt || Date.now());
  return Math.floor(ms / 86400000); // 0 on first day
}

function effectiveCap(acc, cfg) {
  const ramp = Math.max(1, cfg.rampUpDays || 1);
  const day = Math.min(daysSinceAdded(acc) + 1, ramp);
  return Math.max(1, Math.round((cfg.dailyCap || 1) * (day / ramp)));
}

// Re-verify each stored account's live connection state via GOWA.
async function refreshActive() {
  const active = [];
  for (const a of store.all()) {
    try {
      const st = await client.status(a.deviceId);
      const r = st.results || st;
      const loggedIn = !!r.is_logged_in;
      const phone = r.jid ? String(r.jid).split('@')[0].split(':')[0] : undefined;
      if (loggedIn !== a.connected || (r.jid && r.jid !== a.jid) || (phone && phone !== a.phone)) {
        store.setConnected(a.deviceId, loggedIn, r.jid, phone);
      }
      if (loggedIn) active.push(store.get(a.deviceId));
    } catch {
      if (a.connected) store.setConnected(a.deviceId, false);
    }
  }
  return active;
}

async function sendContent(sender, receiver, cfg) {
  const item = content.pick(cfg);
  if (item.type === 'image') {
    await client.sendImage(sender.deviceId, receiver.phone, item.filePath, item.caption);
  } else {
    await client.sendMessage(sender.deviceId, receiver.phone, item.message);
  }
  return item.type;
}

async function loop() {
  while (running) {
    if (!inActiveHours(config)) {
      log.warming('outside active hours, idling');
      await abortableSleep(60000);
      continue;
    }

    const active = await refreshActive();
    events.emit('accountsChanged');
    if (active.length < 2) {
      log.warming(`need >=2 connected accounts (have ${active.length}), waiting`);
      await abortableSleep(15000);
      continue;
    }

    // eligible senders: under their (ramp-up) daily cap
    const eligible = active.filter((s) => store.sentToday(s.deviceId) < effectiveCap(s, config));
    if (eligible.length === 0) {
      log.warming('all accounts hit their daily cap, waiting');
      await abortableSleep(60000);
      continue;
    }

    const sender = eligible[randInt(0, eligible.length - 1)];
    const receivers = active.filter((a) => a.deviceId !== sender.deviceId && a.phone);
    if (receivers.length === 0) { await abortableSleep(5000); continue; }
    const receiver = receivers[randInt(0, receivers.length - 1)];

    let type = 'text';
    let ok = true;
    try {
      type = await sendContent(sender, receiver, config);
      store.bumpSent(sender.deviceId);
      log.warming(`${sender.label} -> ${receiver.label}: ${type}`);
    } catch (e) {
      ok = false;
      log.error('warming', `send failed ${sender.label}->${receiver.label}: ${e.message}`);
    }
    events.emit('tick', {
      ts: Date.now(),
      from: sender.label,
      to: receiver.label,
      type,
      ok,
    });

    if (!running) break;
    const delayMs = randInt(config.minDelaySec, config.maxDelaySec) * 1000 + randInt(0, 2000);
    log.warming(`next send in ${Math.round(delayMs / 1000)}s`);
    await abortableSleep(delayMs);
  }
}

function start(cfg) {
  if (running) return { running: true };
  config = { ...store.loadConfig(), ...(cfg || {}) };
  running = true;
  log.warming('warming started');
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
  log.warming('warming stopped');
  events.emit('state', { running: false });
  return { running: false };
}

function stats() {
  const accounts = store.all();
  const perAccount = accounts.map((a) => ({
    deviceId: a.deviceId,
    label: a.label,
    sentToday: store.sentToday(a.deviceId),
    cap: effectiveCap(a, config || store.loadConfig()),
  }));
  const connected = accounts.filter((a) => a.connected).length;
  return {
    running,
    connected,
    pairsCount: connected * (connected - 1),
    perAccount,
  };
}

module.exports = { events, start, stop, stats, isRunning: () => running };
