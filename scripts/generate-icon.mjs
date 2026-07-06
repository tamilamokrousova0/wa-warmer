#!/usr/bin/env node
// Generates build/icon.png (1024x1024 RGBA): a glowing flame ("прогрев") on a
// dark rounded square. electron-builder derives the mac .icns and win .ico.
// Run: npm run icon
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'build', 'icon.png');

const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) { const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0); const body = Buffer.concat([Buffer.from(type, 'ascii'), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0); return Buffer.concat([len, body, crc]); }
function pngRGBA(w, h, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h); let o = 0;
  for (let y = 0; y < h; y++) { raw[o++] = 0; for (let x = 0; x < w; x++) { const i = (y * w + x) * 4; raw[o++] = rgba[i]; raw[o++] = rgba[i + 1]; raw[o++] = rgba[i + 2]; raw[o++] = rgba[i + 3]; } }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const lerp = (a, b, t) => a + (b - a) * t;
function roundRectSDF(px, py, x0, y0, x1, y1, r) {
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, hx = (x1 - x0) / 2 - r, hy = (y1 - y0) / 2 - r;
  const qx = Math.abs(px - cx) - hx, qy = Math.abs(py - cy) - hy;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

// flame silhouette: rounded bulb at the bottom + a wobbly spike tapering to a tip
function insideFlame(u, v, cx, cyB, R, tipY) {
  const wobble = 0.028 * Math.sin((cyB - v) * Math.PI * 2.3); // slight flicker
  if ((u - cx) ** 2 + (v - cyB) ** 2 <= R * R) return true; // bulb
  if (v <= cyB && v >= tipY) {
    const tt = (cyB - v) / (cyB - tipY); // 0 at bulb .. 1 at tip
    const halfW = R * Math.pow(1 - tt, 0.8);
    if (Math.abs(u - (cx + wobble * tt)) <= halfW) return true; // spike (tip leans a touch)
  }
  return false;
}

function shade(u, v) {
  if (roundRectSDF(u, v, 0.03, 0.03, 0.97, 0.97, 0.22) > 0) return [0, 0, 0, 0]; // transparent corners
  // dark charcoal background, a touch warmer at the top
  const t = clamp((v - 0.03) / 0.94, 0, 1);
  let col = [lerp(34, 14, t), lerp(24, 11, t), lerp(18, 9, t)];

  // soft warm glow around the flame center
  const gd = Math.hypot(u - 0.5, v - 0.6);
  const glow = clamp(1 - gd / 0.42, 0, 1) ** 2 * 0.5;
  col = [col[0] + glow * 200, col[1] + glow * 70, col[2] + glow * 10];

  const outer = insideFlame(u, v, 0.5, 0.66, 0.205, 0.19);
  if (outer) {
    const ft = clamp((v - 0.19) / (0.865 - 0.19), 0, 1); // 0 top .. 1 bottom
    col = [255, lerp(214, 88, ft), lerp(40, 0, ft)]; // yellow tip -> deep-orange base
  }
  if (insideFlame(u, v, 0.5, 0.68, 0.115, 0.37)) {
    const it = clamp((v - 0.37) / (0.795 - 0.37), 0, 1);
    col = [255, lerp(248, 150, it), lerp(190, 30, it)]; // bright core
  }
  return [Math.round(clamp(col[0], 0, 255)), Math.round(clamp(col[1], 0, 255)), Math.round(clamp(col[2], 0, 255)), 255];
}

const N = 1024, SS = 3;
const rgba = Buffer.alloc(N * N * 4);
for (let y = 0; y < N; y++) {
  for (let x = 0; x < N; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const [cr, cg, cb, ca] = shade((x + (sx + 0.5) / SS) / N, (y + (sy + 0.5) / SS) / N);
      r += cr * ca; g += cg * ca; b += cb * ca; a += ca;
    }
    const n = SS * SS, i = (y * N + x) * 4;
    rgba[i] = a ? Math.round(r / a) : 0; rgba[i + 1] = a ? Math.round(g / a) : 0; rgba[i + 2] = a ? Math.round(b / a) : 0; rgba[i + 3] = Math.round(a / n);
  }
}
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, pngRGBA(N, N, rgba));
console.log('Wrote', path.relative(ROOT, OUT));
