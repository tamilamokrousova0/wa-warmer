'use strict';
// User-managed content. On first run creates data/content-pack/ with empty
// messages.txt, links.txt, polls.txt and images/, voice/, stickers/ folders.
// Supports spintax ({a|b|c}) and light variation.
const fs = require('node:fs');
const path = require('node:path');
const { shell } = require('electron');
const paths = require('./paths');

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png']); // /send/image only accepts jpg/jpeg/png
const VOICE_EXT = new Set(['.ogg', '.mp3', '.m4a', '.opus', '.aac', '.wav']);
const STICKER_EXT = new Set(['.webp', '.png']);
const EMOJI = ['🙂', '😄', '👍', '✨', '🔥', '😉', '👌', '💬', '☀️', '😎'];

const MESSAGES_HEADER =
  '# По одному сообщению на строку. Пустые строки и строки с # игнорируются.\n' +
  '# Вариативность: "Привет {друг|дружище}! {Как дела|Что нового}?"\n';
const LINKS_HEADER = '# По одной ссылке на строку.\n';
const POLLS_HEADER =
  '# Опрос на строку: Вопрос? | вариант1 | вариант2 | вариант3\n' +
  '# Пример: Как дела? | отлично | нормально | так себе\n';

function ensure() {
  for (const d of [paths.contentImagesDir(), paths.contentVoiceDir(), paths.contentStickersDir()]) {
    fs.mkdirSync(d, { recursive: true });
  }
  if (!fs.existsSync(paths.messagesFile())) fs.writeFileSync(paths.messagesFile(), MESSAGES_HEADER);
  if (!fs.existsSync(paths.linksFile())) fs.writeFileSync(paths.linksFile(), LINKS_HEADER);
  if (!fs.existsSync(paths.pollsFile())) fs.writeFileSync(paths.pollsFile(), POLLS_HEADER);
}

function readLines(file) {
  try {
    return fs.readFileSync(file, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  } catch { return []; }
}
function listFiles(dir, extSet) {
  try {
    return fs.readdirSync(dir).filter((f) => extSet.has(path.extname(f).toLowerCase())).map((f) => path.join(dir, f));
  } catch { return []; }
}

let cache = null;
function load() {
  ensure();
  const polls = readLines(paths.pollsFile())
    .map((line) => line.split('|').map((s) => s.trim()).filter(Boolean))
    .filter((parts) => parts.length >= 3)
    .map((parts) => ({ question: parts[0], options: parts.slice(1) }));
  cache = {
    texts: readLines(paths.messagesFile()),
    links: readLines(paths.linksFile()),
    images: listFiles(paths.contentImagesDir(), IMAGE_EXT),
    voice: listFiles(paths.contentVoiceDir(), VOICE_EXT),
    stickers: listFiles(paths.contentStickersDir(), STICKER_EXT),
    polls,
  };
  return cache;
}
function get() { return cache || load(); }
function reload() { cache = null; return load(); }

function counts() {
  const c = get();
  return {
    messages: c.texts.length, links: c.links.length, images: c.images.length,
    voice: c.voice.length, stickers: c.stickers.length, polls: c.polls.length,
  };
}
function openFolder() { ensure(); return shell.openPath(paths.contentDir()); }

const pickOne = (arr) => arr[Math.floor(Math.random() * arr.length)];

function expandSpintax(text) {
  let out = text, guard = 0; const re = /\{([^{}]*)\}/;
  while (re.test(out) && guard++ < 20) out = out.replace(re, (_m, g) => pickOne(g.split('|')));
  return out;
}
// invisible zero-width characters used to make each message byte-unique
const ZERO_WIDTH = ['​', '‌', '‍', '⁠', '﻿'];
function noiseSuffix() {
  const n = 2 + Math.floor(Math.random() * 5); // 2–6 invisible chars (many combinations)
  let s = '';
  for (let i = 0; i < n; i++) s += pickOne(ZERO_WIDTH);
  return ' ' + s; // separated by a space, per request
}

function varyText(text, cfg = {}) {
  let t = expandSpintax(text);
  if (Math.random() < 0.25) t += ' ' + pickOne(EMOJI);
  if (cfg.textNoise !== false) t += noiseSuffix(); // unique-ify each message (invisible)
  return t;
}
function pickText(recent = new Set()) {
  const c = get();
  if (c.texts.length === 0) return null;
  const fresh = c.texts.filter((t) => !recent.has(t));
  return pickOne(fresh.length ? fresh : c.texts);
}

// Returns { type, message?, filePath?, caption?, poll?, sourceText? }
function pick(config = {}, recent = new Set()) {
  const c = get();
  const on = (flag, arr) => config[flag] !== false && arr.length > 0;
  const w = {
    text: 0.6,
    image: on('imagesEnabled', c.images) ? 0.12 : 0,
    link: on('linksEnabled', c.links) ? 0.08 : 0,
    voice: on('voiceEnabled', c.voice) ? 0.08 : 0,
    sticker: on('stickersEnabled', c.stickers) ? 0.07 : 0,
    poll: on('pollsEnabled', c.polls) ? 0.05 : 0,
  };
  const total = Object.values(w).reduce((a, b) => a + b, 0);
  if (total === 0) return null;
  let r = Math.random() * total;
  for (const [type, weight] of Object.entries(w)) {
    if (weight <= 0) continue;
    if ((r -= weight) < 0) {
      if (type === 'text') { const s = pickText(recent); return s ? { type, message: varyText(s, config), sourceText: s } : null; }
      if (type === 'image') { const s = pickText(recent); return { type, filePath: pickOne(c.images), caption: s ? varyText(s, config) : '', sourceText: s }; }
      if (type === 'link') { const s = pickText(recent); return { type: 'text', message: `${s ? varyText(s, config) : ''} ${pickOne(c.links)}`.trim(), sourceText: s }; }
      if (type === 'voice') return { type, filePath: pickOne(c.voice) };
      if (type === 'sticker') return { type, filePath: pickOne(c.stickers) };
      if (type === 'poll') { const p = pickOne(c.polls); return { type, poll: p }; }
    }
  }
  const s = pickText(recent);
  return s ? { type: 'text', message: varyText(s, config), sourceText: s } : null;
}

module.exports = { ensure, load, reload, get, counts, openFolder, pick };
