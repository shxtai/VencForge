// VencForge — пути и структура данных
const path = require('path');
const fs = require('fs');

const APPDATA = process.env.APPDATA || path.join(require('os').homedir(), 'AppData', 'Roaming');
const LOCALAPPDATA = process.env.LOCALAPPDATA || path.join(require('os').homedir(), 'AppData', 'Local');

const Root = path.join(APPDATA, 'VencForge');
const Workspace = path.join(Root, 'workspace');
const PluginsDir = path.join(Workspace, 'plugins');
const VcDir = path.join(Workspace, 'Vencord');
const UserPluginsDir = path.join(VcDir, 'src', 'userplugins');
const DistDir = path.join(Root, 'dist');
const LogDir = path.join(Root, 'logs');
const LogFile = path.join(LogDir, 'vencforge.log');
const ConfigFile = path.join(Root, 'config.json');
const StateFile = path.join(Root, 'state.json');
const ToolsDir = path.join(Root, 'tools');
const NodeDir = path.join(ToolsDir, 'node');
const PnpmPrefix = path.join(ToolsDir, 'pnpm');

function ensureDirs() {
  for (const d of [Root, Workspace, PluginsDir, LogDir, ToolsDir]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }
}

const DEFAULT_VENCORD_REPO = 'https://github.com/Vendicated/Vencord';
const DEFAULT_PLUGIN = { name: 'P2PStream', url: 'https://github.com/shxtai/P2PStream', type: 'git' };

module.exports = {
  APPDATA, LOCALAPPDATA,
  Root, Workspace, PluginsDir, VcDir, UserPluginsDir,
  DistDir, LogDir, LogFile, ConfigFile, StateFile, ToolsDir, NodeDir, PnpmPrefix,
  ensureDirs, DEFAULT_VENCORD_REPO, DEFAULT_PLUGIN,
};
