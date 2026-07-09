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
