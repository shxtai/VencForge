// VencForge — инструменты сборки: Node.js (системный или портативный) и pnpm
const fs = require('fs');
const path = require('path');
const util = require('./util');
const log = require('./log');
const { NodeDir, PnpmPrefix, ToolsDir } = require('./paths');
const { getState, saveState } = require('./store');

const NODE_VERSION = '22.21.1'; // LTS; если 404 — возьмём последний 22.x из dist/index.json

function portableNodeExe() {
  if (!fs.existsSync(NodeDir)) return null;
  const entries = fs.readdirSync(NodeDir).filter((e) => /^node-v\d+\.\d+\.\d+-win-x64$/.test(e));
  if (!entries.length) return null;
  const exe = path.join(NodeDir, entries[0], 'node.exe');
  return fs.existsSync(exe) ? exe : null;
}

function portableNpmCmd() {
  const exe = portableNodeExe();
  if (!exe) return null;
  const dir = path.dirname(exe);
  const npm = path.join(dir, 'npm.cmd');
  return fs.existsSync(npm) ? npm : null;
}

async function systemNodeVersion() {
  const r = await util.exec('node', ['-v']);
  if (r.code !== 0) return null;
  const m = (r.stdout || '').trim().match(/^v(\d+)\.(\d+)\.(\d+)$/);
  return m ? { major: +m[1], minor: +m[2], patch: +m[3], raw: 'v' + m[0].replace(/^v/, '') } : null;
}

// возвращает { nodeExe, nodeDir, mode: 'system'|'portable' } либо null
async function ensureNode(onLine) {
  const sys = await systemNodeVersion();
  if (sys && sys.major >= 18) {
    return { nodeExe: 'node', nodeDir: null, mode: 'system', version: sys.raw };
  }
  if (sys) log.warn(`Системный Node ${sys.raw} слишком старый — скачаю портативный 22.x`);
  else log.info('Node.js не найден — скачаю портативный 22.x (без прав администратора)');

  let exe = portableNodeExe();
  if (!exe) {
    let ver = NODE_VERSION;
    let url = `https://nodejs.org/dist/v${ver}/node-v${ver}-win-x64.zip`;
    try {
      await util.download(url, path.join(ToolsDir, 'node.zip'), {
        onProgress: (got, total) => {
          const pct = Math.round((got / total) * 100);
          if (pct % 10 === 0) onLine && onLine('out', `Скачиваю Node.js: ${pct}%`);
        },
      });
    } catch (e) {
      // определяем актуальный 22.x из index.json
      try {
        const idx = JSON.parse(await util.fetchText('https://nodejs.org/dist/index.json'));
        const v22 = idx.find((x) => x.version && x.version.startsWith('v22.'));
        if (!v22) throw new Error('Нет доступного Node 22.x');
        ver = v22.version.slice(1);
        url = `https://nodejs.org/dist/v${ver}/node-v${ver}-win-x64.zip`;
        await util.download(url, path.join(ToolsDir, 'node.zip'));
      } catch (e2) {
        log.err('Не удалось скачать Node.js: ' + (e2 && e2.message));
        return null;
      }
    }
    onLine && onLine('out', 'Распаковываю Node.js...');
    await util.unzip(path.join(ToolsDir, 'node.zip'), NodeDir);
    try { fs.unlinkSync(path.join(ToolsDir, 'node.zip')); } catch { }
    exe = portableNodeExe();
    if (!exe) { log.err('Портативный Node не распаковался'); return null; }
  }
  const s = getState();
  s.tools.nodeMode = 'portable';
  saveState();
  return { nodeExe: exe, nodeDir: path.dirname(exe), mode: 'portable', version: path.basename(path.dirname(exe)) };
}

// pnpm живёт в PnpmPrefix как npm --prefix install; запускаем через node <pnpm.cjs>
async function pnpmCjsPath(node, onLine) {
  const pnpmCjs = path.join(PnpmPrefix, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs');
  if (fs.existsSync(pnpmCjs)) return pnpmCjs;

  onLine && onLine('out', 'Устанавливаю pnpm...');
  const npmCmd = node.mode === 'portable' ? portableNpmCmd() : 'npm';
  if (!npmCmd) { log.err('npm не найден'); return null; }
  const ver = (await readPnpmVersion(onLine)) || 'latest';
  fs.mkdirSync(PnpmPrefix, { recursive: true });
  const env = buildEnv(node);
  const r = await util.stream(npmCmd, ['install', '-g', `pnpm@${ver}`, '--prefix', PnpmPrefix], {
    cwd: PnpmPrefix, env, onLine,
  });
  if (r !== 0 || !fs.existsSync(pnpmCjs)) {
    log.err('pnpm установить не удалось (проверь интернет)');
    return null;
  }
  return pnpmCjs;
}

async function readPnpmVersion(onLine) {
  // берём версию из packageManager репозитория Vencord, если он уже склонирован
  try {
    const { VcDir } = require('./paths');
    const pkg = util.readJson(path.join(VcDir, 'package.json'));
    const pm = pkg && pkg.packageManager;
    const m = pm && pm.match(/^pnpm@(\d+\.\d+\.\d+)/);
    if (m) return m[1];
  } catch { }
  return null;
}

function buildEnv(node) {
  const env = { ...process.env };
  if (node && node.nodeDir) {
    env.PATH = node.nodeDir + path.delimiter + (env.PATH || '');
    env.VENCFORGE_NODE = node.nodeExe;
  }
  return env;
}

// запуск pnpm-команды в каталоге
async function pnpm(node, pnpmCjs, args, cwd, onLine) {
  const env = buildEnv(node);
  const code = await util.stream(node.nodeExe === 'node' ? 'node' : node.nodeExe, [pnpmCjs, ...args], {
    cwd, env, onLine,
  });
  return code;
}

module.exports = { ensureNode, pnpmCjsPath, pnpm, buildEnv, portableNodeExe, systemNodeVersion };
