'use strict';
// Электрон-независимое ядро запуска и обслуживания приложения. Поднимает пул
// движков GOWA (по одному на страновую группу), выполняет миграцию групп,
// вешает вебхук и периодическое обслуживание соединений. Все события уходят
// через переданный `emit(channel, payload)` — веб-сервер (задача 10) повесит
// его на WebSocket; каналы те же, что раньше слал main.js/ipc.js.
//
// ВАЖНО: этот модуль НЕ должен требовать electron. Он опирается только на
// движковый/сторовый слой (`gowaManager`/`gowaClient`/`accountStore`/…), который
// electron-независим.
const scheduler = require('../main/scheduler');
const content = require('../main/contentPack');
const client = require('../main/gowaClient');
const store = require('../main/accountStore');
const gowa = require('../main/gowaManager');
const webhook = require('../main/webhookServer');
const loginFlow = require('../main/loginFlow');
const paths = require('../main/paths');
const log = require('../main/logbus');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let emit = () => {}; // событийный сток; задаётся в boot()
let maintainTimer = null; // хэндл интервала обслуживания соединений

// Снимок аккаунтов для UI — тот же формат, что раньше отдавал ipc.accountsView().
// Экспортируется, чтобы веб-сервер (задача 10) переиспользовал его для WebSocket.
function accountsView() {
  const cfg = store.loadConfig();
  const settleMs = Math.max(0, cfg.settleHours || 0) * 3600000;
  const reloginMs = Math.max(0, cfg.reloginSettleHours || 0) * 3600000;
  return store.all().map((a) => {
    // отсчёт отлёжки = позднее из двух окон: добавление и (если был) ре-логин
    const addUntil = settleMs && a.addedAt ? a.addedAt + settleMs : 0;
    const reUntil = reloginMs && a.reloggedAt ? a.reloggedAt + reloginMs : 0;
    const day = store.daysWarming(a);
    const phase = scheduler.phaseOf(a, cfg); // единый источник истины (не дублируем логику)
    return {
      deviceId: a.deviceId,
      label: a.label,
      phone: a.phone,
      jid: a.jid,
      groupId: a.groupId || 'ua',   // страновая группа аккаунта (для бейджа в UI)
      ready: !!a.ready,             // «прогрет» — вышел из ротации (для бейджа в UI)
      connected: !!a.connected,
      sessionLost: !!a.sessionLost,
      paused: !!a.paused,
      skipSettle: !!a.skipSettle, // ручной оверрайд: отлёжка пропущена
      forceBoost: !!a.forceBoost, // ручной оверрайд: форсированный кросс-страна буст
      // при skipSettle отлёжки нет — обнуляем счётчик, чтобы UI не рисовал обратный отсчёт
      settleUntil: a.skipSettle ? 0 : Math.max(addUntil, reUntil),
      busy: scheduler.isBusy(a.deviceId),
      nextSendAt: scheduler.nextActionAt(a.deviceId),
      activeHours: scheduler.inActiveHoursNow(),
      capToday: scheduler.dailyCapFor(a.deviceId),
      capReached: scheduler.isRunning() && store.sentToday(a.deviceId) >= scheduler.dailyCapFor(a.deviceId),
      sentToday: store.sentToday(a.deviceId),
      days: day,
      // расширенные поля для новой карточки прогресса
      day,
      warmDays: cfg.warmDays,
      phase,
      plannedPartners: scheduler.maxPartners(a, cfg, scheduler.connectedInGroup(a)),
      boostActive: !!cfg.crossCountryBoost && scheduler.inBoostWindow(a, cfg) && phase !== 'ready',
      sent: a.sentTotal || 0,
      received: a.receivedTotal || 0,
      chats: (a.partners || []).length,
      addedAt: a.addedAt,
    };
  });
}

// Проверить живой статус каждого аккаунта, обновить store + вебхук + UI.
async function refreshStatuses() {
  for (const a of store.all()) {
    try {
      const st = await client.status(a.deviceId);
      const r = st.results || st;
      const phone = r.jid ? String(r.jid).split('@')[0].split(':')[0] : a.phone;
      store.setConnected(a.deviceId, !!r.is_logged_in, r.jid, phone);
      if (r.is_logged_in) gowa.registerWebhook(a.deviceId);
    } catch {
      store.setConnected(a.deviceId, false);
    }
  }
  emit('accounts:updated', accountsView());
}

// После готовности пула активно восстанавливаем сессии (они поднимаются не сразу),
// затем пару раз обновляем статусы по мере выхода аккаунтов онлайн.
async function reconnectAccounts() {
  for (const a of store.all()) { try { await client.reconnect(a.deviceId); } catch { /* ignore */ } }
  for (const delay of [3000, 5000, 8000]) { await sleep(delay); await refreshStatuses(); }
}

// Слияние per-group списков устройств в один devMap (deviceId → device).
// Чистый помощник — вынесен ради юнит-теста.
function __mergeDeviceMaps(perGroupLists) {
  const devMap = new Map();
  for (const list of perGroupLists || []) {
    for (const d of (list && list.results) || []) devMap.set(d.id, d);
  }
  return devMap;
}

// Периодическое обслуживание: авто-восстановление отвалившихся аккаунтов (были
// онлайн, ушли в оффлайн). Быстрые ретраи, затем мягкий бэк-офф; никогда не
// сдаёмся полностью. Аккаунты, которые ни разу не логинились (нет jid), ждут QR.
const reconnectAttempts = new Map();
async function maintainConnections() {
  // Пул: у каждой группы свой движок → опрашиваем listDevices(gr.id) по группам
  // и сливаем результаты в один devMap. Группа, чей движок недоступен в этом
  // цикле, пропускается целиком (её аккаунты не трогаем — как раньше при
  // недоступном единственном движке), чтобы временный сбой проксей/движка не
  // пометил живые сессии как потерянные.
  const groups = store.loadConfig().groups || [];
  const perGroupLists = [];
  const reachable = new Set(); // группы, чей движок ответил в этом цикле
  for (const gr of groups) {
    try {
      const list = await client.listDevices(gr.id);
      perGroupLists.push(list);
      reachable.add(gr.id);
    } catch {
      // движок этой группы не поднят/недоступен — пропускаем группу, продолжаем
    }
  }
  const devMap = __mergeDeviceMaps(perGroupLists);

  for (const a of store.all()) {
    if (!reachable.has(a.groupId || 'ua')) continue; // движок группы недоступен → не трогаем

    const dev = devMap.get(a.deviceId);
    const loggedIn = !!dev && dev.state === 'logged_in';
    const hasSession = !!dev && (!!dev.jid || loggedIn);

    if (a.paused) {
      // ручное удержание: отражаем статус для отображения, но не переподключаем
      reconnectAttempts.delete(a.deviceId);
      store.setConnected(a.deviceId, loggedIn, dev?.jid || a.jid, a.phone);
      continue;
    }

    if (loggedIn) {
      reconnectAttempts.delete(a.deviceId);
      const phone = dev.jid ? String(dev.jid).split('@')[0].split(':')[0] : a.phone;
      if (!a.connected) log.info('account', `аккаунт "${a.label}" онлайн`);
      store.setConnected(a.deviceId, true, dev.jid || a.jid, phone);
      gowa.registerWebhook(a.deviceId);
      continue;
    }

    if (!a.jid) { store.setConnected(a.deviceId, false); continue; } // ни разу не залогинен → нужен QR

    if (a.jid && !hasSession) {
      // у аккаунта была сессия, но движок её больше не держит → сессия потеряна.
      // Сначала пара переподключений (грация на медленное восстановление), затем метка.
      const tries = reconnectAttempts.get(a.deviceId) || 0;
      reconnectAttempts.set(a.deviceId, tries + 1);
      store.setConnected(a.deviceId, false);
      if (tries < 2) { try { await client.reconnect(a.deviceId); } catch { /* ignore */ } }
      else {
        store.setSessionLost(a.deviceId, true);
        if (tries === 2) log.warn('account', `аккаунт "${a.label}": сессия потеряна в движке — нужен ре-логин`);
      }
      continue;
    }

    // есть валидная сессия, но сокет упал → восстановимо: ретраи с бэк-оффом
    store.setConnected(a.deviceId, false);
    store.setSessionLost(a.deviceId, false);
    const tries = reconnectAttempts.get(a.deviceId) || 0;
    reconnectAttempts.set(a.deviceId, tries + 1);
    if (tries > 8 && tries % 10 !== 0) continue;
    try { await client.reconnect(a.deviceId); } catch { /* ignore */ }
  }
  emit('accounts:updated', accountsView());
}

// Реакция на реально доставленные входящие (best-effort; форма payload разнится).
function handleInbound(data) {
  try {
    const p = (data && (data.payload || data.results)) || data || {};
    const deviceId = data.device_id || data.deviceId || p.device_id;
    const fromMe = p.from_me ?? p.fromMe ?? data.from_me;
    const from = p.from || p.chat_id || p.sender || data.from || '';
    const messageId = p.id || p.message_id || (p.message && p.message.id) || data.message_id;
    if (fromMe || !deviceId || !messageId || !from) return;
    log.info('webhook', `📨 входящее для ${String(deviceId).slice(0, 8)} от ${String(from).split('@')[0]}`);
    if (!scheduler.isRunning()) return;
    client.markRead(deviceId, messageId, from).catch(() => {});
  } catch { /* ignore malformed */ }
}

// Запуск приложения без Electron. `emit(channel, payload)` — событийный сток.
async function boot({ emit: sink } = {}) {
  emit = typeof sink === 'function' ? sink : () => {};

  log.info('app', `папка данных: ${paths.dataDir()}`);
  content.ensure(); // создаёт data/content-pack/ с пустыми messages.txt/links.txt/images/
  store.migrateGroups(); // ДО старта движков: гарантирует группы в конфиге и groupId у аккаунтов

  // события планировщика/вебхука — как в main.js, но через emit
  scheduler.events.on('loggedOut', ({ label }) => {
    emit('notify', {
      title: 'WA Warmer — аккаунт отключён',
      body: `"${label}" вышел из сети (возможен logout или бан).`,
    });
  });
  webhook.events.on('inbound', handleInbound);

  // проброс событий на веб-панель по WS — те же каналы и формы payload, что
  // раньше слал ipc.js (секция «main -> renderer»). Без этого в браузере не
  // появляется QR при добавлении, пуст живой лог и не идут апдейты прогрева.
  log.on((line) => emit('log:line', line));

  loginFlow.events.on('qr', (p) => emit('login:qr', p));
  loginFlow.events.on('code', (p) => emit('login:code', p));
  loginFlow.events.on('success', (p) => { emit('login:success', p); emit('accounts:updated', accountsView()); });
  loginFlow.events.on('timeout', (p) => emit('login:timeout', p));
  loginFlow.events.on('cancel', (p) => emit('login:cancel', p));

  scheduler.events.on('tick', (p) => emit('warming:tick', p));
  scheduler.events.on('state', (p) => emit('warming:state', p));
  scheduler.events.on('accountsChanged', () => emit('accounts:updated', accountsView()));
  scheduler.events.on('loggedOut', (p) => { emit('account:loggedOut', p); emit('accounts:updated', accountsView()); });

  gowa.state.on('state', (p) => emit('gowa:state', p));

  try {
    await gowa.startAll();
    await reconnectAccounts();
    // периодическое обслуживание: авто-восстановление отвалившихся + свежий статус
    maintainTimer = setInterval(() => { maintainConnections().catch(() => {}); }, 30000);
  } catch (e) {
    log.error('gowa', `failed to start engine: ${e.message}`);
  }
}

// Корректное завершение: остановить обслуживание, планировщик и весь пул движков.
async function shutdown() {
  if (maintainTimer) { clearInterval(maintainTimer); maintainTimer = null; }
  try { scheduler.stop(); } catch { /* ignore */ }
  try { await gowa.stopAll(); } catch { /* ignore */ }
}

module.exports = {
  boot,
  shutdown,
  accountsView,
  // тестовые/внутренние сеймы
  refreshStatuses,
  reconnectAccounts,
  maintainConnections,
  handleInbound,
  __mergeDeviceMaps,
};
