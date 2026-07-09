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

test('isLocalProxy detects 127.0.0.1/localhost/::1 (incl. with auth), not remote hosts', () => {
  for (const p of ['socks5://127.0.0.1:60000', 'socks5://user:pass@127.0.0.1:60000',
    'socks5://localhost:60000', 'http://[::1]:8080', '127.0.0.1:3001']) {
    assert.ok(proxyTest.isLocalProxy(proxyTest.normalizeProxy(p)), `${p} should be local`);
  }
  for (const p of ['socks5://1.2.3.4:1080', 'http://proxy.example.com:8080']) {
    assert.ok(!proxyTest.isLocalProxy(p), `${p} should be remote`);
  }
});

test('toRemoteDns forces socks5 -> socks5h (remote DNS), leaves others as-is', () => {
  assert.strictEqual(proxyTest.toRemoteDns('socks5://user:pass@host:1080'), 'socks5h://user:pass@host:1080');
  assert.strictEqual(proxyTest.toRemoteDns('SOCKS5://host:1080'), 'socks5h://host:1080');
  assert.strictEqual(proxyTest.toRemoteDns('socks5h://host:1080'), 'socks5h://host:1080');
  assert.strictEqual(proxyTest.toRemoteDns('http://host:8080'), 'http://host:8080');
  assert.strictEqual(proxyTest.toRemoteDns('https://host:8080'), 'https://host:8080');
});
