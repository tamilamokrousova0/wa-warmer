# Мульти-прокси группы + веб-панель — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Превратить одно-процессный Electron-прогреватель в headless серверное приложение с пулом процессов GOWA по странам-группам, страна-центричной 10-дневной логикой прогрева и веб-панелью за Tailscale.

**Architecture:** Ядро отвязывается от Electron и запускается под чистым Node. `gowaManager` становится пулом (по процессу GOWA на группу-страну, у каждого свой прокси/порт/база сессий); `engineRouter` маршрутизирует `deviceId → группа → движок`. `scheduler` подбирает пары по стране с европейским бустом в дни 9–10. UI отдаётся Fastify-сервером (REST 1:1 к нынешним IPC + WebSocket), доступ — Tailscale + пароль.

**Tech Stack:** Node ≥ 20, Fastify (+ `@fastify/static`, `@fastify/websocket`, `@fastify/cookie`), встроенный `node:test`, GOWA (собирается из исходников через `build-gowa`), Go ≥ 1.25 (только для сборки движка).

## Global Constraints

- Движок GOWA — сборка из исходников с прокси (`build-gowa`, `-tags purego`), не релиз.
- 4 фиксированные группы-страны: `ua` (primary), `de`, `pl`, `uk` (aux). Автоопределение по префиксу: `+380→ua`, `+49→de`, `+48→pl`, `+44→uk`.
- Один прокси на группу; смена прокси перезапускает процесс группы.
- Миграция: все существующие аккаунты → группа `ua`, переиспользуют существующую `data/gowa/whatsapp.db` → **релогина нет**; `accounts.json`/`stats.json` сохраняются.
- Цикл прогрева 10 дней; ramp сообщений `2,3,4,6,7,9,10,10,10,10`; партнёры `1 + floor((день−1)/2)`; дни 1–8 UA↔UA, дни 9–10 + один EU-партнёр на немецком; день 10 → `ready`, выход из ротации.
- Язык по паре: UA↔UA укр., DE↔DE нем., PL↔PL польск., EN↔EN англ., любая смешанная пара → немецкий.
- Контент: `content-pack/<groupId>/messages.txt`+`links.txt`, медиа общие в `content-pack/shared/`.
- Доступ: Tailscale + один пароль (scrypt-хеш, httpOnly-кука, rate-limit). Никаких новых секретов в git.
- Активные часы — общие для всех; язык кода — английский, UI/логи — русский (как в репозитории).
- Все новые зависимости — только рантайм-сервера (Fastify); ядро прогрева новых npm-зависимостей не тянет.

---

## Файловая структура

Новые:
- `src/main/groups.js` — модель групп: дефолты, префикс→группа, валидация, доступ к группе аккаунта.
- `src/main/engineRouter.js` — `deviceId → engine(baseUrl+auth)` и `groupEngine(groupId)`.
- `src/core/boot.js` — переиспользуемая boot-последовательность (без Electron).
- `src/server/server.js` — headless точка входа (Fastify).
- `src/server/httpApi.js` — REST-роуты (1:1 к нынешним IPC-каналам).
- `src/server/wsBridge.js` — мост событий ядра → WebSocket.
- `src/server/auth.js` — логин по паролю, scrypt, кука, rate-limit.
- `src/renderer/app-api.js` — браузерный `api`-shim (fetch + WebSocket) вместо preload.
- `src/renderer/login.html` — страница логина.
- `scripts/seed-messages.mjs` — генератор контента по языкам.
- `deploy/com.wawarmer.panel.plist` — launchd-юнит.
- `test/**` — тесты на `node:test`.

Изменяемые:
- `src/main/paths.js` — папка данных из env, без `electron.app`; пути контента по группам.
- `src/main/accountStore.js` — `groups` в конфиге, `groupId`/`ready` у аккаунта, миграция, `warmDays`.
- `src/main/gowaManager.js` — пул движков.
- `src/main/gowaClient.js` — маршрутизация запросов на движок группы.
- `src/main/loginFlow.js` — устройство создаётся в группе.
- `src/main/contentPack.js` — контент по группам + выбор по языку.
- `src/main/scheduler.js` — страна-центричная логика.
- `src/renderer/index.html` / `app.js` / `styles.css` — UI групп + вход.
- `package.json` — скрипты `start`/`server`, зависимости Fastify.

Ретайр (после переноса на сервер, удаляются на последнем этапе): `src/main/main.js`, `src/main/ipc.js`, `src/preload/preload.js`.

---

## Task 1: Папка данных без Electron

**Files:**
- Modify: `src/main/paths.js`
- Test: `test/paths.test.js`

**Interfaces:**
- Produces: `paths.dataDir(): string` (без Electron), `paths.setDataDir(dir)` для тестов; остальные экспортируемые пути без изменений в сигнатурах.

- [ ] **Step 1: Write the failing test**
```js
// test/paths.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

test('dataDir uses WA_DATA_DIR when set', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wadd-'));
  process.env.WA_DATA_DIR = tmp;
  delete require.cache[require.resolve('../src/main/paths.js')];
  const paths = require('../src/main/paths.js');
  assert.strictEqual(paths.dataDir(), tmp);
  assert.ok(fs.existsSync(paths.accountsFile().replace(/accounts\.json$/, '')));
});
```

- [ ] **Step 2: Run test to verify it fails**
Run: `node --test test/paths.test.js`
Expected: FAIL (`Cannot find module 'electron'` или обращение к `app`).

- [ ] **Step 3: Implement — drop the electron import**
Заменить в `src/main/paths.js` шапку и `dataDir()`:
```js
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

function osToken(platform) {
  if (platform === 'darwin') return 'mac';
  if (platform === 'win32') return 'win';
  return 'linux';
}
const platformKey = `${osToken(process.platform)}-${process.arch}`;
const exeName = process.platform === 'win32' ? 'whatsapp.exe' : 'whatsapp';

function resourcesRoot() {
  return process.env.WA_RESOURCES_DIR || path.join(__dirname, '..', '..', 'resources');
}
function gowaBinaryPath() {
  return path.join(resourcesRoot(), 'gowa', platformKey, exeName);
}

let cachedDataDir = null;
function setDataDir(dir) { cachedDataDir = dir; }
function dataDir() {
  if (cachedDataDir) return cachedDataDir;
  const base = process.env.WA_DATA_DIR || path.join(os.homedir(), '.wa-warmer', 'data');
  fs.mkdirSync(base, { recursive: true });
  cachedDataDir = base;
  return base;
}
```
Оставить существующие `gowaDbPath/gowaKeysDbPath/accountsFile/configFile/contentDir/...`. Добавить в `module.exports`: `setDataDir`.

- [ ] **Step 4: Run test to verify it passes**
Run: `node --test test/paths.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add src/main/paths.js test/paths.test.js
git commit -m "feat(paths): resolve data dir from env, drop electron dependency"
```

---

## Task 2: Модель групп (`groups.js`)

**Files:**
- Create: `src/main/groups.js`
- Test: `test/groups.test.js`

**Interfaces:**
- Produces:
  - `DEFAULT_GROUPS: Array<{id,label,country,role,lang,proxy}>` — `ua,de,pl,uk`.
  - `detectGroupId(phone: string): string|null` — по префиксу; `null` если не распознан.
  - `groupById(groups, id): group|null`, `groupOf(groups, account): group` (fallback `ua`).
  - `pairLang(groupA, groupB): 'uk'|'de'|'pl'|'en'` — язык по паре (смешанная → `'de'`).
  - `contentGroupIdForLang(lang): 'ua'|'de'|'pl'|'uk'`.

- [ ] **Step 1: Write the failing test**
```js
// test/groups.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const g = require('../src/main/groups.js');

test('detectGroupId by country prefix', () => {
  assert.strictEqual(g.detectGroupId('380671112233'), 'ua');
  assert.strictEqual(g.detectGroupId('+49 151 111 22'), 'de');
  assert.strictEqual(g.detectGroupId('48512223344'), 'pl');
  assert.strictEqual(g.detectGroupId('447700900123'), 'uk');
  assert.strictEqual(g.detectGroupId('15551234567'), null);
});

test('pairLang: same country uses its lang, mixed uses German', () => {
  const G = g.DEFAULT_GROUPS;
  const ua = g.groupById(G, 'ua'), de = g.groupById(G, 'de'), pl = g.groupById(G, 'pl');
  assert.strictEqual(g.pairLang(ua, ua), 'uk');
  assert.strictEqual(g.pairLang(pl, pl), 'pl');
  assert.strictEqual(g.pairLang(ua, de), 'de'); // UA↔EU → немецкий
  assert.strictEqual(g.pairLang(pl, de), 'de'); // EU↔EU разные → немецкий
});
```

- [ ] **Step 2: Run test to verify it fails**
Run: `node --test test/groups.test.js`
Expected: FAIL (`Cannot find module '../src/main/groups.js'`).

- [ ] **Step 3: Implement `src/main/groups.js`**
```js
'use strict';
const DEFAULT_GROUPS = [
  { id: 'ua', label: 'Украина',  country: 'UA', role: 'primary', lang: 'uk', proxy: '' },
  { id: 'de', label: 'Германия', country: 'DE', role: 'aux',     lang: 'de', proxy: '' },
  { id: 'pl', label: 'Польша',   country: 'PL', role: 'aux',     lang: 'pl', proxy: '' },
  { id: 'uk', label: 'Англия',   country: 'GB', role: 'aux',     lang: 'en', proxy: '' },
];
// более длинные префиксы проверяются раньше
const PREFIX_TO_GROUP = [['380','ua'],['49','de'],['48','pl'],['44','uk']];

function detectGroupId(phone) {
  const d = String(phone || '').replace(/[^0-9]/g, '');
  for (const [pfx, id] of PREFIX_TO_GROUP) if (d.startsWith(pfx)) return id;
  return null;
}
const groupById = (groups, id) => groups.find((x) => x.id === id) || null;
const groupOf = (groups, acc) => groupById(groups, acc && acc.groupId) || groupById(groups, 'ua');

const LANG_TO_GROUP = { uk: 'ua', de: 'de', pl: 'pl', en: 'uk' };
const contentGroupIdForLang = (lang) => LANG_TO_GROUP[lang] || 'ua';

function pairLang(a, b) {
  if (a && b && a.id === b.id) return a.lang;   // одна группа → её язык
  return 'de';                                   // любая смешанная пара → немецкий
}
module.exports = { DEFAULT_GROUPS, detectGroupId, groupById, groupOf, pairLang, contentGroupIdForLang };
```

- [ ] **Step 4: Run test to verify it passes**
Run: `node --test test/groups.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add src/main/groups.js test/groups.test.js
git commit -m "feat(groups): country group model, prefix detection, pair language"
```

---

## Task 3: Конфиг групп + миграция + `groupId`/`ready` в accountStore

**Files:**
- Modify: `src/main/accountStore.js`
- Test: `test/accountStore.groups.test.js`

**Interfaces:**
- Consumes: `groups.DEFAULT_GROUPS`.
- Produces:
  - `loadConfig()` возвращает `{...DEFAULT_CONFIG, warmDays, crossCountryBoost, groups}` с гарантией непустых `groups`.
  - `migrateGroups()` — идемпотентно создаёт группы и проставляет `groupId="ua"` старым аккаунтам, переносит `config.proxy`→`ua.proxy`.
  - `setGroup(deviceId, groupId)`, `setReady(deviceId, bool)`, `accountsInGroup(groupId)`.
  - `DEFAULT_CONFIG` дополнен `warmDays: 10`, `crossCountryBoost: true` (поле `proxy` остаётся для миграции).

- [ ] **Step 1: Write the failing test**
```js
// test/accountStore.groups.test.js
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const os = require('node:os'); const fs = require('node:fs'); const path = require('node:path');

function freshStore() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wastore-'));
  process.env.WA_DATA_DIR = tmp;
  for (const m of ['../src/main/paths.js','../src/main/accountStore.js'])
    delete require.cache[require.resolve(m)];
  return { store: require('../src/main/accountStore.js'), tmp };
}

test('migrateGroups seeds 4 groups and assigns legacy accounts to ua', () => {
  const { store, tmp } = freshStore();
  fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ proxy: 'socks5://127.0.0.1:3000' }));
  fs.writeFileSync(path.join(tmp, 'accounts.json'), JSON.stringify([{ deviceId: 'd1', label: 'A', addedAt: 1 }]));
  store.migrateGroups();
  const cfg = store.loadConfig();
  assert.strictEqual(cfg.groups.length, 4);
  assert.strictEqual(cfg.groups.find((x) => x.id === 'ua').proxy, 'socks5://127.0.0.1:3000');
  assert.strictEqual(store.get('d1').groupId, 'ua');
});
```

- [ ] **Step 2: Run test to verify it fails**
Run: `node --test test/accountStore.groups.test.js`
Expected: FAIL (`store.migrateGroups is not a function`).

- [ ] **Step 3: Implement in `src/main/accountStore.js`**
Добавить `const groups = require('./groups');` и в `DEFAULT_CONFIG` поля `warmDays: 10, crossCountryBoost: true`. Затем:
```js
function migrateGroups() {
  const cfg = readJson(paths.configFile(), {});
  if (!Array.isArray(cfg.groups) || cfg.groups.length === 0) {
    cfg.groups = groups.DEFAULT_GROUPS.map((x) => ({ ...x }));
    if (cfg.proxy) cfg.groups[0].proxy = cfg.proxy; // старое одно-прокси поле → группа ua
    writeJsonAtomic(paths.configFile(), { ...DEFAULT_CONFIG, ...cfg });
  }
  loadAccounts();
  let changed = false;
  for (const a of accounts) if (!a.groupId) { a.groupId = 'ua'; changed = true; }
  if (changed) saveAccounts();
}
function setGroup(deviceId, groupId) { const a = get(deviceId); if (a) { a.groupId = groupId; saveAccounts(); } }
function setReady(deviceId, value) { const a = get(deviceId); if (a && !!a.ready !== !!value) { a.ready = !!value; saveAccounts(); } }
function accountsInGroup(groupId) { return loadAccounts().filter((a) => (a.groupId || 'ua') === groupId); }
```
В `loadConfig()` гарантировать группы:
```js
function loadConfig() {
  const c = { ...DEFAULT_CONFIG, ...readJson(paths.configFile(), {}) };
  if (!Array.isArray(c.groups) || c.groups.length === 0) c.groups = groups.DEFAULT_GROUPS.map((x) => ({ ...x }));
  return c;
}
```
Добавить в `module.exports`: `migrateGroups, setGroup, setReady, accountsInGroup`.

- [ ] **Step 4: Run test to verify it passes**
Run: `node --test test/accountStore.groups.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add src/main/accountStore.js test/accountStore.groups.test.js
git commit -m "feat(store): group config, migration to ua, groupId/ready helpers"
```

---

## Task 4: Пул движков в `gowaManager` + `engineRouter`

**Files:**
- Modify: `src/main/gowaManager.js`
- Create: `src/main/engineRouter.js`
- Test: `test/engineRouter.test.js` (юнит на роутинг), интеграционная проверка вручную (см. Step 6).

**Interfaces:**
- Consumes: `store.loadConfig().groups`, `store.get(deviceId).groupId`, `paths.gowaBinaryPath()`.
- Produces:
  - `gowaManager.startAll()`, `stopAll()`, `restartGroup(groupId)`, `engine(groupId): {port,user,pass,ready}|null`, `state` (EventEmitter, событие `state` c `{groupId, ready}`).
  - `engineRouter.forDevice(deviceId): {baseUrl, auth}|null`, `engineRouter.forGroup(groupId): {baseUrl, auth}|null`.

- [ ] **Step 1: Write the failing test (router resolves engine by device's group)**
```js
// test/engineRouter.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os'); const fs = require('node:fs'); const path = require('node:path');

test('engineRouter maps deviceId -> group engine', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'warouter-'));
  process.env.WA_DATA_DIR = tmp;
  for (const m of ['../src/main/paths.js','../src/main/accountStore.js','../src/main/gowaManager.js','../src/main/engineRouter.js'])
    delete require.cache[require.resolve(m)];
  const store = require('../src/main/accountStore.js');
  const gowa = require('../src/main/gowaManager.js');
  const router = require('../src/main/engineRouter.js');
  store.upsert({ deviceId: 'd1', label: 'A', groupId: 'de', addedAt: 1 });
  gowa.__setEngineForTest('de', { port: 5555, user: 'u', pass: 'p', ready: true }); // test seam
  const e = router.forDevice('d1');
  assert.strictEqual(e.baseUrl, 'http://127.0.0.1:5555');
  assert.strictEqual(e.auth, 'Basic ' + Buffer.from('u:p').toString('base64'));
});
```

- [ ] **Step 2: Run test to verify it fails**
Run: `node --test test/engineRouter.test.js`
Expected: FAIL (нет `engineRouter`, нет `__setEngineForTest`).

- [ ] **Step 3: Implement pool in `gowaManager.js`**
Заменить единичный `child/current` на `Map`. Ключевые части:
```js
const engines = new Map(); // groupId -> { child, port, user, pass, ready, restarts, dbPath }

function dbPathFor(groupId) {
  if (groupId === 'ua') return paths.gowaDbPath(); // старая база — непрерывность сессий
  const dir = require('node:path').join(paths.dataDir(), 'gowa', groupId);
  fs.mkdirSync(dir, { recursive: true });
  return require('node:path').join(dir, 'whatsapp.db');
}

async function spawnGroup(group) {
  const binPath = paths.gowaBinaryPath();
  prepareBinary(binPath);
  const port = await getFreePort();
  const user = 'warmer';
  const pass = crypto.randomBytes(18).toString('base64url');
  const dbPath = dbPathFor(group.id);
  const env = { ...process.env, APP_PORT: String(port), APP_BASIC_AUTH: `${user}:${pass}`,
    DB_URI: `file:${dbPath}`, DB_KEYS_URI: `file:${dbPath.replace(/whatsapp\.db$/, 'keys.db')}` };
  const args = ['rest', '--port', String(port), '-b', `${user}:${pass}`];
  const proxy = String(group.proxy || '').trim();
  if (proxy) { env.WHATSAPP_PROXY = proxy; args.push('--whatsapp-proxy', proxy); }
  const child = spawn(binPath, args, { env, cwd: paths.dataDir(), windowsHide: true });
  const eng = { child, port, user, pass, ready: false, restarts: 0, dbPath };
  engines.set(group.id, eng);
  // pipe logs, wait ready, supervise restart per-group (перенести существующую логику, ключ = group.id)
  // при exit — spawnGroup(group) с backoff, если !shuttingDown
}

async function startAll() { for (const gr of store.loadConfig().groups) await spawnGroup(gr).catch((e)=>log.error('gowa',`${gr.id}: ${e.message}`)); }
async function stopAll() { /* kill каждый child как в текущем stop() */ }
async function restartGroup(id) { await stopGroup(id); const gr = store.loadConfig().groups.find(g=>g.id===id); if (gr) await spawnGroup(gr); }
const engine = (id) => { const e = engines.get(id); return e ? { port: e.port, user: e.user, pass: e.pass, ready: e.ready } : null; };
function __setEngineForTest(id, e) { engines.set(id, { ...e, child: null }); } // test seam
module.exports = { startAll, stopAll, restartGroup, engine, state, registerWebhook, __setEngineForTest,
  isReady: (id) => !!engines.get(id)?.ready, info: () => [...engines].map(([id,e])=>({id,ready:e.ready,port:e.port})) };
```

- [ ] **Step 4: Implement `src/main/engineRouter.js`**
```js
'use strict';
const store = require('./accountStore');
const gowa = require('./gowaManager');
function toEngine(e) { return e ? { baseUrl: `http://127.0.0.1:${e.port}`, auth: 'Basic ' + Buffer.from(`${e.user}:${e.pass}`).toString('base64') } : null; }
function forGroup(groupId) { return toEngine(gowa.engine(groupId)); }
function forDevice(deviceId) { const a = store.get(deviceId); return forGroup((a && a.groupId) || 'ua'); }
module.exports = { forGroup, forDevice };
```

- [ ] **Step 5: Run test to verify it passes**
Run: `node --test test/engineRouter.test.js`
Expected: PASS.

- [ ] **Step 6: Integration check (real proxy routing) + commit**
Прогнать харнесс из истории проекта: поднять 2 группы (реальный UA-прокси и прямая), создать устройство в каждой, `GET /app/login` — QR приходит; битый прокси в группе → QR НЕ приходит. Затем:
```bash
git add src/main/gowaManager.js src/main/engineRouter.js test/engineRouter.test.js
git commit -m "feat(engine): per-group GOWA process pool + device→engine router"
```

---

## Task 5: Маршрутизация `gowaClient` на движок группы

**Files:**
- Modify: `src/main/gowaClient.js`
- Modify: `src/main/loginFlow.js`
- Test: `test/gowaClient.routing.test.js`

**Interfaces:**
- Consumes: `engineRouter.forDevice`, `engineRouter.forGroup`.
- Produces: методы `gowaClient` резолвят движок по `deviceId` внутри `request()`; `createDevice(groupId, displayName)` бьёт в движок группы; `login/status/logout/...` — без изменения сигнатур (deviceId уже есть).

- [ ] **Step 1: Write the failing test**
```js
// test/gowaClient.routing.test.js — проверяем, что request идёт на baseUrl движка группы устройства
const { test } = require('node:test');
const assert = require('node:assert');
// замокать engineRouter.forDevice -> {baseUrl, auth}; замокать global.fetch; вызвать client.status('d1');
// assert: fetch вызван с этим baseUrl и заголовком Authorization = auth, X-Device-Id = 'd1'
```
(Полный мок: подменить `require.cache` для `engineRouter`, установить `global.fetch = async (url, opts) => { captured = {url, opts}; return new Response('{}'); }`.)

- [ ] **Step 2: Run test to verify it fails**
Run: `node --test test/gowaClient.routing.test.js`
Expected: FAIL (клиент всё ещё использует единый `baseUrl` из `configure`).

- [ ] **Step 3: Implement routing in `gowaClient.js`**
Заменить глобальные `baseUrl/authHeader` на резолв через роутер:
```js
const router = require('./engineRouter');
async function request(method, endpoint, { deviceId, groupId, json, body, extraHeaders } = {}) {
  const eng = deviceId ? router.forDevice(deviceId) : (groupId ? router.forGroup(groupId) : null);
  if (!eng) throw new Error('нет активного движка для запроса');
  const headers = { Authorization: eng.auth, ...(extraHeaders || {}) };
  if (deviceId) headers['X-Device-Id'] = deviceId;
  // ...дальше как сейчас, но fetch(`${eng.baseUrl}${endpoint}`, ...)
}
const createDevice = (groupId, displayName) => request('POST', '/devices', { groupId, json: { display_name: displayName || '' } });
```
`authHeaderValue()` заменить на `authHeaderFor(deviceId)` (используется в `loginFlow.toDataUrl` для картинки QR).

- [ ] **Step 4: Update `loginFlow.newDevice` to pass group**
```js
async function newDevice(label, groupId) {
  const created = await client.createDevice(groupId, label);
  const deviceId = (created.results || created).id;
  store.upsert({ deviceId, label: label || 'Аккаунт', groupId, jid: '', phone: '', connected: false, addedAt: Date.now() });
  return deviceId;
}
```
`startLogin(label, groupId)` и `startLoginWithCode(label, phone, groupId)` — прокинуть `groupId` (по умолчанию из `groups.detectGroupId(phone) || 'ua'`).

- [ ] **Step 5: Run test + commit**
Run: `node --test test/gowaClient.routing.test.js` → PASS.
```bash
git add src/main/gowaClient.js src/main/loginFlow.js test/gowaClient.routing.test.js
git commit -m "feat(client): route requests to the device's group engine"
```

---

## Task 6: Контент по группам + выбор языка

**Files:**
- Modify: `src/main/contentPack.js`
- Modify: `src/main/paths.js` (пути контента по группам)
- Test: `test/contentPack.groups.test.js`

**Interfaces:**
- Consumes: `groups.contentGroupIdForLang(lang)`.
- Produces:
  - `paths.messagesFile(groupId)`, `paths.linksFile(groupId)`, `paths.sharedImagesDir()`, `paths.sharedVoiceDir()`.
  - `contentPack.pick(cfg, avoidSet, lang)` — тексты берутся из контента группы языка; медиа — из shared.
  - `contentPack.ensure()` создаёт `content-pack/<ua|de|pl|uk>/messages.txt|links.txt` и `content-pack/shared/{images,voice}`; мигрирует старый `content-pack/*.txt` → `ua/`.

- [ ] **Step 1: Write the failing test**
```js
// test/contentPack.groups.test.js
// подготовить content-pack/de/messages.txt со строкой "hallo"; pick(cfg,set,'de') должен вернуть текст из de.
```

- [ ] **Step 2: Run it → FAIL** (`pick` не принимает язык).

- [ ] **Step 3: Implement per-group content**
- `paths.js`: `contentDir()` без изменений; добавить `messagesFile(groupId='ua')`→`content-pack/<groupId>/messages.txt`, аналогично `linksFile`; `sharedImagesDir()`→`content-pack/shared/images`, `sharedVoiceDir()`→`content-pack/shared/voice`.
- `contentPack.js`: держать `Map<lang, {messages, links}>`; `reload()` читает 4 языковые папки; `pick(cfg, avoid, lang)` берёт `contentGroupIdForLang(lang)`-набор для текста/ссылок и shared для картинок/голоса. `ensure()` создаёт папки и мигрирует legacy файлы в `ua/`.

- [ ] **Step 4: Run test → PASS.**

- [ ] **Step 5: Commit**
```bash
git add src/main/contentPack.js src/main/paths.js test/contentPack.groups.test.js
git commit -m "feat(content): per-language content packs + shared media"
```

---

## Task 7: Страна-центричный scheduler (10 дней, буст, ready, язык)

**Files:**
- Modify: `src/main/scheduler.js`
- Test: `test/scheduler.pairing.test.js`

**Interfaces:**
- Consumes: `store.loadConfig()` (`warmDays`, `crossCountryBoost`, `groups`), `groups.groupOf/pairLang`, `store.setReady`, `contentPack.pick(cfg, set, lang)`.
- Produces (внутренние, тестируемые чистые функции, экспортировать для тестов):
  - `canPair(a, b, cfg): boolean` — правило подбора по стране + буст в дни 9–10.
  - `isReadyDay(acc, cfg): boolean` — `daysWarming(acc) >= cfg.warmDays`.
  - `capFor(acc, cfg): number` — ramp с плато и множителем `role==='aux'` (≈0.5).

- [ ] **Step 1: Write the failing test**
```js
// test/scheduler.pairing.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const sch = require('../src/main/scheduler.js');
const cfg = { warmDays: 10, crossCountryBoost: true,
  groups: require('../src/main/groups.js').DEFAULT_GROUPS };
const mk = (id, group, day) => ({ deviceId: id, groupId: group, __day: day });

test('same-country always allowed; cross-country only on days 9-10', () => {
  // подменить daysWarming через __day (см. реализацию: scheduler читает store.daysWarming)
  assert.strictEqual(sch.__canPair(mk('a','ua',3), mk('b','ua',3), cfg), true);   // UA↔UA рано
  assert.strictEqual(sch.__canPair(mk('a','ua',3), mk('c','de',3), cfg), false);  // кросс рано — нельзя
  assert.strictEqual(sch.__canPair(mk('a','ua',9), mk('c','de',9), cfg), true);   // кросс в день 9 — можно
  assert.strictEqual(sch.__canPair(mk('a','ua',9), mk('c','de',3), cfg), false);  // партнёр не в окне
});
```

- [ ] **Step 2: Run it → FAIL** (`sch.__canPair` не определён).

- [ ] **Step 3: Implement country-aware logic**
Добавить чистые функции (с внедряемым `dayOf` для тестируемости):
```js
const groups = require('./groups');
const dayOf = (acc) => (acc.__day != null ? acc.__day : store.daysWarming(acc)); // __day — тестовый seam

function canPair(a, b, cfg) {
  if (a.groupId === b.groupId) return true;
  if (!cfg.crossCountryBoost) return false;
  const last2 = (d) => d >= (cfg.warmDays - 1);       // дни 9 и 10 при warmDays=10
  return last2(dayOf(a)) && last2(dayOf(b));          // буст «на 2 последних дня» для ОБОИХ
}
function isReadyDay(acc, cfg) { return dayOf(acc) >= (cfg.warmDays || 10); }
function capFor(acc, cfg) {
  const base = effectiveCap(acc, cfg);                 // текущий ramp с плато
  const grp = groups.groupOf(cfg.groups, acc);
  return grp && grp.role === 'aux' ? Math.max(2, Math.round(base * 0.5)) : base;
}
module.exports.__canPair = canPair; // для тестов
```
Встроить в `pickPair`: кандидаты фильтруются `canPair(sender, cand, config)`; `ready`-аккаунты исключаются из `activeCache` (в `refreshActive`: `!store.get(a.deviceId).ready`), и по достижении `isReadyDay` вызвать `store.setReady(deviceId, true)` + `log`. Заменить использования `effectiveCap` в `pacedAllowance`/лимитах на `capFor`. В `sendTurn` выбирать язык: `const lang = groups.pairLang(groups.groupOf(cfg.groups, sender), groups.groupOf(cfg.groups, receiver)); content.pick(pickCfg, new Set(recentTexts), lang);`.

- [ ] **Step 4: Run test → PASS.**

- [ ] **Step 5: Commit**
```bash
git add src/main/scheduler.js test/scheduler.pairing.test.js
git commit -m "feat(scheduler): country-centric 10-day warming, EU boost, ready, per-pair language"
```

---

## Task 8: Boot-ядро без Electron

**Files:**
- Create: `src/core/boot.js`
- Test: ручная проверка запуска (Step 4).

**Interfaces:**
- Consumes: `gowaManager.startAll/stopAll`, `store.migrateGroups`, `content.ensure`, `webhook`, `scheduler`.
- Produces: `boot({ onEvent })` — поднимает пул, миграцию, вебхук, обслуживание соединений; `shutdown()`.

- [ ] **Step 1: Extract boot sequence from `main.js`**
Перенести из `src/main/main.js` функции `refreshStatuses/reconnectAccounts/maintainConnections/handleInbound` и последовательность `boot()` в `src/core/boot.js`, убрав Electron (`Notification`→`onEvent('notify', ...)`, `mainWindow`→callback). Вызвать `store.migrateGroups()` перед `gowa.startAll()`.

- [ ] **Step 2: Provide event sink**
`boot({ emit })` где `emit(channel, payload)` — сервер повесит это на WebSocket; те же каналы, что сейчас в `ipc.js`.

- [ ] **Step 3: Wire maintenance across the pool**
`maintainConnections` перебирает `store.all()`, но `client.listDevices()` теперь per-engine — вызвать для каждой группы (`for (const gr of cfg.groups) client.listDevices(gr.id)`), объединить в `devMap`. Добавить `listDevices(groupId)` в `gowaClient` (запрос с `groupId`).

- [ ] **Step 4: Manual run check + commit**
Запустить временный харнесс `node -e "require('./src/core/boot').boot({emit:()=>{}})"` с тестовой data-папкой без прокси — движок `ua` стартует, лог «ready».
```bash
git add src/core/boot.js src/main/gowaClient.js
git commit -m "refactor(core): headless boot sequence, pool-aware maintenance"
```

---

## Task 9: Аутентификация панели

**Files:**
- Create: `src/server/auth.js`
- Test: `test/auth.test.js`

**Interfaces:**
- Produces: `hashPassword(pw): string` (scrypt, формат `scrypt$salt$hash`), `verifyPassword(pw, stored): boolean`, `rateLimiter()` (N попыток/окно), Fastify-preHandler `requireSession`.

- [ ] **Step 1: Write the failing test**
```js
// test/auth.test.js
const { test } = require('node:test'); const assert = require('node:assert');
const a = require('../src/server/auth.js');
test('hash/verify round-trip', () => {
  const h = a.hashPassword('Correct-Horse-9!');
  assert.ok(a.verifyPassword('Correct-Horse-9!', h));
  assert.ok(!a.verifyPassword('wrong', h));
});
```

- [ ] **Step 2: Run it → FAIL.**

- [ ] **Step 3: Implement `auth.js`** (scrypt из `node:crypto`, timing-safe сравнение, счётчик попыток по IP с блокировкой на 15 мин после 5 неудач).

- [ ] **Step 4: Run test → PASS. Commit**
```bash
git add src/server/auth.js test/auth.test.js
git commit -m "feat(auth): scrypt password hashing + verify + rate limiter"
```

---

## Task 10: HTTP+WS сервер (Fastify)

**Files:**
- Create: `src/server/server.js`, `src/server/httpApi.js`, `src/server/wsBridge.js`, `src/renderer/login.html`
- Modify: `package.json` (deps + скрипты)
- Test: `test/httpApi.test.js`

**Interfaces:**
- Consumes: `core/boot`, `auth`, все существующие модули ядра.
- Produces: сервер на `WA_PANEL_PORT` (деф. 8760); REST-роуты 1:1 к нынешним IPC-каналам; `/ws` рассылает события; статика renderer; `requireSession` на всех `/api/*`.

- [ ] **Step 1: Add deps + scripts**
```bash
npm i fastify @fastify/static @fastify/websocket @fastify/cookie
```
`package.json` scripts: `"server": "node src/server/server.js"`, `"start": "node src/server/server.js"`, `prestart`/`preserver` → `ensure-assets`.

- [ ] **Step 2: Write failing endpoint test**
```js
// test/httpApi.test.js — поднять fastify app из httpApi (inject), GET /api/accounts без куки → 401; с кукой → 200 массив.
```

- [ ] **Step 3: Implement `httpApi.js`** — по одному роуту на каждый нынешний `ipcMain.handle` из `src/main/ipc.js`:
  `GET /api/accounts` → `accountsView()`; `POST /api/login/start {label,groupId}`; `POST /api/login/startCode`; `POST /api/login/bulkCode`; `POST /api/login/refreshQr`; `POST /api/login/cancel`; `POST /api/account/rename|setPaused|reconnect|logout|setGroup`; `GET/POST /api/config`; `POST /api/warming/start|stop`; `GET /api/stats/full`; `GET /api/stats/exportCsv` (download); `GET /api/groups`, `POST /api/groups` (сохранить + `restartGroup`); `POST /api/proxy/test|apply` (на группу); `GET/POST /api/content/*` (upload картинок — multipart). Все под `requireSession`, кроме `POST /api/login-panel` (пароль→кука) и статики/`login.html`.

- [ ] **Step 4: Implement `wsBridge.js`** — `boot({ emit })`, где `emit` шлёт всем WS-клиентам `{channel, payload}`; каналы: `log:line, accounts:updated, login:qr|code|success|timeout|cancel, warming:tick|state, gowa:state, account:loggedOut`.

- [ ] **Step 5: Implement `server.js`** — регистрирует cookie/static/websocket, `httpApi`, стартует `boot`, слушает `0.0.0.0:PORT`; при первом старте, если нет `panel.json`, читает `WA_PANEL_PASSWORD` и пишет хеш.

- [ ] **Step 6: Run test → PASS. Commit**
```bash
git add src/server package.json package-lock.json src/renderer/login.html test/httpApi.test.js
git commit -m "feat(server): fastify http+ws panel with auth, REST 1:1 to former IPC"
```

---

## Task 11: Браузерный `api`-shim + UI групп

**Files:**
- Create: `src/renderer/app-api.js`
- Modify: `src/renderer/index.html`, `src/renderer/app.js`, `src/renderer/styles.css`
- Test: ручная проверка в браузере (Step 4).

**Interfaces:**
- Consumes: REST/WS из Task 10.
- Produces: глобальный `window.api` с теми же именами методов, что в `preload.js`, но через `fetch`/WebSocket; UI управления группами и назначения группы аккаунту.

- [ ] **Step 1: Implement `app-api.js`** — воспроизвести поверхность `preload.js`: invoke-методы → `fetch('/api/...', {method, body})`; `on*`-подписки → один общий WebSocket с диспетчеризацией по `channel`. Подключить `<script src="app-api.js">` вместо preload в `index.html`.

- [ ] **Step 2: Groups UI** — в `index.html` добавить блок «Группы» (4 строки: label/страна/прокси/`role` + «Проверить»); в модалке добавления аккаунта — поле группы с автозаполнением по префиксу (`api.detectGroup(phone)` на клиенте через `groups`-таблицу, дублированную в JS); в карточке аккаунта — бейдж группы и день/`ready`.

- [ ] **Step 3: Login page** — `login.html` постит пароль на `/api/login-panel`, при успехе редирект на `/`.

- [ ] **Step 4: Manual browser check + commit**
`npm run server`, открыть `http://127.0.0.1:8760`, войти по паролю, увидеть аккаунты/лог/группы, добавить номер (группа определилась по префиксу), «Проверить прокси» группы.
```bash
git add src/renderer
git commit -m "feat(ui): browser api shim + groups management + login page"
```

---

## Task 12: Эксплуатация (launchd + README) и ретайр Electron

**Files:**
- Create: `deploy/com.wawarmer.panel.plist`, обновить `README.md`
- Delete: `src/main/main.js`, `src/main/ipc.js`, `src/preload/preload.js`, Electron-зависимости из `package.json`

- [ ] **Step 1: launchd plist** — `deploy/com.wawarmer.panel.plist`: `ProgramArguments = [node, .../src/server/server.js]`, env `WA_DATA_DIR/WA_PANEL_PORT/WA_PANEL_PASSWORD/WA_RESOURCES_DIR`, `KeepAlive=true`, `StandardOut/ErrorPath` в лог.

- [ ] **Step 2: README** — раздел «Сервер на Mac mini»: `npm ci`, `npm run build-gowa -- --all`, задать `WA_PANEL_PASSWORD`, `launchctl load`, доступ по `http://<magicdns>:8760` в Tailscale, опц. `tailscale serve` для HTTPS.

- [ ] **Step 3: Remove Electron** — удалить `main.js/ipc.js/preload.js`, `electron`/`electron-builder` из `devDependencies`, `electron-builder.yml`/`afterPack.js`/`fetch-gowa` пометить устаревшими или удалить; убрать `build:*` скрипты.

- [ ] **Step 4: Full test run + commit**
Run: `node --test` (все тесты зелёные).
```bash
git add -A
git commit -m "chore: launchd unit, server README, retire electron shell"
```

---

## Self-Review (сверка с спекой)

- **Пул/группы** → Tasks 2–5. **Миграция без релогина** → Task 3 + `dbPathFor('ua')` в Task 4. **Логика прогрева (10 дней, ramp, буст 9–10, ready, aux ½, язык по паре)** → Task 7 (+ контент Task 6). **Веб-сервер/REST/WS** → Tasks 10–11. **Auth Tailscale+пароль** → Tasks 9–10. **Ops (launchd/README)** → Task 12. **Контент по языкам** → Task 6 + генератор (отдельно, `scripts/seed-messages.mjs`).
- **Типы согласованы:** `engine(groupId)→{port,user,pass,ready}` (Task 4) ↔ `engineRouter.forGroup/forDevice→{baseUrl,auth}` (Task 4/5) ↔ `gowaClient.request({deviceId|groupId})` (Task 5). `canPair/isReadyDay/capFor(acc,cfg)` (Task 7) используют `groups.groupOf/pairLang` (Task 2). `content.pick(cfg,set,lang)` (Task 6) ↔ вызов из `sendTurn` (Task 7).
- **Плейсхолдеров нет:** тестовые сидинги описаны словами только в Task 5/6/8/11, где нужен браузер/мок fetch — там указан точный способ (подмена `require.cache`, `global.fetch`, inject Fastify).

## Открытые мелочи (решить при реализации, не блокируют)

- Точное число воркеров/лимитов для `aux` — начать с ½ и откалибровать.
- Формат хранения `panel.json` (хеш + соль) — по `auth.hashPassword`.
