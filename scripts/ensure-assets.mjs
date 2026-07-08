#!/usr/bin/env node
// Runs before `start` / `build`: makes sure the app icon and the host GOWA
// binary are present. (User content is created by the app at runtime in
// data/content-pack/, so nothing to seed here.)
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function node(script, args = []) {
  const r = spawnSync(process.execPath, [path.join(__dirname, script), ...args], { stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

// 1) app icon
if (!fs.existsSync(path.join(ROOT, 'build', 'icon.png'))) {
  console.log('[ensure-assets] generating app icon...');
  node('generate-icon.mjs');
}

// 2) GOWA binary for the host platform (folder key matches electron-builder ${os}).
// Built from source (see build-gowa.mjs): the engine needs a proxy-capable build
// that isn't in any tagged release yet. Requires the Go toolchain on the machine.
const osToken = process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : 'linux';
const hostKey = `${osToken}-${process.arch}`;
const exe = process.platform === 'win32' ? 'whatsapp.exe' : 'whatsapp';
const hostBin = path.join(ROOT, 'resources', 'gowa', hostKey, exe);
if (!fs.existsSync(hostBin)) {
  console.log(`[ensure-assets] building GOWA engine for ${hostKey} (needs Go)...`);
  node('build-gowa.mjs', ['--current']);
}
