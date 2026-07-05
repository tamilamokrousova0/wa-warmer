#!/usr/bin/env node
// Downloads the prebuilt GOWA (go-whatsapp-web-multidevice) release binaries
// and unpacks them into resources/gowa/<platformKey>/ so electron-builder can
// ship them via extraResources. Run: npm run fetch-gowa
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const GOWA_VERSION = '8.10.0';
const BASE = `https://github.com/aldinokemal/go-whatsapp-web-multidevice/releases/download/v${GOWA_VERSION}`;

// Folder keys match electron-builder's ${os}-${arch} macros (mac/win + x64/arm64).
const TARGETS = [
  { asset: `whatsapp_${GOWA_VERSION}_darwin_amd64.zip`, key: 'mac-x64', exe: 'whatsapp', archToken: 'darwin-amd64' },
  { asset: `whatsapp_${GOWA_VERSION}_darwin_arm64.zip`, key: 'mac-arm64', exe: 'whatsapp', archToken: 'darwin-arm64' },
  { asset: `whatsapp_${GOWA_VERSION}_windows_amd64.zip`, key: 'win-x64', exe: 'whatsapp.exe', archToken: 'windows-amd64' },
];

// By default fetch every target so a build machine can produce all artifacts.
// Pass --current to fetch only the host platform (handy for local dev).
const onlyCurrent = process.argv.includes('--current');
const osToken = process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : 'linux';
const hostKey = `${osToken}-${process.arch}`;

async function download(url) {
  process.stdout.write(`  downloading ${url}\n`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

function findExe(zip, archToken) {
  // Inside the release zip the binary is named after the platform (e.g.
  // "darwin-arm64", "windows-amd64.exe"), alongside a readme. Pick the real
  // executable: skip docs/checksums/dirs, prefer a name matching the arch.
  const files = zip.getEntries().filter((e) => !e.isDirectory);
  const isDoc = (n) => /(readme|license|changelog|\.md$|\.txt$|checksums)/i.test(path.basename(n));
  const candidates = files.filter((e) => !isDoc(e.entryName));
  if (candidates.length === 0) return null;
  const byArch = candidates.find((e) => path.basename(e.entryName).includes(archToken));
  if (byArch) return byArch;
  // else the largest file is almost certainly the binary
  return candidates.sort((a, b) => b.header.size - a.header.size)[0];
}

async function run() {
  for (const t of TARGETS) {
    if (onlyCurrent && t.key !== hostKey) continue;
    const outDir = path.join(ROOT, 'resources', 'gowa', t.key);
    const outExe = path.join(outDir, t.exe);
    if (fs.existsSync(outExe)) {
      console.log(`[skip] ${t.key} already present`);
      continue;
    }
    console.log(`[fetch] ${t.key}`);
    const buf = await download(`${BASE}/${t.asset}`);
    const zip = new AdmZip(buf);
    const entry = findExe(zip, t.archToken);
    if (!entry) {
      console.error(`  zip contents: ${zip.getEntries().map((e) => e.entryName).join(', ')}`);
      throw new Error(`Could not find ${t.exe} inside ${t.asset}`);
    }
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(outExe, entry.getData());
    if (!t.key.startsWith('win32')) fs.chmodSync(outExe, 0o755);
    console.log(`  -> ${path.relative(ROOT, outExe)} (from ${entry.entryName})`);
  }
  console.log('Done.');
}

run().catch((err) => {
  console.error('fetch-gowa failed:', err.message);
  console.error(`If you are offline, place the binaries manually in resources/gowa/<platform-arch>/ (from ${BASE}). Host: ${os.platform()}-${os.arch()}`);
  process.exit(1);
});
