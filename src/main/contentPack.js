'use strict';
// User-managed content, per country-group. On first run creates
// data/content-pack/<ua|de|pl|uk>/ with messages.txt + links.txt (seeded from
// the repo's content-seed/ when available) and data/content-pack/shared/
// with images/, voice/ (shared media across all groups).
// Supports spintax ({a|b|c}), emoji variation and invisible text uniqueness.
const fs = require('node:fs');
const path = require('node:path');
const paths = require('./paths');
const { DEFAULT_GROUPS, contentGroupIdForLang } = require('./groups');

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png']); // /send/image only accepts jpg/jpeg/png
const VOICE_EXT = new Set(['.ogg', '.mp3', '.m4a', '.opus', '.aac', '.wav']);
const EMOJI = ['🙂', '😄', '👍', '✨', '🔥', '😉', '👌', '💬', '☀️', '😎'];

const GROUP_IDS = DEFAULT_GROUPS.map((g) => g.id); // ['ua','de','pl','uk']

const MESSAGES_HEADER =
  '# По одному сообщению на строку. Пустые строки и строки с # игнорируются.\n' +
  '# Вариативность: "Привет {друг|дружище}! {Как дела|Что нового}?"\n';
const LINKS_HEADER = '# По одной ссылке на строку.\n';

// строка считается "реальным" контентом, если это не пустая строка и не комментарий
function hasRealContent(file) {
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .some((l) => { const t = l.trim(); return t && !t.startsWith('#'); });
  } catch { return false; }
}

// перенос файла в новое место, только если там ещё ничего нет (не затираем групповой контент)
function moveFileIfNoDest(src, dest) {
  if (!fs.existsSync(src) || fs.existsSync(dest)) return;
  try { fs.renameSync(src, dest); } catch { /* best-effort */ }
}

// перенос содержимого папки (без затирания уже существующих файлов в назначении)
function moveDirContents(srcDir, destDir) {
  if (!fs.existsSync(srcDir)) return;
  fs.mkdirSync(destDir, { recursive: true });
  let entries = [];
  try { entries = fs.readdirSync(srcDir); } catch { return; }
  for (const name of entries) {
    const src = path.join(srcDir, name);
    const dest = path.join(destDir, name);
    try {
      if (fs.statSync(src).isFile() && !fs.existsSync(dest)) fs.renameSync(src, dest);
    } catch { /* best-effort */ }
  }
  try { fs.rmdirSync(srcDir); } catch { /* not empty (leftovers) or already gone — ignore */ }
}

// миграция старого плоского формата (до разбивки по группам) → ua/ + shared/
function migrateLegacyFlatLayout() {
  fs.mkdirSync(path.dirname(paths.messagesFile('ua')), { recursive: true });
  moveFileIfNoDest(path.join(paths.contentDir(), 'messages.txt'), paths.messagesFile('ua'));
  moveFileIfNoDest(path.join(paths.contentDir(), 'links.txt'), paths.linksFile('ua'));
  moveDirContents(path.join(paths.contentDir(), 'images'), paths.sharedImagesDir());
  moveDirContents(path.join(paths.contentDir(), 'voice'), paths.sharedVoiceDir());
}

// заполняем messages.txt группы из content-seed/<groupId>/messages.txt, если файл
// отсутствует или пуст (реального контента нет); существующий пользовательский
// контент никогда не перезаписываем.
function seedMessagesIfEmpty(groupId) {
  const dest = paths.messagesFile(groupId);
  if (hasRealContent(dest)) return;
  const seed = path.join(__dirname, '..', '..', 'content-seed', groupId, 'messages.txt');
  if (fs.existsSync(seed)) {
    try { fs.copyFileSync(seed, dest); return; } catch { /* fall through to header */ }
  }
  if (!fs.existsSync(dest)) fs.writeFileSync(dest, MESSAGES_HEADER);
}

function ensure() {
  fs.mkdirSync(paths.contentDir(), { recursive: true });
  migrateLegacyFlatLayout();
  for (const groupId of GROUP_IDS) {
    fs.mkdirSync(path.dirname(paths.messagesFile(groupId)), { recursive: true });
    seedMessagesIfEmpty(groupId);
    if (!fs.existsSync(paths.linksFile(groupId))) fs.writeFileSync(paths.linksFile(groupId), LINKS_HEADER);
  }
  for (const d of [paths.sharedImagesDir(), paths.sharedVoiceDir()]) {
    fs.mkdirSync(d, { recursive: true });
  }
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
  const groups = {};
  for (const groupId of GROUP_IDS) {
    groups[groupId] = {
      texts: readLines(paths.messagesFile(groupId)),
      links: readLines(paths.linksFile(groupId)),
    };
  }
  cache = {
    groups,
    images: listFiles(paths.sharedImagesDir(), IMAGE_EXT),
    voice: listFiles(paths.sharedVoiceDir(), VOICE_EXT),
  };
  return cache;
}
function get() { return cache || load(); }
function reload() { cache = null; return load(); }

function groupContent(c, groupId) { return c.groups[groupId] || c.groups.ua; }

function counts() {
  const c = get();
  const messages = Object.values(c.groups).reduce((sum, g) => sum + g.texts.length, 0);
  const links = Object.values(c.groups).reduce((sum, g) => sum + g.links.length, 0);
  return { messages, links, images: c.images.length, voice: c.voice.length };
}
// Ленивый require('electron') — нужен только под Electron-оболочкой (её больше
// нет в проде, но модуль остаётся Node-совместимым, если кто-то всё же запустит
// его внутри Electron). Под чистым Node просто отдаём путь без открытия окна.
function openFolder() {
  ensure();
  let electron;
  try { electron = require('electron'); } catch { /* нет electron — headless-сервер */ }
  if (electron && electron.shell) return electron.shell.openPath(paths.contentDir());
  return Promise.resolve(paths.contentDir());
}

const pickOne = (arr) => arr[Math.floor(Math.random() * arr.length)];

function expandSpintax(text) {
  let out = text, guard = 0; const re = /\{([^{}]*)\}/;
  while (re.test(out) && guard++ < 20) out = out.replace(re, (_m, g) => pickOne(g.split('|')));
  return out;
}
// invisible zero-width characters used to make each message byte-unique
const ZERO_WIDTH = ['​', '‌', '‍', '⁠', '﻿'];
function noiseSuffix() {
  const n = 2 + Math.floor(Math.random() * 5); // 2–6 invisible chars
  let s = '';
  for (let i = 0; i < n; i++) s += pickOne(ZERO_WIDTH);
  return ' ' + s;
}
function varyText(text, cfg = {}) {
  let t = expandSpintax(text);
  if (Math.random() < 0.25) t += ' ' + pickOne(EMOJI);
  if (cfg.textNoise !== false) t += noiseSuffix();
  return t;
}
function pickText(recent = new Set(), groupId = 'ua') {
  const c = get();
  const texts = groupContent(c, groupId).texts;
  if (texts.length === 0) return null;
  const fresh = texts.filter((t) => !recent.has(t));
  return pickOne(fresh.length ? fresh : texts);
}

// Returns { type, message?, filePath?, caption?, sourceText? }.
// Text/links come from the content group for `lang`; images/voice are shared media.
function pick(config = {}, recent = new Set(), lang = 'uk') {
  const c = get();
  const groupId = contentGroupIdForLang(lang);
  const group = groupContent(c, groupId);
  const on = (flag, arr) => config[flag] !== false && arr.length > 0;
  const w = {
    text: 0.72,
    image: on('imagesEnabled', c.images) ? 0.14 : 0,
    link: on('linksEnabled', group.links) ? 0.08 : 0,
    voice: on('voiceEnabled', c.voice) ? 0.06 : 0,
  };
  const total = Object.values(w).reduce((a, b) => a + b, 0);
  if (total === 0) return null;
  let r = Math.random() * total;
  for (const [type, weight] of Object.entries(w)) {
    if (weight <= 0) continue;
    if ((r -= weight) < 0) {
      if (type === 'text') { const s = pickText(recent, groupId); return s ? { type, message: varyText(s, config), sourceText: s } : null; }
      if (type === 'image') { const s = pickText(recent, groupId); return { type, filePath: pickOne(c.images), caption: s ? varyText(s, config) : '', sourceText: s }; }
      if (type === 'link') { const s = pickText(recent, groupId); return { type: 'text', message: `${s ? varyText(s, config) : ''} ${pickOne(group.links)}`.trim(), sourceText: s }; }
      if (type === 'voice') return { type, filePath: pickOne(c.voice) };
    }
  }
  const s = pickText(recent, groupId);
  return s ? { type: 'text', message: varyText(s, config), sourceText: s } : null;
}

module.exports = { ensure, load, reload, get, counts, openFolder, pick };
