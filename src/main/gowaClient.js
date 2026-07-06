'use strict';
// Thin HTTP client for the GOWA REST API. Every call carries basic-auth and,
// where relevant, the per-account X-Device-Id header.
const fs = require('node:fs');
const path = require('node:path');

let baseUrl = null;
let authHeader = null;

function configure({ port, user, pass }) {
  baseUrl = `http://127.0.0.1:${port}`;
  authHeader = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

function isConfigured() {
  return !!baseUrl;
}

function authHeaderValue() {
  return authHeader;
}

function headers(deviceId, extra = {}) {
  const h = { Authorization: authHeader, ...extra };
  if (deviceId) h['X-Device-Id'] = deviceId;
  return h;
}

async function request(method, endpoint, { deviceId, json, body, extraHeaders } = {}) {
  if (!baseUrl) throw new Error('gowaClient not configured');
  const opts = { method, headers: headers(deviceId, extraHeaders) };
  if (json !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(json);
  } else if (body !== undefined) {
    opts.body = body; // FormData
  }
  const res = await fetch(`${baseUrl}${endpoint}`, opts);
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
const createDevice = (displayName) =>
  request('POST', '/devices', { json: { display_name: displayName || '' } });
const listDevices = () => request('GET', '/devices', {});
const deleteDevice = (id) => request('DELETE', `/devices/${encodeURIComponent(id)}`, {});

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
  configure,
  isConfigured,
  authHeaderValue,
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
