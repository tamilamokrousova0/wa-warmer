#!/usr/bin/env node
// Скачивает N бесплатных картинок (Lorem Picsum, отдаёт фото из Unsplash) в
// content-seed/shared/images/ — общий набор картинок для отправки при прогреве.
// contentPack.ensure() засеет их в рабочую папку данных при первом старте.
// Запуск: node scripts/fetch-images.mjs [count]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'content-seed', 'shared', 'images');
const COUNT = Math.max(1, parseInt(process.argv[2] || '100', 10));
const SIZE = 640;

fs.mkdirSync(OUT, { recursive: true });

async function fetchOne(i) {
  const dest = path.join(OUT, `img-${String(i).padStart(3, '0')}.jpg`);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 2000) return 'skip';
  // seed делает картинку стабильной для номера i; /SIZE/SIZE — квадрат
  const url = `https://picsum.photos/seed/wa-${i}/${SIZE}/${SIZE}.jpg`;
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 2000) throw new Error('too small');
  fs.writeFileSync(dest, buf);
  return 'ok';
}

let ok = 0, skip = 0, fail = 0;
// небольшими пачками, чтобы не долбить хост
for (let i = 1; i <= COUNT; i += 8) {
  const batch = [];
  for (let j = i; j < Math.min(i + 8, COUNT + 1); j++) batch.push(
    fetchOne(j).then((r) => { r === 'skip' ? skip++ : ok++; }).catch(() => { fail++; })
  );
  await Promise.all(batch);
  process.stdout.write(`\r  ${ok + skip}/${COUNT} (ok ${ok}, skip ${skip}, fail ${fail})`);
}
process.stdout.write('\n');
console.log(`[fetch-images] готово: ${OUT} (${fs.readdirSync(OUT).filter((f) => f.endsWith('.jpg')).length} файлов)`);
if (ok + skip < COUNT * 0.9) { console.error('[fetch-images] слишком много ошибок'); process.exit(1); }
