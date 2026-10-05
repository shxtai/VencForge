// VencForge — config.json (совместим со скриптом PS1) и state.json
const fs = require('fs');
const { ConfigFile, StateFile, DEFAULT_VENCORD_REPO, DEFAULT_PLUGIN, ensureDirs } = require('./paths');
const { readJson, writeJsonNoBom } = require('./util');
const log = require('./log');

let config = null;
let state = null;

function defaultConfig() {
  return {
    vencordRepo: DEFAULT_VENCORD_REPO,
    vencordBranch: 'main',
    plugins: [{ ...DEFAULT_PLUGIN }],
  };
}

function normalizePlugin(p) {
  if (!p || !p.name) return null;
  const out = {
    name: String(p.name),
    type: p.type || (p.url ? 'git' : 'folder'),
  };
  if (p.url) out.url = String(p.url);
  if (p.sourcePath) out.sourcePath = String(p.sourcePath);
  if (p.branch) out.branch = String(p.branch);
  if (p.addedAt) out.addedAt = p.addedAt;
  if (p.updatedAt) out.updatedAt = p.updatedAt;
  return out;
}

function loadConfig() {
  const raw = readJson(ConfigFile);
  if (!raw || !Array.isArray(raw.plugins)) {
    config = defaultConfig();
    saveConfig();
  } else {
    config = {
      vencordRepo: raw.vencordRepo || DEFAULT_VENCORD_REPO,
      vencordBranch: raw.vencordBranch || 'main',
      plugins: raw.plugins.map(normalizePlugin).filter(Boolean),
    };
  }
  return config;
}

function saveConfig() {
  ensureDirs();
  writeJsonNoBom(ConfigFile, config);
}

function defaultState() {
  return {
    settings: {
      autoCheckOnStart: true,
      enablePlugins: true,
      intervalHours: 6,
      githubToken: '',
    },
    tools: {},          // { nodeMode: 'system'|'portable' }
    lastBuild: null,    // { time, head }
    appPath: null,      // путь к exe — для задачи планировщика
    distHead: null,
  };
}

function loadState() {
  state = Object.assign(defaultState(), readJson(StateFile) || {});
  state.settings = Object.assign(defaultState().settings, state.settings || {});
  return state;
}

function saveState() {
  ensureDirs();
  writeJsonNoBom(StateFile, state);
}

function getConfig() { return config || loadConfig(); }
function getState() { return state || loadState(); }

function setSetting(k, v) {
  getState().settings[k] = v;
  saveState();
}

module.exports = { loadConfig, saveConfig, getConfig, loadState, saveState, getState, setSetting, normalizePlugin };
