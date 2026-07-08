'use strict';

// Тесты REST-панели через app.inject() — без реальной сети и без GOWA.
// Поднимаем app из тестируемой фабрики buildApp(ctx) с поддельным ctx: роуты,
// которые дёргаем, трогают только store/accountsView-фейки, движки не спавнятся.

const { test } = require('node:test');
const assert = require('node:assert');
const { buildApp, loadOrInitPanel } = require('../src/server/server.js');
const auth = require('../src/server/auth.js');

const PASSWORD = 'panel-secret-42!';

// Минимальный поддельный ctx: только то, что нужно проверяемым роутам.
function fakeCtx() {
  const accounts = [{ deviceId: 'dev-1', label: 'Acc 1', phone: '380001' }];
  return {
    cookieSecret: 'test-cookie-secret-0123456789',
    auth: { passwordHash: auth.hashPassword(PASSWORD) },
    accountsView: () => accounts.slice(),
    broadcast: () => {},
    // модули-заглушки на случай, если роут их коснётся
    store: {
      loadConfig: () => ({ groups: [{ id: 'ua', proxy: '' }] }),
      saveConfig: (c) => c,
      historyDays: () => [],
      get: () => null,
      uniqueLabel: (b) => b,
    },
    scheduler: { stats: () => ({ total: 1, connected: 0, sentTotal: 0, receivedTotal: 0, running: false, perAccount: [] }) },
    content: { counts: () => ({ messages: 0, links: 0, images: 0, voice: 0 }), reload: () => {} },
    paths: { dataDir: () => '/tmp/wa', sharedImagesDir: () => '/tmp/wa/images' },
    gowa: { info: () => [] },
    log: { history: () => [], info: () => {}, warn: () => {}, error: () => {} },
    proxyTest: { validate: () => ({ proxy: 'x' }), testProxy: async () => ({ ok: true }) },
    client: {}, loginFlow: {},
  };
}

async function makeApp() {
  const app = await buildApp(fakeCtx());
  await app.ready();
  return app;
}

// --- сессия / доступ -------------------------------------------------------

test('GET /api/accounts без сессионной куки → 401', async () => {
  const app = await makeApp();
  const res = await app.inject({ method: 'GET', url: '/api/accounts' });
  assert.strictEqual(res.statusCode, 401);
  await app.close();
});

test('POST /api/login-panel с верным паролем → 200 и ставит куку', async () => {
  const app = await makeApp();
  const res = await app.inject({
    method: 'POST', url: '/api/login-panel',
    payload: { password: PASSWORD },
  });
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(res.json(), { ok: true });
  const setCookie = res.headers['set-cookie'];
  assert.ok(setCookie && String(setCookie).includes(auth.SESSION_COOKIE), 'set-cookie содержит сессионную куку');
  assert.ok(String(setCookie).toLowerCase().includes('httponly'), 'кука httpOnly');
  await app.close();
});

test('логин → GET /api/accounts с кукой → 200 и JSON-массив', async () => {
  const app = await makeApp();
  const login = await app.inject({
    method: 'POST', url: '/api/login-panel', payload: { password: PASSWORD },
  });
  const cookie = login.cookies.find((c) => c.name === auth.SESSION_COOKIE);
  assert.ok(cookie, 'сессионная кука выдана');

  const res = await app.inject({
    method: 'GET', url: '/api/accounts',
    cookies: { [auth.SESSION_COOKIE]: cookie.value },
  });
  assert.strictEqual(res.statusCode, 200);
  const body = res.json();
  assert.ok(Array.isArray(body), 'ответ — массив');
  assert.strictEqual(body[0].deviceId, 'dev-1');
  await app.close();
});

test('неверный пароль → 401', async () => {
  const app = await makeApp();
  const res = await app.inject({
    method: 'POST', url: '/api/login-panel', payload: { password: 'wrong' },
  });
  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(res.json().error, 'invalid_password');
  await app.close();
});

test('повторные неверные пароли в итоге упираются в rate-limit (429)', async () => {
  const app = await makeApp();
  let sawLimit = false;
  // дефолт: 5 попыток в окне → 6-я и далее блокируются
  for (let i = 0; i < 8; i++) {
    // eslint-disable-next-line no-await-in-loop
    const res = await app.inject({
      method: 'POST', url: '/api/login-panel', payload: { password: 'wrong' },
    });
    if (res.statusCode === 429) { sawLimit = true; break; }
  }
  assert.ok(sawLimit, 'после нескольких неудач получаем 429');
  await app.close();
});

test('POST /api/logout-panel очищает куку', async () => {
  const app = await makeApp();
  const res = await app.inject({ method: 'POST', url: '/api/logout-panel' });
  assert.strictEqual(res.statusCode, 200);
  const setCookie = String(res.headers['set-cookie'] || '');
  assert.ok(setCookie.includes(auth.SESSION_COOKIE), 'clearCookie шлёт заголовок для сессионной куки');
  await app.close();
});

// --- loadOrInitPanel (первый запуск) --------------------------------------

test('loadOrInitPanel создаёт panel.json из WA_PANEL_PASSWORD и переиспользует его', async () => {
  const os = require('node:os');
  const fs = require('node:fs');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-panel-'));
  const paths = { dataDir: () => dir };
  const prev = process.env.WA_PANEL_PASSWORD;
  process.env.WA_PANEL_PASSWORD = 'first-run-pw';
  try {
    const cfg1 = loadOrInitPanel(paths, null);
    assert.ok(cfg1.passwordHash && cfg1.cookieSecret, 'создан хеш и секрет');
    assert.ok(auth.verifyPassword('first-run-pw', cfg1.passwordHash), 'хеш валиден');
    // второй вызов — читает существующий файл, секрет не меняется
    const cfg2 = loadOrInitPanel(paths, null);
    assert.strictEqual(cfg2.cookieSecret, cfg1.cookieSecret);
  } finally {
    if (prev === undefined) delete process.env.WA_PANEL_PASSWORD;
    else process.env.WA_PANEL_PASSWORD = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
