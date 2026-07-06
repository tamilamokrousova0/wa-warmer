'use strict';
// electron-builder afterPack hook: ad-hoc code-sign the macOS build so it isn't
// flagged as "damaged" on download (esp. Apple Silicon). Without a paid Apple
// Developer ID we can't notarize — first launch still needs right-click → Open
// ("unidentified developer") — but this removes the "damaged/move to Trash" block
// and lets the bundled GOWA binary execute on arm64.
const { execSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

// electron-builder Arch enum: ia32=0, x64=1, armv7l=2, arm64=3, universal=4
function archName(a) {
  return a === 3 ? 'arm64' : a === 1 ? 'x64' : String(a);
}

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appName = context.packager.appInfo.productFilename; // "WA Warmer"
  const appPath = path.join(context.appOutDir, `${appName}.app`);
  const arch = archName(context.arch);

  const sign = (target) =>
    execSync(`codesign --force --timestamp=none --sign - "${target}"`, { stdio: 'inherit' });

  // 1) sign the bundled GOWA mach-o first (loose binary in Resources)
  const gowa = path.join(appPath, 'Contents', 'Resources', 'gowa', `mac-${arch}`, 'whatsapp');
  if (fs.existsSync(gowa)) {
    console.log(`[afterPack] ad-hoc signing GOWA binary (${arch})`);
    sign(gowa);
  }

  // 2) sign the whole app bundle (deep) so the outer seal is valid
  console.log(`[afterPack] ad-hoc signing ${appName}.app (${arch})`);
  execSync(`codesign --force --deep --timestamp=none --sign - "${appPath}"`, { stdio: 'inherit' });

  // verify
  try { execSync(`codesign -dv "${appPath}"`, { stdio: 'inherit' }); } catch { /* info only */ }
};
