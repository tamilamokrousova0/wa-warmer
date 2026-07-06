'use strict';
// Resolves filesystem locations for the packaged/dev app: the GOWA binary,
// the bundled content pack, and the portable runtime data directory.
const path = require('node:path');
const fs = require('node:fs');
const { app } = require('electron');

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
  // Packaged: files live under process.resourcesPath (extraResources).
  // Dev: they live under <projectRoot>/resources.
  return app.isPackaged ? process.resourcesPath : path.join(__dirname, '..', '..', 'resources');
}

function gowaBinaryPath() {
  return path.join(resourcesRoot(), 'gowa', platformKey, exeName);
}

function isWritable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, '.writetest');
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

let cachedDataDir = null;
function dataDir() {
  if (cachedDataDir) return cachedDataDir;

  // Windows portable: beside the .exe (reliable via PORTABLE_EXECUTABLE_DIR).
  if (process.env.PORTABLE_EXECUTABLE_DIR) {
    const p = path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'data');
    if (isWritable(p)) { cachedDataDir = p; return p; }
  }
  // Dev run: project root.
  if (!app.isPackaged) {
    const p = path.join(__dirname, '..', '..', 'data');
    if (isWritable(p)) { cachedDataDir = p; return p; }
  }
  // Packaged mac/linux: a fixed, predictable, always-writable location.
  // (Beside-the-.app is unreliable on macOS because Gatekeeper "App
  // Translocation" runs downloaded apps from a random read-only copy.)
  cachedDataDir = path.join(app.getPath('appData'), 'WA Warmer', 'data');
  fs.mkdirSync(cachedDataDir, { recursive: true });
  return cachedDataDir;
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
function contentDir() {
  return path.join(dataDir(), 'content-pack');
}
function messagesFile() {
  return path.join(contentDir(), 'messages.txt');
}
function linksFile() {
  return path.join(contentDir(), 'links.txt');
}
function contentImagesDir() {
  return path.join(contentDir(), 'images');
}
function contentVoiceDir() {
  return path.join(contentDir(), 'voice');
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
  gowaDbPath,
  gowaKeysDbPath,
  accountsFile,
  configFile,
  contentDir,
  messagesFile,
  linksFile,
  contentImagesDir,
  contentVoiceDir,
  statsFile,
};
