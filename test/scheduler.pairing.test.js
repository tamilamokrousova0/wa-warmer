'use strict';
// Тесты страна-центричной логики прогрева: подбор пар по стране + буст в дни 9–10,
// признак «готов» и множитель дневной нормы для aux-групп. Используем тестовый seam
// `__day`, чтобы не зависеть от реального `addedAt`/времени.
const { test } = require('node:test');
const assert = require('node:assert');
const sch = require('../src/main/scheduler.js');
const { DEFAULT_GROUPS } = require('../src/main/groups.js');

const cfg = {
  warmDays: 10,
  crossCountryBoost: true,
  dailyCap: 10,
  rampUpDays: 7,
  groups: DEFAULT_GROUPS,
};
// __day — тестовый seam для dayOf(); groupId — как у реальных аккаунтов
const mk = (id, group, day) => ({ deviceId: id, groupId: group, __day: day });

test('same-country pair allowed on an early day (day 3)', () => {
  assert.strictEqual(sch.__canPair(mk('a', 'ua', 3), mk('b', 'ua', 3), cfg), true);
});

test('cross-country pair NOT allowed on day 3', () => {
  assert.strictEqual(sch.__canPair(mk('a', 'ua', 3), mk('c', 'de', 3), cfg), false);
});

test('cross-country pair allowed when BOTH on day 9', () => {
  assert.strictEqual(sch.__canPair(mk('a', 'ua', 9), mk('c', 'de', 9), cfg), true);
});

test('cross-country NOT allowed if only one is in the last-two-days window', () => {
  assert.strictEqual(sch.__canPair(mk('a', 'ua', 9), mk('c', 'de', 3), cfg), false);
  assert.strictEqual(sch.__canPair(mk('a', 'ua', 3), mk('c', 'de', 10), cfg), false);
});

test('cross-country disabled entirely when crossCountryBoost is false', () => {
  const noBoost = { ...cfg, crossCountryBoost: false };
  assert.strictEqual(sch.__canPair(mk('a', 'ua', 9), mk('c', 'de', 9), noBoost), false);
  // одна группа всё равно разрешена
  assert.strictEqual(sch.__canPair(mk('a', 'ua', 9), mk('b', 'ua', 9), noBoost), true);
});

test('isReadyDay false at day 10 (still warms+boosts), true at day 11', () => {
  assert.strictEqual(sch.__isReadyDay(mk('a', 'ua', 10), cfg), false);
  assert.strictEqual(sch.__isReadyDay(mk('a', 'ua', 11), cfg), true);
  assert.strictEqual(sch.__isReadyDay(mk('a', 'ua', 9), cfg), false);
});

test('isSettled respects reloggedAt pause (reloginSettleHours)', () => {
  const c = { settleHours: 0, reloginSettleHours: 6 };
  // без reloggedAt — сеттлед (settleHours=0)
  assert.strictEqual(sch.__isSettled({ addedAt: 0 }, c), true);
  // свежий ре-логин — ещё не сеттлед
  assert.strictEqual(sch.__isSettled({ addedAt: 0, reloggedAt: Date.now() }, c), false);
  // ре-логин >6ч назад — снова сеттлед
  assert.strictEqual(sch.__isSettled({ addedAt: 0, reloggedAt: Date.now() - 7 * 3600000 }, c), true);
});

test('phaseOf: settle → intra → boost → ready across the warm window', () => {
  const c = { ...cfg, settleHours: 12, reloginSettleHours: 6 };
  assert.strictEqual(sch.__phaseOf({ ...mk('a', 'ua', 3), addedAt: 0, reloggedAt: Date.now() }, c), 'settle');
  assert.strictEqual(sch.__phaseOf({ ...mk('a', 'ua', 3), addedAt: 0 }, c), 'intra');
  assert.strictEqual(sch.__phaseOf({ ...mk('a', 'ua', 9), addedAt: 0 }, c), 'boost');
  assert.strictEqual(sch.__phaseOf({ ...mk('a', 'ua', 11), addedAt: 0 }, c), 'ready');
});

test('capFor halves for an aux-group account vs a primary account (mid-ramp)', () => {
  const aux = sch.__capFor(mk('d', 'de', 4), cfg); // de = aux
  const prim = sch.__capFor(mk('p', 'ua', 4), cfg); // ua = primary
  assert.ok(aux < prim, `aux ${aux} should be < primary ${prim} on a mid-ramp day`);
});

test('capFor respects the min-2 floor for aux even on early days', () => {
  assert.ok(sch.__capFor(mk('e', 'de', 1), cfg) >= 2);
  assert.ok(sch.__capFor(mk('e', 'de', 4), cfg) >= 2);
});

// ---- ручные оверрайды этапа: skipSettle / forceBoost ----
test('skipSettle: isSettled true even with a just-added account (settleHours>0)', () => {
  const c = { settleHours: 12, reloginSettleHours: 6 };
  // без оверрайда свежий аккаунт ещё не сеттлед…
  assert.strictEqual(sch.__isSettled({ addedAt: Date.now() }, c), false);
  // …а с skipSettle — сразу сеттлед
  assert.strictEqual(sch.__isSettled({ addedAt: Date.now(), skipSettle: true }, c), true);
  // skipSettle перекрывает и окно ре-логина
  assert.strictEqual(sch.__isSettled({ addedAt: 0, reloggedAt: Date.now(), skipSettle: true }, c), true);
});

test('forceBoost: cross-country pair allowed on an early day when BOTH forceBoost', () => {
  const a = { ...mk('a', 'ua', 3), forceBoost: true };
  const b = { ...mk('c', 'de', 3), forceBoost: true };
  assert.strictEqual(sch.__canPair(a, b, cfg), true);
});

test('forceBoost: cross-country still DISALLOWED when only one has forceBoost (other early)', () => {
  const a = { ...mk('a', 'ua', 3), forceBoost: true };
  const b = mk('c', 'de', 3); // раннее, без оверрайда
  assert.strictEqual(sch.__canPair(a, b, cfg), false);
  assert.strictEqual(sch.__canPair(b, a, cfg), false);
});

test('inBoostWindow: true for late day OR forceBoost, false for early day', () => {
  assert.strictEqual(sch.inBoostWindow(mk('a', 'ua', 3), cfg), false);
  assert.strictEqual(sch.inBoostWindow(mk('a', 'ua', 9), cfg), true);
  assert.strictEqual(sch.inBoostWindow({ ...mk('a', 'ua', 3), forceBoost: true }, cfg), true);
});

test('phaseOf: forceBoost early+settled → boost; early not-settled stays settle', () => {
  const c = { ...cfg, settleHours: 12, reloginSettleHours: 6 };
  // ранний день, settled (addedAt в прошлом), forceBoost → boost
  assert.strictEqual(sch.__phaseOf({ ...mk('a', 'ua', 3), addedAt: 0, forceBoost: true }, c), 'boost');
  // ранний день, свежий ре-логин (не settled), forceBoost, но НЕ skipSettle → всё ещё settle
  assert.strictEqual(sch.__phaseOf({ ...mk('a', 'ua', 3), addedAt: 0, reloggedAt: Date.now(), forceBoost: true }, c), 'settle');
  // добавив skipSettle — прорывается в boost
  assert.strictEqual(sch.__phaseOf({ ...mk('a', 'ua', 3), addedAt: 0, reloggedAt: Date.now(), forceBoost: true, skipSettle: true }, c), 'boost');
});
