// VencForge — git-операции. Если git не установлен — фолбэк на zip с GitHub (публичные репо),
// для приватных — токен из настроек (api.github.com zipball).
const fs = require('fs');
const path = require('path');
const util = require('./util');
const log = require('./log');

let gitAvailable = null; // null = не проверяли, true/false

async function hasGit() {
  if (gitAvailable !== null) return gitAvailable;
  const r = await util.exec('git', ['--version']);
  gitAvailable = r.code === 0 && /git version/i.test(r.stdout + r.stderr);
  if (!gitAvailable) log.warn('git не найден — репозитории будут скачиваться zip-архивами с GitHub');
  return gitAvailable;
}

// https://github.com/<owner>/<repo>(.git)(/tree/<branch>) -> {owner, repo}
function parseGithubUrl(url) {
  const m = String(url || '').match(/github\.com[/:]([^/]+)\/([^/#?]+?)(?:\.git)?(?:\/tree\/([^/#?]+))?\/?$/i);
  if (!m) return null;
  return { owner: m[1], repo: m[2], branch: m[3] || null };
}

function githubHeaders() {
  const { getState } = require('./store');
  const token = (getState().settings.githubToken || '').trim();
  return token ? { Authorization: 'Bearer ' + token } : {};
}

// скачивание zip-архива ветки/коммита и распаковка в dir (без .git)
async function syncViaZip(url, dir, branch, onLine) {
  const info = parseGithubUrl(url);
  if (!info) throw new Error('Не похоже на GitHub-ссылку: ' + url);
  const tryBranches = [branch || info.branch, 'main', 'master'].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i);

  const headers = githubHeaders();
  const tmpZip = path.join(require('os').tmpdir(), `vencforge-${info.repo}-${Date.now()}.zip`);
  let lastErr = null;
  let okBranch = null;
  for (const br of tryBranches) {
    try {
      const apiUrl = `https://api.github.com/repos/${info.owner}/${info.repo}/zipball/${encodeURIComponent(br)}`;
      if (onLine) onLine('out', `Скачиваю zip: ${info.owner}/${info.repo}@${br}`);
      await util.download(apiUrl, tmpZip, { headers });
      okBranch = br;
      break;
    } catch (e) {
      lastErr = e;
    }
  }
  if (!okBranch) throw new Error(`Не удалось скачать ${info.owner}/${info.repo}: ${lastErr && lastErr.message}`);

  // Распаковываем РЯДОМ с назначением (тот же том — rename возможен всегда):
  // %TEMP% может быть на другом диске (rename между томами = EXDEV/EPERM),
  // плюс свежераспакованное любят держать под хэндлами Defender/индексатор.
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const tmpUn = path.join(path.dirname(dir), `.${path.basename(dir)}.unzip-${Date.now()}`);
  try {
    await util.unzip(tmpZip, tmpUn);
  } finally {
    try { fs.unlinkSync(tmpZip); } catch { }
  }

  // в архиве одна папка <repo>-<sha>; переносим содержимое в dir
  const entries = fs.readdirSync(tmpUn);
  const inner = entries.map((e) => path.join(tmpUn, e)).find((p) => fs.statSync(p).isDirectory()) || tmpUn;

  // подчистить прошлую попытку: хвостовые esbuild держат хэндлы в node_modules
  await util.killStrayBuilders();
  // Если вычистить НЕ удалось — падаем ГРОМКО: наложить свежие исходники поверх
  // обрезков = битое дерево (pnpm потом «доставляет 8 пакетов» вместо всех)
  for (let i = 0; i < 5 && fs.existsSync(dir); i++) {
    util.rmrf(dir);
    if (fs.existsSync(dir)) await util.sleep(400);
  }
  if (fs.existsSync(dir)) {
    throw new Error(`Не смог полностью удалить старую папку ${dir} — её держит антивирус или чужой процесс. Перезапусти ПК (или убей esbuild.exe/node.exe в диспетчере) и повтори`);
  }

  // перенос с ретраями (EPERM от антивируса) и фолбэком на рекурсивную копию
  const how = await util.renameWithRetry(inner, dir);
  if (how === 'copy') log.warn('rename не удался — исходники перенесены копированием');
  util.rmrf(tmpUn);
  return { ok: true, changed: true, mode: 'zip' };
}

// клон/обновление репозитория. Возвращает {ok, changed, mode}
async function syncRepo({ url, dir, branch = 'main', onLine }) {
  const say = (tag, line) => { if (onLine) onLine(tag, line); };

  if (!fs.existsSync(dir) || !fs.existsSync(path.join(dir, '.git'))) {
    if (await hasGit()) {
      say('out', `git clone --depth 1 (${branch})`);
      util.rmrf(dir);
      const r = await util.exec('git', ['clone', '--depth', '1', '--branch', branch, url, dir]);
      if (r.code !== 0) {
        // ветки может не быть — пробуем клон по умолчанию
        const r2 = await util.exec('git', ['clone', '--depth', '1', url, dir]);
        if (r2.code !== 0) {
          const tail = String(r2.stderr || r.stderr || '').trim().split(/\r?\n/).filter(Boolean).pop();
          say('err', 'git clone не удался' + (tail ? ` — ${tail.slice(0, 140)}` : '') + ', пробую zip-фолбэк');
          return syncViaZip(url, dir, branch, onLine);
        }
      }
      return { ok: true, changed: true, mode: 'git' };
    }
    return syncViaZip(url, dir, branch, onLine);
  }

  // уже cloned — обновляем
  if (await hasGit()) {
    const before = (await util.exec('git', ['-C', dir, 'rev-parse', 'HEAD'])).stdout.trim();
    await util.exec('git', ['-C', dir, 'remote', 'set-url', 'origin', url]);
    const f = await util.exec('git', ['-C', dir, 'fetch', '--depth', '1', 'origin', branch]);
    if (f.code !== 0) {
      const f2 = await util.exec('git', ['-C', dir, 'fetch', '--depth', '1', 'origin']);
      if (f2.code !== 0) { say('err', 'git fetch не удался (сеть?)'); return { ok: false, changed: false, mode: 'git' }; }
    }
    const branchRef = f.code === 0 ? 'FETCH_HEAD' : 'origin/' + branch;
    const rs = await util.exec('git', ['-C', dir, 'reset', '--hard', branchRef]);
    if (rs.code !== 0) { say('err', 'git reset не удался'); return { ok: false, changed: false, mode: 'git' }; }
    await util.exec('git', ['-C', dir, 'clean', '-fd']);
    const after = (await util.exec('git', ['-C', dir, 'rev-parse', 'HEAD'])).stdout.trim();
    return { ok: true, changed: before !== after, mode: 'git' };
  }

  // cloned ранее zip-ом (нет .git) — перекачиваем
  return syncViaZip(url, dir, branch, onLine);
}

async function gitHead(dir) {
  if (!fs.existsSync(path.join(dir, '.git'))) return null;
  const r = await util.exec('git', ['-C', dir, 'rev-parse', '--short', 'HEAD']);
  return r.code === 0 ? r.stdout.trim() : null;
}

module.exports = { hasGit, syncRepo, syncViaZip, gitHead, parseGithubUrl };
