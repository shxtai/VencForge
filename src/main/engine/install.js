// VencForge — установка: патч Discord (asar-шим), настройки Vencord, Vesktop (vencordDir)
const fs = require('fs');
const path = require('path');
const util = require('./util');
const log = require('./log');
const { buildAsarShim } = require('./asar');
const clients = require('./clients');
const { DistDir, APPDATA, Root, Workspace, PnpmPrefix } = require('./paths');
const { getConfig, getState } = require('./store');

function requirePatcher() {
  const patcher = path.join(DistDir, 'patcher.js');
  if (!util.exists(patcher)) throw new Error('Нет patcher.js — сначала собери Vencord (вкладка «Сборка»)');
  return patcher;
}

// патч всех найденных Discord: app.asar -> _app.asar (оригинал) + наш шим
async function patchDiscord() {
  const patcher = requirePatcher();
  const installs = clients.findDiscordInstalls();
  let n = 0;
  for (const di of installs) {
    const appAsar = path.join(di.resources, 'app.asar');
    const backupAsar = path.join(di.resources, '_app.asar');
    try {
      if (!di.patched && di.appAsarExists) {
        fs.renameSync(appAsar, backupAsar);
      }
      if (!util.exists(backupAsar)) {
        log.warn(`Discord ${di.label}: нет app.asar — пропускаю`);
        continue;
      }
      buildAsarShim(patcher, appAsar);
      log.ok(`Discord ${di.label}: патч обновлён (оригинал хранится как _app.asar)`);
      n++;
    } catch (e) {
      log.err(`Discord ${di.label}: не удалось пропатчить — ${e.message} (клиент запущен?)`);
    }
  }
  if (n === 0 && installs.length === 0) {
    log.warn('Discord-установки не найдены. Нужен сам Discord — discord.com/download');
  }
  return n;
}

// восстановление оригинала
async function unpatchDiscord() {
  const installs = clients.findDiscordInstalls();
  let n = 0;
  for (const di of installs) {
    const appAsar = path.join(di.resources, 'app.asar');
    const backupAsar = path.join(di.resources, '_app.asar');
    if (!util.exists(backupAsar)) continue;
    try {
      if (util.exists(appAsar)) fs.rmSync(appAsar, { force: true });
      fs.renameSync(backupAsar, appAsar);
      log.ok(`Discord ${di.label}: оригинал восстановлен`);
      n++;
    } catch (e) {
      log.err(`Discord ${di.label}: не удалось восстановить — ${e.message}`);
    }
  }
  if (n === 0) log.info('Пропатченных установок Discord не найдено');
  return n;
}

// settings.json Vencord: autoUpdate off + включение наших плагинов
async function applyVencordSettings() {
  const enablePlugins = !!getState().settings.enablePlugins;
  try {
    const sdir = path.join(APPDATA, 'Vencord', 'settings');
    const sp = path.join(sdir, 'settings.json');
    fs.mkdirSync(sdir, { recursive: true });
    const obj = util.readJson(sp) || {};
    obj.autoUpdate = false;
    obj.autoUpdateNotification = false;
    if (enablePlugins) {
      if (!obj.plugins || typeof obj.plugins !== 'object') obj.plugins = {};
      for (const p of getConfig().plugins) {
        if (!obj.plugins[p.name] || typeof obj.plugins[p.name] !== 'object') obj.plugins[p.name] = {};
        obj.plugins[p.name].enabled = true;
      }
    }
    util.writeJsonNoBom(sp, obj);
    log.ok('Vencord: autoUpdate выключен (сборкой управляет VencForge)' + (enablePlugins ? ', плагины включены' : ''));
  } catch (e) {
    log.warn('Не удалось обновить settings.json Vencord: ' + e.message);
  }
}

// Vesktop: vencordDir -> наша сборка (state.json, строгий JSON без BOM)
async function linkVesktop({ force = false } = {}) {
  const vdir = path.join(APPDATA, 'vesktop');
  if (!util.exists(vdir)) {
    log.info('Vesktop не установлен — шаг пропущен');
    return { done: true, skipped: true };
  }
  if (!util.exists(path.join(DistDir, 'vencordDesktopMain.js'))) {
    log.err('Нет сборки (dist) — сначала собери Vencord');
    return { done: false };
  }
  const statePath = path.join(vdir, 'state.json');
  const state = util.readJson(statePath) || {};
  const cur = state.vencordDir || null;
  if (cur && path.normalize(cur).toLowerCase() !== path.normalize(DistDir).toLowerCase()) {
    if (!force) {
      return { done: false, foreign: cur };
    }
    log.warn(`vencordDir был: ${cur} — перенаправляю на сборку VencForge`);
  }
  state.vencordDir = DistDir;
  util.writeJsonNoBom(statePath, state);
  log.ok('Vesktop подключён к сборке VencForge: ' + DistDir);
  return { done: true };
}

async function unlinkVesktop() {
  const statePath = path.join(APPDATA, 'vesktop', 'state.json');
  if (!util.exists(statePath)) return;
  const state = util.readJson(statePath);
  if (state && state.vencordDir) {
    if (path.normalize(state.vencordDir).toLowerCase() === path.normalize(DistDir).toLowerCase()) {
      delete state.vencordDir;
      util.writeJsonNoBom(statePath, state);
      log.ok('Vesktop: vencordDir снят (вернулся к официальной сборке)');
    } else {
      log.info('Vesktop указывает на чужую сборку — не трогаю: ' + state.vencordDir);
    }
  }
}

// диагностика текстом в лог
async function doctor() {
  const gitops = require('./gitops');
  const tools = require('./tools');
  log.info('=== VencForge: диагностика ===');
  const g = await gitops.hasGit();
  const node = await tools.systemNodeVersion();
  log.info(`git: ${g ? 'есть' : 'НЕТ (буду качать zip)'}`);
  log.info(`node (системный): ${node ? node.raw : 'НЕТ'}`);
  const pn = util.exists(path.join(PnpmPrefix, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'));
  log.info(`pnpm (VencForge): ${pn ? 'установлен' : 'будет установлен при сборке'}`);
  log.info(`папка данных: ${Root}`);
  log.info(`workspace: ${Workspace}`);
  log.info(`dist: ${DistDir} — ${util.exists(path.join(DistDir, 'patcher.js')) ? 'сборка есть' : 'нет сборки'}`);
  const cfg = getConfig();
  for (const p of cfg.plugins) {
    const src = p.type === 'git' ? p.url : (p.sourcePath || '?');
    log.info(`плагин: ${p.name} (${p.type}) -> ${src}`);
  }
  for (const di of clients.findDiscordInstalls()) {
    log.info(`Discord ${di.label} ${di.version}: ${di.patched ? 'пропатчен' : 'оригинал'} (${di.resources})`);
  }
  const st = util.readJson(path.join(APPDATA, 'vesktop', 'state.json'));
  log.info(`Vesktop vencordDir: ${st && st.vencordDir ? st.vencordDir : 'по умолчанию'}`);
  const running = await clients.getRunningClients();
  log.info(`запущено клиентов: ${running.length ? running.join(', ') : 'нет'}`);
  log.info('=== конец диагностики ===');
}

module.exports = { patchDiscord, unpatchDiscord, applyVencordSettings, linkVesktop, unlinkVesktop, doctor, requirePatcher };
