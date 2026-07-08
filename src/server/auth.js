'use strict';

// Аутентификация панели: хеширование/проверка пароля (scrypt) и rate-limiter
// попыток входа. Модуль не зависит от веб-фреймворка (Fastify подключается
// отдельно в Task 10) — здесь только чистые Node-примитивы.

const crypto = require('node:crypto');

// --- Параметры scrypt -------------------------------------------------
// N=16384 (2^14), r=8, p=1 — рекомендуемые OWASP-минимумы для интерактивного
// логина (не для файлового шифрования), дают ~лёгкую задержку на обычном
// железе, но затрудняют offline-брутфорс. keylen=64 байта хеша.
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;
const SALT_BYTES = 16;

/**
 * Хеширует пароль со случайной солью.
 * Формат результата: scrypt$<saltHex>$<hashHex>
 * @param {string} pw
 * @returns {string}
 */
function hashPassword(pw) {
  if (typeof pw !== 'string' || pw.trim().length === 0) {
    throw new Error('Password must be a non-empty string');
  }
  const salt = crypto.randomBytes(SALT_BYTES);
  const hash = crypto.scryptSync(pw, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

/**
 * Проверяет пароль против сохранённой строки формата scrypt$salt$hash.
 * Никогда не бросает исключение — любая некорректность возвращает false.
 * @param {string} pw
 * @param {string} stored
 * @returns {boolean}
 */
function verifyPassword(pw, stored) {
  try {
    if (typeof pw !== 'string' || typeof stored !== 'string') return false;

    const parts = stored.split('$');
    if (parts.length !== 3) return false;
    const [scheme, saltHex, hashHex] = parts;
    if (scheme !== 'scrypt') return false;
    if (!/^[0-9a-f]+$/i.test(saltHex) || !/^[0-9a-f]+$/i.test(hashHex)) return false;

    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(hashHex, 'hex');
    if (salt.length === 0 || expected.length === 0) return false;

    const actual = crypto.scryptSync(pw, salt, expected.length, {
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
    });

    // timingSafeEqual требует равной длины буферов — иначе кинет исключение,
    // что мы уже перехватываем через try/catch выше.
    if (actual.length !== expected.length) return false;
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/**
 * Создаёт in-memory rate-limiter попыток входа по ключу (например, IP).
 * @param {{ maxAttempts?: number, windowMs?: number, now?: () => number }} opts
 */
function rateLimiter({ maxAttempts = 5, windowMs = 900000, now = () => Date.now() } = {}) {
  // key -> { count: number, firstFailAt: number }
  const attempts = new Map();

  function check(key) {
    const entry = attempts.get(key);
    if (!entry) return { allowed: true };

    const elapsed = now() - entry.firstFailAt;
    if (elapsed >= windowMs) {
      // Окно истекло — считаем, что блокировки больше нет (запись подчистится
      // при следующем fail/reset).
      return { allowed: true };
    }

    if (entry.count < maxAttempts) {
      return { allowed: true };
    }

    return { allowed: false, retryAfterMs: windowMs - elapsed };
  }

  function fail(key) {
    const entry = attempts.get(key);
    const t = now();
    if (!entry || t - entry.firstFailAt >= windowMs) {
      // Новое окно
      attempts.set(key, { count: 1, firstFailAt: t });
      return;
    }
    entry.count += 1;
  }

  function reset(key) {
    attempts.delete(key);
  }

  return { check, fail, reset };
}

// --- Сессионная кука ---------------------------------------------------
// Имя и значение подписанной httpOnly-куки сессии. Подпись/проверка делаются
// плагином @fastify/cookie (req.unsignCookie / reply.setCookie{signed:true}),
// секрет задаётся при регистрации плагина в server.js. Здесь — только имя,
// «полезная нагрузка» и preHandler-страж.
const SESSION_COOKIE = 'wa_panel';
const SESSION_VALUE = 'authenticated';

// Опции для reply.setCookie при успешном логине.
function sessionCookieOptions() {
  return { signed: true, httpOnly: true, sameSite: 'lax', path: '/' };
}

/**
 * Fastify preHandler: пропускает запрос только при валидной подписанной куке.
 * Иначе отвечает 401 и завершает запрос. Требует зарегистрированный
 * @fastify/cookie (req.cookies + req.unsignCookie).
 */
async function requireSession(req, reply) {
  const raw = req.cookies && req.cookies[SESSION_COOKIE];
  if (!raw) return reply.code(401).send({ error: 'unauthorized' });
  const un = req.unsignCookie(raw);
  if (!un.valid || un.value !== SESSION_VALUE) {
    return reply.code(401).send({ error: 'unauthorized' });
  }
  return undefined; // валидна — пропускаем дальше
}

module.exports = {
  hashPassword,
  verifyPassword,
  rateLimiter,
  requireSession,
  sessionCookieOptions,
  SESSION_COOKIE,
  SESSION_VALUE,
};
