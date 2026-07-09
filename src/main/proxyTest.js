'use strict';
// Checks that a proxy URL is reachable and reports the IP it exits from, so the
// user can confirm a proxy works *before* restarting the engine through it.
// Uses the system `curl` (present on macOS and Windows 10+) to avoid adding a
// SOCKS-capable dependency to the portable build. This mirrors, but is not
// identical to, the connection GOWA/whatsmeow makes — it only proves the proxy
// carries traffic and shows the visible IP.
const { execFile } = require('node:child_process');

const ALLOWED_SCHEMES = ['socks5://', 'socks5h://', 'socks4://', 'http://', 'https://'];

// 9Proxy и подобные отдают «голый» host:port без схемы, а движку нужна схема.
// Пустая строка остаётся пустой (= прямое соединение); значение со схемой — как есть;
// иначе считаем это SOCKS5 и подставляем socks5://.
function normalizeProxy(s) {
  const p = String(s || '').trim();
  if (!p) return '';
  if (ALLOWED_SCHEMES.some((sc) => p.toLowerCase().startsWith(sc))) return p;
  return `socks5://${p}`;
}

// прокси указывает на локальную машину (127.0.0.1 / localhost / ::1)?
// такие адреса типичны для 9Proxy и подобных «forward proxy to port» приложений.
function isLocalProxy(proxy) {
  let host = '';
  try { host = new URL(proxy).hostname; } catch { /* нестандартная схема — парсим вручную */ }
  if (!host) {
    const m = /(?:@|\/\/)([^@/:]+):\d+/.exec(String(proxy));
    host = m ? m[1] : '';
  }
  host = host.replace(/^\[|\]$/g, '').toLowerCase();
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

function validate(proxy) {
  const p = normalizeProxy(proxy);
  if (!p) return { error: 'Прокси не задан' };
  if (!ALLOWED_SCHEMES.some((s) => p.toLowerCase().startsWith(s))) {
    return { error: 'Нужен URL со схемой: socks5://, http:// или https://' };
  }
  return { proxy: p };
}

function curl(args, timeoutMs = 30000) {
  return new Promise((resolve) => {
    execFile('curl', args, { timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
      resolve({ err, out: String(stdout || '').trim() });
    });
  });
}

// Returns { ok, ip, country, city, isp } or { ok:false, error }.
async function testProxy(proxy) {
  const v = validate(proxy);
  if (v.error) return { ok: false, error: v.error };

  const ipRes = await curl(['-s', '--max-time', '25', '--proxy', v.proxy, 'https://api.ipify.org']);
  const ip = ipRes.out;
  if (!ip || !/^[0-9a-f.:]+$/i.test(ip)) {
    if (isLocalProxy(v.proxy)) {
      return { ok: false, error: 'Прокси не отвечает. Для 9Proxy: запустите приложение и привяжите IP к этому порту (Forward proxy to port), протокол SOCKS5.' };
    }
    return { ok: false, error: 'Прокси не отвечает или неверные данные' };
  }

  // Geo lookup goes direct (not through the proxy) — it only labels the exit IP.
  let geo = {};
  try {
    const g = await curl(['-s', '--max-time', '10', `http://ip-api.com/json/${ip}?fields=country,city,isp`], 12000);
    geo = JSON.parse(g.out || '{}');
  } catch { /* geo is best-effort */ }

  return { ok: true, ip, country: geo.country || '', city: geo.city || '', isp: geo.isp || '' };
}

module.exports = { testProxy, validate, normalizeProxy, isLocalProxy };
