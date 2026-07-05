#!/usr/bin/env node
// Runs before `start` / `build` to make sure the content pack and the GOWA
// binary for the current host are present. Seeds content, and fetches the
// host GOWA binary if missing (build:mac/build:win fetch all arches separately).
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

// 1) content pack
if (!fs.existsSync(path.join(ROOT, 'resources', 'content-pack', 'content.json'))) {
  console.log('[ensure-assets] seeding content pack...');
  node('seed-content.mjs');
}

// 2) GOWA binary for the host platform (folder key matches electron-builder ${os})
const osToken = process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : 'linux';
const hostKey = `${osToken}-${process.arch}`;
const exe = process.platform === 'win32' ? 'whatsapp.exe' : 'whatsapp';
const hostBin = path.join(ROOT, 'resources', 'gowa', hostKey, exe);
if (!fs.existsSync(hostBin)) {
  console.log(`[ensure-assets] fetching GOWA binary for ${hostKey}...`);
  node('fetch-gowa.mjs', ['--current']);
}
