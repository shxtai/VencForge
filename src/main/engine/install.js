// VencForge — установка: патч Discord (asar-шим) + OpenAsar, настройки Vencord
// Схема файлов в resources Discord:
//   app.asar          — наш шим (require patcher.js сборки VencForge)
//   _app.asar         — то, что грузит шим: OpenAsar (если включён) или оригинал Discord
//   app-original.asar — нетронутая копия оригинала Discord (для отката OpenAsar/всего патча)
const fs = require('fs');
const path = require('path');
const util = require('./util');
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

// внутри asar'а OpenAsar есть строки "OpenAsar"; в оригинальном Discord их нет
function isOpenAsarAsar(p) {
  try {
    const st = fs.statSync(p);
    if (!st.isFile() || st.size < 4096) return false;
    const fd = fs.openSync(p, 'r');
    const len = Math.min(st.size, 4 * 1024 * 1024);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, 0);
    fs.closeSync(fd);
    return /openasar/i.test(buf.toString('latin1'));
  } catch {
    return false;
  }
}

function asarStatus(di) {
  const appAsar = path.join(di.resources, 'app.asar');
  const backupAsar = path.join(di.resources, '_app.asar');
  if (!util.exists(backupAsar)) return { patched: false, openAsar: false };
  return { patched: true, openAsar: isOpenAsarAsar(backupAsar) };
}

// патч всех найденных Discord: шим + (опционально) OpenAsar
async function patchDiscord() {
  const patcher = requirePatcher();
  const installs = clients.findDiscordInstalls();
  const wantOpenAsar = !!getState().settings.installOpenAsar;
  let n = 0;
  for (const di of installs) {
    const appAsar = path.join(di.resources, 'app.asar');
    const backupAsar = path.join(di.resources, '_app.asar');
    const originalAsar = path.join(di.resources, 'app-original.asar');
    try {
      // 1. бэкап оригинала (один раз, потом никогда не трогаем)
      if (!util.exists(originalAsar)) {
        if (util.exists(backupAsar)) fs.copyFileSync(backupAsar, originalAsar);
        else if (util.exists(appAsar)) fs.copyFileSync(appAsar, originalAsar);
      }

      // 2. _app.asar — то, что грузит наш шим
      if (!util.exists(backupAsar)) {
        if (util.exists(appAsar)) fs.renameSync(appAsar, backupAsar);
        else if (util.exists(originalAsar)) fs.copyFileSync(originalAsar, backupAsar);
      }
      if (!util.exists(backupAsar)) {
        log.warn(`Discord ${di.label}: нет app.asar — пропускаю`);
        continue;
      }

      // 3. OpenAsar
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
        fs.copyFileSync(originalAsar, backupAsar);
        log.info(`Discord ${di.label}: OpenAsar снят (в настройках выключен)`);
      }

      // 4. наш шим поверх
      buildAsarShim(patcher, appAsar);
      log.ok(`Discord ${di.label}: патч обновлён${wantOpenAsar ? ' + OpenAsar' : ''} (Vencord из сборки VencForge)`);
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
    const originalAsar = path.join(di.resources, 'app-original.asar');
    if (!util.exists(backupAsar) && !util.exists(originalAsar)) continue;
    try {
      const src = util.exists(originalAsar) ? originalAsar : backupAsar;
      if (util.exists(originalAsar) && util.exists(backupAsar)) fs.rmSync(backupAsar, { force: true });
      if (util.exists(appAsar)) fs.rmSync(appAsar, { force: true });
      fs.copyFileSync(src, appAsar);
      if (util.exists(originalAsar)) fs.rmSync(originalAsar, { force: true });
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

// диагностика текстом в лог
async function doctor() {
  const gitops = require('./gitops');
  const tools = require('./tools');
  log.info('=== VencForge: диагностика ===');
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
    log.info(`Discord ${di.label} ${di.version}: ${st.patched ? 'пропатчен' : 'оригинал'}${st.patched ? (st.openAsar ? ' + OpenAsar' : ' без OpenAsar') : ''} (${di.resources})`);
  }
  const running = await clients.getRunningClients();
  log.info(`запущено клиентов: ${running.length ? running.join(', ') : 'нет'}`);
  log.info('=== конец диагностики ===');
}

module.exports = { patchDiscord, unpatchDiscord, applyVencordSettings, doctor, requirePatcher, asarStatus };
