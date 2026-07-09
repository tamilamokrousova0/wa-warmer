'use strict';
// Adding accounts: via QR or pairing code. Mints a device (GOWA owns the id),
// streams the QR/code to the renderer, polls status until logged in, then
// registers the device's inbound webhook.
const { EventEmitter } = require('node:events');
const QRCode = require('qrcode');
const client = require('./gowaClient');
const store = require('./accountStore');
const gowa = require('./gowaManager');
const groups = require('./groups');
const log = require('./logbus');

const events = new EventEmitter();
const sessions = new Map(); // deviceId -> { cancelled }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function extractQr(data) {
  // GOWA returns { code: "SUCCESS", results: { qr_link } }. Prefer the image
  // link; never fall back to the envelope's top-level `code` (it's "SUCCESS",
  // which previously got rendered as a bogus QR).
  const r = data?.results || data?.result || {};
  const link = r.qr_link || r.qrLink || r.image;
  if (link) return { link };
  const code = r.qr_code || r.qr; // a real raw QR string, only if GOWA provides one
  if (code && typeof code === 'string' && !/^https?:/i.test(code)) return { code };
  return null;
}
async function toDataUrl(qr, deviceId) {
  if (qr.code) return QRCode.toDataURL(qr.code, { margin: 1, width: 300 });
  const res = await fetch(qr.link, {
    headers: qr.link.includes('127.0.0.1') ? { Authorization: client.authHeaderFor(deviceId) } : {},
  }).catch(() => null);
  if (res && res.ok) {
    const buf = Buffer.from(await res.arrayBuffer());
    return `data:${res.headers.get('content-type') || 'image/png'};base64,${buf.toString('base64')}`;
  }
  return qr.link;
}
function phoneFromJid(jid) {
  if (!jid) return '';
  return String(jid).split('@')[0].split(':')[0];
}

async function newDevice(label, groupId, owner) {
  const created = await client.createDevice(groupId, label);
  const deviceId = (created.results || created).id;
  store.upsert({ deviceId, label: label || 'Аккаунт', groupId, owner: String(owner || '').trim(), jid: '', phone: '', connected: false, addedAt: Date.now() });
  return deviceId;
}

// Poll /app/status until logged in (or cancelled). onTick lets QR flow refresh code.
async function pollLogin(deviceId, { maxSec = 150, onTick, isRelogin = false } = {}) {
  const s = sessions.get(deviceId);
  const started = Date.now();
  while (s && !s.cancelled && (Date.now() - started) / 1000 < maxSec) {
    if (onTick) { try { await onTick(); } catch { /* ignore */ } }
    await sleep(2000);
    if (s.cancelled) break;
    let st;
    try { st = await client.status(deviceId); } catch { continue; }
    const r = st.results || st;
    if (r.is_logged_in) {
      const phone = phoneFromJid(r.jid);
      store.upsert({ deviceId, jid: r.jid || '', phone, connected: true });
      // ре-логин → ставим паузу «отлёжки» (WhatsApp держит ~6ч спам-лимит)
      if (isRelogin) store.setReloggedAt(deviceId);
      gowa.registerWebhook(deviceId);
      log.info('login', `вошёл: ${phone}`);
      events.emit('success', { deviceId, jid: r.jid, phone });
      return true;
    }
  }
  return false;
}

async function refreshQr(deviceId) {
  const data = await client.login(deviceId);
  const qr = extractQr(data);
  if (!qr) return false;
  events.emit('qr', { deviceId, qr: await toDataUrl(qr, deviceId) });
  return true;
}

function findByLabel(label) {
  const l = String(label || '').trim().toLowerCase();
  if (!l) return null;
  return store.all().find((a) => String(a.label || '').trim().toLowerCase() === l) || null;
}

async function startLogin(label, groupId, owner) {
  const existing = findByLabel(label);
  if (existing) {
    // same name as an offline account → re-login it (reuse device, its own group); online → real duplicate
    if (existing.connected) return { error: `Название «${label}» уже занято` };
    return relogin(existing.deviceId);
  }
  const gid = groupId || 'ua';
  let deviceId;
  try { deviceId = await newDevice(label, gid, owner); } catch (e) { log.error('login', e.message); return { error: e.message }; }
  sessions.set(deviceId, { cancelled: false });
  log.info('login', `QR-логин для "${label}"`);
  (async () => {
    let lastQr = 0;
    const ok = await pollLogin(deviceId, {
      maxSec: 150,
      onTick: async () => {
        if (Date.now() - lastQr > 20000) { await refreshQr(deviceId); lastQr = Date.now(); }
      },
    });
    if (!ok && !sessions.get(deviceId)?.cancelled) events.emit('timeout', { deviceId });
    sessions.delete(deviceId);
  })();
  return { deviceId };
}

// request a pairing code for an existing device (no new device, no name check).
// isRelogin=true, когда повторно логиним уже существующий оффлайн-аккаунт.
async function codeLogin(deviceId, phone, isRelogin = false) {
  sessions.set(deviceId, { cancelled: false });
  let code = null;
  try {
    const res = await client.loginWithCode(deviceId, phone);
    code = (res.results || res).pair_code || (res.results || res).code || null;
    events.emit('code', { deviceId, code, phone });
    log.info('login', `код для ${phone}: ${code}`);
  } catch (e) {
    log.error('login', `login-with-code ${phone}: ${e.message}`);
    sessions.delete(deviceId);
    return { error: e.message };
  }
  (async () => {
    const ok = await pollLogin(deviceId, { maxSec: 180, isRelogin });
    if (!ok && !sessions.get(deviceId)?.cancelled) events.emit('timeout', { deviceId });
    sessions.delete(deviceId);
  })();
  return { deviceId, code };
}

async function startLoginWithCode(label, phone, groupId, owner) {
  const existing = findByLabel(label);
  if (existing) {
    if (existing.connected) return { error: `Название «${label}» уже занято` };
    return codeLogin(existing.deviceId, phone, true); // re-login the offline account by code, its own group
  }
  const gid = groupId || groups.detectGroupId(phone) || 'ua';
  let deviceId;
  try { deviceId = await newDevice(label, gid, owner); } catch (e) { return { error: e.message }; }
  return codeLogin(deviceId, phone);
}

// Re-login into an EXISTING device (after a disconnect) without recreating it.
async function relogin(deviceId) {
  const acc = store.get(deviceId);
  if (!acc) return { error: 'нет такого аккаунта' };
  sessions.set(deviceId, { cancelled: false });
  log.info('login', `ре-логин "${acc.label}"`);
  (async () => {
    let lastQr = 0;
    const ok = await pollLogin(deviceId, {
      maxSec: 150,
      isRelogin: true, // ре-логин существующего устройства → отлёжка после входа
      onTick: async () => { if (Date.now() - lastQr > 20000) { await refreshQr(deviceId); lastQr = Date.now(); } },
    });
    if (!ok && !sessions.get(deviceId)?.cancelled) events.emit('timeout', { deviceId });
    sessions.delete(deviceId);
  })();
  return { deviceId };
}

// force a fresh QR immediately (manual "refresh" button)
function forceRefresh(deviceId) {
  return refreshQr(deviceId).catch(() => false);
}

function cancel(deviceId) {
  const s = sessions.get(deviceId);
  if (s) s.cancelled = true;
  sessions.delete(deviceId);
  const acc = store.get(deviceId);
  // only discard devices that never completed a login (no jid); keep re-login targets
  if (acc && !acc.connected && !acc.jid) {
    client.deleteDevice(deviceId).catch(() => {});
    store.remove(deviceId);
  }
  events.emit('cancel', { deviceId });
}

module.exports = { events, startLogin, startLoginWithCode, relogin, forceRefresh, cancel, phoneFromJid };
