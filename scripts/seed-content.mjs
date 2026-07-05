#!/usr/bin/env node
// Generates the built-in content pack: a few placeholder images (PNG) plus
// content.json (message texts + links). Run: npm run seed-content
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PACK = path.join(ROOT, 'resources', 'content-pack');
const IMG = path.join(PACK, 'images');

// --- minimal PNG encoder (RGB, 8-bit, no external deps) ---
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function makePng(width, height, painter) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type RGB
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let o = 0;
  for (let y = 0; y < height; y++) {
    raw[o++] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const [r, g, b] = painter(x, y, width, height);
      raw[o++] = r; raw[o++] = g; raw[o++] = b;
    }
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// Distinct diagonal-gradient images so each looks different.
const PALETTE = [
  [ [46, 204, 113], [39, 174, 96] ],
  [ [52, 152, 219], [41, 128, 185] ],
  [ [155, 89, 182], [142, 68, 173] ],
  [ [241, 196, 15], [243, 156, 18] ],
  [ [231, 76, 60], [192, 57, 43] ],
];

fs.mkdirSync(IMG, { recursive: true });
const W = 640, H = 420;
const images = [];
PALETTE.forEach(([a, b], i) => {
  const name = String(i + 1).padStart(2, '0') + '.png';
  const png = makePng(W, H, (x, y) => {
    const t = (x / W + y / H) / 2;
    return [
      Math.round(a[0] + (b[0] - a[0]) * t),
      Math.round(a[1] + (b[1] - a[1]) * t),
      Math.round(a[2] + (b[2] - a[2]) * t),
    ];
  });
  fs.writeFileSync(path.join(IMG, name), png);
  images.push({ file: name, caption: '' });
});

const content = {
  texts: [
    'Привет! Как дела?',
    'Что нового?',
    'Как прошёл день?',
    'Ты сегодня занят?',
    'Давно не общались 🙂',
    'Смотри что нашёл',
    'Есть минутка?',
    'Как настроение?',
    'Что делаешь?',
    'Согласен, полностью поддерживаю',
    'Договорились, до связи',
    'Отличная идея!',
    'Спасибо, очень помогло',
    'Позже наберу тебя',
    'Ок, понял тебя',
    'Хорошего дня! ☀️',
    'Уже бегу',
    'Интересно, расскажи подробнее',
    'Ха-ха, отлично 😄',
    'Как погода у вас?',
  ],
  links: [
    'https://www.wikipedia.org',
    'https://www.weather.com',
    'https://www.nationalgeographic.com',
    'https://www.bbc.com/news',
    'https://www.goodreads.com',
  ],
  images,
};

fs.writeFileSync(path.join(PACK, 'content.json'), JSON.stringify(content, null, 2));
console.log(`Seeded ${images.length} images + content.json into ${path.relative(ROOT, PACK)}`);
