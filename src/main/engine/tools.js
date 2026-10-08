// VencForge — инструменты сборки: Node.js (системный или портативный) и pnpm
// pnpm: сначала ищем УЖЕ установленный (PATH / standalone / npm -g / corepack),
// и только если ничего нет — ставим свой (standalone exe → npm → corepack).
const fs = require('fs');
const path = require('path');
const util = require('./util');
const log = require('./log');
const { NodeDir, PnpmPrefix, ToolsDir, LOCALAPPDATA, APPDATA } = require('./paths');
const { getState, saveState } = require('./store');

const NODE_VERSION = '22.21.1'; // LTS; если 404 — возьмём последний 22.x из dist/index.json
const PNPM_STANDALONE_URL = 'https://github.com/pnpm/pnpm/releases/latest/download/pnpm-win-x64.exe';

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

// ---------------------------------------------------------------- pnpm
// Тул pnpm: { kind: 'exe'|'cjs'|'shell', path, src }
//   exe   — самодостаточный pnpm.exe (standalone-установка или скачанный нами)
//   cjs   — .../node_modules/pnpm/bin/pnpm.cjs — запускаем через node
//   shell — pnpm.cmd — запускаем через cmd-шелл
const PNPM_CJS_OWN = () => path.join(PnpmPrefix, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs');

function pnpmToolFromPath(p) {
  if (!p || !util.exists(p)) return null;
  const ext = path.extname(p).toLowerCase();
  if (ext === '.exe') return { kind: 'exe', path: p };
  if (ext === '.cjs' || ext === '.js') return { kind: 'cjs', path: p };
  if (ext === '.cmd' || ext === '.bat') {
    // npm-глобальная схема: <prefix>\pnpm.cmd + <prefix>\node_modules\pnpm\bin\pnpm.cjs
    const cjs = path.join(path.dirname(p), 'node_modules', 'pnpm', 'bin', 'pnpm.cjs');
    if (util.exists(cjs)) return { kind: 'cjs', path: cjs };
    return { kind: 'shell', path: p };
  }
  return null;
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

// проверка: тул реально запускается и отвечает версией
async function verifyPnpm(tool, node) {
  if (!tool) return false;
  try {
    let r;
    if (tool.kind === 'exe') r = await util.exec(tool.path, ['-v']);
    else if (tool.kind === 'cjs') r = await util.exec(node && node.nodeExe !== 'node' ? node.nodeExe : 'node', [tool.path, '-v']);
    else r = await util.exec(tool.path, ['-v'], { shell: true });
    if (r.code !== 0) return false;
    return /^\d+\.\d+\.\d+/m.test((r.stdout || '').trim());
  } catch {
    return false;
  }
}

// где живёт pnpm в PATH (Windows `where`)
async function wherePnpm() {
  const r = await util.exec('where', ['pnpm']);
  if (r.code !== 0 || !r.stdout) return [];
  return (r.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

// быстрый кандидаты-поиск без установки. Возвращает тул или null (и запоминает источник)
async function detectPnpm(node, onLine) {
  const cands = [];

  // 1) наш собственный pnpm (npm --prefix в папке данных)
  cands.push({ t: pnpmToolFromPath(PNPM_CJS_OWN()), src: 'VencForge' });

  // 2) pnpm из PATH (standalone-установщик кладёт pnpm.exe в %LOCALAPPDATA%\pnpm и добавляет в PATH)
  for (const p of await wherePnpm()) {
    const t = pnpmToolFromPath(p);
    if (t) cands.push({ t, src: 'PATH' });
  }

  // 3) известные места установки
  cands.push({ t: pnpmToolFromPath(path.join(LOCALAPPDATA, 'pnpm', 'pnpm.exe')), src: 'standalone' });
  cands.push({ t: pnpmToolFromPath(path.join(APPDATA, 'npm', 'pnpm.cmd')), src: 'npm global' });
  cands.push({ t: pnpmToolFromPath(path.join(APPDATA, 'npm', 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')), src: 'npm global' });

  // 4) префикс npm (может быть кастомным)
  const npmCmd = node && node.mode === 'portable' ? portableNpmCmd() : 'npm';
  if (npmCmd) {
    const r = await util.exec(npmCmd, ['config', 'get', 'prefix']);
    const prefix = (r.stdout || '').trim().split(/\r?\n/).pop();
    if (r.code === 0 && prefix && util.exists(prefix)) {
      cands.push({ t: pnpmToolFromPath(path.join(prefix, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')), src: 'npm prefix' });
    }
  }

  // 5) shim от corepack рядом с node
  const whereCore = await util.exec('where', ['corepack']);
  if (whereCore.code === 0) {
    const coreDir = path.dirname((whereCore.stdout || '').split(/\r?\n/)[0].trim());
    cands.push({ t: pnpmToolFromPath(path.join(coreDir, 'pnpm.cmd')), src: 'corepack' });
  }

  for (const { t, src } of cands) {
    if (!t) continue;
    if (await verifyPnpm(t, node)) {
      log.ok(`pnpm найден (${src}): ${t.path}`);
      return { ...t, src };
    }
  }
  return null;
}

// установка pnpm. Порядок: standalone exe → npm --prefix → corepack
async function installPnpm(node, onLine) {
  // 1) самодостаточный pnpm.exe с GitHub — не требует ни npm, ни corepack
  try {
    onLine && onLine('out', 'Скачиваю pnpm (standalone)...');
    const dest = path.join(ToolsDir, 'pnpm', 'pnpm.exe');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    await util.download(PNPM_STANDALONE_URL, dest);
    const t = pnpmToolFromPath(dest);
    if (t && await verifyPnpm(t, node)) {
      log.ok('pnpm установлен (standalone exe): ' + dest);
      return { ...t, src: 'VencForge standalone' };
    }
  } catch (e) {
    log.warn('standalone pnpm не скачался: ' + (e && e.message));
  }

  // 2) npm install -g pnpm --prefix <наша папка> (без прав администратора)
  try {
    const npmCmd = node && node.mode === 'portable' ? portableNpmCmd() : 'npm';
    if (npmCmd) {
      onLine && onLine('out', 'Устанавливаю pnpm через npm...');
      const ver = (await readPnpmVersion(onLine)) || 'latest';
      fs.mkdirSync(PnpmPrefix, { recursive: true });
      const env = buildEnv(node);
      const r = await util.stream(npmCmd, ['install', '-g', `pnpm@${ver}`, '--prefix', PnpmPrefix], {
        cwd: PnpmPrefix, env, onLine, shell: true,
      });
      const t = pnpmToolFromPath(PNPM_CJS_OWN());
      if (r === 0 && t && await verifyPnpm(t, node)) {
        log.ok('pnpm установлен (npm): ' + t.path);
        return { ...t, src: 'VencForge npm' };
      }
    }
  } catch (e) {
    log.warn('npm-установка pnpm не удалась: ' + (e && e.message));
  }

  // 3) corepack (идёт в комплекте с Node)
  try {
    onLine && onLine('out', 'Пробую corepack...');
    const ver = (await readPnpmVersion(onLine)) || 'latest';
    const r = await util.exec('corepack', ['prepare', `pnpm@${ver}`, '--activate'], { shell: true });
    if (r.code === 0) {
      for (const p of await wherePnpm()) {
        const t = pnpmToolFromPath(p);
        if (t && await verifyPnpm(t, node)) return { ...t, src: 'corepack' };
      }
    }
  } catch (e) {
    log.warn('corepack не сработал: ' + (e && e.message));
  }

  return null;
}

// главная точка входа: находит рабочий pnpm (кэш → поиск → установка) либо null
async function ensurePnpm(node, onLine) {
  const s = getState();
  const cached = s.tools && s.tools.pnpmTool;
  if (cached && cached.path) {
    const t = pnpmToolFromPath(cached.path);
    if (t && t.kind === cached.kind && await verifyPnpm(t, node)) {
      return { ...t, src: cached.src || 'кэш' };
    }
  }

  const found = await detectPnpm(node, onLine);
  if (found) {
    s.tools.pnpmTool = { kind: found.kind, path: found.path, src: found.src };
    saveState();
    return found;
  }

  log.info('Установленный pnpm не найден — ставлю...');
  const installed = await installPnpm(node, onLine);
  if (installed) {
    s.tools.pnpmTool = { kind: installed.kind, path: installed.path, src: installed.src };
    saveState();
    return installed;
  }

  log.err('pnpm не найден и установить не удалось (проверь интернет)');
  return null;
}

// без запуска процессов: что видно по файлам/кэшу (для UI и диагностики)
function probePnpm() {
  const s = getState();
  const cached = s.tools && s.tools.pnpmTool;
  if (cached && cached.path && util.exists(cached.path)) {
    return { kind: cached.kind, path: cached.path, src: cached.src || 'кэш' };
  }
  const own = pnpmToolFromPath(PNPM_CJS_OWN());
  if (own) return { ...own, src: 'VencForge' };
  const stand = pnpmToolFromPath(path.join(LOCALAPPDATA, 'pnpm', 'pnpm.exe'));
  if (stand) return { ...stand, src: 'standalone' };
  const npmG = pnpmToolFromPath(path.join(APPDATA, 'npm', 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'));
  if (npmG) return { ...npmG, src: 'npm global' };
  return null;
}

function buildEnv(node) {
  const env = { ...process.env };
  if (node && node.nodeDir) {
    // ВАЖНО: на Windows ключ называется Path, а на КОПИИ объекта ({...process.env})
    // case-insensitive магия process.env не работает — env.PATH = ... создавал ВТОРОЙ
    // ключ только с nodeDir, и у дочерних процессов терялся остальной PATH
    // (git «не найден» при живом клоне, node при этом находился).
    const key = Object.keys(env).find((k) => k.toLowerCase() === 'path') || 'PATH';
    env[key] = node.nodeDir + path.delimiter + (env[key] || '');
    env.VENCFORGE_NODE = node.nodeExe;
  }
  return env;
}

// запуск pnpm-команды в каталоге
async function pnpm(node, tool, args, cwd, onLine) {
  const env = buildEnv(node);
  let code;
  if (tool.kind === 'exe') {
    code = await util.stream(tool.path, args, { cwd, env, onLine });
  } else if (tool.kind === 'cjs') {
    const nodeExe = node && node.nodeExe !== 'node' ? node.nodeExe : 'node';
    code = await util.stream(nodeExe, [tool.path, ...args], { cwd, env, onLine });
  } else {
    code = await util.stream(tool.path, args, { cwd, env, onLine, shell: true });
  }
  return code;
}

module.exports = {
  ensureNode, ensurePnpm, probePnpm, pnpm, buildEnv,
  portableNodeExe, portableNpmCmd, systemNodeVersion, verifyPnpm,
};
