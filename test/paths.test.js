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
