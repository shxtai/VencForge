// VencForge — реестр плагинов: Git-ссылка / локальная папка / одиночный файл
// Материализация в workspace/plugins/<name>, синхронизация в src/userplugins (как в veskforge)
const fs = require('fs');
const path = require('path');
const util = require('./util');
const log = require('./log');
const gitops = require('./gitops');
const { PluginsDir, UserPluginsDir } = require('./paths');
const { getConfig, saveConfig } = require('./store');

const INDEX_EXTS = ['index.tsx', 'index.ts', 'index.jsx', 'index.js'];
const FILE_EXTS = ['.ts', '.tsx', '.js', '.jsx'];

// корень плагина: index.* в корне каталога ИЛИ ровно в одной подпапке
function findPluginRoot(dir) {
  for (const ext of INDEX_EXTS) {
    if (util.exists(path.join(dir, ext))) return dir;
  }
  const hits = [];
  let subs = [];
  try { subs = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name !== '.git'); } catch { }
  for (const s of subs) {
    for (const ext of INDEX_EXTS) {
      if (util.exists(path.join(dir, s.name, ext))) { hits.push(path.join(dir, s.name)); break; }
    }
  }
  return hits.length === 1 ? hits[0] : null;
}

function getPluginMeta(name) {
  return getConfig().plugins.find((p) => p.name === name) || null;
}

function repoNameFromUrl(url) {
  const m = String(url || '').match(/[\/:]([^\/?#]+?)(?:\.git)?\/?$/);
  return m ? m[1] : null;
}

// метка свежести исходника (folder/file): максимальный mtime файлов
function srcStamp(p) {
  try {
    const st = fs.statSync(p);
    if (st.isFile()) return st.mtimeMs;
    let max = 0;
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.name === '.git') continue;
        const fp = path.join(d, e.name);
        if (e.isDirectory()) walk(fp);
        else { const s = fs.statSync(fp); if (s.mtimeMs > max) max = s.mtimeMs; }
      }
    };
    walk(p);
    return max;
  } catch { return 0; }
}

async function addGit(url) {
  const name = util.safeName(repoNameFromUrl(url) || '');
  if (!name) throw new Error('Не понял ссылку — нужен адрес репозитория GitHub');
  if (getPluginMeta(name)) throw new Error(`Плагин «${name}» уже есть в списке`);
  log.info(`Добавляю плагин из Git: ${url}`);
  const dir = path.join(PluginsDir, name);
  const r = await gitops.syncRepo({ url, dir, branch: 'main' });
  if (!r.ok) throw new Error('Не удалось скачать репозиторий (сеть? ссылка?)');
  const root = findPluginRoot(dir);
  if (!root) {
    util.rmrf(dir);
    throw new Error('В репозитории не найден index.ts/tsx/js/jsx (в корне или в одной подпапке)');
  }
  const cfg = getConfig();
  cfg.plugins.push({
    name, type: 'git', url, addedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
  saveConfig();
  log.ok(`Плагин «${name}» добавлен (git)`);
  return { name };
}

async function addFolder(folderPath) {
  if (!util.exists(folderPath)) throw new Error('Папка не найдена: ' + folderPath);
  const name = util.safeName(path.basename(folderPath));
  if (!name) throw new Error('Не понял имя папки');
  if (getPluginMeta(name)) throw new Error(`Плагин «${name}» уже есть в списке`);
  const probe = findPluginRoot(folderPath);
  if (!probe) throw new Error('В папке не найден index.ts/tsx/js/jsx (в корне или в одной подпапке)');
  log.info(`Добавляю плагин из папки: ${folderPath}`);
  const dir = path.join(PluginsDir, name);
  util.rmrf(dir);
  util.copyDir(folderPath, dir);
  const cfg = getConfig();
  cfg.plugins.push({
    name, type: 'folder', sourcePath: folderPath, srcStamp: srcStamp(folderPath), addedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
  saveConfig();
  log.ok(`Плагин «${name}» добавлен (папка)`);
  return { name };
}

async function addFile(filePath) {
  if (!util.exists(filePath)) throw new Error('Файл не найден: ' + filePath);
  const ext = path.extname(filePath).toLowerCase();
  if (!FILE_EXTS.includes(ext)) {
    throw new Error('Файл плагина должен быть .ts, .tsx, .js или .jsx (и экспортировать плагин через export default)');
  }
  const name = util.safeName(path.basename(filePath, ext));
  if (!name) throw new Error('Не понял имя файла');
  if (getPluginMeta(name)) throw new Error(`Плагин «${name}» уже есть в списке`);
  log.info(`Добавляю плагин из файла: ${filePath}`);
  const dir = path.join(PluginsDir, name);
  util.rmrf(dir);
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(filePath, path.join(dir, 'index' + ext));
  const cfg = getConfig();
  cfg.plugins.push({
    name, type: 'file', sourcePath: filePath, srcStamp: srcStamp(filePath), addedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
  saveConfig();
  log.ok(`Плагин «${name}» добавлен (файл)`);
  return { name };
}

async function updatePlugin(name) {
  const meta = getPluginMeta(name);
  if (!meta) throw new Error('Плагин не найден: ' + name);
  const dir = path.join(PluginsDir, name);
  let changed = false;
  if (meta.type === 'git') {
    const r = await gitops.syncRepo({ url: meta.url, dir, branch: 'main' });
    if (!r.ok) throw new Error('git не обновился (сеть?)');
    if (!findPluginRoot(dir)) throw new Error('После обновления в репозитории не найден index.*');
    changed = !!r.changed;
  } else {
    const src = meta.sourcePath;
    if (!src || !util.exists(src)) {
      log.warn(`Исходник «${src || '?'}» недоступен — оставляю предыдущую копию`);
      return { changed: false };
    }
    const stamp = srcStamp(src);
    if (meta.srcStamp && stamp === meta.srcStamp) {
      log.info(`Плагин «${name}» без изменений (исходник не менялся)`);
      return { changed: false };
    }
    if (meta.type === 'folder') {
      if (!findPluginRoot(src)) throw new Error('В исходной папке больше нет index.*');
      util.rmrf(dir);
      util.copyDir(src, dir);
    } else {
      const ext = path.extname(src).toLowerCase();
      if (!FILE_EXTS.includes(ext)) throw new Error('Исходный файл больше не .ts/.tsx/.js/.jsx');
      util.rmrf(dir);
      fs.mkdirSync(dir, { recursive: true });
      fs.copyFileSync(src, path.join(dir, 'index' + ext));
    }
    meta.srcStamp = stamp;
    changed = true;
  }
  if (changed) {
    meta.updatedAt = new Date().toISOString();
    saveConfig();
    log.ok(`Плагин «${name}» обновлён`);
  }
  return { changed };
}

async function removePlugin(name) {
  const cfg = getConfig();
  const i = cfg.plugins.findIndex((p) => p.name === name);
  if (i < 0) throw new Error('Плагин не найден: ' + name);
  cfg.plugins.splice(i, 1);
  saveConfig();
  util.rmrf(path.join(PluginsDir, name));
  log.ok(`Плагин «${name}» удалён из списка (пересобери Vencord, чтобы убрать его из сборки)`);
}

// пересоздаём src/userplugins из манифеста — плагины выживают любые обновления Vencord
async function syncToUserplugins() {
  const up = UserPluginsDir;
  fs.mkdirSync(up, { recursive: true });
  // чистим всё, кроме служебных файлов Vencord
  for (const entry of fs.readdirSync(up)) {
    if (entry === '.gitkeep') continue;
    util.rmrf(path.join(up, entry));
  }
  let n = 0;
  for (const meta of getConfig().plugins) {
    const dir = path.join(PluginsDir, meta.name);
    if (!util.exists(dir)) { log.warn(`Плагин ${meta.name} не скачан — пропускаю`); continue; }
    const root = findPluginRoot(dir);
    if (!root) { log.warn(`В ${meta.name} не найден index.* — пропускаю`); continue; }
    const dest = path.join(up, meta.name);
    util.rmrf(dest);
    util.copyDir(root, dest);
    n++;
    log.ok(`Плагин ${meta.name} подключён к сборке`);
  }
  return n;
}

module.exports = { addGit, addFolder, addFile, updatePlugin, removePlugin, syncToUserplugins, findPluginRoot, getPluginMeta, repoNameFromUrl };
