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
function renderAccounts(list) {
  const ul = $('accountsList');
  ul.innerHTML = '';
  $('accountsEmpty').style.display = list.length ? 'none' : 'block';
  for (const a of list) {
    const li = document.createElement('li');
    li.className = 'acct';
    const dotClass = a.connected ? 'dot-on' : 'dot-err';
    li.innerHTML = `
      <span class="dot ${dotClass}"></span>
      <span class="meta">
        <div class="label"></div>
        <div class="phone"></div>
        <div class="stats muted small"></div>
      </span>
      <button class="btn btn-ghost">Выйти</button>`;
    li.querySelector('.label').textContent = a.label || 'Аккаунт';
    li.querySelector('.phone').textContent = a.connected
      ? (a.phone ? '+' + a.phone : 'подключён')
      : 'нужен ре-логин';
    li.querySelector('.stats').textContent =
      `прогрев: день ${a.days ?? 1} · отправлено ${a.sent ?? 0} · принято ${a.received ?? 0}`;
    li.querySelector('button').onclick = async () => {
      if (confirm(`Отвязать «${a.label}»?`)) {
        await api.logoutAccount(a.deviceId);
        await refreshAccounts();
      }
    };
    ul.appendChild(li);
  }
  updateStartEnabled(list);
}

async function refreshAccounts() {
  const list = await api.listAccounts();
  renderAccounts(list);
}

function updateStartEnabled(list) {
  const connected = list.filter((a) => a.connected).length;
  $('startBtn').disabled = warmingRunning || !gowaReady || connected < 2;
  $('stopBtn').disabled = !warmingRunning;
}

// ---------- config ----------
async function loadConfig() {
  const c = await api.getConfig();
  $('minDelayMin').value = c.minDelayMin;
  $('maxDelayMin').value = c.maxDelayMin;
  $('dailyCap').value = c.dailyCap;
  $('rampUpDays').value = c.rampUpDays;
  $('activeStart').value = c.activeStartHour;
  $('activeEnd').value = c.activeEndHour;
  $('imagesEnabled').checked = c.imagesEnabled;
  $('linksEnabled').checked = c.linksEnabled;
}

function readConfig() {
  return {
    minDelayMin: Math.max(1, +$('minDelayMin').value || 2),
    maxDelayMin: Math.max(1, +$('maxDelayMin').value || 7),
    dailyCap: Math.max(1, +$('dailyCap').value || 30),
    rampUpDays: Math.max(1, +$('rampUpDays').value || 5),
    activeStartHour: Math.min(23, Math.max(0, +$('activeStart').value || 0)),
    activeEndHour: Math.min(23, Math.max(0, +$('activeEnd').value || 23)),
    imagesEnabled: $('imagesEnabled').checked,
    linksEnabled: $('linksEnabled').checked,
  };
}

async function saveConfig() {
  await api.setConfig(readConfig());
}
['minDelayMin', 'maxDelayMin', 'dailyCap', 'rampUpDays', 'activeStart', 'activeEnd', 'imagesEnabled', 'linksEnabled']
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

// ---------- QR modal ----------
$('addBtn').onclick = () => {
  $('qrLabel').value = '';
  $('qrStage').classList.add('hidden');
  $('qrBox').innerHTML = '<span class="muted">получаем QR…</span>';
  $('qrStart').disabled = false;
  currentLoginDevice = null;
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
  $('qrStage').classList.remove('hidden');
  const { deviceId } = await api.startLogin(label);
  currentLoginDevice = deviceId;
};

api.onQr(({ deviceId, qr }) => {
  if (deviceId !== currentLoginDevice) return;
  $('qrBox').innerHTML = `<img src="${qr}" alt="QR" />`;
});
api.onLoginSuccess(({ deviceId }) => {
  if (deviceId === currentLoginDevice) {
    currentLoginDevice = null;
    $('qrModal').classList.add('hidden');
  }
  refreshAccounts();
});
api.onLoginTimeout(({ deviceId }) => {
  if (deviceId === currentLoginDevice) {
    $('qrBox').innerHTML = '<span class="muted">QR истёк. Закройте и попробуйте снова.</span>';
  }
});

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
  $('contentCounts').textContent = `сообщений: ${c.messages} · ссылок: ${c.links} · картинок: ${c.images}`;
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
