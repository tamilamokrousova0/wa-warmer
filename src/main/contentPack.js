'use strict';
// Loads the bundled content pack and picks warming content at random with
// configurable weights (mostly text, sometimes an image, sometimes a link).
const fs = require('node:fs');
const path = require('node:path');
const paths = require('./paths');

let pack = null;

function load() {
  if (pack) return pack;
  const dir = paths.contentPackDir();
  const data = JSON.parse(fs.readFileSync(path.join(dir, 'content.json'), 'utf8'));
  pack = {
    texts: data.texts || [],
    links: data.links || [],
    images: (data.images || []).map((im) => ({
      caption: im.caption || '',
      filePath: path.join(dir, 'images', im.file),
    })).filter((im) => fs.existsSync(im.filePath)),
  };
  return pack;
}

function pickOne(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// Returns { type:'text'|'link'|'image', message?, filePath?, caption? }
function pick(config = {}) {
  const p = load();
  const imagesOn = config.imagesEnabled !== false && p.images.length > 0;
  const linksOn = config.linksEnabled !== false && p.links.length > 0;

  const weights = { text: 0.75, image: imagesOn ? 0.15 : 0, link: linksOn ? 0.1 : 0 };
  const total = weights.text + weights.image + weights.link;
  let r = Math.random() * total;

  if ((r -= weights.image) < 0 && imagesOn) {
    const im = pickOne(p.images);
    return { type: 'image', filePath: im.filePath, caption: im.caption || pickOne(p.texts) };
  }
  if ((r -= weights.link) < 0 && linksOn) {
    return { type: 'link', message: `${pickOne(p.texts)} ${pickOne(p.links)}` };
  }
  return { type: 'text', message: pickOne(p.texts) };
}

module.exports = { load, pick };
