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

test('isReadyDay true at day 10, false at day 9', () => {
  assert.strictEqual(sch.__isReadyDay(mk('a', 'ua', 10), cfg), true);
  assert.strictEqual(sch.__isReadyDay(mk('a', 'ua', 9), cfg), false);
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
