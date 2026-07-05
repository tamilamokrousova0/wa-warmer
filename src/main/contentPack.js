'use strict';
// User-managed content pack. On first run it creates data/content-pack/ with
// empty messages.txt, links.txt and an images/ folder for the user to fill.
// Content is loaded from there (not bundled). Supports simple spintax
// ({a|b|c}) and light variation so the same line isn't sent twice in a row.
const fs = require('node:fs');
const path = require('node:path');
const { shell } = require('electron');
const paths = require('./paths');

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);
const EMOJI = ['🙂', '😄', '👍', '✨', '🔥', '😉', '👌', '💬', '☀️', '😎'];

const MESSAGES_HEADER =
  '# По одному сообщению на строку. Пустые строки и строки, начинающиеся с #, игнорируются.\n' +
  '# Можно использовать вариативность: "Привет {друг|дружище}! {Как дела|Что нового}?"\n';
const LINKS_HEADER =
  '# По одной ссылке на строку. Пустые строки и строки с # игнорируются.\n';

// Create the content folder + empty files if missing.
function ensure() {
  fs.mkdirSync(paths.contentImagesDir(), { recursive: true });
  if (!fs.existsSync(paths.messagesFile())) fs.writeFileSync(paths.messagesFile(), MESSAGES_HEADER);
  if (!fs.existsSync(paths.linksFile())) fs.writeFileSync(paths.linksFile(), LINKS_HEADER);
}

function readLines(file) {
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
  } catch {
    return [];
  }
}

let cache = null;
function load() {
  ensure();
  const texts = readLines(paths.messagesFile());
  const links = readLines(paths.linksFile());
  let images = [];
  try {
    images = fs
      .readdirSync(paths.contentImagesDir())
      .filter((f) => IMAGE_EXT.has(path.extname(f).toLowerCase()))
      .map((f) => path.join(paths.contentImagesDir(), f));
  } catch {
    images = [];
  }
  cache = { texts, links, images };
  return cache;
}

function get() {
  return cache || load();
}

function reload() {
  cache = null;
  return load();
}

function counts() {
  const c = get();
  return { messages: c.texts.length, links: c.links.length, images: c.images.length };
}

function openFolder() {
  ensure();
  return shell.openPath(paths.contentDir());
}

// ---- selection / variation ----
function pickOne(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// Expand {a|b|c} spintax groups, recursively.
function expandSpintax(text) {
  let out = text;
  let guard = 0;
  const re = /\{([^{}]*)\}/;
  while (re.test(out) && guard++ < 20) {
    out = out.replace(re, (_m, group) => pickOne(group.split('|')));
  }
  return out;
}

function varyText(text) {
  let t = expandSpintax(text);
  if (Math.random() < 0.25) t += ' ' + pickOne(EMOJI); // occasional emoji
  return t;
}

// avoid repeating the exact same source line twice in a row (per caller-provided memory)
function pickText(recent = new Set()) {
  const c = get();
  if (c.texts.length === 0) return null;
  const fresh = c.texts.filter((t) => !recent.has(t));
  const pool = fresh.length ? fresh : c.texts;
  return pickOne(pool);
}

// Returns { type, message?, filePath?, caption?, sourceText? }
function pick(config = {}, recent = new Set()) {
  const c = get();
  const imagesOn = config.imagesEnabled !== false && c.images.length > 0;
  const linksOn = config.linksEnabled !== false && c.links.length > 0;

  const weights = { text: 0.75, image: imagesOn ? 0.15 : 0, link: linksOn ? 0.1 : 0 };
  const total = weights.text + weights.image + weights.link;
  if (total === 0) return null;
  let r = Math.random() * total;

  if ((r -= weights.image) < 0 && imagesOn) {
    const src = pickText(recent);
    return { type: 'image', filePath: pickOne(c.images), caption: src ? varyText(src) : '', sourceText: src };
  }
  if ((r -= weights.link) < 0 && linksOn) {
    const src = pickText(recent);
    const base = src ? varyText(src) : '';
    return { type: 'link', message: `${base} ${pickOne(c.links)}`.trim(), sourceText: src };
  }
  const src = pickText(recent);
  if (!src) return null;
  return { type: 'text', message: varyText(src), sourceText: src };
}

module.exports = { ensure, load, reload, get, counts, openFolder, pick };
