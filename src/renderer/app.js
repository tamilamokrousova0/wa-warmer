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
let editingId = null; // deviceId being renamed inline (suppresses re-render)

function startRename(li, a) {
  editingId = a.deviceId;
  const top = li.querySelector('.top');
  const input = document.createElement('input');
  input.className = 'rename-input';
  input.value = a.label || '';
  top.innerHTML = '';
  top.appendChild(input);
  input.focus();
  input.select();
  let done = false;
  const finish = async (save) => {
    if (done) return; done = true;
    editingId = null;
    if (save) {
      const name = input.value.trim();
      if (name && name !== a.label) {
        const r = await api.renameAccount(a.deviceId, name);
        if (r && r.error) alert(r.error);
      }
    }
    refreshAccounts();
  };
  input.onkeydown = (e) => { if (e.key === 'Enter') finish(true); else if (e.key === 'Escape') finish(false); };
  input.onblur = () => finish(true);
}

function fmtDuration(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  if (s < 60) return s + 'с';
  const m = Math.floor(s / 60), ss = s % 60;
  if (m < 60) return m + 'м' + (ss ? ' ' + ss + 'с' : '');
  const h = Math.floor(m / 60), mm = m % 60;
  return h + 'ч' + (mm ? ' ' + mm + 'м' : '');
}
// what happens next for this account, and when
function nextActionText(a) {
  if (!a.connected || a.paused) return '';
  const now = Date.now();
  if (a.settleUntil && a.settleUntil > now) return `⏳ отлёжка · прогрев через ${fmtDuration(a.settleUntil - now)}`;
  if (!warmingRunning) return 'готов · ожидает старта';
  if (a.activeHours === false) return '🌙 вне активных часов';
  if (a.capReached) return `✅ дневной лимит исчерпан (${a.capToday})`;
  if (a.busy) return '🔥 сейчас в диалоге';
  if (a.nextSendAt && a.nextSendAt > now) return `🔥 следующий диалог через ${fmtDuration(a.nextSendAt - now)}`;
  return '🔥 в прогреве';
}

function accountRow(a) {
  const li = document.createElement('li');
  li.className = 'acct' + (a.paused ? ' paused' : '');
  const dotClass = a.paused ? 'dot-warn' : (a.connected ? 'dot-on' : 'dot-err');
  const reconBtn = (!a.connected && !a.paused) ? '<button class="recon" title="Переподключить">↻</button>' : '';
  const pauseBtn = `<button class="pause" title="${a.paused ? 'Снять паузу' : 'Пауза — исключить из прогрева'}">${a.paused ? '▶' : '⏸'}</button>`;
  li.innerHTML = `
    <span class="dot ${dotClass}"></span>
    <span class="meta">
      <span class="top"><span class="label"></span><span class="group-badge"></span><span class="phone"></span></span>
      <span class="stats"></span>
      <span class="next small"></span>
    </span>
    ${reconBtn}
    <button class="edit" title="Переименовать">✎</button>
    ${pauseBtn}
    <button class="x" title="Отвязать">✕</button>`;
  li.querySelector('.label').textContent = a.label || 'Аккаунт';
  const gid = a.groupId || 'ua';
  const badge = li.querySelector('.group-badge');
  badge.textContent = groupLabel(gid);
  badge.classList.add('grp-' + gid);
  li.querySelector('.edit').onclick = () => startRename(li, a);
  li.querySelector('.phone').textContent = a.paused ? 'на паузе'
    : (a.connected ? (a.phone ? '+' + a.phone : 'онлайн')
      : (a.sessionLost ? 'нужен ре-логин (сессия потеряна)' : (a.jid ? 'переподключение…' : 'не привязан')));
  li.querySelector('.stats').textContent = `${a.ready ? '✅ прогрет' : 'день ' + (a.days ?? 1)} · чатов ${a.chats ?? 0} · ↑${a.sent ?? 0} · ↓${a.received ?? 0}`;
  const nextEl = li.querySelector('.next');
  const nextTxt = nextActionText(a);
  if (nextTxt) nextEl.textContent = nextTxt; else nextEl.style.display = 'none';
  const recon = li.querySelector('.recon');
  if (recon) recon.onclick = () => doReconnect(a);
  li.querySelector('.pause').onclick = async () => { await api.setAccountPaused(a.deviceId, !a.paused); await refreshAccounts(); };
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
  if (editingId) return; // don't rebuild rows while renaming
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
  const active = list.filter((a) => a.connected && !a.paused).length; // eligible for warming
  const paused = list.filter((a) => a.paused).length;
  const sent = list.reduce((s, a) => s + (a.sent || 0), 0);
  const received = list.reduce((s, a) => s + (a.received || 0), 0);
  $('sumAccounts').textContent = `${connected} / ${list.length} онлайн` + (paused ? ` · ${paused} на паузе` : '');
  $('sumTraffic').textContent = `↑${sent} ↓${received}`;
  $('acctCount').textContent = list.length ? `(${list.length})` : '';
  applyAccountFilter();
  $('startBtn').disabled = warmingRunning || !gowaReady || active < 2;
  $('stopBtn').disabled = !warmingRunning;
}
$('acctFilter').addEventListener('input', applyAccountFilter);
setInterval(() => { if (accountsCache.length) applyAccountFilter(); }, 5000); // keep the countdowns live

async function refreshAccounts() {
  renderAccounts(await api.listAccounts());
}

// ---------- config ----------
async function loadConfig() {
  const c = await api.getConfig();
  $('minDelayMin').value = c.minDelayMin;
  $('maxDelayMin').value = c.maxDelayMin;
  $('settleHours').value = c.settleHours;
  $('dailyCap').value = c.dailyCap;
  $('maxConcurrent').value = c.maxConcurrent;
  $('daysPerPartner').value = c.daysPerPartner;
  $('rampUpDays').value = c.rampUpDays;
  $('activeStart').value = c.activeStartHour;
  $('activeEnd').value = c.activeEndHour;
  $('imagesEnabled').checked = c.imagesEnabled;
  $('linksEnabled').checked = c.linksEnabled;
  $('voiceEnabled').checked = c.voiceEnabled;
  $('textNoise').checked = c.textNoise;
}

function readConfig() {
  return {
    minDelayMin: Math.max(1, +$('minDelayMin').value || 2),
    maxDelayMin: Math.max(1, +$('maxDelayMin').value || 7),
    settleHours: Math.max(0, +$('settleHours').value || 0),
    dailyCap: Math.max(1, +$('dailyCap').value || 30),
    maxConcurrent: Math.min(24, Math.max(1, +$('maxConcurrent').value || 4)),
    daysPerPartner: Math.max(1, +$('daysPerPartner').value || 2),
    rampUpDays: Math.max(1, +$('rampUpDays').value || 5),
    activeStartHour: Math.min(23, Math.max(0, +$('activeStart').value || 0)),
    activeEndHour: Math.min(23, Math.max(0, +$('activeEnd').value || 23)),
    imagesEnabled: $('imagesEnabled').checked,
    linksEnabled: $('linksEnabled').checked,
    voiceEnabled: $('voiceEnabled').checked,
    textNoise: $('textNoise').checked,
  };
}

async function saveConfig() {
  await api.setConfig(readConfig());
}
['minDelayMin', 'maxDelayMin', 'dailyCap', 'maxConcurrent', 'rampUpDays', 'activeStart', 'activeEnd',
  'daysPerPartner', 'settleHours', 'imagesEnabled', 'linksEnabled', 'voiceEnabled', 'textNoise']
  .forEach((id) => $(id).addEventListener('change', saveConfig));

// ---------- groups (per-group proxy; saving restarts changed engines) ----------
let groupsCache = [];
const ROLE_RU = { primary: 'основная', aux: 'вспомог.' };
// ожидаемая страна IP для каждой группы (регистронезависимо, с распространёнными вариантами)
const GROUP_COUNTRY = {
  ua: ['ukraine'],
  de: ['germany'],
  pl: ['poland'],
  uk: ['united kingdom', 'uk', 'great britain', 'england'],
};
function groupLabel(id) { const g = groupsCache.find((x) => x.id === id); return g ? g.label : id; }

function setGroupsStatus(text, kind /* 'ok' | 'err' | '' */) {
  const el = $('groupsStatus');
  el.textContent = text;
  el.classList.toggle('ok', kind === 'ok');
  el.classList.toggle('err', kind === 'err');
}

function groupRow(g) {
  const div = document.createElement('div');
  div.className = 'group-row';
  div.dataset.id = g.id;
  div.innerHTML = `
    <div class="group-info">
      <span class="group-badge grp-${g.id}">${g.label}</span>
      <span class="group-role muted small">${g.country} · ${ROLE_RU[g.role] || g.role}</span>
    </div>
    <input class="group-proxy" type="text" spellcheck="false" autocomplete="off" placeholder="socks5://user:pass@host:1080" />
    <button class="btn btn-mini group-test">Проверить</button>
    <span class="group-result muted small"></span>
    <div class="group-notes">
      <span class="note-pair amber small"></span>
      <span class="note-geo amber small"></span>
    </div>`;
  div.querySelector('.group-proxy').value = g.proxy || '';
  // предупреждение: для прогрева внутри страны нужна пара номеров
  if ((g.accountCount ?? 0) < 2) {
    div.querySelector('.note-pair').textContent = '⚠ нужно ≥2 номера для прогрева внутри страны';
  }
  const resEl = div.querySelector('.group-result');
  const geoEl = div.querySelector('.note-geo');
  div.querySelector('.group-test').onclick = async (e) => {
    const proxy = div.querySelector('.group-proxy').value.trim();
    resEl.className = 'group-result muted small';
    geoEl.textContent = '';
    if (!proxy) { resEl.textContent = 'прямое подключение'; return; }
    e.target.disabled = true;
    resEl.textContent = 'проверяю…';
    try {
      const r = await api.testProxy(proxy);
      if (r.ok) {
        const geo = [r.city, r.country].filter(Boolean).join(', ');
        resEl.textContent = `✓ ${r.ip}${geo ? ` — ${geo}` : ''}`;
        resEl.classList.add('ok');
        // сверяем страну IP с ожидаемой страной группы
        const expected = GROUP_COUNTRY[g.id];
        const ipCountry = String(r.country || '').trim();
        if (expected && ipCountry && !expected.includes(ipCountry.toLowerCase())) {
          geoEl.textContent = `⚠ IP ${ipCountry} ≠ страна группы`;
        }
      } else {
        resEl.textContent = `✕ ${r.error || 'не удалось'}`;
        resEl.classList.add('err');
      }
    } catch (err) {
      resEl.textContent = `✕ ${err.message}`;
      resEl.classList.add('err');
    } finally {
      e.target.disabled = false;
    }
  };
  return div;
}

function populateGroupSelect() {
  const sel = $('qrGroup');
  if (!sel) return;
  const cur = sel.value;
  sel.innerHTML = groupsCache.map((g) => `<option value="${g.id}">${g.label} (${g.country})</option>`).join('');
  if (cur) sel.value = cur;
}

function renderGroups(list) {
  groupsCache = Array.isArray(list) ? list : [];
  const box = $('groupsList');
  box.innerHTML = '';
  for (const g of groupsCache) box.appendChild(groupRow(g));
  populateGroupSelect();
}

async function loadGroups() {
  try { renderGroups(await api.getGroups()); } catch { /* ignore */ }
}

$('groupsSave').onclick = async () => {
  const rows = [...document.querySelectorAll('#groupsList .group-row')];
  const groups = rows.map((row) => {
    const base = groupsCache.find((x) => x.id === row.dataset.id) || { id: row.dataset.id };
    return { ...base, proxy: row.querySelector('.group-proxy').value.trim() };
  });
  const btn = $('groupsSave');
  btn.disabled = true;
  setGroupsStatus('Сохраняю, движки перезапускаются…', '');
  try {
    const r = await api.saveGroups(groups);
    if (r && r.error) { setGroupsStatus(`✕ ${r.error}`, 'err'); return; }
    groupsCache = r.groups || groups;
    const n = (r.restarted || []).length;
    setGroupsStatus(n ? `Сохранено. Перезапущены движки: ${r.restarted.join(', ')}.` : 'Сохранено. Без изменений прокси.', 'ok');
  } catch (e) {
    setGroupsStatus(`✕ ${e.message}`, 'err');
  } finally {
    btn.disabled = false;
  }
};

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
  if ($('qrGroup').options.length) $('qrGroup').value = 'ua';
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
$('qrRefresh').onclick = () => { if (currentLoginDevice) { $('qrBox').innerHTML = '<span class="muted">обновляю…</span>'; api.refreshQr(currentLoginDevice); } };
function showAddError(msg) {
  $('codeStage').classList.add('hidden');
  $('qrHint').textContent = '⚠ ' + msg;
  $('qrHint').style.color = 'var(--red)';
  $('qrStage').classList.remove('hidden');
  $('qrBox').innerHTML = '';
  $('qrStart').disabled = false;
}
// автозаполнение группы по префиксу номера (клиентский помощник api.detectGroup)
$('qrPhone').addEventListener('input', () => {
  const gid = api.detectGroup($('qrPhone').value);
  if (gid) $('qrGroup').value = gid;
});

$('qrStart').onclick = async () => {
  const label = $('qrLabel').value.trim() || 'Аккаунт';
  const groupId = $('qrGroup').value || 'ua';
  $('qrStart').disabled = true;
  $('qrHint').style.color = '';
  if (loginMode === 'qr') {
    const r = await api.startLogin(label, groupId);
    if (r.error) { showAddError(r.error); return; }
    $('codeStage').classList.add('hidden');
    $('qrHint').textContent = 'WhatsApp → Настройки → Связанные устройства → Привязать устройство. Сканируйте сразу — код обновляется каждые 20с.';
    $('qrStage').classList.remove('hidden');
    $('qrBox').innerHTML = '<span class="muted">получаем QR…</span>';
    currentLoginDevice = r.deviceId;
  } else {
    const phone = $('qrPhone').value.replace(/[^0-9]/g, '');
    if (!phone) { $('qrStart').disabled = false; return; }
    const r = await api.startLoginCode(label, phone, groupId);
    if (r.error) { showAddError(r.error); return; }
    $('qrStage').classList.add('hidden');
    $('codeStage').classList.remove('hidden');
    $('codeBox').textContent = r.code || '…';
    currentLoginDevice = r.deviceId || null;
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
const MONTHS = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
function fmtDay(iso) { return `${+iso.slice(8, 10)} ${MONTHS[+iso.slice(5, 7) - 1]}`; }
function esc(s) { return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

// фаза прогрева → человекочитаемый чип
const PHASE_LABEL = { settle: '⏳ Отлёжка', intra: '🔥 Прогрев внутри страны', boost: '🌍 Буст Европой', ready: '✅ Готов' };
// «Дальше» — что предстоит аккаунту, исходя из фазы (день N−1 буст, N+1 готов)
function nextStatsText(a, acc) {
  const wd = a.warmDays || 10;
  if (a.phase === 'settle') {
    const su = acc && acc.settleUntil;
    const left = (su && su > Date.now()) ? ` · ${fmtDuration(su - Date.now())}` : '';
    return `прогрев начнётся после отлёжки${left}`;
  }
  if (a.phase === 'boost') return `финальный буст · готов на дне ${wd + 1}`;
  if (a.phase === 'ready') return '— готов к работе';
  // intra
  return `буст Европой с дня ${wd - 1}, готов на дне ${wd + 1}`;
}

async function openStats() {
  const s = await api.statsFull();
  const t = s.totals;
  const today = s.history[s.history.length - 1] || { sent: 0, received: 0 };
  const totalMsgs = t.sent + t.received;

  const card = (val, key) => `<div class="stat-card"><div class="sc-val">${val}</div><div class="sc-key">${key}</div></div>`;
  $('statsTotals').innerHTML =
    card(t.connected + ' / ' + t.accounts, 'аккаунтов онлайн') +
    card(today.sent + today.received, 'сообщений сегодня') +
    card(totalMsgs, 'сообщений всего') +
    card(t.running ? 'идёт' : 'стоп', 'прогрев');

  // one clear metric per day: total messages (sent+received)
  const days = s.history.map((h) => ({ date: h.date, total: (h.sent || 0) + (h.received || 0) }));
  const maxDay = Math.max(1, ...days.map((d) => d.total));
  $('statsDaily').innerHTML = days.slice().reverse().map((d) => { // newest day first
    const w = (d.total / maxDay * 100).toFixed(0);
    return `<div class="day-row"><span class="day-date">${fmtDay(d.date)}</span>` +
      `<span class="day-bar"><i style="width:${w}%"></i></span>` +
      `<span class="day-val">${d.total || ''}</span></div>`;
  }).join('');

  // per-account: карточки прогресса «что сделано / что будет»
  $('statsPerAccount').innerHTML = s.perAccount.length
    ? s.perAccount.map((a) => {
      const acc = accountsCache.find((x) => x.deviceId === a.deviceId) || {};
      const gid = acc.groupId || 'ua';
      const phone = acc.phone ? '+' + acc.phone : '';
      const wd = a.warmDays || 10;
      const day = a.day ?? a.days ?? 1;
      const pct = Math.max(0, Math.min(100, (day / Math.max(1, wd)) * 100)).toFixed(0);
      const phase = a.phase || 'intra';
      return `<div class="sa-card">
        <div class="sa-top">
          <span class="group-badge grp-${gid}">${esc(groupLabel(gid))}</span>
          <span class="sa-name">${esc(a.label)}</span>
          <span class="sa-phone muted small">${esc(phone)}</span>
          <span class="phase-chip phase-${phase}">${PHASE_LABEL[phase] || phase}</span>
        </div>
        <div class="sa-progress">
          <span class="sa-day small">День ${day}/${wd}</span>
          <span class="progress-bar"><i style="width:${pct}%"></i></span>
        </div>
        <div class="sa-metrics small">
          <span>сегодня ${a.sentToday ?? 0}/${a.capToday ?? 0}</span>
          <span>чатов ${a.chats ?? 0}/${a.plannedPartners ?? 0}</span>
          <span>↑${a.sent ?? 0} ↓${a.received ?? 0}</span>
        </div>
        <div class="sa-next small"><span class="muted">Дальше:</span> ${esc(nextStatsText(a, acc))}</div>
      </div>`;
    }).join('')
    : '<div class="muted small">нет данных</div>';

  $('statsModal').classList.remove('hidden');
}
$('statsBtn').onclick = openStats;
$('statsClose').onclick = () => $('statsModal').classList.add('hidden');
$('helpBtn').onclick = async () => {
  $('helpModal').classList.remove('hidden');
  $('copyDataStatus').textContent = '';
  try { $('dataPath').textContent = await api.dataPath(); } catch { /* ignore */ }
};
$('helpClose').onclick = () => $('helpModal').classList.add('hidden');
// Панель может работать на удалённом сервере — из браузера нельзя открыть папку.
// Вместо этого копируем путь в буфер обмена и показываем подтверждение.
async function copyDataPath(statusEl) {
  let path = '';
  try { path = await api.dataPath(); } catch { /* ignore */ }
  if (!path) return;
  try {
    await navigator.clipboard.writeText(path);
    if (statusEl) { statusEl.textContent = '✓ путь скопирован'; setTimeout(() => { if (statusEl.textContent === '✓ путь скопирован') statusEl.textContent = ''; }, 2500); }
    appendLog({ ts: Date.now(), tag: 'app', level: 'info', msg: 'путь к данным скопирован в буфер' });
  } catch {
    if (statusEl) statusEl.textContent = path; // fallback: покажем путь для ручного копирования
    appendLog({ ts: Date.now(), tag: 'app', level: 'warn', msg: `не удалось скопировать; путь: ${path}` });
  }
}
$('copyDataBtn').onclick = () => copyDataPath($('copyDataStatus'));
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
    `сообщ: ${c.messages} · ссыл: ${c.links} · карт: ${c.images} · голос: ${c.voice ?? 0}`;
}
async function refreshContent() { renderCounts(await api.contentCounts()); }
// 📂 → копирование пути к данным (нет открытия папки в браузере)
$('openContent').onclick = () => copyDataPath(null);
$('reloadContent').onclick = async () => renderCounts(await api.contentReload());
$('addImages').onclick = async () => renderCounts(await api.contentAddImages());

// Движков теперь пул (по одному на страну-группу). gowa.info() отдаёт МАССИВ
// [{id,ready,port},...], а события gowa:state приходят по одной группе
// {groupId,ready}. Держим карту готовности per-group и агрегируем: Старт
// разрешён, пока жив хотя бы один движок, — упавший aux не должен блокировать
// прогрев, если основной (ua) поднят.
const gowaEngines = new Map(); // groupId -> ready(bool)

function recomputeGowa() {
  const total = gowaEngines.size;
  const ready = [...gowaEngines.values()].filter(Boolean).length;
  gowaReady = total > 0 && ready > 0;
  const dot = $('gowaDot');
  const txt = $('gowaText');
  if (total === 0) { dot.className = 'dot dot-off'; txt.textContent = 'движок: запуск…'; }
  else if (ready === total) { dot.className = 'dot dot-on'; txt.textContent = `движок: готов (${ready}/${total})`; }
  else if (ready > 0) { dot.className = 'dot dot-warn'; txt.textContent = `движок: ${ready}/${total}`; }
  else { dot.className = 'dot dot-err'; txt.textContent = 'движок: запуск…'; }
  refreshAccounts();
}

// seed из gowa.info() (массив)
function seedGowa(list) {
  gowaEngines.clear();
  if (Array.isArray(list)) for (const e of list) gowaEngines.set(e.id, !!e.ready);
  recomputeGowa();
}

// событие по одной группе {groupId, ready}
function setGowa(s) {
  if (s && s.groupId) gowaEngines.set(s.groupId, !!s.ready);
  recomputeGowa();
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
  await loadGroups();
  await refreshContent();
  await refreshAccounts();
  try {
    const g = await api.gowaStatus(); // массив [{id,ready,port},...]
    seedGowa(g);
  } catch { /* ignore */ }
  const hist = await api.logHistory();
  hist.forEach((l) => appendLog(l));
})();
})();
