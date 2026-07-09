'use strict';
// Thin HTTP client for the GOWA REST API. Every call carries basic-auth and,
// where relevant, the per-account X-Device-Id header. The pool has one GOWA
// process per country group, so every request resolves its target engine
// (baseUrl + auth) via engineRouter instead of a single module-global one.
const fs = require('node:fs');
const path = require('node:path');

// Lazy require: gowaManager requires gowaClient (for setWebhook), and
// engineRouter requires gowaManager — a top-level require here would close
// that cycle mid-load and hand engineRouter a not-yet-populated gowaManager
// export. Deferring to call time (after every module has finished loading)
// sidesteps the ordering problem entirely.
const router = () => require('./engineRouter');

// Resolve the engine for a request: by device (existing account) when
// deviceId is given, else by group (e.g. creating a brand-new device that
// has no deviceId yet).
function resolveEngine({ deviceId, groupId }) {
  if (deviceId) return router().forDevice(deviceId);
  if (groupId) return router().forGroup(groupId);
  return null;
}

function authHeaderFor(deviceId) {
  const eng = router().forDevice(deviceId);
  return eng ? eng.auth : null;
}

function headers(eng, deviceId, extra = {}) {
  const h = { Authorization: eng.auth, ...extra };
  if (deviceId) h['X-Device-Id'] = deviceId;
  return h;
}

async function request(method, endpoint, { deviceId, groupId, json, body, extraHeaders } = {}) {
  const eng = resolveEngine({ deviceId, groupId });
  if (!eng) throw new Error('нет активного движка для запроса');
  const opts = { method, headers: headers(eng, deviceId, extraHeaders) };
  if (json !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(json);
  } else if (body !== undefined) {
    opts.body = body; // FormData
  }
  const res = await fetch(`${eng.baseUrl}${endpoint}`, opts);
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const err = new Error(`GOWA ${method} ${endpoint} -> ${res.status}: ${text.slice(0, 300)}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

// --- device management (GOWA generates the id) ---
const createDevice = (groupId, displayName) =>
  request('POST', '/devices', { groupId, json: { display_name: displayName || '' } });
const listDevices = (groupId) => request('GET', '/devices', { groupId });
const deleteDevice = (deviceId) => request('DELETE', `/devices/${encodeURIComponent(deviceId)}`, { deviceId });

// --- app / session (scoped by X-Device-Id) ---
const login = (deviceId) => request('GET', '/app/login', { deviceId });
const loginWithCode = (deviceId, phone) =>
  request('GET', `/app/login-with-code?phone=${encodeURIComponent(phone)}`, { deviceId });
const status = (deviceId) => request('GET', '/app/status', { deviceId });
const logout = (deviceId) => request('GET', '/app/logout', { deviceId });
const reconnect = (deviceId) => request('GET', '/app/reconnect', { deviceId });

// full JID form required by presence/read endpoints
const toJid = (phone) => (String(phone).includes('@') ? String(phone) : `${phone}@s.whatsapp.net`);

// --- presence / typing / read (realism) ---
const chatPresence = (deviceId, phone, action /* 'start' | 'stop' */) =>
  request('POST', '/send/chat-presence', { deviceId, json: { phone: toJid(phone), action } });
const presence = (deviceId, type /* 'available' | 'unavailable' */) =>
  request('POST', '/send/presence', { deviceId, json: { type } });
const markRead = (deviceId, messageId, phone) =>
  request('POST', `/message/${encodeURIComponent(messageId)}/read`, { deviceId, json: { phone: toJid(phone) } });

// --- device webhook (for real inbound events) ---
const setWebhook = (deviceId, webhookUrl, secret = '') =>
  request('PATCH', `/devices/${encodeURIComponent(deviceId)}/webhook`, {
    deviceId,
    json: { webhook_url: webhookUrl, webhook_secret: secret, webhook_events: '' },
  });
const userCheck = (deviceId, phone) =>
  request('GET', `/user/check?phone=${encodeURIComponent(phone)}`, { deviceId });

// --- message actions ---
const reaction = (deviceId, messageId, phone, emoji) =>
  request('POST', `/message/${encodeURIComponent(messageId)}/reaction`, { deviceId, json: { phone, emoji } });
const updateMessage = (deviceId, messageId, phone, message) =>
  request('POST', `/message/${encodeURIComponent(messageId)}/update`, { deviceId, json: { phone, message } });

// --- sending ---
const sendMessage = (deviceId, phone, message, replyId) =>
  request('POST', '/send/message', {
    deviceId,
    json: replyId ? { phone, message, reply_message_id: replyId } : { phone, message },
  });
const MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif',
  '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
};
function sendFileForm(deviceId, endpoint, field, filePath, extra = {}) {
  const buf = fs.readFileSync(filePath);
  const form = new FormData();
  for (const [k, v] of Object.entries(extra)) form.append(k, v);
  const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
  form.append(field, new Blob([buf], { type }), path.basename(filePath));
  return request('POST', endpoint, { deviceId, body: form });
}

const sendImage = (deviceId, phone, filePath, caption = '') =>
  sendFileForm(deviceId, '/send/image', 'image', filePath, { phone, caption, compress: 'false' });
const sendAudio = (deviceId, phone, filePath) =>
  sendFileForm(deviceId, '/send/audio', 'audio', filePath, { phone });

module.exports = {
  authHeaderFor,
  createDevice,
  listDevices,
  deleteDevice,
  login,
  loginWithCode,
  status,
  logout,
  reconnect,
  chatPresence,
  presence,
  markRead,
  setWebhook,
  userCheck,
  reaction,
  updateMessage,
  sendMessage,
  sendImage,
  sendAudio,
};
