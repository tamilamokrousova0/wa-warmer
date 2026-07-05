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
  saveAccounts();
}

function setConnected(deviceId, connected, jid, phone) {
  const a = get(deviceId);
  if (!a) return;
  a.connected = connected;
  if (jid) a.jid = jid;
  if (phone) a.phone = phone;
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
}

function bumpReceived(deviceId) {
  const a = get(deviceId);
  if (!a) return;
  a.receivedTotal = (a.receivedTotal || 0) + 1;
  saveAccounts();
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

// ---- config ----
const DEFAULT_CONFIG = {
  minDelayMin: 2, // gap between conversations, in MINUTES
  maxDelayMin: 7,
  imagesEnabled: true,
  linksEnabled: true,
  dailyCap: 30, // outgoing messages per account per day
  rampUpDays: 5,
  activeStartHour: 9, // local system time
  activeEndHour: 23,
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
  upsert,
  remove,
  setConnected,
  bumpSent,
  bumpReceived,
  sentToday,
  daysWarming,
  ensureDaily,
  loadConfig,
  saveConfig,
  DEFAULT_CONFIG,
};
