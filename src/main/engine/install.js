// VencForge — установка: патч Discord (asar-шим) + OpenAsar, настройки Vencord
// Схема файлов в resources Discord:
//   app.asar          — наш шим (require patcher.js сборки VencForge)
//   _app.asar         — то, что грузит шим: OpenAsar (если включён) или оригинал Discord
//   app-original.asar — нетронутая копия оригинала Discord (для отката OpenAsar/всего патча)
//
// ВАЖНО: все операции с .asar-файлами — через fsx (original-fs). Обычный fs в
// пакнутом Electron патчится и превращает работу с самим asar-архивом в поиск
// записи '' внутри него («ENOENT,  not found in _app.asar»).
// Ещё бывает сломанное состояние: app.asar — ПАПКА (после апдейтов Discord или
// старых установщиков). Чинится рекурсивной очисткой и перепатчиванием.
const fs = require('fs');
const path = require('path');
const util = require('./util');
const { fsx, pathKind, copyFile, rmrfSafe } = util;
const log = require('./log');
const { buildAsarShim } = require('./asar');
const clients = require('./clients');
const { DistDir, APPDATA, Root } = require('./paths');
const { getConfig, getState } = require('./store');

const OPENASAR_URL = 'https://github.com/GooseMod/OpenAsar/releases/download/nightly/app.asar';

function requirePatcher() {
  const patcher = path.join(DistDir, 'patcher.js');
  if (!util.exists(patcher)) throw new Error('Нет patcher.js — сначала собери Vencord (вкладка «Сборка»)');
  return patcher;
}

// внутри asar'а OpenAsar есть строки "OpenAsar"; в оригинальном Discord их нет.
// Читаем сырые байты через fsx (обычный fs в Electron с архевом так не умеет)
function isOpenAsarAsar(p) {
  try {
    const st = fsx.statSync(p);
    if (!st.isFile() || st.size < 4096) return false;
    const fd = fsx.openSync(p, 'r');
    try {
      const len = Math.min(st.size, 4 * 1024 * 1024);
      const buf = Buffer.alloc(len);
      fsx.readSync(fd, buf, 0, len, 0);
      return /openasar/i.test(buf.toString('latin1'));
    } finally {
      try { fsx.closeSync(fd); } catch { }
    }
  } catch {
    return false;
  }
}

function asarStatus(di) {
  const appAsar = path.join(di.resources, 'app.asar');
  const backupAsar = path.join(di.resources, '_app.asar');
  const appKind = pathKind(appAsar);
  const patched = !!util.exists(backupAsar);
  return {
    patched,
    openAsar: patched && isOpenAsarAsar(backupAsar),
    broken: appKind === 'dir',
    appKind,
  };
}

// патч одного Discord-установза. Вынесено отдельно — легко тестировать
async function patchOne(di, { patcher, wantOpenAsar } = {}) {
  const res = di.resources;
  const appAsar = path.join(res, 'app.asar');
  const backupAsar = path.join(res, '_app.asar');
  const originalAsar = path.join(res, 'app-original.asar');

  let appKind = pathKind(appAsar);
  let backupKind = pathKind(backupAsar);

  // 0. сломанное состояние: app.asar — ПАПКА (Discord-апдейтер/старые установщики)
  if (appKind === 'dir') {
    log.warn(`Discord ${di.label}: app.asar оказался ПАПКОЙ (сломанное состояние) — чищу`);
    if (!rmrfSafe(appAsar)) throw new Error('не смог удалить папку app.asar (клиент запущен?)');
    appKind = null;
  }

  // 1. бэкап оригинала — один раз, потом никогда не трогаем
  if (!util.exists(originalAsar)) {
    // берём только настоящий Discord-asar (не OpenAsar)
    if (backupKind === 'file' && !isOpenAsarAsar(backupAsar)) {
      copyFile(backupAsar, originalAsar);
    } else if (appKind === 'file' && !isOpenAsarAsar(appAsar)) {
      copyFile(appAsar, originalAsar);
    } else {
      log.warn(`Discord ${di.label}: оригинальный app.asar не найден (только OpenAsar?) — откат возможен переустановкой Discord`);
    }
  }

  // 2. снова вычисляем appKind (мог почиститься) и готовим _app.asar — то, что грузит шим
  appKind = pathKind(appAsar);
  backupKind = pathKind(backupAsar);
  if (backupKind !== 'file') {
    if (backupKind === 'dir') {
      log.warn(`Discord ${di.label}: _app.asar оказался ПАПКОЙ — чищу`);
      if (!rmrfSafe(backupAsar)) throw new Error('не смог удалить папку _app.asar (клиент запущен?)');
    }
    if (appKind === 'file') {
      // ретраи: Defender/запущенный Discord держат хэндл на app.asar — rename кидает EPERM
      await util.renameWithRetry(appAsar, backupAsar);
    } else if (util.exists(originalAsar)) {
      copyFile(originalAsar, backupAsar);
    } else if (wantOpenAsar) {
      // оригинала нет вообще — OpenAsar самостоятельный бутстрап, им можно заменить
      log.info(`Discord ${di.label}: оригинала нет — ставлю OpenAsar как основу`);
      await util.download(OPENASAR_URL, backupAsar);
    } else {
      throw new Error('нет ни app.asar, ни бэкапа — включи OpenAsar в настройках или переустанови Discord');
    }
  }

  // 3. OpenAsar (тумблер в настройках, по умолчанию включён)
  if (wantOpenAsar) {
    if (isOpenAsarAsar(backupAsar)) {
      log.info(`Discord ${di.label}: OpenAsar уже установлен`);
    } else {
      try {
        await util.download(OPENASAR_URL, backupAsar);
        log.ok(`Discord ${di.label}: OpenAsar установлен (оригинал сохранён в app-original.asar)`);
      } catch (e) {
        log.warn(`Discord ${di.label}: OpenAsar скачать не удалось (${e.message}) — продолжаю без него`);
      }
    }
  } else if (isOpenAsarAsar(backupAsar) && util.exists(originalAsar)) {
    copyFile(originalAsar, backupAsar);
    log.info(`Discord ${di.label}: OpenAsar снят (в настройках выключен)`);
  }

  // 4. наш шим поверх (перезаписываем любой файл; папку — только если снова появилась)
  if (pathKind(appAsar) === 'dir' && !rmrfSafe(appAsar)) {
    throw new Error('app.asar снова папка и не удаляется (клиент запущен?)');
  }
  buildAsarShim(patcher, appAsar);
  log.ok(`Discord ${di.label}: патч обновлён${wantOpenAsar ? ' + OpenAsar' : ''} (Vencord из сборки VencForge)`);
  return true;
}

// патч всех найденных Discord: шим + (опционально) OpenAsar
async function patchDiscord() {
  const patcher = requirePatcher();
  const installs = clients.findDiscordInstalls();
  const wantOpenAsar = !!getState().settings.installOpenAsar;
  let n = 0;
  for (const di of installs) {
    try {
      if (await patchOne(di, { patcher, wantOpenAsar })) n++;
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
    const res = di.resources;
    const appAsar = path.join(res, 'app.asar');
    const backupAsar = path.join(res, '_app.asar');
    const originalAsar = path.join(res, 'app-original.asar');
    if (!util.exists(backupAsar) && !util.exists(originalAsar) && pathKind(appAsar) === null) continue;
    try {
      const src = util.exists(originalAsar) ? originalAsar : backupAsar;
      // recursive: app.asar/_app.asar могут быть папками (сломанное состояние) — EISDIR без него
      rmrfSafe(backupAsar);
      rmrfSafe(appAsar);
      if (src && util.exists(src)) {
        copyFile(src, appAsar);
      } else {
        log.warn(`Discord ${di.label}: бэкапа нет — оригинал придётся переустановить с discord.com`);
      }
      rmrfSafe(originalAsar);
      log.ok(`Discord ${di.label}: оригинал восстановлен`);
      n++;
    } catch (e) {
      log.err(`Discord ${di.label}: не удалось восстановить — ${e.message} (клиент запущен?)`);
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

// диагностика текстом в лог
async function doctor() {
  const tools = require('./tools');
  log.info('=== VencForge: диагностика ===');
  const gitops = require('./gitops');
  const g = await gitops.hasGit();
  const node = await tools.systemNodeVersion();
  log.info(`git: ${g ? 'есть' : 'НЕТ (буду качать zip)'}`);
  log.info(`node (системный): ${node ? node.raw : 'НЕТ'}`);
  const pn = tools.probePnpm();
  log.info(`pnpm: ${pn ? `${pn.path} (${pn.src})` : 'не найден — подберу/установлю при сборке'}`);
  log.info(`папка данных: ${Root}`);
  log.info(`dist: ${DistDir} — ${util.exists(path.join(DistDir, 'patcher.js')) ? 'сборка есть' : 'нет сборки'}`);
  const cfg = getConfig();
  for (const p of cfg.plugins) {
    const src = p.type === 'git' ? p.url : (p.sourcePath || '?');
    log.info(`плагин: ${p.name} (${p.type}) -> ${src}`);
  }
  const wantOpenAsar = !!getState().settings.installOpenAsar;
  log.info(`OpenAsar: ${wantOpenAsar ? 'включён в установку' : 'выключен в настройках'}`);
  for (const di of clients.findDiscordInstalls()) {
    const st = asarStatus(di);
    const kindTxt = st.appKind === 'dir' ? 'app.asar — ПАПКА (сломано!)' : st.appKind === 'file' ? 'app.asar есть' : 'app.asar нет';
    log.info(`Discord ${di.label} ${di.version}: ${st.patched ? 'пропатчен' : 'оригинал'}${st.patched ? (st.openAsar ? ' + OpenAsar' : ' без OpenAsar') : ''}${st.broken ? ' [СЛОМАН: app.asar — папка]' : ''} (${di.resources}; ${kindTxt})`);
  }
  const running = await clients.getRunningClients();
  log.info(`запущено клиентов: ${running.length ? running.join(', ') : 'нет'}`);
  log.info('=== конец диагностики ===');
}

module.exports = { patchDiscord, unpatchDiscord, applyVencordSettings, doctor, requirePatcher, asarStatus, patchOne, isOpenAsarAsar };
