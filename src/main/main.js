// VencForge — main-процесс: окно, IPC, тихий режим автообновления
const { app, BrowserWindow, ipcMain, dialog, shell, Notification } = require('electron');
const path = require('path');
const fs = require('fs');

const paths = require('./engine/paths');
const log = require('./engine/log');
const store = require('./engine/store');
const tasks = require('./engine/tasks');
const clients = require('./engine/clients');
const gitops = require('./engine/gitops');
const tools = require('./engine/tools');
const plugins = require('./engine/plugins');
const build = require('./engine/build');
const install = require('./engine/install');
const schedule = require('./engine/schedule');
const { updateEverything } = require('./engine/orchestrator');

const isSilent = process.argv.includes('--silent-update');
let win = null;
let silentRan = false;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
}

function broadcast(event, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(event, payload);
}

log.setBroadcast((ev, payload) => broadcast(ev, payload));
tasks.setBroadcast((ev, payload) => broadcast(ev, payload));

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 940,
    minHeight: 640,
    backgroundColor: '#141419',
    icon: path.join(__dirname, '..', '..', 'build', 'icon.ico'),
    autoHideMenuBar: true,
    title: 'VencForge',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  if (process.env.VF_DEBUG) {
    win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
      console.log(`[renderer:${level}] ${message} (${sourceId}:${line})`);
    });
  }
  win.on('closed', () => { win = null; });
}

// ---------------------------------------------------------------- state
async function buildState() {
  const cfg = store.getConfig();
  const st = store.getState();
  const distReady = fs.existsSync(path.join(paths.DistDir, 'patcher.js'));
  const distMain = fs.existsSync(path.join(paths.DistDir, 'vencordDesktopMain.js'));
  const installs = clients.findDiscordInstalls();
  const running = await clients.getRunningClients();
  const head = await gitops.gitHead(paths.VcDir);
  const pnpmTool = tools.probePnpm();
  const node = await tools.systemNodeVersion();
  return {
    version: app.getVersion(),
    paths: {
      root: paths.Root, workspace: paths.Workspace, dist: paths.DistDir, log: paths.LogFile,
    },
    config: {
      vencordRepo: cfg.vencordRepo,
      vencordBranch: cfg.vencordBranch,
      plugins: cfg.plugins,
    },
    vencord: {
      cloned: fs.existsSync(path.join(paths.VcDir, 'package.json')),
      head,
      distReady,
      distComplete: distReady && distMain,
      lastBuild: st.lastBuild,
    },
    tools: {
      git: await gitops.hasGit(),
      node: node ? node.raw : null,
      nodePortable: !!tools.portableNodeExe(),
      pnpm: pnpmTool ? { kind: pnpmTool.kind, path: pnpmTool.path, src: pnpmTool.src } : null,
    },
    clients: installs.map((c) => ({ ...c, openAsar: install.asarStatus(c).openAsar })),
    running,
    schedule: { enabled: await schedule.scheduleExists(), hours: st.settings.intervalHours },
    settings: st.settings,
    task: tasks.snapshot(),
    logTail: log.tail(120),
  };
}

// ---------------------------------------------------------------- задачи
function startTask(id, label, fn) {
  return tasks.runTask(id, label, fn).then((r) => ({ ...r, task: tasks.snapshot() }));
}

// ---------------------------------------------------------------- IPC
function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, payload) => {
    try {
      return await fn(payload || {});
    } catch (err) {
      log.err(err && err.message ? err.message : String(err));
      return { error: (err && err.message) || String(err) };
    }
  });
}

handle('state:get', () => buildState());

handle('task:updateAll', ({ force }) => startTask('updateAll', 'Обновление и установка', async () => {
  const res = await updateEverything({ what: 'full', silent: false });
  if (res.needClose) return { needClose: res.needClose, detail: 'Клиенты запущены: ' + res.needClose.join(', ') };
  return { detail: 'Готово', res };
}));

handle('task:updateAllForce', () => startTask('updateAllForce', 'Обновление и установка (принудительно)', async () => {
  const running = await clients.getRunningClients();
  if (running.length) {
    log.info('Закрываю клиенты: ' + running.join(', '));
    await clients.killClients(running);
  }
  const res = await updateEverything({ what: 'full', silent: true });
  return { detail: 'Готово', res };
}));

handle('task:buildOnly', () => startTask('buildOnly', 'Сборка Vencord', async () => {
  await updateEverything({ what: 'build-only', silent: true });
  return { detail: 'Сборка обновлена' };
}));

handle('task:patchOnly', ({ force }) => startTask('patchOnly', 'Патч клиентов', async () => {
  const running = await clients.getRunningClients();
  if (running.length && !force) {
    return { needClose: running, detail: 'Клиенты запущены: ' + running.join(', ') };
  }
  if (running.length && force) {
    log.info('Закрываю клиенты: ' + running.join(', '));
    await clients.killClients(running);
  }
  await install.patchDiscord();
  await install.applyVencordSettings();
  return { detail: 'Готово' };
}));

handle('task:uninstall', ({ force }) => startTask('uninstall', 'Возврат клиентов к оригиналу', async () => {
  const running = await clients.getRunningClients();
  if (running.length && !force) return { needClose: running };
  if (running.length && force) await clients.killClients(running);
  await install.unpatchDiscord();
  await schedule.removeSchedule();
  return { detail: 'VencForge снят с клиентов. Папка ' + paths.Root + ' оставлена.' };
}));

handle('task:doctor', () => startTask('doctor', 'Диагностика', async () => {
  await install.doctor();
  return { detail: 'Диагностика выведена в лог' };
}));

handle('plugins:add', ({ mode, value }) => startTask('plugin-add', 'Добавление плагина', async () => {
  if (mode === 'git') await plugins.addGit(String(value || '').trim());
  else if (mode === 'folder') await plugins.addFolder(value);
  else if (mode === 'file') await plugins.addFile(value);
  else throw new Error('Неизвестный тип источника: ' + mode);
  return { detail: 'Плагин добавлен. Теперь нажми «Собрать Vencord»' };
}));

handle('plugins:update', ({ name }) => startTask('plugin-update-' + name, 'Обновление плагина ' + name, async () => {
  const r = await plugins.updatePlugin(name);
  return { detail: r && r.changed ? 'Плагин обновлён — пересобери Vencord' : 'Плагин уже свежий (исходник не менялся)' };
}));

handle('plugins:remove', ({ name }) => startTask('plugin-remove-' + name, 'Удаление плагина ' + name, async () => {
  await plugins.removePlugin(name);
  return { detail: 'Плагин удалён из списка. Пересобери Vencord, чтобы убрать его из сборки' };
}));

handle('clients:run', ({ branch }) => {
  const inst = clients.findDiscordInstalls().find((d) => d.branch === branch);
  if (inst) {
    const exe = path.join(inst.appDir, 'Discord.exe');
    if (fs.existsSync(exe)) { spawnDetached(exe); return { ok: true }; }
  }
  return { ok: false, error: 'Не нашёл ' + branch };
});

function spawnDetached(exe) {
  const { spawn } = require('child_process');
  const child = spawn(exe, [], { detached: true, stdio: 'ignore', cwd: path.dirname(exe) });
  child.unref();
}

handle('client:reveal', ({ p }) => { if (p && fs.existsSync(p)) shell.openPath(p); return { ok: true }; });

handle('app:openExternal', ({ url }) => {
  if (/^https:\/\/(github\.com|discord\.com|nodejs\.org)/i.test(url || '')) shell.openExternal(url);
  return { ok: true };
});

handle('dialog:pickFolder', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  return { path: r.canceled ? null : r.filePaths[0] };
});

handle('dialog:pickFile', async () => {
  const r = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [{ name: 'Плагин Vencord (ts/tsx/js/jsx)', extensions: ['ts', 'tsx', 'js', 'jsx'] }],
  });
  return { path: r.canceled ? null : r.filePaths[0] };
});

handle('settings:set', ({ key, value }) => {
  const allowed = ['autoCheckOnStart', 'enablePlugins', 'installOpenAsar', 'intervalHours', 'githubToken'];
  if (!allowed.includes(key)) return { error: 'Нет такого параметра' };
  store.setSetting(key, value);
  return { ok: true };
});

handle('config:vencord', ({ repo, branch }) => {
  const cfg = store.getConfig();
  cfg.vencordRepo = String(repo || paths.DEFAULT_VENCORD_REPO).trim();
  cfg.vencordBranch = String(branch || 'main').trim();
  store.saveConfig();
  return { ok: true };
});

handle('schedule:set', ({ enabled, hours }) => startTask('schedule', 'Расписание автообновления', async () => {
  const st = store.getState();
  const h = Number(hours) || Number(st.settings.intervalHours) || 6;
  store.setSetting('intervalHours', h);
  if (enabled) {
    await schedule.createSchedule(h, st.appPath || process.execPath);
  } else {
    await schedule.removeSchedule();
  }
  return { detail: enabled ? `Автообновление каждые ${h} ч` : 'Автообновление выключено' };
}));

handle('log:open', () => { shell.openPath(paths.LogFile); return { ok: true }; });
handle('log:revealDir', () => { shell.openPath(paths.LogDir); return { ok: true }; });

// ---------------------------------------------------------------- запуск
paths.ensureDirs();
store.loadConfig();
store.loadState();

app.whenReady().then(async () => {
  // в portable-сборке process.execPath указывает на временный распакованный exe —
  // для планировщика нужен путь к настоящему Portable.exe
  const realAppPath = (process.env.PORTABLE_EXECUTABLE_DIR && process.env.PORTABLE_EXECUTABLE_FILENAME)
    ? path.join(process.env.PORTABLE_EXECUTABLE_DIR, process.env.PORTABLE_EXECUTABLE_FILENAME)
    : process.execPath;
  store.getState().appPath = realAppPath;
  store.saveState();

  if (isSilent) {
    // тихий режим для планировщика: обновить всё и выйти
    log.info('VencForge: тихое автообновление (по расписанию)');
    try {
      await updateEverything({ what: 'full', silent: true });
      notify('VencForge: автообновление завершено', 'Смотри лог: ' + paths.LogFile);
    } catch (e) {
      log.err('Автообновление не удалось: ' + (e && e.message));
      notify('VencForge: автообновление не удалось', (e && e.message) || '');
    }
    silentRan = true;
    app.exit(0);
    return;
  }

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  // авто-проверка при запуске (тихие правила: без диалогов)
  setTimeout(async () => {
    if (!store.getState().settings.autoCheckOnStart) return;
    if (tasks.isBusy()) return;
    log.info('Авто-проверка обновлений при запуске...');
    await tasks.runTask('startup', 'Авто-проверка обновлений', async () => {
      const res = await updateEverything({ what: 'full', silent: true });
      return { detail: res.patched ? 'Всё свежее и установлено' : 'Готово (патч мог быть пропущен — клиенты были запущены)' };
    });
  }, 1500);
});

function notify(title, body) {
  try {
    if (Notification.isSupported()) new Notification({ title, body, silent: true }).show();
  } catch { }
}

app.on('window-all-closed', () => {
  if (silentRan || isSilent) app.quit();
  else app.quit();
});

process.on('uncaughtException', (e) => {
  try { log.err('Непредвиденная ошибка: ' + (e && e.stack || e)); } catch { }
});
process.on('unhandledRejection', (e) => {
  try { log.err('Непредвиденная ошибка (promise): ' + (e && e.stack || e)); } catch { }
});
