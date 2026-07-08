'use strict';
// Resolves filesystem locations for the app: the GOWA binary, the bundled
// content pack, and the portable runtime data directory. No Electron
// dependency — the data directory is resolved from an env var (or a
// well-known default), so this module works under plain Node too.
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

// Folder naming matches electron-builder's ${os}-${arch} macros (mac/win/linux
// + x64/arm64), so the same path works in dev and in the packaged app.
function osToken(platform) {
  if (platform === 'darwin') return 'mac';
  if (platform === 'win32') return 'win';
  return 'linux';
}
const platformKey = `${osToken(process.platform)}-${process.arch}`;
const exeName = process.platform === 'win32' ? 'whatsapp.exe' : 'whatsapp';

function resourcesRoot() {
  return process.env.WA_RESOURCES_DIR || path.join(__dirname, '..', '..', 'resources');
}

function gowaBinaryPath() {
  return path.join(resourcesRoot(), 'gowa', platformKey, exeName);
}

let cachedDataDir = null;
function setDataDir(dir) { cachedDataDir = dir; }
function dataDir() {
  if (cachedDataDir) return cachedDataDir;
  const base = process.env.WA_DATA_DIR || path.join(os.homedir(), '.wa-warmer', 'data');
  fs.mkdirSync(base, { recursive: true });
  cachedDataDir = base;
  return base;
}

function gowaDbPath() {
  const dir = path.join(dataDir(), 'gowa');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'whatsapp.db');
}

function gowaKeysDbPath() {
  return path.join(dataDir(), 'gowa', 'keys.db');
}

function accountsFile() {
  return path.join(dataDir(), 'accounts.json');
}

function configFile() {
  return path.join(dataDir(), 'config.json');
}

// User-editable content lives next to the app so it's easy to manage.
// Text/links are per country-group (each group has its own language); images
// and voice notes are shared across all groups.
function contentDir() {
  return path.join(dataDir(), 'content-pack');
}
function messagesFile(groupId = 'ua') {
  return path.join(contentDir(), groupId, 'messages.txt');
}
function linksFile(groupId = 'ua') {
  return path.join(contentDir(), groupId, 'links.txt');
}
function sharedImagesDir() {
  return path.join(contentDir(), 'shared', 'images');
}
function sharedVoiceDir() {
  return path.join(contentDir(), 'shared', 'voice');
}
// Legacy aliases — images/voice are shared media, kept for existing call sites (e.g. ipc.js).
function contentImagesDir() {
  return sharedImagesDir();
}
function contentVoiceDir() {
  return sharedVoiceDir();
}
function statsFile() {
  return path.join(dataDir(), 'stats.json');
}

module.exports = {
  platformKey,
  osToken,
  exeName,
  resourcesRoot,
  gowaBinaryPath,
  dataDir,
  setDataDir,
  gowaDbPath,
  gowaKeysDbPath,
  accountsFile,
  configFile,
  contentDir,
  messagesFile,
  linksFile,
  sharedImagesDir,
  sharedVoiceDir,
  contentImagesDir,
  contentVoiceDir,
  statsFile,
};
