'use strict';

// Точка входа headless-панели: HTTP+WS сервер на Fastify, заменяющий Electron-
// окно и IPC. Поднимает cookie/статику/websocket, вешает REST-роуты (httpApi),
// широковещает события ядра через WebSocket (wsBridge) и запускает ядро
// приложения (core/boot). Слушает 0.0.0.0:WA_PANEL_PORT (деф. 8760).
//
// buildApp(ctx) — тестируемая фабрика: возвращает сконфигурированный Fastify
// (cookie + multipart + REST) БЕЗ статики/ws/boot/listen, чтобы тесты гоняли
// app.inject() с поддельным ctx и без спавна GOWA.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Fastify = require('fastify');
const cookie = require('@fastify/cookie');
const multipart = require('@fastify/multipart');
const auth = require('./auth');
const httpApi = require('./httpApi');

// ---- панельный конфиг (пароль + секрет куки) -----------------------------
// Хранится в panel.json под папкой данных, режим 0600. При первом старте, если
// файла нет, берём пароль из WA_PANEL_PASSWORD, хешируем и пишем вместе со
// случайным секретом для подписи cookie.
function loadOrInitPanel(paths, log) {
  const file = path.join(paths.dataDir(), 'panel.json');
  if (fs.existsSync(file)) {
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!cfg.cookieSecret) {
      cfg.cookieSecret = crypto.randomBytes(32).toString('hex');
      writePanel(file, cfg);
    }
    return cfg;
  }
  const pw = process.env.WA_PANEL_PASSWORD;
  if (!pw || !pw.trim()) {
    throw new Error('Первый запуск: задайте пароль панели в переменной окружения WA_PANEL_PASSWORD');
  }
  const cfg = {
    passwordHash: auth.hashPassword(pw),
    cookieSecret: crypto.randomBytes(32).toString('hex'),
  };
  writePanel(file, cfg);
  if (log) log.info('server', `panel.json создан: ${file}`);
  return cfg;
}

function writePanel(file, cfg) {
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* ignore (напр. Windows) */ }
}

// ---- тестируемая фабрика приложения --------------------------------------
async function buildApp(ctx) {
  const app = Fastify({ logger: false, bodyLimit: 20 * 1024 * 1024 });
  await app.register(cookie, { secret: ctx.cookieSecret });
  await app.register(multipart, { limits: { fileSize: 20 * 1024 * 1024 } });
  httpApi.register(app, ctx);
  return app;
}

// ---- полный сервер (статика + ws + boot + listen) ------------------------
async function start() {
  // Ленивая загрузка ядра — чтобы buildApp/тесты не тянули electron-зависимую
  // цепочку и не спавнили движки.
  const paths = require('../main/paths');
  const store = require('../main/accountStore');
  const client = require('../main/gowaClient');
  const loginFlow = require('../main/loginFlow');
  const scheduler = require('../main/scheduler');
  const gowa = require('../main/gowaManager');
  const content = require('../main/contentPack');
  const proxyTest = require('../main/proxyTest');
  const log = require('../main/logbus');
  const core = require('../core/boot');

  const panel = loadOrInitPanel(paths, log);

  const staticPlugin = require('@fastify/static');
  const websocket = require('@fastify/websocket');
  const wsBridge = require('./wsBridge');

  const ctx = {
    store, client, loginFlow, scheduler, gowa, content, paths, proxyTest, log,
    accountsView: core.accountsView,
    cookieSecret: panel.cookieSecret,
    auth: { passwordHash: panel.passwordHash },
  };

  const app = await buildApp(ctx);
  await app.register(websocket);

  // WebSocket-мост: emit прокидывается в ядро как событийный сток.
  const bridge = wsBridge.attach(app);
  ctx.broadcast = bridge.emit; // httpApi разделяет тот же emit после регистрации

  // Гейт статики: неаутентифицированный доступ к страницам панели → /login.html.
  // Публичны только login.html + стили (для самой страницы входа). /api/* и /ws
  // проверяют сессию сами.
  const PUBLIC = new Set(['/login.html', '/styles.css', '/favicon.ico']);
  app.addHook('onRequest', async (req, reply) => {
    const url = (req.raw.url || '/').split('?')[0];
    if (url.startsWith('/api/') || url === '/ws' || PUBLIC.has(url)) return;
    const raw = req.cookies && req.cookies[auth.SESSION_COOKIE];
    const un = raw ? req.unsignCookie(raw) : { valid: false };
    if (!un.valid || un.value !== auth.SESSION_VALUE) {
      return reply.redirect('/login.html');
    }
    return undefined;
  });

  await app.register(staticPlugin, {
    root: path.join(__dirname, '..', 'renderer'),
    prefix: '/',
  });

  // Сначала открываем порт — панель должна быть доступна сразу, не дожидаясь
  // готовности движков (startAll ждёт readiness каждой группы до 20с).
  const port = Number(process.env.WA_PANEL_PORT) || 8760;
  await app.listen({ host: '0.0.0.0', port });
  log.info('server', `панель доступна на http://0.0.0.0:${port}`);

  // Запуск ядра в фоне: события ядра уходят в панель через WebSocket.
  core.boot({ emit: bridge.emit }).catch((e) => log.error('server', `boot failed: ${e.message}`));

  const stop = async () => {
    try { await core.shutdown(); } catch { /* ignore */ }
    try { await app.close(); } catch { /* ignore */ }
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  return app;
}

module.exports = { buildApp, start, loadOrInitPanel };

// Запуск как самостоятельного процесса.
if (require.main === module) {
  start().catch((e) => {
    // eslint-disable-next-line no-console
    console.error('server start failed:', e.message);
    process.exit(1);
  });
}
