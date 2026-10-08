// VencForge — сборка Vencord из исходников с плагинами
const fs = require('fs');
const path = require('path');
const util = require('./util');
const log = require('./log');
const tools = require('./tools');
const gitops = require('./gitops');
const plugins = require('./plugins');
const { VcDir, DistDir } = require('./paths');
const { getConfig, saveState, getState } = require('./store');

// проверка: плагины реально вкомпилированы в бандлы (grep имени по dist)
function verifyPluginsInDist(pluginNames, distDir) {
  const pick = (f) => { try { return fs.readFileSync(path.join(distDir, f), 'utf8'); } catch { return null; } };
  const web = pick('renderer.js');
  const desktop = pick('vencordDesktopRenderer.js');
  const main = pick('vencordDesktopMain.js');
  return pluginNames.map((name) => ({
    name,
    inWeb: !!(web && web.includes(name)),
    inDesktop: !!(desktop && desktop.includes(name)),
    inMain: !!(main && main.includes(name)),
  }));
}

async function buildVencord({ onLine, force = false } = {}) {
  const cfg = getConfig();
  const say = (tag, line) => { if (onLine) onLine(tag, line); };

  // исходники Vencord
  if (!util.exists(path.join(VcDir, 'package.json'))) {
    log.info('Клонирую Vencord...');
    const r = await gitops.syncRepo({ url: cfg.vencordRepo, dir: VcDir, branch: cfg.vencordBranch, onLine });
    if (!r.ok) throw new Error('Не удалось скачать Vencord (сеть?)');
  }

  const node = await tools.ensureNode(onLine);
  if (!node) throw new Error('Node.js недоступен — сборка невозможна');
  log.ok(`Node.js: ${node.version} (${node.mode === 'portable' ? 'портативный' : 'системный'})`);

  // Билд-скрипт Vencord ставит штамп версии через `git rev-parse` (scripts/build/common.mjs) —
  // без git сборка падает невнятной ошибкой cmd. Проверяем заранее.
  if (!(await gitops.hasGit())) {
    throw new Error('Для сборки Vencord нужен Git (билд-скрипт ставит штамп версии через git). Установи Git для Windows и перезапусти VencForge');
  }

  const pnpmTool = await tools.ensurePnpm(node, onLine);
  if (!pnpmTool) throw new Error('pnpm недоступен — сборка невозможна');

  const tInstall = Date.now();
  log.info('Устанавливаю зависимости Vencord (pnpm install)...');

  // Санити-проверка установки: если node_modules остался от прошлой попытки
  // (частично не удалился из-за хэндлов антивируса/esbuild), pnpm верит манифесту
  // виртуального стора и «доустанавливает» несколько пакетов вместо всех — сборка
  // падает на Missing-файлах (ERR_MODULE_NOT_FOUND внутри .pnpm). Считаем пакеты
  // в lockfile и в .pnpm: сильное расхождение = установка битая.
  const installLooksBroken = () => {
    try {
      const lock = fs.readFileSync(path.join(VcDir, 'pnpm-lock.yaml'), 'utf8');
      const res = (lock.match(/resolution:/g) || []).length;
      const pn = path.join(VcDir, 'node_modules', '.pnpm');
      let dirs = 0;
      if (util.exists(pn)) for (const e of fs.readdirSync(pn, { withFileTypes: true })) if (e.isDirectory() && !e.name.startsWith('.')) dirs++;
      return res > 40 && dirs < res * 0.5 ? { res, dirs } : null;
    } catch { return null; }
  };

  const runInstall = async (extra = []) => {
    let c = await tools.pnpm(node, pnpmTool, ['install', '--frozen-lockfile', ...extra], VcDir, onLine);
    if (c !== 0) {
      log.warn('install --frozen-lockfile не удался — пробую без lockfile');
      c = await tools.pnpm(node, pnpmTool, ['install', '--no-frozen-lockfile', ...extra], VcDir, onLine);
    }
    return c;
  };

  let code = await runInstall();
  const nmDir = path.join(VcDir, 'node_modules');
  let broken = installLooksBroken();
  if (broken) {
    log.warn(`pnpm поставил только ${broken.dirs} папок из ~${broken.res} пакетов — node_modules бит, чищу и ставлю принудительно`);
    await util.killStrayBuilders();
    util.rmrf(nmDir);
    code = await runInstall(['--force']);
    broken = installLooksBroken();
    if (broken) throw new Error(`pnpm install битый (${broken.dirs} из ~${broken.res}) — мешает антивирус или недособранный диск; перезапусти ПК и повтори`);
  }
  if (code !== 0) throw new Error('pnpm install не удался');
  const installSec = ((Date.now() - tInstall) / 1000).toFixed(1);

  const tBuild = Date.now();
  log.info('Собираю Vencord (pnpm build) — это живой esbuild из исходников...');
  let buildErrs = '';
  const buildOnLine = (tag, line) => { if (tag === 'err') buildErrs += line + '\n'; if (onLine) onLine(tag, line); };
  code = await tools.pnpm(node, pnpmTool, ['build'], VcDir, buildOnLine);
  if (code !== 0 && /ERR_MODULE_NOT_FOUND|Cannot find package/.test(buildErrs)) {
    // самовосстановление: хвосты убитой сборки/антивирус держат node_modules
    log.warn('Похоже на битый node_modules — убиваю хвосты esbuild, чищу зависимости и собираю заново');
    await util.killStrayBuilders();
    util.rmrf(nmDir);
    const hc = await runInstall(['--force']);
    if (hc !== 0) throw new Error('pnpm install (восстановление) не удался');
    code = await tools.pnpm(node, pnpmTool, ['build'], VcDir, buildOnLine);
  }
  if (code !== 0) throw new Error('pnpm build не удался (весь вывод выше — смотри ошибки esbuild)');
  const buildSec = ((Date.now() - tBuild) / 1000).toFixed(1);

  const mainJs = path.join(VcDir, 'dist', 'vencordDesktopMain.js');
  const patcher = path.join(VcDir, 'dist', 'patcher.js');
  if (!util.exists(mainJs) || !util.exists(patcher)) {
    throw new Error('В dist нет ожидаемых файлов (patcher.js / vencordDesktopMain.js)');
  }

  log.info('Копирую сборку в ' + DistDir);
  util.rmrf(DistDir);
  fs.mkdirSync(DistDir, { recursive: true });
  util.copyDir(path.join(VcDir, 'dist'), DistDir, { skip: ['.git'] });
  for (const f of fs.readdirSync(DistDir)) {
    if (f.endsWith('.map')) { try { fs.unlinkSync(path.join(DistDir, f)); } catch { } }
  }
  fs.writeFileSync(path.join(DistDir, 'package.json'), '{}', 'utf8');

  log.info(`Тайминги: pnpm install ${installSec} c · pnpm build ${buildSec} c`);

  // проверка, что кастомные плагины реально вкомпилированы (анти-«сборка-пустышка»)
  const names = cfg.plugins.map((p) => p.name);
  if (names.length) {
    for (const r of verifyPluginsInDist(names, DistDir)) {
      if (r.inWeb || r.inDesktop) {
        log.ok(`Плагин «${r.name}» вкомпилирован в сборку${r.inMain ? ' (+нативная часть)' : ''}`);
      } else {
        log.err(`Плагин «${r.name}» НЕ найден в dist — проверь исходники (нужен export default definePlugin({...}))`);
      }
    }
  }

  // размер dist для наглядности
  try {
    let bytes = 0, files = 0;
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else { bytes += fs.statSync(p).size; files++; }
      }
    };
    walk(DistDir);
    log.info(`dist: ${files} файлов, ${(bytes / 1048576).toFixed(1)} МБ`);
  } catch { }

  const head = await gitops.gitHead(VcDir);
  const s = getState();
  s.lastBuild = { time: new Date().toISOString(), head };
  saveState();
  log.ok(`Сборка готова${head ? ' (Vencord ' + head + ')' : ''}: ${DistDir}`);
  return { ok: true, head };
}

module.exports = { buildVencord, verifyPluginsInDist };
