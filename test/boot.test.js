'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const BOOT_PATH = path.join(__dirname, '..', 'src', 'core', 'boot.js');

test('boot.js loads and exports boot/shutdown without a direct electron dependency', () => {
  // модуль не должен напрямую тянуть electron — веб-сервер (задача 10) headless
  const src = fs.readFileSync(BOOT_PATH, 'utf8');
  assert.ok(!/require\(\s*['"]electron['"]\s*\)/.test(src), 'boot.js must not require electron');

  const boot = require('../src/core/boot.js');
  assert.strictEqual(typeof boot.boot, 'function', 'exports boot()');
  assert.strictEqual(typeof boot.shutdown, 'function', 'exports shutdown()');
});

test('__mergeDeviceMaps merges per-group device lists into one map (deviceId -> device)', () => {
  const { __mergeDeviceMaps } = require('../src/core/boot.js');

  const merged = __mergeDeviceMaps([
    { results: [{ id: 'ua1', state: 'logged_in' }, { id: 'ua2', jid: 'x@s' }] },
    { results: [{ id: 'de1', state: 'connecting' }] },
  ]);
  assert.strictEqual(merged.size, 3);
  assert.strictEqual(merged.get('ua1').state, 'logged_in');
  assert.strictEqual(merged.get('ua2').jid, 'x@s');
  assert.strictEqual(merged.get('de1').state, 'connecting');
});

test('__mergeDeviceMaps tolerates empty/missing results and empty input', () => {
  const { __mergeDeviceMaps } = require('../src/core/boot.js');
  assert.strictEqual(__mergeDeviceMaps([]).size, 0);
  assert.strictEqual(__mergeDeviceMaps([{}, { results: [] }, null]).size, 0);
});
