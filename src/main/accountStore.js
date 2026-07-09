'use strict';
// Persists the account list and warming config to the portable data dir.
const fs = require('node:fs');
const path = require('node:path');
const paths = require('./paths');
const groups = require('./groups');

function todayStr() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD (local-ish, UTC date)
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

// ---- accounts ----
let accounts = null;

function loadAccounts() {
  if (accounts) return accounts;
  accounts = readJson(paths.accountsFile(), []);
  if (!Array.isArray(accounts)) accounts = [];
  return accounts;
}

function saveAccounts() {
  writeJsonAtomic(paths.accountsFile(), accounts || []);
}

function all() {
  return loadAccounts();
}

function get(deviceId) {
  return loadAccounts().find((a) => a.deviceId === deviceId) || null;
}

// account labels must be unique (case-insensitive, trimmed)
function labelExists(label) {
  const l = String(label || '').trim().toLowerCase();
  if (!l) return false;
  return loadAccounts().some((a) => String(a.label || '').trim().toLowerCase() === l);
}
function uniqueLabel(base) {
  let label = base;
  let n = 1;
  while (labelExists(label)) { n += 1; label = `${base} ${n}`; }
  return label;
}
function rename(deviceId, newLabel) {
  const a = get(deviceId);
  if (!a) return { error: 'аккаунт не найден' };
  const name = String(newLabel || '').trim();
  if (!name) return { error: 'название не может быть пустым' };
  const l = name.toLowerCase();
  if (loadAccounts().some((x) => x.deviceId !== deviceId && String(x.label || '').trim().toLowerCase() === l)) {
    return { error: `Название «${name}» уже занято` };
  }
  a.label = name;
  saveAccounts();
  return { ok: true };
}

function upsert(acc) {
  loadAccounts();
  const idx = accounts.findIndex((a) => a.deviceId === acc.deviceId);
  if (idx >= 0) accounts[idx] = { ...accounts[idx], ...acc };
  else accounts.push(acc);
  saveAccounts();
  return get(acc.deviceId);
}

function remove(deviceId) {
  loadAccounts();
  accounts = accounts.filter((a) => a.deviceId !== deviceId);
  for (const a of accounts) if (a.partners) a.partners = a.partners.filter((id) => id !== deviceId);
  saveAccounts();
}

// established chat relationships (mutual, persisted) — for gradual partner growth
function linkPartners(idA, idB) {
  const a = get(idA);
  const b = get(idB);
  if (!a || !b) return;
  a.partners = a.partners || [];
  b.partners = b.partners || [];
  if (!a.partners.includes(idB)) a.partners.push(idB);
  if (!b.partners.includes(idA)) b.partners.push(idA);
  saveAccounts();
}
function partnersOf(deviceId) {
  const a = get(deviceId);
  return (a && a.partners) || [];
}

function setConnected(deviceId, connected, jid, phone) {
  const a = get(deviceId);
  if (!a) return;
  a.connected = connected;
  if (connected) a.sessionLost = false;
  if (jid) a.jid = jid;
  if (phone) a.phone = phone;
  saveAccounts();
}

// mark that GOWA no longer holds this device's session (needs a fresh QR login)
function setSessionLost(deviceId, value) {
  const a = get(deviceId);
  if (!a || a.sessionLost === value) return;
  a.sessionLost = value;
  saveAccounts();
}

// manual "hold" — paused accounts are excluded from warming and left untouched
function setPaused(deviceId, value) {
  const a = get(deviceId);
  if (!a) return;
  a.paused = !!value;
  saveAccounts();
}

// ручной оверрайд «пропустить отлёжку»: аккаунт греется сразу, минуя settleHours
// и reloginSettleHours (см. scheduler.isSettled).
function setSkipSettle(deviceId, value) {
  const a = get(deviceId);
  if (!a || !!a.skipSettle === !!value) return;
  a.skipSettle = !!value;
  saveAccounts();
}

// ручной оверрайд «форсировать буст»: аккаунт считается в окне кросс-страна буста
// независимо от дня (дневная норма/ramp остаются по реальному дню; см. scheduler.inBoostWindow).
function setForceBoost(deviceId, value) {
  const a = get(deviceId);
  if (!a || !!a.forceBoost === !!value) return;
  a.forceBoost = !!value;
  saveAccounts();
}

// daily send counter with rollover
function ensureDaily(a) {
  const t = todayStr();
  if (!a.dailySent || a.dailySent.date !== t) a.dailySent = { date: t, count: 0 };
  return a.dailySent;
}

function bumpSent(deviceId) {
  const a = get(deviceId);
  if (!a) return;
  const d = ensureDaily(a);
  d.count += 1;
  a.sentTotal = (a.sentTotal || 0) + 1;
  saveAccounts();
  bumpHistory('sent');
}

function bumpReceived(deviceId) {
  const a = get(deviceId);
  if (!a) return;
  a.receivedTotal = (a.receivedTotal || 0) + 1;
  saveAccounts();
  bumpHistory('received');
}

function sentToday(deviceId) {
  const a = get(deviceId);
  if (!a) return 0;
  return ensureDaily(a).count;
}

// full days since the account was added (1 on the first day)
function daysWarming(a) {
  const ms = Date.now() - (a.addedAt || Date.now());
  return Math.floor(ms / 86400000) + 1;
}

// ---- daily traffic history (for the stats dashboard) ----
let history = null;
function loadHistory() {
  if (history) return history;
  history = readJson(paths.statsFile(), {});
  if (typeof history !== 'object' || !history) history = {};
  return history;
}
function bumpHistory(kind /* 'sent' | 'received' */, n = 1) {
  loadHistory();
  const t = todayStr();
  if (!history[t]) history[t] = { sent: 0, received: 0 };
  history[t][kind] = (history[t][kind] || 0) + n;
  writeJsonAtomic(paths.statsFile(), history);
}
function historyDays(days = 14) {
  loadHistory();
  const out = [];
  const now = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 86400000).toISOString().slice(0, 10);
    const h = history[d] || { sent: 0, received: 0 };
    out.push({ date: d, sent: h.sent || 0, received: h.received || 0 });
  }
  return out;
}

// ---- config ----
const DEFAULT_CONFIG = {
  minDelayMin: 5, // gap between conversations, in MINUTES (gentler by default)
  maxDelayMin: 14,
  imagesEnabled: true,
  linksEnabled: true,
  voiceEnabled: true,
  textNoise: true, // append invisible random chars so each message is byte-unique
  settleHours: 12, // "отлёжка": wait N hours after linking before an account warms
  reloginSettleHours: 6, // "отлёжка" после ре-логина: пауза, пока WhatsApp снимет ~6ч спам-лимит
  dailyCap: 10, // outgoing messages per account per day (ramp: 2→3→4→6→7→9→10)
  rampUpDays: 7, // grow the daily cap gradually over the first N days
  daysPerPartner: 2, // add one new chat partner every N days (day 1 = 1 partner)
  activeStartHour: 9, // local system time
  activeEndHour: 23,
  maxConcurrent: 4, // parallel conversations (scales throughput for many accounts)
  proxy: '', // outbound proxy for the WhatsApp connection (socks5/http/https URL);
             // applied process-wide via GOWA's --whatsapp-proxy. Empty = direct.
             // Legacy field: migrateGroups() moves its value into group `ua`'s proxy.
  warmDays: 10, // total warm-up duration in days (ramp/partner growth window)
  crossCountryBoost: true, // allow aux-country groups to warm up UA numbers via cross-group chats
};

function loadConfig() {
  const c = { ...DEFAULT_CONFIG, ...readJson(paths.configFile(), {}) };
  // всегда гарантируем непустой список групп, даже если миграция ещё не запускалась
  if (!Array.isArray(c.groups) || c.groups.length === 0) c.groups = groups.DEFAULT_GROUPS.map((x) => ({ ...x }));
  return c;
}

function saveConfig(cfg) {
  const merged = { ...DEFAULT_CONFIG, ...cfg };
  writeJsonAtomic(paths.configFile(), merged);
  return merged;
}

// ---- group migration ----
// Идемпотентно: группы сеются только если отсутствуют, groupId проставляется
// только аккаунтам без него. Безопасно вызывать при каждом старте приложения.
function migrateGroups() {
  const cfg = readJson(paths.configFile(), {});
  if (!Array.isArray(cfg.groups) || cfg.groups.length === 0) {
    cfg.groups = groups.DEFAULT_GROUPS.map((x) => ({ ...x }));
    if (cfg.proxy) cfg.groups[0].proxy = cfg.proxy; // старое одно-прокси поле → группа ua
    writeJsonAtomic(paths.configFile(), { ...DEFAULT_CONFIG, ...cfg });
  }
  loadAccounts();
  let changed = false;
  for (const a of accounts) if (!a.groupId) { a.groupId = 'ua'; changed = true; }
  if (changed) saveAccounts();
}

function setGroup(deviceId, groupId) {
  const a = get(deviceId);
  if (a) { a.groupId = groupId; saveAccounts(); }
}

function setReady(deviceId, value) {
  const a = get(deviceId);
  if (a && !!a.ready !== !!value) { a.ready = !!value; saveAccounts(); }
}

// Отметить момент успешного ре-логина — планировщик добавит паузу reloginSettleHours,
// пока WhatsApp держит спам-лимит после повторного входа.
function setReloggedAt(deviceId) {
  const a = get(deviceId);
  if (!a) return;
  a.reloggedAt = Date.now();
  saveAccounts();
}

function accountsInGroup(groupId) {
  return loadAccounts().filter((a) => (a.groupId || 'ua') === groupId);
}

module.exports = {
  all,
  get,
  labelExists,
  uniqueLabel,
  rename,
  upsert,
  remove,
  linkPartners,
  partnersOf,
  setConnected,
  setSessionLost,
  setPaused,
  setSkipSettle,
  setForceBoost,
  bumpSent,
  bumpReceived,
  bumpHistory,
  historyDays,
  sentToday,
  daysWarming,
  ensureDaily,
  loadConfig,
  saveConfig,
  DEFAULT_CONFIG,
  migrateGroups,
  setGroup,
  setReady,
  setReloggedAt,
  accountsInGroup,
};
