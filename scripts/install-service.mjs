#!/usr/bin/env node
// Генерирует и устанавливает launchd-юнит панели WA Warmer (постоянный сервис,
// автозапуск, авто-рестарт) под ТЕКУЩУЮ машину: подставляет реальные пути.
// Пароль в plist НЕ пишется — он уже захеширован в data/panel.json (безопаснее);
// если panel.json ещё нет, задайте WA_PANEL_PASSWORD в окружении при первом
// ручном запуске, либо перед установкой.
//
// Запуск: node scripts/install-service.mjs   (или npm run install-service)
// НЕ загружает сервис автоматически — печатает команды, чтобы вы сами
// остановили ручной инстанс и загрузили один управляемый (без гонки инстансов).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const LABEL = 'com.wawarmer.panel';

// node: предпочитаем стабильный симлинк из Homebrew, иначе текущий бинарник.
const nodeCandidates = ['/opt/homebrew/bin/node', '/usr/local/bin/node', process.execPath];
const nodePath = nodeCandidates.find((p) => { try { return fs.existsSync(p); } catch { return false; } }) || process.execPath;

const dataDir = process.env.WA_DATA_DIR || path.join(os.homedir(), '.wa-warmer', 'data');
const port = process.env.WA_PANEL_PORT || '8760';
const resourcesDir = path.join(ROOT, 'resources');
const logDir = path.join(os.homedir(), 'Library', 'Logs', 'wa-warmer');
const logPath = path.join(logDir, 'panel.log');
const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const panelJson = path.join(dataDir, 'panel.json');
const havePanel = fs.existsSync(panelJson);

// Пароль в env кладём в plist ТОЛЬКО если panel.json ещё нет (первый запуск).
const pwEnv = (!havePanel && process.env.WA_PANEL_PASSWORD)
  ? `    <key>WA_PANEL_PASSWORD</key>\n    <string>${process.env.WA_PANEL_PASSWORD}</string>\n`
  : '';

const x = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${x(nodePath)}</string>
    <string>${x(path.join(ROOT, 'src', 'server', 'server.js'))}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${x(ROOT)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>WA_DATA_DIR</key>
    <string>${x(dataDir)}</string>
    <key>WA_PANEL_PORT</key>
    <string>${x(port)}</string>
    <key>WA_RESOURCES_DIR</key>
    <string>${x(resourcesDir)}</string>
${pwEnv}  </dict>
  <key>KeepAlive</key>
  <true/>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${x(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${x(logPath)}</string>
</dict>
</plist>
`;

fs.mkdirSync(logDir, { recursive: true });
fs.mkdirSync(path.dirname(plistPath), { recursive: true });
fs.writeFileSync(plistPath, plist);

console.log('[install-service] plist записан:');
console.log('  ' + plistPath);
console.log('  node:      ' + nodePath);
console.log('  сервер:    ' + path.join(ROOT, 'src/server/server.js'));
console.log('  данные:    ' + dataDir + (havePanel ? '  (panel.json есть — пароль в plist НЕ пишем)' : '  (panel.json нет!)'));
console.log('  логи:      ' + logPath);
if (!havePanel && !process.env.WA_PANEL_PASSWORD) {
  console.log('\n  ⚠️  panel.json нет и WA_PANEL_PASSWORD не задан — панель не поднимется без пароля.');
  console.log('      Задайте пароль: node scripts/install-service.mjs с WA_PANEL_PASSWORD=... , или запустите сервер вручную один раз с этой переменной.');
}
console.log('\nДальше (важно — сначала остановите ручной инстанс, чтобы не было двух серверов):');
console.log('  pkill -f "server/server.js"; pkill -f "gowa/mac-arm64/whatsapp"; sleep 3');
console.log(`  launchctl load ${plistPath.replace(os.homedir(), '~')}`);
console.log('\nУправление:');
console.log(`  launchctl kickstart -k gui/$(id -u)/${LABEL}    # перезапустить (после git pull)`);
console.log(`  launchctl unload ${plistPath.replace(os.homedir(), '~')}   # остановить`);
console.log(`  launchctl load   ${plistPath.replace(os.homedir(), '~')}   # запустить`);
console.log(`  tail -f ${logPath.replace(os.homedir(), '~')}              # логи`);
console.log('\n⚠️  Пока сервис загружен, НЕ запускайте `npm run server` вручную — будет два инстанса и флап.');
