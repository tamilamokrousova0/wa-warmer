'use strict';
// normalizeProxy: «голый» host:port (как отдаёт 9Proxy) → socks5://; URL со схемой
// проходит без изменений; пустое остаётся пустым.
const { test } = require('node:test');
const assert = require('node:assert');
const proxyTest = require('../src/main/proxyTest.js');

test('normalizeProxy prepends socks5:// to a bare host:port', () => {
  assert.strictEqual(proxyTest.normalizeProxy('127.0.0.1:3001'), 'socks5://127.0.0.1:3001');
});

test('normalizeProxy passes through URLs that already have a scheme', () => {
  for (const s of ['socks5://h:1', 'socks5h://h:1', 'socks4://h:1', 'http://h:1', 'https://h:1']) {
    assert.strictEqual(proxyTest.normalizeProxy(s), s);
  }
});

test('normalizeProxy returns empty for empty/whitespace input', () => {
  assert.strictEqual(proxyTest.normalizeProxy(''), '');
  assert.strictEqual(proxyTest.normalizeProxy('   '), '');
  assert.strictEqual(proxyTest.normalizeProxy(null), '');
});

test('validate normalizes first and returns the normalized proxy', () => {
  const v = proxyTest.validate('127.0.0.1:3001');
  assert.strictEqual(v.proxy, 'socks5://127.0.0.1:3001');
  assert.ok(!v.error);
});
