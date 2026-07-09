'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

function freshContentPack() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wacontent-'));
  process.env.WA_DATA_DIR = tmp;
  for (const m of ['../src/main/paths.js', '../src/main/groups.js', '../src/main/contentPack.js'])
    delete require.cache[require.resolve(m)];
  return { content: require('../src/main/contentPack.js'), paths: require('../src/main/paths.js'), tmp };
}

test('pick(cfg, avoid, "de") returns text from the de group, not ua', () => {
  const { content, paths } = freshContentPack();
  const deDir = path.join(paths.contentDir(), 'de');
  fs.mkdirSync(deDir, { recursive: true });
  fs.writeFileSync(path.join(deDir, 'messages.txt'), 'hallo\n');
  content.reload();

  const cfg = { imagesEnabled: false, linksEnabled: false, voiceEnabled: false };
  const item = content.pick(cfg, new Set(), 'de');
  assert.ok(item, 'expected a text item');
  assert.strictEqual(item.type, 'text');
  assert.ok(item.message.startsWith('hallo'), `expected message to start with "hallo", got "${item.message}"`);
});

test('ensure() creates the 4 group dirs + shared media dirs, and seeds de from content-seed if present', () => {
  const { content, paths } = freshContentPack();
  content.ensure();

  for (const groupId of ['ua', 'de', 'pl', 'uk']) {
    assert.ok(fs.existsSync(paths.messagesFile(groupId)), `${groupId}/messages.txt should exist`);
    assert.ok(fs.existsSync(paths.linksFile(groupId)), `${groupId}/links.txt should exist`);
  }
  assert.ok(fs.existsSync(paths.sharedImagesDir()), 'shared/images should exist');
  assert.ok(fs.existsSync(paths.sharedVoiceDir()), 'shared/voice should exist');

  const seedPath = path.join(__dirname, '..', 'content-seed', 'de', 'messages.txt');
  if (fs.existsSync(seedPath)) {
    const deContent = fs.readFileSync(paths.messagesFile('de'), 'utf8').trim();
    assert.ok(deContent.length > 0, 'de/messages.txt should be seeded and non-empty');
  }
});

test('ensure() populates shared/images from content-seed when the runtime dir is empty', () => {
  const { content, paths } = freshContentPack();
  const seedDir = path.join(__dirname, '..', 'content-seed', 'shared', 'images');
  const IMG = /\.(jpe?g|png)$/i;
  const seedImgs = fs.readdirSync(seedDir).filter((f) => IMG.test(f));
  assert.ok(seedImgs.length > 0, 'seed dir must ship real images for this test');

  content.ensure();

  const seeded = fs.readdirSync(paths.sharedImagesDir()).filter((f) => IMG.test(f));
  assert.strictEqual(seeded.length, seedImgs.length, 'all seed images should be copied into shared/images');
});

test('ensure() populates shared/voice from content-seed when the runtime dir is empty', () => {
  const { content, paths } = freshContentPack();
  const seedDir = path.join(__dirname, '..', 'content-seed', 'shared', 'voice');
  const OGG = /\.ogg$/i;
  const seedVoice = fs.readdirSync(seedDir).filter((f) => OGG.test(f));
  assert.ok(seedVoice.length > 0, 'seed dir must ship real voice clips for this test');

  content.ensure();

  const seeded = fs.readdirSync(paths.sharedVoiceDir()).filter((f) => OGG.test(f));
  assert.strictEqual(seeded.length, seedVoice.length, 'all seed voice clips should be copied into shared/voice');
});

test('ensure() does not overwrite existing shared/images (only seeds when empty)', () => {
  const { content, paths } = freshContentPack();
  const dir = paths.sharedImagesDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'mine.jpg'), 'user-image');

  content.ensure();

  const files = fs.readdirSync(dir).filter((f) => /\.(jpe?g|png)$/i.test(f));
  assert.deepStrictEqual(files, ['mine.jpg'], 'user images should be left untouched, no seeding');
  assert.strictEqual(fs.readFileSync(path.join(dir, 'mine.jpg'), 'utf8'), 'user-image');
});
