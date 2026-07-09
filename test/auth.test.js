'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const a = require('../src/server/auth.js');

// --- hashPassword / verifyPassword ---------------------------------------

test('hash/verify round-trip: correct password verifies', () => {
  const h = a.hashPassword('Correct-Horse-9!');
  assert.strictEqual(a.verifyPassword('Correct-Horse-9!', h), true);
});

test('hash/verify: wrong password fails', () => {
  const h = a.hashPassword('Correct-Horse-9!');
  assert.strictEqual(a.verifyPassword('wrong', h), false);
});

test('hash/verify: malformed stored string returns false, never throws', () => {
  assert.doesNotThrow(() => {
    assert.strictEqual(a.verifyPassword('anything', 'not-a-valid-hash'), false);
    assert.strictEqual(a.verifyPassword('anything', ''), false);
    assert.strictEqual(a.verifyPassword('anything', null), false);
    assert.strictEqual(a.verifyPassword('anything', undefined), false);
    assert.strictEqual(a.verifyPassword('anything', 'scrypt$onlyonepart'), false);
    assert.strictEqual(a.verifyPassword('anything', 'scrypt$zz$zz'), false);
    assert.strictEqual(a.verifyPassword('anything', 'bcrypt$aa$bb'), false);
  });
});

test('hashPassword rejects empty or whitespace-only passwords', () => {
  assert.throws(() => a.hashPassword(''));
  assert.throws(() => a.hashPassword('   '));
  assert.throws(() => a.hashPassword());
});

test('two hashes of the same password differ (random salt) yet both verify', () => {
  const h1 = a.hashPassword('same-password');
  const h2 = a.hashPassword('same-password');
  assert.notStrictEqual(h1, h2);
  assert.strictEqual(a.verifyPassword('same-password', h1), true);
  assert.strictEqual(a.verifyPassword('same-password', h2), true);
});

test('hashPassword output matches scrypt$salt$hash format', () => {
  const h = a.hashPassword('some-pass');
  const parts = h.split('$');
  assert.strictEqual(parts.length, 3);
  assert.strictEqual(parts[0], 'scrypt');
  assert.match(parts[1], /^[0-9a-f]+$/);
  assert.match(parts[2], /^[0-9a-f]+$/);
});

// --- rateLimiter -----------------------------------------------------------

test('rateLimiter: allows attempts under maxAttempts', () => {
  let clock = 1000;
  const rl = a.rateLimiter({ maxAttempts: 3, windowMs: 900000, now: () => clock });
  assert.strictEqual(rl.check('1.2.3.4').allowed, true);
  rl.fail('1.2.3.4');
  assert.strictEqual(rl.check('1.2.3.4').allowed, true);
  rl.fail('1.2.3.4');
  assert.strictEqual(rl.check('1.2.3.4').allowed, true);
});

test('rateLimiter: blocks after maxAttempts failures within window, with positive retryAfterMs', () => {
  let clock = 1000;
  const rl = a.rateLimiter({ maxAttempts: 3, windowMs: 900000, now: () => clock });
  rl.fail('1.2.3.4');
  rl.fail('1.2.3.4');
  rl.fail('1.2.3.4');
  const result = rl.check('1.2.3.4');
  assert.strictEqual(result.allowed, false);
  assert.ok(result.retryAfterMs > 0);
});

test('rateLimiter: unblocks after window elapses', () => {
  let clock = 1000;
  const rl = a.rateLimiter({ maxAttempts: 3, windowMs: 900000, now: () => clock });
  rl.fail('1.2.3.4');
  rl.fail('1.2.3.4');
  rl.fail('1.2.3.4');
  assert.strictEqual(rl.check('1.2.3.4').allowed, false);
  clock += 900001;
  assert.strictEqual(rl.check('1.2.3.4').allowed, true);
});

test('rateLimiter: reset clears failures immediately', () => {
  let clock = 1000;
  const rl = a.rateLimiter({ maxAttempts: 3, windowMs: 900000, now: () => clock });
  rl.fail('1.2.3.4');
  rl.fail('1.2.3.4');
  rl.fail('1.2.3.4');
  assert.strictEqual(rl.check('1.2.3.4').allowed, false);
  rl.reset('1.2.3.4');
  assert.strictEqual(rl.check('1.2.3.4').allowed, true);
});

test('rateLimiter: keys are independent', () => {
  let clock = 1000;
  const rl = a.rateLimiter({ maxAttempts: 2, windowMs: 900000, now: () => clock });
  rl.fail('1.1.1.1');
  rl.fail('1.1.1.1');
  assert.strictEqual(rl.check('1.1.1.1').allowed, false);
  assert.strictEqual(rl.check('2.2.2.2').allowed, true);
});

test('rateLimiter: defaults are maxAttempts=5, windowMs=900000', () => {
  let clock = 1000;
  const rl = a.rateLimiter({ now: () => clock });
  for (let i = 0; i < 4; i++) rl.fail('9.9.9.9');
  assert.strictEqual(rl.check('9.9.9.9').allowed, true);
  rl.fail('9.9.9.9');
  assert.strictEqual(rl.check('9.9.9.9').allowed, false);
});
