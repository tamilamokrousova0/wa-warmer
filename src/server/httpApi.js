'use strict';

// REST-роуты панели, зеркалящие 1:1 бывшие ipcMain.handle из src/main/ipc.js.
// Всё под requireSession, кроме /api/login-panel и /api/logout-panel. Мутации,
// которые раньше слали в renderer 'accounts:updated', здесь широковещают то же
// событие через ctx.broadcast (WebSocket). Electron-специфика (нативные диалоги
// сохранения/выбора файлов, открытие папок) заменена на download/upload/возврат
// пути — семантика хендлеров сохранена.

const path = require('node:path');
const fs = require('node:fs');
const auth = require('./auth');

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);

/**
 * Регистрирует все REST-роуты на переданном Fastify-инстансе.
 * @param {import('fastify').FastifyInstance} app
 * @param {object} ctx  ядро приложения: store, client, loginFlow, scheduler,
 *   gowa, content, paths, proxyTest, log, accountsView, broadcast, auth{passwordHash}.
 */
function register(app, ctx) {
  const {
    store, client, loginFlow, scheduler, gowa, content, paths, proxyTest, log,
    accountsView, broadcast,
  } = ctx;

  const emit = typeof broadcast === 'function' ? broadcast : () => {};
  const pushAccounts = () => emit('accounts:updated', accountsView());

  // rate-limiter попыток входа по IP (общий на весь процесс сервера)
  const loginLimiter = auth.rateLimiter();

  const requireSession = { preHandler: auth.requireSession };

  // ---- аутентификация панели (без сессии) --------------------------------
  app.post('/api/login-panel', async (req, reply) => {
    const ip = req.ip || 'unknown';
    const gate = loginLimiter.check(ip);
    if (!gate.allowed) {
      return reply.code(429).send({ error: 'too_many_attempts', retryAfterMs: gate.retryAfterMs });
    }
    const password = req.body && req.body.password;
    const stored = ctx.auth && ctx.auth.passwordHash;
    if (stored && auth.verifyPassword(String(password || ''), stored)) {
      loginLimiter.reset(ip);
      reply.setCookie(auth.SESSION_COOKIE, auth.SESSION_VALUE, auth.sessionCookieOptions());
      return { ok: true };
    }
    loginLimiter.fail(ip);
    return reply.code(401).send({ error: 'invalid_password' });
  });

  app.post('/api/logout-panel', async (_req, reply) => {
    reply.clearCookie(auth.SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  // ---- аккаунты и логин-флоу ---------------------------------------------
  app.get('/api/accounts', requireSession, async () => accountsView());

  app.post('/api/login/start', requireSession, async (req) => {
    const { label, groupId } = req.body || {};
    const r = await loginFlow.startLogin(label, groupId);
    pushAccounts();
    return r;
  });

  app.post('/api/login/start-code', requireSession, async (req) => {
    const { label, phone, groupId } = req.body || {};
    const r = await loginFlow.startLoginWithCode(label, phone, groupId);
    pushAccounts();
    return r;
  });

  app.post('/api/login/bulk-code', requireSession, async (req) => {
    const { phones = [], prefix } = req.body || {};
    const out = [];
    let i = 0;
    for (const phone of phones) {
      i += 1;
      const label = store.uniqueLabel(`${prefix || 'Аккаунт'} ${i}`); // избегаем дубля имён
      const r = await loginFlow.startLoginWithCode(label, phone); // eslint-disable-line no-await-in-loop
      out.push({ phone, code: r.code || null, deviceId: r.deviceId || null, error: r.error || null });
      pushAccounts();
    }
    return out;
  });

  app.post('/api/login/refresh-qr', requireSession, async (req) => {
    const { deviceId } = req.body || {};
    return { ok: await loginFlow.forceRefresh(deviceId) };
  });

  app.post('/api/login/cancel', requireSession, async (req) => {
    const { deviceId } = req.body || {};
    loginFlow.cancel(deviceId);
    return { ok: true };
  });

  // ---- операции над аккаунтом --------------------------------------------
  app.post('/api/account/rename', requireSession, async (req) => {
    const { deviceId, label } = req.body || {};
    const r = store.rename(deviceId, label);
    if (r.ok) pushAccounts();
    return r;
  });

  app.post('/api/account/set-paused', requireSession, async (req) => {
    const { deviceId, paused } = req.body || {};
    store.setPaused(deviceId, paused);
    pushAccounts();
    return { ok: true };
  });

  app.post('/api/account/set-group', requireSession, async (req) => {
    const { deviceId, groupId } = req.body || {};
    store.setGroup(deviceId, groupId);
    pushAccounts();
    return { ok: true };
  });

  app.post('/api/account/reconnect', requireSession, async (req) => {
    const { deviceId } = req.body || {};
    try { await client.reconnect(deviceId); } catch { /* ignore */ }
    await new Promise((r) => setTimeout(r, 1800));
    let loggedIn = false; let jid; let phone;
    try {
      const st = await client.status(deviceId);
      const r = st.results || st;
      loggedIn = !!r.is_logged_in;
      jid = r.jid;
      phone = r.jid ? String(r.jid).split('@')[0].split(':')[0] : undefined;
    } catch { /* ignore */ }
    if (loggedIn) {
      store.setConnected(deviceId, true, jid, phone);
      gowa.registerWebhook(deviceId);
      pushAccounts();
      return { connected: true };
    }
    await loginFlow.relogin(deviceId); // сессия потеряна → показать QR для того же устройства
    return { connected: false, relogin: true, deviceId };
  });

  app.post('/api/account/logout', requireSession, async (req) => {
    const { deviceId } = req.body || {};
    try { await client.logout(deviceId); } catch (e) { log.warn('account', `logout error: ${e.message}`); }
    try { await client.deleteDevice(deviceId); } catch (e) { log.warn('account', `deleteDevice error: ${e.message}`); }
    store.remove(deviceId);
    pushAccounts();
    return { ok: true };
  });

  // ---- конфиг прогрева ----------------------------------------------------
  app.get('/api/config', requireSession, async () => store.loadConfig());
  app.post('/api/config', requireSession, async (req) => {
    const config = (req.body && req.body.config) || req.body || {};
    return store.saveConfig(config);
  });

  // ---- прогрев ------------------------------------------------------------
  app.post('/api/warming/start', requireSession, async (req) => {
    const config = req.body && req.body.config;
    return scheduler.start(config);
  });
  app.post('/api/warming/stop', requireSession, async () => scheduler.stop());

  // ---- статистика ---------------------------------------------------------
  app.get('/api/stats/full', requireSession, async () => {
    const s = scheduler.stats();
    return {
      totals: { accounts: s.total, connected: s.connected, sent: s.sentTotal, received: s.receivedTotal, running: s.running },
      perAccount: s.perAccount,
      history: store.historyDays(14),
    };
  });

  app.get('/api/stats/export-csv', requireSession, async (_req, reply) => {
    const rows = [['label', 'phone', 'days', 'sent', 'received', 'sentToday', 'cap']];
    for (const a of scheduler.stats().perAccount) {
      const acc = store.get(a.deviceId);
      rows.push([a.label, acc?.phone || '', a.days, a.sent, a.received, a.sentToday, a.cap]);
    }
    const csv = rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
    reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', 'attachment; filename="wa-warmer-stats.csv"');
    return '﻿' + csv; // BOM для корректной кириллицы в Excel
  });

  // ---- группы (per-group прокси) -----------------------------------------
  app.get('/api/groups', requireSession, async () => store.loadConfig().groups || []);

  app.post('/api/groups', requireSession, async (req, reply) => {
    const cfg = store.loadConfig();
    const oldGroups = cfg.groups || [];
    const newGroups = (req.body && req.body.groups) || [];
    if (!Array.isArray(newGroups) || newGroups.length === 0) {
      return reply.code(400).send({ error: 'groups must be a non-empty array' });
    }
    // Валидация прокси до сохранения (пустой прокси допустим = прямое соединение)
    for (const g of newGroups) {
      const px = String(g.proxy || '').trim();
      if (px) {
        const v = proxyTest.validate(px);
        if (v.error) return reply.code(400).send({ error: `${g.id}: ${v.error}` });
      }
    }
    store.saveConfig({ ...cfg, groups: newGroups });
    // Перезапускаем только те движки, у которых сменился прокси
    const changed = [];
    for (const g of newGroups) {
      const old = oldGroups.find((o) => o.id === g.id);
      if (!old || String(old.proxy || '') !== String(g.proxy || '')) changed.push(g.id);
    }
    for (const id of changed) {
      log.info('proxy', `перезапуск движка группы ${id}…`);
      try {
        await gowa.restartGroup(id); // eslint-disable-line no-await-in-loop
      } catch (e) {
        log.error('proxy', `[${id}] перезапуск движка не удался: ${e.message}`);
      }
    }
    return { ok: true, groups: newGroups, restarted: changed };
  });

  // ---- проверка прокси (без применения) ----------------------------------
  app.post('/api/proxy/test', requireSession, async (req) => {
    const { proxy } = req.body || {};
    return proxyTest.testProxy(proxy);
  });

  // ---- контент ------------------------------------------------------------
  app.get('/api/content/counts', requireSession, async () => content.counts());
  app.post('/api/content/reload', requireSession, async () => {
    content.reload();
    return content.counts();
  });

  app.post('/api/content/add-images', requireSession, async (req) => {
    const dir = paths.sharedImagesDir();
    fs.mkdirSync(dir, { recursive: true });
    let saved = 0;
    // @fastify/multipart: перебираем части запроса, сохраняем только картинки
    for await (const part of req.parts()) {
      if (part.type !== 'file') continue;
      const ext = path.extname(part.filename || '').toLowerCase();
      if (!IMAGE_EXT.has(ext)) { part.file.resume(); continue; } // пропускаем не-картинки
      const dest = path.join(dir, path.basename(part.filename));
      try {
        await new Promise((resolve, reject) => {
          const ws = fs.createWriteStream(dest);
          part.file.pipe(ws);
          part.file.on('error', reject);
          ws.on('error', reject);
          ws.on('finish', resolve);
        });
        saved += 1;
      } catch (e) {
        log.warn('content', e.message);
      }
    }
    content.reload();
    return { ...content.counts(), saved };
  });

  // ---- движок / логи / данные --------------------------------------------
  app.get('/api/gowa/status', requireSession, async () => gowa.info());
  app.get('/api/log/history', requireSession, async () => log.history());
  app.get('/api/data/path', requireSession, async () => ({ path: paths.dataDir() }));
}

module.exports = { register };
