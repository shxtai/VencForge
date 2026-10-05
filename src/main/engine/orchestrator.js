// VencForge — оркестратор: «обновить и установить всё», частичные режимы
const path = require('path');
const util = require('./util');
const log = require('./log');
const gitops = require('./gitops');
const plugins = require('./plugins');
const build = require('./build');
const install = require('./install');
const clients = require('./clients');
const { VcDir, DistDir } = require('./paths');
const { getConfig, getState } = require('./store');

// what: 'full' | 'build-only' | 'patch-only'
// silent: true => без диалогов (пропуск патча при запущенных клиентах)
async function updateEverything({ what = 'full', silent = false, onLine } = {}) {
  const say = (tag, line) => { if (onLine) onLine(tag, line); };
  const cfg = getConfig();

  // 1. обновление Vencord
  log.info('Обновляю исходники Vencord...');
  const haveVc = util.exists(path.join(VcDir, 'package.json'));
  const rVc = await gitops.syncRepo({ url: cfg.vencordRepo, dir: VcDir, branch: cfg.vencordBranch, onLine });
  if (!rVc.ok) throw new Error('Не удалось обновить Vencord (сеть? git?)');
  const vcChanged = rVc.changed;
  log.ok(vcChanged ? 'Vencord обновлён' : (haveVc ? 'Vencord без изменений' : 'Vencord скачан'));

  // 2. обновление git-плагинов
  let anyPluginChanged = false;
  for (const p of cfg.plugins) {
    if (p.type !== 'git') continue;
    log.info(`Обновляю плагин ${p.name}...`);
    try {
      const r = await plugins.updatePlugin(p.name);
      if (r && r.changed) { anyPluginChanged = true; }
    } catch (e) {
      log.warn(`Плагин ${p.name}: ${e.message}`);
    }
  }

  // 3. синхронизация в src/userplugins
  await plugins.syncToUserplugins();

  // 4. сборка
  if (what !== 'patch-only') {
    const distReady = util.exists(path.join(DistDir, 'patcher.js'));
    const s = getState();
    const distMatches = s.lastBuild && s.lastBuild.head && (await gitops.gitHead(VcDir)) === s.lastBuild.head;
    if (silent && distReady && distMatches && !vcChanged && !anyPluginChanged) {
      log.info('Изменений нет — пересборка пропущена');
    } else {
      await build.buildVencord({ onLine });
    }
  }
  if (what === 'build-only') return { done: true, patched: false };

  // 5. клиенты
  const running = await clients.getRunningClients();
  if (running.length) {
    if (silent) {
      log.warn(`Запущено: ${running.join(', ')} — патч пропущен (закрой клиенты и нажми «Починить Discord»)`);
      return { done: true, patched: false, skipped: 'running', running };
    }
    return { done: false, needClose: running };
  }

  // 6. патч + настройки
  await install.patchDiscord();
  await install.applyVencordSettings();

  // 7. Vesktop
  const lv = await install.linkVesktop({ force: false });
  if (lv.foreign) {
    if (silent) {
      log.warn(`Vesktop указывает на чужую сборку (${lv.foreign}) — не трогаю`);
    } else {
      return { done: false, vesktopForeign: lv.foreign, patched: true };
    }
  }

  log.ok('Готово. Запускай Discord / Vesktop.');
  return { done: true, patched: true };
}

module.exports = { updateEverything };
