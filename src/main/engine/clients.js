// VencForge — обнаружение клиентов: Discord (Stable/PTB/Canary/Dev)
// Vesktop НЕ трогаем: он на старой архитектуре и не является целевым клиентом
const fs = require('fs');
const path = require('path');
const { LOCALAPPDATA, APPDATA } = require('./paths');
const { exec, exists, readJson } = require('./util');

const BRANCHES = ['Discord', 'DiscordPTB', 'DiscordCanary', 'DiscordDevelopment'];
const BRANCH_LABELS = {
  Discord: 'Discord Stable',
  DiscordPTB: 'Discord PTB',
  DiscordCanary: 'Discord Canary',
  DiscordDevelopment: 'Discord Development',
};
const CLIENT_EXES = ['Discord.exe', 'DiscordPTB.exe', 'DiscordCanary.exe', 'DiscordDevelopment.exe'];

function findDiscordInstalls() {
  const list = [];
  for (const branch of BRANCHES) {
    const base = path.join(LOCALAPPDATA, branch);
    if (!exists(base)) continue;
    let apps = [];
    try {
      apps = fs.readdirSync(base)
        .filter((n) => /^app-/.test(n))
        .sort()
        .reverse()
        .map((n) => path.join(base, n))
        .filter((p) => exists(path.join(p, 'resources')));
    } catch { }
    for (const app of apps) {
      const res = path.join(app, 'resources');
      const appAsar = path.join(res, 'app.asar');
      const backupAsar = path.join(res, '_app.asar');
      if (!exists(appAsar) && !exists(backupAsar)) continue;
      list.push({
        kind: 'discord',
        branch,
        label: BRANCH_LABELS[branch] || branch,
        resources: res,
        appDir: app,
        version: path.basename(app).replace(/^app-/, ''),
        appAsarExists: exists(appAsar),
        patched: exists(backupAsar),
      });
    }
  }
  return list;
}

async function getRunningClients() {
  const r = await exec('tasklist', ['/FO', 'CSV', '/NH']);
  if (r.code !== 0 && !r.stdout) return [];
  const found = new Set();
  const re = /"([^"\\\/]+?\.exe)"/gi;
  let m;
  while ((m = re.exec(r.stdout)) !== null) {
    const name = m[1];
    if (CLIENT_EXES.some((x) => x.toLowerCase() === name.toLowerCase())) {
      found.add(name.replace(/\.exe$/i, ''));
    }
  }
  return [...found];
}

async function killClients(names) {
  const out = [];
  for (const n of names) {
    const r = await exec('taskkill', ['/F', '/T', '/IM', n + '.exe']);
    out.push({ name: n, ok: r.code === 0 });
  }
  await new Promise((res) => setTimeout(res, 1500));
  return out;
}

module.exports = { findDiscordInstalls, getRunningClients, killClients, BRANCHES, BRANCH_LABELS, CLIENT_EXES };
