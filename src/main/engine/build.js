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

  const pnpmTool = await tools.ensurePnpm(node, onLine);
  if (!pnpmTool) throw new Error('pnpm недоступен — сборка невозможна');

  log.info('Устанавливаю зависимости Vencord (pnpm install)...');
  let code = await tools.pnpm(node, pnpmTool, ['install', '--frozen-lockfile'], VcDir, onLine);
  if (code !== 0) {
    log.warn('install --frozen-lockfile не удался — пробую без lockfile');
    code = await tools.pnpm(node, pnpmTool, ['install', '--no-frozen-lockfile'], VcDir, onLine);
    if (code !== 0) throw new Error('pnpm install не удался');
  }

  log.info('Собираю Vencord (pnpm build)...');
  code = await tools.pnpm(node, pnpmTool, ['build'], VcDir, onLine);
  if (code !== 0) throw new Error('pnpm build не удался');

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

  const head = await gitops.gitHead(VcDir);
  const s = getState();
  s.lastBuild = { time: new Date().toISOString(), head };
  saveState();
  log.ok(`Сборка готова${head ? ' (Vencord ' + head + ')' : ''}: ${DistDir}`);
  return { ok: true, head };
}

module.exports = { buildVencord };
