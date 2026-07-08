'use strict';
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
