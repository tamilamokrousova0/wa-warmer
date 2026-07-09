#!/usr/bin/env node
// Генерирует content-seed/shared/voice/*.ogg — короткие украинские голосовые
// (voice notes) синтезом речи: macOS `say` голосом Lesya (uk_UA) → opus/ogg
// через ffmpeg (формат WhatsApp voice note). contentPack.ensure() засеет их в
// рабочую папку данных при первом старте.
//
// Требования (только macOS): встроенный `say` с голосом Lesya + `ffmpeg`
// (brew install ffmpeg). Реальную живую речь в свободном доступе не скачать —
// это синтез; при желании замените файлы своими .ogg-записями.
//
// Запуск: node scripts/seed-voice.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'content-seed', 'shared', 'voice');
const VOICE = 'Lesya'; // uk_UA

// короткие бытовые фразы в стиле голосового — приветствия, смолл-ток, реакции, планы
const PHRASES = [
  'Привіт! Як ти?', 'Доброго ранку! Гарного дня.', 'Привіт, як настрій?', 'Слухай, як справи?',
  'Що робиш зараз?', 'Ну що, як воно?', 'Давно тебе не чула, як ти?', 'Привіт-привіт, що нового?',
  'Як пройшов день?', 'Що плануєш на вечір?', 'Уже пообідав?', 'Каву будеш?',
  'Як робота, багато справ?', 'Ти вже вдома?', 'Ще не спиш?', 'Як вихідні минули?',
  'Дякую тобі велике!', 'Нема за що, звертайся.', 'Домовились, так і зробимо.', 'Добре, без проблем.',
  'Згодна повністю.', 'Ой, цікаво дуже.', 'Гарна ідея, мені подобається.', 'Звучить непогано.',
  'Зрозуміло, дякую.', 'Ясно, добре.', 'Та все нормально, не хвилюйся.', 'Все буде добре, побачиш.',
  'Хочеш прогуляємось трохи?', 'Може, зустрінемось завтра?', 'Давай зідзвонимось пізніше.', 'Пропоную сходити на каву.',
  'Я трохи втомилась сьогодні.', 'Нарешті вихідний, відпочиваю.', 'Сьогодні багато роботи було.', 'Тільки прокинулась, п’ю каву.',
  'Погода сьогодні гарна, правда?', 'На вулиці холодно, одягайся тепло.', 'Здається, буде дощ.', 'Сонце світить, так класно.',
  'Наберу тебе трохи згодом.', 'Передзвоню, коли звільнюсь.', 'Побачимось незабаром!', 'Гарного тобі вечора!',
  'На добраніч, гарних снів.', 'Бережи себе, добре?', 'Тримайся, все вийде.', 'Я скучила, давай побачимось.',
  'Ну розкажи, як ти там?', 'Що там у тебе цікавого?', 'Як здоров’я, все гаразд?', 'Радо тебе чути, чесно.',
];

function haveTool(cmd, args) {
  try { execFileSync(cmd, args, { stdio: 'ignore' }); return true; } catch { return false; }
}

function main() {
  if (process.platform !== 'darwin') {
    console.error('[seed-voice] нужен macOS (`say`). На другой ОС положите свои .ogg в content-seed/shared/voice/.');
    process.exit(1);
  }
  if (!haveTool('ffmpeg', ['-version'])) {
    console.error('[seed-voice] нет ffmpeg. Установите: brew install ffmpeg');
    process.exit(1);
  }
  fs.mkdirSync(OUT, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wavoice-'));
  let ok = 0;
  PHRASES.forEach((phrase, i) => {
    const n = String(i + 1).padStart(2, '0');
    const aiff = path.join(tmp, `${n}.aiff`);
    const ogg = path.join(OUT, `voice-${n}.ogg`);
    try {
      execFileSync('say', ['-v', VOICE, '-o', aiff, phrase]);
      // opus mono 32k — стандартный формат WhatsApp voice note
      execFileSync('ffmpeg', ['-y', '-i', aiff, '-c:a', 'libopus', '-b:a', '32k', '-ac', '1', ogg], { stdio: 'ignore' });
      ok += 1;
      process.stdout.write(`\r  ${ok}/${PHRASES.length}`);
    } catch (e) {
      console.error(`\n[seed-voice] пропущено ${n}: ${e.message}`);
    }
  });
  process.stdout.write('\n');
  fs.rmSync(tmp, { recursive: true, force: true });
  const count = fs.readdirSync(OUT).filter((f) => f.endsWith('.ogg')).length;
  console.log(`[seed-voice] готово: ${OUT} (${count} .ogg)`);
  if (ok < PHRASES.length * 0.9) process.exit(1);
}

main();
