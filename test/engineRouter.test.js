'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os'); const fs = require('node:fs'); const path = require('node:path');

test('engineRouter maps deviceId -> group engine', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'warouter-'));
  process.env.WA_DATA_DIR = tmp;
  for (const m of ['../src/main/paths.js', '../src/main/accountStore.js', '../src/main/gowaManager.js', '../src/main/engineRouter.js'])
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

test('engineRouter.forDevice defaults to ua group when device has no groupId', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'warouter-'));
  process.env.WA_DATA_DIR = tmp;
  for (const m of ['../src/main/paths.js', '../src/main/accountStore.js', '../src/main/gowaManager.js', '../src/main/engineRouter.js'])
    delete require.cache[require.resolve(m)];
  const store = require('../src/main/accountStore.js');
  const gowa = require('../src/main/gowaManager.js');
  const router = require('../src/main/engineRouter.js');
  store.upsert({ deviceId: 'legacy', label: 'L', addedAt: 1 }); // no groupId
  gowa.__setEngineForTest('ua', { port: 6001, user: 'warmer', pass: 'x', ready: true });
  const e = router.forDevice('legacy');
  assert.strictEqual(e.baseUrl, 'http://127.0.0.1:6001');
  assert.strictEqual(e.auth, 'Basic ' + Buffer.from('warmer:x').toString('base64'));
});

test('engineRouter returns null for unknown group', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'warouter-'));
  process.env.WA_DATA_DIR = tmp;
  for (const m of ['../src/main/paths.js', '../src/main/accountStore.js', '../src/main/gowaManager.js', '../src/main/engineRouter.js'])
    delete require.cache[require.resolve(m)];
  const gowa = require('../src/main/gowaManager.js');
  const router = require('../src/main/engineRouter.js');
  assert.strictEqual(gowa.engine('nope'), null);
  assert.strictEqual(router.forGroup('nope'), null);
});
