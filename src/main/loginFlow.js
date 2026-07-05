'use strict';
// Handles adding an account: mint a device id, fetch the QR from GOWA, stream
// it to the renderer, and poll /app/status until the account is logged in.
const { EventEmitter } = require('node:events');
const QRCode = require('qrcode');
const client = require('./gowaClient');
const store = require('./accountStore');
const log = require('./logbus');

const events = new EventEmitter();
const sessions = new Map(); // deviceId -> { cancelled, timer }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// GOWA response shapes vary; dig out a QR code string or an image link.
function extractQr(data) {
  const r = data?.results || data?.result || data || {};
  const code = r.qr_code || r.code || r.qr || data.code;
  const link = r.qr_link || r.qrLink || r.image;
  if (code && typeof code === 'string' && !/^https?:/i.test(code)) return { code };
  if (link) return { link };
  if (code) return { link: code };
  return null;
}

async function toDataUrl(qr) {
  if (qr.code) return QRCode.toDataURL(qr.code, { margin: 1, width: 320 });
  // link: fetch (may need auth) and inline as data URL
  const res = await fetch(qr.link, {
    headers: qr.link.includes('127.0.0.1') ? { Authorization: client.authHeaderValue() } : {},
  }).catch(() => null);
  if (res && res.ok) {
    const buf = Buffer.from(await res.arrayBuffer());
    const type = res.headers.get('content-type') || 'image/png';
    return `data:${type};base64,${buf.toString('base64')}`;
  }
  return qr.link; // let the <img> try directly
}

function phoneFromJid(jid) {
  if (!jid) return '';
  // e.g. "6281234567890:12@s.whatsapp.net" -> "6281234567890"
  return String(jid).split('@')[0].split(':')[0];
}

async function refreshQr(deviceId) {
  const data = await client.login(deviceId);
  const qr = extractQr(data);
  if (!qr) {
    log.warn('login', `no QR in login response: ${JSON.stringify(data).slice(0, 200)}`);
    return false;
  }
  const dataUrl = await toDataUrl(qr);
  events.emit('qr', { deviceId, qr: dataUrl });
  return true;
}

async function startLogin(label) {
  // GOWA owns the device id — create the device, then use the returned id.
  let deviceId;
  try {
    const created = await client.createDevice(label);
    deviceId = (created.results || created).id;
  } catch (e) {
    log.error('login', `createDevice failed: ${e.message}`);
    return { error: e.message };
  }
  store.upsert({
    deviceId,
    label: label || 'Аккаунт',
    jid: '',
    phone: '',
    connected: false,
    addedAt: Date.now(),
  });
  sessions.set(deviceId, { cancelled: false });
  log.info('login', `start login for ${label} (${deviceId})`);

  (async () => {
    const s = sessions.get(deviceId);
    let attempts = 0;
    const maxAttempts = 5;
    let sinceQr = 1e9;
    try {
      while (s && !s.cancelled && attempts < maxAttempts) {
        // (re)fetch a QR every ~30s until logged in
        if (sinceQr > 28) {
          const ok = await refreshQr(deviceId);
          if (!ok) { attempts++; }
          sinceQr = 0;
          attempts++;
        }
        await sleep(2000);
        sinceQr += 2;
        if (s.cancelled) break;

        let st;
        try {
          st = await client.status(deviceId);
        } catch (e) {
          log.warn('login', `status error: ${e.message}`);
          continue;
        }
        const r = st.results || st;
        if (r.is_logged_in) {
          const phone = phoneFromJid(r.jid);
          store.upsert({ deviceId, jid: r.jid || '', phone, connected: true });
          log.info('login', `logged in: ${phone}`);
          events.emit('success', { deviceId, jid: r.jid, phone });
          sessions.delete(deviceId);
          return;
        }
      }
      if (s && !s.cancelled) {
        log.warn('login', `login timed out for ${deviceId}`);
        events.emit('timeout', { deviceId });
        // leave the (disconnected) account record; user can retry or remove it
      }
    } catch (e) {
      log.error('login', `login flow failed: ${e.message}`);
      events.emit('timeout', { deviceId, error: e.message });
    } finally {
      sessions.delete(deviceId);
    }
  })();

  return { deviceId };
}

function cancel(deviceId) {
  const s = sessions.get(deviceId);
  if (s) s.cancelled = true;
  sessions.delete(deviceId);
  // discard the half-created device so it doesn't linger in GOWA / the store
  const acc = store.get(deviceId);
  if (acc && !acc.connected) {
    client.deleteDevice(deviceId).catch(() => {});
    store.remove(deviceId);
  }
  events.emit('cancel', { deviceId });
}

module.exports = { events, startLogin, cancel, phoneFromJid };
