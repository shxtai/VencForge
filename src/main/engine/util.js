// VencForge — низкоуровневые утилиты: процессы, скачивание, распаковка, файлы
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

function log2(txt) { const log = require('./log'); log.raw(txt); }

// ВАЖНО: в пакнутом Electron fs патчится (asar-виртуальная ФС). Любая работа с
// .asar-ФАЙЛАМИ (копия/переименование/чтение/запись самого архива) обязана идти
// через original-fs, иначе Electron ищет запись '' внутри архива и кидает
// «ENOENT,  not found in ...\_app.asar». В обычном Node original-fs нет — там fs.
let fsx;
try { fsx = require('original-fs'); } catch { fsx = fs; }
if (!fsx || typeof fsx.readFileSync !== 'function') fsx = fs;

// ---------------------------------------------------------------- процессы
const IS_WIN = process.platform === 'win32';

// .cmd/.bat на Windows нельзя спавнить без shell (Node >= 18.20/20.12: EINVAL, CVE-2024-27980)
function needsShell(cmd) {
  if (!IS_WIN) return false;
  if (/\.(cmd|bat)$/i.test(cmd)) return true;
  return /^(npm|npx|pnpm|yarn|corepack)(\.cmd)?$/i.test(path.basename(cmd));
}

// при shell:true собираем одну строку и квотим пути с пробелами
function shellLine(cmd, args) {
  const q = (s) => (/\s/.test(String(s)) ? '"' + String(s).replace(/"/g, '""') + '"' : String(s));
  return [q(cmd), ...args.map(q)].join(' ');
}

function exec(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    let stdout = '', stderr = '';
    const useShell = !!opts.shell || needsShell(cmd);
    let p;
    try {
      p = useShell
        ? spawn(shellLine(cmd, args), { cwd: opts.cwd, env: opts.env, windowsHide: true, shell: true })
        : spawn(cmd, args, { cwd: opts.cwd, env: opts.env, windowsHide: true });
    } catch (e) {
      return resolve({ code: -1, stdout: '', stderr: String(e && e.message || e) });
    }
    p.stdout && p.stdout.on('data', (d) => { stdout += d.toString(); });
    p.stderr && p.stderr.on('data', (d) => { stderr += d.toString(); });
    p.on('error', (e) => { stderr += String(e && e.message || e); });
    p.on('close', (code) => resolve({ code: code == null ? -1 : code, stdout, stderr }));
  });
}

// потоковый запуск с построчным выводом
function stream(cmd, args, { cwd, env, onLine, shell } = {}) {
  return new Promise((resolve) => {
    const useShell = !!shell || needsShell(cmd);
    let p;
    try {
      p = useShell
        ? spawn(shellLine(cmd, args), { cwd, env, windowsHide: true, shell: true })
        : spawn(cmd, args, { cwd, env, windowsHide: true });
    } catch (e) {
      if (onLine) onLine('err', String(e && e.message || e));
      return resolve(-1);
    }
    const feeder = (tag) => {
      let buf = '';
      return (d) => {
        buf += d.toString();
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).replace(/\r$/, '');
          buf = buf.slice(i + 1);
          if (line && onLine) onLine(tag, line);
        }
      };
    };
    if (p.stdout) p.stdout.on('data', feeder('out'));
    if (p.stderr) p.stderr.on('data', feeder('err'));
    p.on('error', (e) => { if (onLine) onLine('err', String(e && e.message || e)); });
    p.on('close', (c) => resolve(c == null ? -1 : c));
  });
}

// ---------------------------------------------------------------- сеть
function download(url, dest, { headers = {}, onProgress } = {}, depth = 0) {
  return new Promise((resolve, reject) => {
    if (depth > 8) return reject(new Error('Слишком много перенаправлений: ' + url));
    const mod = url.startsWith('http:') ? http : https;
    const req = mod.get(url, {
      headers: {
        'User-Agent': 'VencForge/1.1 (+https://github.com/shxtai/VencForge)',
        Accept: '*/*',
        ...headers,
      },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        return download(next, dest, { headers, onProgress }, depth + 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} для ${url}`));
      }
      const total = parseInt(res.headers['content-length'] || '0', 10);
      let got = 0;
      const tmp = dest + '.part';
      // fsx: dest может быть .asar-файлом (OpenAsar) — обычный fs в Electron его патчит
      const file = fsx.createWriteStream(tmp);
      res.on('data', (chunk) => {
        got += chunk.length;
        if (onProgress && total) onProgress(got, total);
      });
      res.pipe(file);
      file.on('finish', () => file.close(() => {
        try { fsx.renameSync(tmp, dest); resolve(dest); }
        catch (e) { reject(e); }
      }));
      file.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(120000, () => req.destroy(new Error('Таймаут скачивания: ' + url)));
  });
}

async function fetchText(url, headers = {}) {
  const tmp = path.join(require('os').tmpdir(), 'vencforge-fetch-' + Date.now() + '.txt');
  await download(url, tmp, { headers });
  const t = fs.readFileSync(tmp, 'utf8');
  try { fs.unlinkSync(tmp); } catch { }
  return t;
}

async function unzip(zipPath, destDir) {
  const extract = require('extract-zip');
  fs.mkdirSync(destDir, { recursive: true });
  await extract(zipPath, { dir: destDir });
}

// ---------------------------------------------------------------- файлы
function exists(p) { try { return fs.existsSync(p); } catch { return false; } }

function rmrf(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); return true; } catch (e) { log2('rmrf ' + p + ': ' + (e && e.message)); return false; }
}

function readJson(p) {
  try {
    const raw = fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(raw);
  } catch { return null; }
}

// JSON строго без BOM (строгие читатели вроде Vencord/Vesktop ждут чистый JSON)
function writeJsonNoBom(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8');
}

function copyDir(src, dest, { skip = ['.git', 'node_modules'] } = {}) {
  fs.cpSync(src, dest, {
    recursive: true,
    filter: (s) => {
      if (s === src) return true;
      const parts = s.split(path.sep);
      return !parts.some((x) => skip.includes(x));
    },
  });
}

function safeName(name) {
  return String(name || '').replace(/[^\w.\-]+/g, '_').replace(/^_+|_+$/g, '') || 'plugin';
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// рекурсивное удаление через original-fs (app.asar может оказаться ПАПКОЙ — сломанное
// состояние после апдейтов Discord/старых установщиков; rmSync без recursive = EISDIR)
function rmrfSafe(p) {
  try { fsx.rmSync(p, { recursive: true, force: true }); return true; }
  catch (e) { log2('rmrfSafe ' + p + ': ' + (e && e.message)); return false; }
}

// тип пути по original-fs: 'file' | 'dir' | null
function pathKind(p) {
  try { return fsx.statSync(p).isDirectory() ? 'dir' : 'file'; } catch { return null; }
}

function copyFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fsx.copyFileSync(src, dest);
}

module.exports = {
  exec, stream, download, fetchText, unzip,
  exists, rmrf, rmrfSafe, readJson, writeJsonNoBom, copyDir, safeName, sleep,
  fsx, pathKind, copyFile,
};
