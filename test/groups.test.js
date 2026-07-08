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
