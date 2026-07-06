'use strict';
// Persists the account list and warming config to the portable data dir.
const fs = require('node:fs');
const path = require('node:path');
const paths = require('./paths');

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
  minDelayMin: 3, // gap between conversations, in MINUTES (gentler by default)
  maxDelayMin: 10,
  imagesEnabled: true,
  linksEnabled: true,
  voiceEnabled: true,
  stickersEnabled: true,
  pollsEnabled: true,
  textNoise: true, // append invisible random chars so each message is byte-unique
  settleHours: 12, // "отлёжка": wait N hours after linking before an account warms
  dailyCap: 20, // outgoing messages per account per day
  rampUpDays: 7, // grow the daily cap gradually over the first N days
  daysPerPartner: 2, // add one new chat partner every N days (day 1 = 1 partner)
  activeStartHour: 9, // local system time
  activeEndHour: 23,
  maxConcurrent: 4, // parallel conversations (scales throughput for many accounts)
};

function loadConfig() {
  return { ...DEFAULT_CONFIG, ...readJson(paths.configFile(), {}) };
}

function saveConfig(cfg) {
  const merged = { ...DEFAULT_CONFIG, ...cfg };
  writeJsonAtomic(paths.configFile(), merged);
  return merged;
}

module.exports = {
  all,
  get,
  labelExists,
  uniqueLabel,
  upsert,
  remove,
  linkPartners,
  partnersOf,
  setConnected,
  setSessionLost,
  setPaused,
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
};
