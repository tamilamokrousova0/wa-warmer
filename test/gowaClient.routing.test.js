'use strict';
// gowaClient no longer talks to a single module-global baseUrl: every request
// resolves its target engine (baseUrl + auth) via engineRouter, keyed by the
// device (existing account) or the group (new device with no id yet).
const { test } = require('node:test');
const assert = require('node:assert');

const ROUTER_PATH = require.resolve('../src/main/engineRouter.js');
const CLIENT_PATH = require.resolve('../src/main/gowaClient.js');

// Replace engineRouter in the require cache with a fake before gowaClient is
// (re)loaded, so `require('./engineRouter')` inside gowaClient resolves to it.
function loadClientWithRouter(fakeRouter) {
  require.cache[ROUTER_PATH] = { id: ROUTER_PATH, filename: ROUTER_PATH, loaded: true, exports: fakeRouter };
  delete require.cache[CLIENT_PATH];
  return require('../src/main/gowaClient.js');
}

function cleanup(originalFetch) {
  delete require.cache[ROUTER_PATH];
  delete require.cache[CLIENT_PATH];
  global.fetch = originalFetch;
}

test('status(deviceId) routes to the device engine via router.forDevice', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => cleanup(originalFetch));
  const eng = { baseUrl: 'http://127.0.0.1:9001', auth: 'Basic ZDE6cA==' };
  const client = loadClientWithRouter({
    forDevice: (id) => (id === 'd1' ? eng : null),
    forGroup: () => null,
  });

  let captured = null;
  global.fetch = async (url, opts) => {
    captured = { url, opts };
    return { ok: true, status: 200, text: async () => '{}' };
  };

  await client.status('d1');

  assert.strictEqual(captured.url, `${eng.baseUrl}/app/status`);
  assert.strictEqual(captured.opts.headers.Authorization, eng.auth);
  assert.strictEqual(captured.opts.headers['X-Device-Id'], 'd1');
});

test('createDevice(groupId, name) routes to the group engine via router.forGroup', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => cleanup(originalFetch));
  const eng = { baseUrl: 'http://127.0.0.1:9002', auth: 'Basic ZGU6cA==' };
  const client = loadClientWithRouter({
    forDevice: () => null,
    forGroup: (gid) => (gid === 'de' ? eng : null),
  });

  let captured = null;
  global.fetch = async (url, opts) => {
    captured = { url, opts };
    return { ok: true, status: 200, text: async () => '{}' };
  };

  await client.createDevice('de', 'x');

  assert.strictEqual(captured.url, `${eng.baseUrl}/devices`);
  assert.strictEqual(captured.opts.method, 'POST');
  assert.strictEqual(captured.opts.headers.Authorization, eng.auth);
  assert.strictEqual(JSON.parse(captured.opts.body).display_name, 'x');
});

test('request() throws a clear error when no engine resolves', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => cleanup(originalFetch));
  const client = loadClientWithRouter({ forDevice: () => null, forGroup: () => null });
  global.fetch = async () => { throw new Error('fetch must not be called'); };

  await assert.rejects(() => client.status('ghost'));
});

test('authHeaderFor(deviceId) returns the device engine auth header', (t) => {
  t.after(() => cleanup(global.fetch));
  const eng = { baseUrl: 'http://127.0.0.1:9003', auth: 'Basic Zm9vOmJhcg==' };
  const client = loadClientWithRouter({
    forDevice: (id) => (id === 'd9' ? eng : null),
    forGroup: () => null,
  });
  assert.strictEqual(client.authHeaderFor('d9'), eng.auth);
  assert.strictEqual(client.authHeaderFor('unknown'), null);
});
