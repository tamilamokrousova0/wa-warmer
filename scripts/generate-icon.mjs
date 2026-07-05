#!/usr/bin/env node
// Generates build/icon.png (1024x1024 RGBA) — a WhatsApp-green rounded square
// with a white chat bubble and three "typing" dots. electron-builder derives
// the mac .icns and win .ico from it automatically. Run: npm run icon
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
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((w * 4 + 1) * h); let o = 0;
  for (let y = 0; y < h; y++) { raw[o++] = 0; for (let x = 0; x < w; x++) { const i = (y * w + x) * 4; raw[o++] = rgba[i]; raw[o++] = rgba[i + 1]; raw[o++] = rgba[i + 2]; raw[o++] = rgba[i + 3]; } }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// signed distance to a rounded rectangle centered box [x0,y0,x1,y1], corner r
function roundRectSDF(px, py, x0, y0, x1, y1, r) {
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const hx = (x1 - x0) / 2 - r, hy = (y1 - y0) / 2 - r;
  const qx = Math.abs(px - cx) - hx, qy = Math.abs(py - cy) - hy;
  const ax = Math.max(qx, 0), ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r;
}
function lerp(a, b, t) { return a + (b - a) * t; }

// evaluate final color at normalized coords (0..1), supersampled outside
function shade(u, v) {
  // background rounded square (full-bleed with rounded corners)
  const bg = roundRectSDF(u, v, 0.03, 0.03, 0.97, 0.97, 0.22);
  if (bg > 0) return [0, 0, 0, 0];
  // green vertical gradient
  const t = Math.min(1, Math.max(0, (v - 0.03) / 0.94));
  let col = [Math.round(lerp(37, 18, t)), Math.round(lerp(211, 140, t)), Math.round(lerp(102, 126, t)), 255];

  // chat bubble (white) with a tail
  const bubble = roundRectSDF(u, v, 0.24, 0.28, 0.76, 0.64, 0.10);
  const inTail = v > 0.60 && v < 0.74 && u > 0.30 && u < 0.30 + (0.74 - v) * 1.1;
  if (bubble < 0 || inTail) {
    col = [255, 255, 255, 255];
    // three "typing" dots
    const dy = 0.46;
    for (const dx of [0.37, 0.50, 0.63]) {
      if (Math.hypot(u - dx, v - dy) < 0.035) col = [37, 180, 96, 255];
    }
  }
  return col;
}

const N = 1024, SS = 2;
const rgba = Buffer.alloc(N * N * 4);
for (let y = 0; y < N; y++) {
  for (let x = 0; x < N; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const u = (x + (sx + 0.5) / SS) / N, v = (y + (sy + 0.5) / SS) / N;
      const [cr, cg, cb, ca] = shade(u, v);
      r += cr * ca; g += cg * ca; b += cb * ca; a += ca;
    }
    const n = SS * SS; const i = (y * N + x) * 4;
    rgba[i] = a ? Math.round(r / a) : 0; rgba[i + 1] = a ? Math.round(g / a) : 0; rgba[i + 2] = a ? Math.round(b / a) : 0; rgba[i + 3] = Math.round(a / n);
  }
}
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, pngRGBA(N, N, rgba));
console.log('Wrote', path.relative(ROOT, OUT));
