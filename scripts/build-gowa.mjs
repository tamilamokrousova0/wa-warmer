#!/usr/bin/env node
// Builds the GOWA (go-whatsapp-web-multidevice) engine FROM SOURCE at a pinned
// commit and drops the binaries into resources/gowa/<platformKey>/ — same layout
// electron-builder ships via extraResources.
//
// Why from source (instead of scripts/fetch-gowa.mjs, which downloads a release):
// outbound-proxy support (--whatsapp-proxy / WHATSAPP_PROXY -> whatsmeow
// SetProxyAddress) landed on GOWA's `main` AFTER the last tagged release
// (v8.10.0), so no prebuilt release binary carries it yet. We pin to the commit
// that added it. Built with `-tags purego` + CGO disabled so the pure-Go SQLite
// driver is used and cross-compiling (mac<->win) needs no C toolchain.
//
// Requires the Go toolchain (>=1.25). On macOS: `brew install go`.
// Usage:
//   node scripts/build-gowa.mjs            # host platform only
//   node scripts/build-gowa.mjs --current  # host platform only (explicit)
//   node scripts/build-gowa.mjs --all      # mac-x64, mac-arm64, win-x64
//   node scripts/build-gowa.mjs --target win-x64
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// Pinned to the `main` commit that added --whatsapp-proxy (issue #581).
// Bump this (and re-run) to track upstream; drop the whole source build once a
// tagged GOWA release ships proxy support and switch back to fetch-gowa.
const GOWA_REPO = 'https://github.com/aldinokemal/go-whatsapp-web-multidevice.git';
const GOWA_REF = 'd1ac267f3347dbe4f226c8b25fa04ca82251f209';

const TARGETS = [
  { key: 'mac-x64', goos: 'darwin', goarch: 'amd64', exe: 'whatsapp' },
  { key: 'mac-arm64', goos: 'darwin', goarch: 'arm64', exe: 'whatsapp' },
  { key: 'win-x64', goos: 'windows', goarch: 'amd64', exe: 'whatsapp.exe' },
];

const osToken = process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : 'linux';
const hostKey = `${osToken}-${process.arch}`;

function pickTargets() {
  const argv = process.argv.slice(2);
  if (argv.includes('--all')) return TARGETS;
  // collect every `--target <key>` (repeatable)
  const keys = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--target' && argv[i + 1]) keys.push(argv[++i]);
  }
  if (keys.length) {
    return keys.map((k) => {
      const t = TARGETS.find((x) => x.key === k);
      if (!t) throw new Error(`unknown --target ${k} (have: ${TARGETS.map((x) => x.key).join(', ')})`);
      return t;
    });
  }
  const host = TARGETS.find((x) => x.key === hostKey);
  if (!host) throw new Error(`no build target for host ${hostKey}`);
  return [host];
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} -> exit ${r.status}`);
}

function ensureGo() {
  const r = spawnSync('go', ['version'], { encoding: 'utf8' });
  if (r.status !== 0) {
    console.error('[build-gowa] Go toolchain not found. Install it (macOS: `brew install go`) and re-run.');
    console.error(`[build-gowa] Host: ${os.platform()}-${os.arch()}. GOWA needs Go >= 1.25.`);
    process.exit(1);
  }
  console.log(`[build-gowa] ${r.stdout.trim()}`);
}

// Shallow-clone the pinned commit into a reusable, git-ignored cache dir.
function ensureSource() {
  const srcRoot = path.join(ROOT, '.gowa-src');
  const srcDir = path.join(srcRoot, 'src'); // GOWA's Go module lives under /src
  const stamp = path.join(srcRoot, '.ref');
  if (fs.existsSync(srcDir) && fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8').trim() === GOWA_REF) {
    console.log('[build-gowa] reusing cached source checkout');
    return srcDir;
  }
  fs.rmSync(srcRoot, { recursive: true, force: true });
  fs.mkdirSync(srcRoot, { recursive: true });
  console.log(`[build-gowa] cloning GOWA @ ${GOWA_REF.slice(0, 10)} ...`);
  // Fetch just the pinned commit (works on GitHub, avoids a full history clone).
  run('git', ['init', '-q'], { cwd: srcRoot });
  run('git', ['remote', 'add', 'origin', GOWA_REPO], { cwd: srcRoot });
  run('git', ['fetch', '-q', '--depth', '1', 'origin', GOWA_REF], { cwd: srcRoot });
  run('git', ['checkout', '-q', 'FETCH_HEAD'], { cwd: srcRoot });
  fs.writeFileSync(stamp, GOWA_REF);
  return srcDir;
}

function build(target, srcDir) {
  const outDir = path.join(ROOT, 'resources', 'gowa', target.key);
  fs.mkdirSync(outDir, { recursive: true });
  const outExe = path.join(outDir, target.exe);
  console.log(`[build-gowa] building ${target.key} (${target.goos}/${target.goarch}) ...`);
  run('go', ['build', '-tags', 'purego', '-trimpath', '-ldflags', '-s -w', '-o', outExe, '.'], {
    cwd: srcDir,
    env: { ...process.env, CGO_ENABLED: '0', GOOS: target.goos, GOARCH: target.goarch },
  });
  if (target.goos !== 'windows') fs.chmodSync(outExe, 0o755);
  const kb = Math.round(fs.statSync(outExe).size / 1024);
  console.log(`[build-gowa]   -> ${path.relative(ROOT, outExe)} (${kb} KB)`);
}

function main() {
  const targets = pickTargets();
  ensureGo();
  const srcDir = ensureSource();
  for (const t of targets) build(t, srcDir);
  console.log('[build-gowa] done.');
}

main();
