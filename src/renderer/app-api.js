'use strict';

// Браузерный shim для window.api: воспроизводит поверхность Electron-preload
// (src/preload/preload.js), но поверх REST (fetch) и одного общего WebSocket.
// Имена методов и on*-подписок совпадают 1:1 с preload.js, поэтому app.js
// работает без изменений сигнатур (кроме новых per-group методов). Все запросы
// идут на тот же origin (credentials:'same-origin' — подписанная кука сессии).

(() => {
  // ---- REST-помощники ------------------------------------------------------
  async function getJson(url) {
    const res = await fetch(url, { credentials: 'same-origin' });
    if (res.status === 401) { window.location.href = '/login.html'; return {}; }
    return res.json();
  }
  async function postJson(url, body) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
      credentials: 'same-origin',
    });
    if (res.status === 401) { window.location.href = '/login.html'; return {}; }
    // 4xx с JSON-ошибкой тоже возвращаем как объект {error:…} — app.js это ждёт
    try { return await res.json(); } catch { return { ok: res.ok }; }
  }

  // ---- определение группы по префиксу номера (клиентская копия таблицы) -----
  // Дублирует src/main/groups.js: +380→ua, +49→de, +48→pl, +44→uk.
  const PREFIX_TO_GROUP = [['380', 'ua'], ['49', 'de'], ['48', 'pl'], ['44', 'uk']];
  function detectGroup(phone) {
    const d = String(phone || '').replace(/[^0-9]/g, '');
    for (const [pfx, id] of PREFIX_TO_GROUP) if (d.startsWith(pfx)) return id;
    return null;
  }

  // ---- скачивание файла (замена нативного диалога сохранения) ---------------
  function triggerDownload(url) {
    const a = document.createElement('a');
    a.href = url;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  // ---- выбор файлов для загрузки (замена нативного диалога Electron) --------
  function pickAndUploadImages(url) {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.multiple = true;
      input.style.display = 'none';
      document.body.appendChild(input);
      input.onchange = async () => {
        const files = [...(input.files || [])];
        input.remove();
        if (!files.length) { resolve(await getJson('/api/content/counts')); return; }
        const fd = new FormData();
        for (const f of files) fd.append('images', f, f.name);
        const res = await fetch(url, { method: 'POST', body: fd, credentials: 'same-origin' });
        try { resolve(await res.json()); } catch { resolve({}); }
      };
      // если пользователь закрыл диалог без выбора — вернём текущие счётчики
      window.addEventListener('focus', function once() {
        window.removeEventListener('focus', once);
        setTimeout(() => { if (document.body.contains(input)) { input.remove(); getJson('/api/content/counts').then(resolve); } }, 400);
      });
      input.click();
    });
  }

  // ---- единый WebSocket с диспетчеризацией по каналу ------------------------
  const listeners = new Map(); // channel -> Set<fn>
  let ws = null;
  let reconnectTimer = null;

  function dispatch(channel, payload) {
    const set = listeners.get(channel);
    if (set) for (const fn of set) { try { fn(payload); } catch { /* игнор ошибок обработчика */ } }
  }

  function connect() {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${window.location.host}/ws`);
    ws.onmessage = (ev) => {
      try {
        const { channel, payload } = JSON.parse(ev.data);
        dispatch(channel, payload);
      } catch { /* игнор невалидных кадров */ }
    };
    ws.onclose = () => {
      ws = null;
      if (!reconnectTimer) reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, 2000);
    };
    ws.onerror = () => { try { ws.close(); } catch { /* ignore */ } };
  }
  connect();

  function on(channel, fn) {
    let set = listeners.get(channel);
    if (!set) { set = new Set(); listeners.set(channel, set); }
    set.add(fn);
    return () => set.delete(fn); // отписка — как в preload
  }

  // ---- поверхность window.api ---------------------------------------------
  window.api = {
    // invoke (renderer -> REST)
    listAccounts: () => getJson('/api/accounts'),
    startLogin: (label, groupId) => postJson('/api/login/start', { label, groupId }),
    startLoginCode: (label, phone, groupId) => postJson('/api/login/start-code', { label, phone, groupId }),
    bulkLoginCode: (phones, prefix) => postJson('/api/login/bulk-code', { phones, prefix }),
    refreshQr: (deviceId) => postJson('/api/login/refresh-qr', { deviceId }),
    cancelLogin: (deviceId) => postJson('/api/login/cancel', { deviceId }),
    renameAccount: (deviceId, label) => postJson('/api/account/rename', { deviceId, label }),
    setAccountPaused: (deviceId, paused) => postJson('/api/account/set-paused', { deviceId, paused }),
    setAccountGroup: (deviceId, groupId) => postJson('/api/account/set-group', { deviceId, groupId }),
    reconnectAccount: (deviceId) => postJson('/api/account/reconnect', { deviceId }),
    logoutAccount: (deviceId) => postJson('/api/account/logout', { deviceId }),
    startWarming: (config) => postJson('/api/warming/start', { config }),
    stopWarming: () => postJson('/api/warming/stop', {}),
    getConfig: () => getJson('/api/config'),
    setConfig: (config) => postJson('/api/config', { config }),
    getStats: () => getJson('/api/stats/full'), // нет warming:stats — единый источник stats/full
    statsFull: () => getJson('/api/stats/full'),
    statsExportCsv: () => { triggerDownload('/api/stats/export-csv'); return Promise.resolve({ ok: true }); },

    // ---- группы (per-group прокси) — заменяют старое одно-прокси поле ----
    getGroups: () => getJson('/api/groups'),
    saveGroups: (groups) => postJson('/api/groups', { groups }),
    testProxy: (proxy) => postJson('/api/proxy/test', { proxy }),
    detectGroup, // клиентский помощник — автозаполнение группы по номеру
    // Совместимость со старыми одно-прокси вызовами (на случай, если где-то остались):
    getProxy: async () => { const g = await getJson('/api/groups'); return { proxy: (g[0] && g[0].proxy) || '' }; },
    applyProxy: async (proxy) => {
      const groups = await getJson('/api/groups');
      if (groups[0]) groups[0].proxy = proxy || '';
      return postJson('/api/groups', { groups });
    },

    gowaStatus: () => getJson('/api/gowa/status'),
    logHistory: () => getJson('/api/log/history'),
    dataPath: async () => (await getJson('/api/data/path')).path, // строка, как в Electron
    openDataFolder: () => {}, // нет нативной ФС в браузере — no-op

    contentCounts: () => getJson('/api/content/counts'),
    contentReload: () => postJson('/api/content/reload', {}),
    contentOpenFolder: () => {}, // no-op в браузере
    contentAddImages: () => pickAndUploadImages('/api/content/add-images'),

    // events (WS -> renderer); каждый возвращает функцию-отписку
    onQr: (fn) => on('login:qr', fn),
    onCode: (fn) => on('login:code', fn),
    onLoginSuccess: (fn) => on('login:success', fn),
    onLoginTimeout: (fn) => on('login:timeout', fn),
    onLoginCancel: (fn) => on('login:cancel', fn),
    onAccountsUpdated: (fn) => on('accounts:updated', fn),
    onLogLine: (fn) => on('log:line', fn),
    onWarmingTick: (fn) => on('warming:tick', fn),
    onWarmingState: (fn) => on('warming:state', fn),
    onGowaState: (fn) => on('gowa:state', fn),
    onLoggedOut: (fn) => on('account:loggedOut', fn),
  };
})();
