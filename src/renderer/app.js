'use strict';
// Wrapped in an IIFE: contextBridge exposes `api` as a global, so a top-level
// `const api` in global scope would throw "Identifier 'api' has already been declared".
(() => {
const $ = (id) => document.getElementById(id);
const api = window.api;

let warmingRunning = false;
let gowaReady = false;
let currentLoginDevice = null;
let logFilter = 'all';
const logLines = [];

// ---------- accounts ----------
let accountsCache = [];

function accountRow(a) {
  const li = document.createElement('li');
  li.className = 'acct';
  const dotClass = a.connected ? 'dot-on' : 'dot-err';
  const reconBtn = a.connected ? '' : '<button class="recon" title="Переподключить">↻</button>';
  li.innerHTML = `
    <span class="dot ${dotClass}"></span>
    <span class="meta">
      <span class="top"><span class="label"></span><span class="phone"></span></span>
      <span class="stats"></span>
    </span>
    ${reconBtn}
    <button class="x" title="Отвязать">✕</button>`;
  li.querySelector('.label').textContent = a.label || 'Аккаунт';
  li.querySelector('.phone').textContent = a.connected ? (a.phone ? '+' + a.phone : 'онлайн') : 'нужен ре-логин';
  li.querySelector('.stats').textContent = `день ${a.days ?? 1} · ↑${a.sent ?? 0} · ↓${a.received ?? 0}`;
  const recon = li.querySelector('.recon');
  if (recon) recon.onclick = () => doReconnect(a);
  li.querySelector('.x').onclick = async () => {
    if (confirm(`Отвязать «${a.label}»?`)) { await api.logoutAccount(a.deviceId); await refreshAccounts(); }
  };
  return li;
}

async function doReconnect(a) {
  appendLog({ ts: Date.now(), tag: 'account', level: 'info', msg: `переподключаю "${a.label}"…` });
  const r = await api.reconnectAccount(a.deviceId);
  if (r.connected) { refreshAccounts(); return; }
  if (r.relogin) openReloginModal(a, r.deviceId);
}
function openReloginModal(a, deviceId) {
  currentLoginDevice = deviceId;
  $('qrLabel').value = a.label || '';
  applyModeUI('qr'); // don't cancel: relogin already started for this device
  $('phoneField').classList.add('hidden');
  $('codeStage').classList.add('hidden');
  $('qrStage').classList.remove('hidden');
  $('qrBox').innerHTML = '<span class="muted">получаем QR…</span>';
  $('qrStart').disabled = true; // login already running for this device
  $('qrHint').textContent = 'Ре-логин: отсканируйте QR тем же аккаунтом (WhatsApp → Связанные устройства).';
  $('qrModal').classList.remove('hidden');
}

function applyAccountFilter() {
  const q = ($('acctFilter').value || '').trim().toLowerCase();
  const ul = $('accountsList');
  ul.innerHTML = '';
  const list = q
    ? accountsCache.filter((a) => (a.label || '').toLowerCase().includes(q) || (a.phone || '').includes(q))
    : accountsCache;
  $('accountsEmpty').style.display = accountsCache.length ? 'none' : 'block';
  for (const a of list) ul.appendChild(accountRow(a));
}

function renderAccounts(list) {
  accountsCache = list;
  const connected = list.filter((a) => a.connected).length;
  const sent = list.reduce((s, a) => s + (a.sent || 0), 0);
  const received = list.reduce((s, a) => s + (a.received || 0), 0);
  $('sumAccounts').textContent = `${connected} / ${list.length} онлайн`;
  $('sumTraffic').textContent = `↑${sent} ↓${received}`;
  $('acctCount').textContent = list.length ? `(${list.length})` : '';
  applyAccountFilter();
  $('startBtn').disabled = warmingRunning || !gowaReady || connected < 2;
  $('stopBtn').disabled = !warmingRunning;
}
$('acctFilter').addEventListener('input', applyAccountFilter);

async function refreshAccounts() {
  renderAccounts(await api.listAccounts());
}

// ---------- config ----------
async function loadConfig() {
  const c = await api.getConfig();
  $('minDelayMin').value = c.minDelayMin;
  $('maxDelayMin').value = c.maxDelayMin;
  $('dailyCap').value = c.dailyCap;
  $('maxConcurrent').value = c.maxConcurrent;
  $('rampUpDays').value = c.rampUpDays;
  $('activeStart').value = c.activeStartHour;
  $('activeEnd').value = c.activeEndHour;
  $('imagesEnabled').checked = c.imagesEnabled;
  $('linksEnabled').checked = c.linksEnabled;
  $('voiceEnabled').checked = c.voiceEnabled;
  $('stickersEnabled').checked = c.stickersEnabled;
  $('pollsEnabled').checked = c.pollsEnabled;
  $('contactsEnabled').checked = c.contactsEnabled;
}

function readConfig() {
  return {
    minDelayMin: Math.max(1, +$('minDelayMin').value || 2),
    maxDelayMin: Math.max(1, +$('maxDelayMin').value || 7),
    dailyCap: Math.max(1, +$('dailyCap').value || 30),
    maxConcurrent: Math.min(24, Math.max(1, +$('maxConcurrent').value || 4)),
    rampUpDays: Math.max(1, +$('rampUpDays').value || 5),
    activeStartHour: Math.min(23, Math.max(0, +$('activeStart').value || 0)),
    activeEndHour: Math.min(23, Math.max(0, +$('activeEnd').value || 23)),
    imagesEnabled: $('imagesEnabled').checked,
    linksEnabled: $('linksEnabled').checked,
    voiceEnabled: $('voiceEnabled').checked,
    stickersEnabled: $('stickersEnabled').checked,
    pollsEnabled: $('pollsEnabled').checked,
    contactsEnabled: $('contactsEnabled').checked,
  };
}

async function saveConfig() {
  await api.setConfig(readConfig());
}
['minDelayMin', 'maxDelayMin', 'dailyCap', 'maxConcurrent', 'rampUpDays', 'activeStart', 'activeEnd',
  'imagesEnabled', 'linksEnabled', 'voiceEnabled', 'stickersEnabled', 'pollsEnabled', 'contactsEnabled']
  .forEach((id) => $(id).addEventListener('change', saveConfig));

// ---------- warming ----------
$('startBtn').onclick = async () => {
  await saveConfig();
  await api.startWarming(readConfig());
};
$('stopBtn').onclick = () => api.stopWarming();

function setWarmingState(running) {
  warmingRunning = running;
  $('warmState').textContent = running ? 'идёт прогрев…' : 'остановлено';
  refreshAccounts();
}

// ---------- add-account modal (QR / code) ----------
let loginMode = 'qr';
function applyModeUI(mode) {
  loginMode = mode;
  $('tabQr').classList.toggle('active', mode === 'qr');
  $('tabCode').classList.toggle('active', mode === 'code');
  $('phoneField').classList.toggle('hidden', mode !== 'code');
  $('qrStart').textContent = mode === 'qr' ? 'Получить QR' : 'Получить код';
}
// user clicking a tab: cancel any in-progress login and reset the modal state
function setMode(mode) {
  if (currentLoginDevice) { api.cancelLogin(currentLoginDevice); currentLoginDevice = null; }
  $('qrStage').classList.add('hidden');
  $('codeStage').classList.add('hidden');
  $('qrBox').innerHTML = '<span class="muted">получаем QR…</span>';
  $('codeBox').textContent = '— — — —';
  $('qrStart').disabled = false;
  applyModeUI(mode);
}
$('tabQr').onclick = () => setMode('qr');
$('tabCode').onclick = () => setMode('code');

$('addBtn').onclick = () => {
  $('qrLabel').value = '';
  $('qrPhone').value = '';
  $('qrStage').classList.add('hidden');
  $('codeStage').classList.add('hidden');
  $('qrBox').innerHTML = '<span class="muted">получаем QR…</span>';
  $('qrHint').textContent = 'WhatsApp → Настройки → Связанные устройства → Привязать устройство.';
  $('qrStart').disabled = false;
  currentLoginDevice = null;
  setMode('qr');
  $('qrModal').classList.remove('hidden');
};
function closeModal() {
  if (currentLoginDevice) api.cancelLogin(currentLoginDevice);
  currentLoginDevice = null;
  $('qrModal').classList.add('hidden');
}
$('qrClose').onclick = closeModal;
$('qrStart').onclick = async () => {
  const label = $('qrLabel').value.trim() || 'Аккаунт';
  $('qrStart').disabled = true;
  if (loginMode === 'qr') {
    $('qrStage').classList.remove('hidden');
    const { deviceId } = await api.startLogin(label);
    currentLoginDevice = deviceId;
  } else {
    const phone = $('qrPhone').value.replace(/[^0-9]/g, '');
    if (!phone) { $('qrStart').disabled = false; return; }
    $('codeStage').classList.remove('hidden');
    $('codeBox').textContent = '…';
    const r = await api.startLoginCode(label, phone);
    currentLoginDevice = r.deviceId || null;
    $('codeBox').textContent = r.code || (r.error ? 'ошибка' : '…');
  }
};

api.onQr(({ deviceId, qr }) => { if (deviceId === currentLoginDevice) $('qrBox').innerHTML = `<img src="${qr}" alt="QR" />`; });
api.onCode(({ deviceId, code }) => { if (deviceId === currentLoginDevice && code) $('codeBox').textContent = code; });
api.onLoginSuccess(({ deviceId }) => {
  if (deviceId === currentLoginDevice) { currentLoginDevice = null; $('qrModal').classList.add('hidden'); }
  refreshAccounts();
});
api.onLoginTimeout(({ deviceId }) => {
  if (deviceId === currentLoginDevice) {
    if (loginMode === 'qr') $('qrBox').innerHTML = '<span class="muted">QR истёк. Закройте и попробуйте снова.</span>';
    else $('codeBox').textContent = 'истёк';
  }
});

// ---------- bulk add (by code) ----------
$('bulkBtn').onclick = () => { $('bulkResults').innerHTML = ''; $('bulkModal').classList.remove('hidden'); };
$('bulkClose').onclick = () => $('bulkModal').classList.add('hidden');
$('bulkStart').onclick = async () => {
  const phones = $('bulkPhones').value.split(/\r?\n/).map((s) => s.replace(/[^0-9]/g, '')).filter(Boolean);
  if (phones.length === 0) return;
  $('bulkStart').disabled = true;
  $('bulkResults').innerHTML = '<span class="muted small">запрашиваю коды…</span>';
  const res = await api.bulkLoginCode(phones, $('bulkPrefix').value.trim() || 'Аккаунт');
  $('bulkResults').innerHTML = res.map((r) =>
    `<div class="bulk-row"><span>${r.phone}</span><b>${r.error ? 'ошибка' : (r.code || '…')}</b></div>`).join('');
  $('bulkStart').disabled = false;
  refreshAccounts();
};

// ---------- stats dashboard ----------
function bars(history) {
  const max = Math.max(1, ...history.map((h) => Math.max(h.sent, h.received)));
  const bw = 100 / history.length;
  let svg = '<svg viewBox="0 0 100 40" preserveAspectRatio="none" class="chart-svg">';
  history.forEach((h, i) => {
    const x = i * bw;
    const hs = (h.sent / max) * 38, hr = (h.received / max) * 38;
    svg += `<rect x="${(x + bw * 0.12).toFixed(2)}" y="${(40 - hs).toFixed(2)}" width="${(bw * 0.36).toFixed(2)}" height="${hs.toFixed(2)}" fill="#2ea6ff"></rect>`;
    svg += `<rect x="${(x + bw * 0.52).toFixed(2)}" y="${(40 - hr).toFixed(2)}" width="${(bw * 0.36).toFixed(2)}" height="${hr.toFixed(2)}" fill="#2ecc71"></rect>`;
  });
  svg += '</svg>';
  return svg;
}
async function openStats() {
  const s = await api.statsFull();
  const t = s.totals;
  $('statsTotals').innerHTML =
    `<span class="chip">аккаунтов: ${t.accounts}</span><span class="chip">онлайн: ${t.connected}</span>` +
    `<span class="chip">↑ отправлено: ${t.sent}</span><span class="chip">↓ принято: ${t.received}</span>`;
  $('statsChart').innerHTML = bars(s.history) +
    `<div class="legend"><span><i style="background:#2ea6ff"></i>отправлено</span><span><i style="background:#2ecc71"></i>принято</span></div>`;
  const maxAcc = Math.max(1, ...s.perAccount.map((a) => Math.max(a.sent, a.received)));
  $('statsPerAccount').innerHTML = s.perAccount.map((a) => `
    <div class="sa-row">
      <span class="sa-name">${a.label}</span>
      <span class="sa-bar"><i style="width:${(a.sent / maxAcc * 100).toFixed(0)}%;background:#2ea6ff"></i></span>
      <span class="sa-bar"><i style="width:${(a.received / maxAcc * 100).toFixed(0)}%;background:#2ecc71"></i></span>
      <span class="sa-num muted small">день ${a.days} · ↑${a.sent} ↓${a.received}</span>
    </div>`).join('') || '<span class="muted small">нет данных</span>';
  $('statsModal').classList.remove('hidden');
}
$('statsBtn').onclick = openStats;
$('statsClose').onclick = () => $('statsModal').classList.add('hidden');
$('statsExport').onclick = async () => {
  const r = await api.statsExportCsv();
  if (r && r.path) appendLog({ ts: Date.now(), tag: 'app', level: 'info', msg: `статистика сохранена: ${r.path}` });
};

// ---------- events ----------
api.onAccountsUpdated((list) => renderAccounts(list));
api.onWarmingState(({ running }) => setWarmingState(running));
api.onGowaState((s) => setGowa(s));
api.onLoggedOut(({ label }) => {
  const line = { ts: Date.now(), tag: 'warming', level: 'warn', msg: `⚠ аккаунт "${label}" отключился (logout/бан)` };
  appendLog(line);
});

// ---------- content ----------
function renderCounts(c) {
  $('contentCounts').textContent =
    `сообщ: ${c.messages} · ссыл: ${c.links} · карт: ${c.images} · голос: ${c.voice ?? 0} · стик: ${c.stickers ?? 0} · опрос: ${c.polls ?? 0}`;
}
async function refreshContent() { renderCounts(await api.contentCounts()); }
$('openContent').onclick = () => api.contentOpenFolder();
$('reloadContent').onclick = async () => renderCounts(await api.contentReload());
$('addImages').onclick = async () => renderCounts(await api.contentAddImages());

function setGowa(s) {
  gowaReady = !!s.ready;
  const dot = $('gowaDot');
  const txt = $('gowaText');
  if (s.ready) { dot.className = 'dot dot-on'; txt.textContent = `движок: готов (порт ${s.port})`; }
  else if (s.fatal) { dot.className = 'dot dot-err'; txt.textContent = 'движок: не запустился'; }
  else if (s.restarting) { dot.className = 'dot dot-warn'; txt.textContent = 'движок: перезапуск…'; }
  else { dot.className = 'dot dot-off'; txt.textContent = 'движок: запуск…'; }
  refreshAccounts();
}

// ---------- log ----------
function tagClass(tag) { return 'tag tag-' + tag; }
function renderLogLine(line) {
  const div = document.createElement('div');
  div.className = 'line';
  if (line.level === 'error') div.classList.add('lvl-error');
  if (line.level === 'warn') div.classList.add('lvl-warn');
  const time = new Date(line.ts).toLocaleTimeString();
  div.innerHTML = `<span class="ts">${time}</span><span class="${tagClass(line.tag)}">${line.tag}</span><span class="msg"></span>`;
  div.querySelector('.msg').textContent = line.msg;
  return div;
}
function passesFilter(line) {
  return logFilter === 'all' || line.tag === logFilter;
}
function appendLog(line) {
  logLines.push(line);
  if (logLines.length > 600) logLines.shift();
  if (!passesFilter(line)) return;
  const box = $('log');
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  box.appendChild(renderLogLine(line));
  while (box.childElementCount > 600) box.removeChild(box.firstChild);
  if (atBottom) box.scrollTop = box.scrollHeight;
}
function rerenderLog() {
  const box = $('log');
  box.innerHTML = '';
  logLines.filter(passesFilter).forEach((l) => box.appendChild(renderLogLine(l)));
  box.scrollTop = box.scrollHeight;
}
api.onLogLine((line) => appendLog(line));
$('logFilter').onchange = (e) => { logFilter = e.target.value; rerenderLog(); };
$('clearLog').onclick = () => { logLines.length = 0; rerenderLog(); };

api.onWarmingTick((t) => {
  // ticks also arrive via log:line; nothing extra needed here for now
});

// ---------- boot ----------
(async function init() {
  await loadConfig();
  await refreshContent();
  await refreshAccounts();
  try {
    const g = await api.gowaStatus();
    setGowa(g);
  } catch { /* ignore */ }
  const hist = await api.logHistory();
  hist.forEach((l) => appendLog(l));
})();
})();
