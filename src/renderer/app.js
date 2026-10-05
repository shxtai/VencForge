// VencForge — renderer
/* global vf */
const $ = (id) => document.getElementById(id);

let S = null;          // последний state
let currentTab = 'home';
const logLines = [];   // {ts, level, text}

// ---------------------------------------------------------------- helpers
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function isBusy() { return S && S.task && S.task.state === 'run'; }

function toast(text, kind = 'info', ms = 4200) {
  const el = document.createElement('div');
  el.className = 'toast ' + (kind === 'info' ? '' : kind);
  el.textContent = text;
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), ms);
}

function ask({ title, body, okText = 'ОК', danger = false, showCancel = true }) {
  return new Promise((resolve) => {
    $('modalTitle').textContent = title;
    $('modalBody').innerHTML = body;
    $('modalOk').textContent = okText;
    $('modalDanger').classList.toggle('hidden', !danger);
    $('modalOk').classList.toggle('hidden', danger);
    $('modalCancel').classList.toggle('hidden', !showCancel);
    $('modal').classList.remove('hidden');
    const done = (v) => {
      $('modal').classList.add('hidden');
      $('modalOk').onclick = $('modalCancel').onclick = $('modalDanger').onclick = null;
      resolve(v);
    };
    $('modalOk').onclick = () => done(true);
    $('modalDanger').onclick = () => done(true);
    $('modalCancel').onclick = () => done(false);
  });
}

async function invoke(ch, payload) {
  const r = await vf.invoke(ch, payload);
  if (r && r.error) { toast(r.error, 'err'); return null; }
  return r;
}

function setControlsEnabled(on) {
  for (const id of ['btnUpdateAll', 'btnBuildOnly', 'btnPatchFix', 'btnUninstall', 'btnDoctor',
    'btnAddGit', 'btnAddFolder', 'btnAddFile', 'btnBuild', 'btnSaveVc',
    'btnScheduleOn', 'btnScheduleOff']) {
    $(id).disabled = !on;
  }
}

// ---------------------------------------------------------------- log
function appendLog(line) {
  logLines.push(line);
  if (logLines.length > 900) logLines.shift();
  const box = $('logbox');
  const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 40;
  const el = document.createElement('span');
  el.className = 'log-line l-' + (line.level || 'info');
  el.innerHTML = `<span class="l-ts">${esc(line.ts)}</span>${esc(line.text)}`;
  box.appendChild(el);
  while (box.childNodes.length > 900) box.removeChild(box.firstChild);
  if (atBottom) box.scrollTop = box.scrollHeight;
  $('statusText').textContent = line.text.slice(0, 120);
}

// ---------------------------------------------------------------- render
function renderAll() {
  if (!S) return;
  $('verTag').textContent = 'v' + S.version;
  $('pluginCount').textContent = S.config.plugins.length;

  // hero
  const dist = S.vencord.distReady;
  const patchedN = S.clients.filter((c) => c.patched).length;
  if (!dist) {
    $('heroTitle').textContent = 'Сборки ещё нет';
    $('heroSub').textContent = 'Нажми «Обновить и установить всё» — VencForge скачает Vencord, подключит плагины, соберёт и пропатчит Discord (+ OpenAsar).';
  } else if (patchedN === 0) {
    $('heroTitle').textContent = 'Сборка готова, но клиенты не подключены';
    $('heroSub').textContent = 'Запусти «Обновить и установить всё» или «Починить Discord», чтобы применить сборку.';
  } else {
    $('heroTitle').textContent = 'Всё готово к работе';
    $('heroSub').textContent = 'Сборка установлена. Вкладка «Плагины» — добавить новые, «Починить Discord» — после обновления Discord.';
  }

  $('heroStats').innerHTML = `
    <div class="stat">Сборка Vencord <b>${dist ? (S.vencord.head ? 'Vencord ' + esc(S.vencord.head) : 'есть') : 'нет'}</b></div>
    <div class="stat">Плагины <b>${S.config.plugins.map((p) => esc(p.name)).join(', ') || '—'}</b></div>
    <div class="stat">Discord пропатчен <b>${patchedN ? patchedN + ' из ' + S.clients.length : 'нет'}</b></div>`;

  // статус
  const t = S.tools;
  const pnpmTxt = t.pnpm
    ? 'pnpm ✓ (' + esc(t.pnpm.src || 'найден') + ')'
    : 'pnpm — подберу при сборке';
  const toolsTxt = (t.git ? 'git ✓' : 'git → zip-фолбэк') + ' · ' +
    (t.node ? 'node ' + esc(t.node) : 'node — скачает при сборке') + ' · ' + pnpmTxt;
  $('statusList').innerHTML = `
    <div class="kv"><span class="k">Инструменты</span><span class="v">${toolsTxt}</span></div>
    <div class="kv"><span class="k">Последняя сборка</span><span class="v">${S.vencord.lastBuild ? new Date(S.vencord.lastBuild.time).toLocaleString('ru-RU') + (S.vencord.lastBuild.head ? ' · ' + esc(S.vencord.lastBuild.head) : '') : '—'}</span></div>
    <div class="kv"><span class="k">Папка данных</span><span class="v">${esc(S.paths.root)}</span></div>
    <div class="kv"><span class="k">Автообновление</span><span class="v">${S.schedule.enabled ? 'вкл (каждые ' + S.schedule.hours + ' ч)' : 'выкл'}</span></div>`;

  // клиенты (главная)
  const items = S.clients.map((c) => `
    <div class="mini"><span class="name">${esc(c.label)} ${esc(c.version)}</span>
      <span class="sub">${c.patched ? (c.openAsar ? 'пропатчен + OpenAsar' : 'пропатчен') : 'оригинал'}</span>
      <span class="flex-sp"></span>
      <button class="btn small" data-run="${esc(c.branch)}">Запустить</button></div>`).join('');
  $('homeClients').innerHTML = items || '<div class="empty">Discord не найден — установи с discord.com/download</div>';
  document.querySelectorAll('[data-run]').forEach((b) => {
    b.onclick = async () => { await invoke('clients:run', { branch: b.dataset.run }); toast('Запускаю ' + b.dataset.run); };
  });

  // предупреждение о запущенных
  $('runningWarn').classList.toggle('hidden', !S.running.length);
  $('runningNames').textContent = S.running.join(', ');

  // клиенты (вкладка)
  $('clientsList').innerHTML = (S.clients.map((c) => `
    <div class="card client-card">
      <div class="client-ico">💬</div>
      <div class="client-info">
        <div class="client-name">${esc(c.label)}<span class="pill ${c.patched ? 'ok' : 'off'}">${c.patched ? (c.openAsar ? 'Vencord + OpenAsar' : 'Vencord установлен') : 'без Vencord'}</span></div>
        <div class="client-sub">версия ${esc(c.version)} · ${esc(c.resources)}</div>
      </div>
      <div class="client-actions">
        <button class="btn small" data-run2="${esc(c.branch)}">Запустить</button>
        <button class="btn small subtle" data-reveal="${esc(c.appDir)}">Папка</button>
      </div>
    </div>`).join('') || '<div class="card"><div class="empty">Discord (Stable/PTB/Canary) не найден. Установи Discord — discord.com/download, затем вернись сюда.</div></div>');

  document.querySelectorAll('[data-run2]').forEach((b) => {
    b.onclick = async () => { await invoke('clients:run', { branch: b.dataset.run2 }); toast('Запускаю ' + b.dataset.run2); };
  });
  document.querySelectorAll('[data-reveal]').forEach((b) => {
    b.onclick = () => invoke('client:reveal', { p: b.dataset.reveal });
  });

  // плагины
  $('pluginsList').innerHTML = S.config.plugins.map((p) => {
    const tag = p.type === 'git' ? '<span class="src-tag">git</span>' : p.type === 'folder' ? '<span class="src-tag folder">папка</span>' : '<span class="src-tag file">файл</span>';
    const src = p.type === 'git' ? esc(p.url || '') : esc(p.sourcePath || '');
    const upd = p.updatedAt ? new Date(p.updatedAt).toLocaleString('ru-RU') : '';
    return `<div class="plugin">
      <div>
        <div class="p-name">${esc(p.name)} ${tag}</div>
        <div class="p-src">${src}${upd ? ' · обновлён ' + upd : ''}</div>
      </div>
      <div class="p-actions">
        <button class="btn small" data-pupd="${esc(p.name)}">Обновить</button>
        <button class="btn small subtle" data-pdel="${esc(p.name)}">Удалить</button>
      </div>
    </div>`;
  }).join('') || '<div class="empty">Список пуст. Добавь плагин сверху — Git-ссылкой, папкой или файлом.</div>';
  document.querySelectorAll('[data-pupd]').forEach((b) => {
    b.onclick = () => guardTask(async () => {
      const r = await invoke('plugins:update', { name: b.dataset.pupd });
      if (r && r.task && r.task.state === 'done') toast(r.task.detail || 'Готово', 'ok');
      refresh();
    });
  });
  document.querySelectorAll('[data-pdel]').forEach((b) => {
    b.onclick = async () => {
      const ok = await ask({
        title: 'Удалить плагин?',
        body: `Плагин <b>${esc(b.dataset.pdel)}</b> будет убран из списка. Из собранного Vencord он пропадёт после следующей сборки.`,
        okText: 'Удалить', danger: true,
      });
      if (!ok) return;
      await invoke('plugins:remove', { name: b.dataset.pdel });
      refresh();
    };
  });

  // сборка
  $('vcRepo').value = S.config.vencordRepo;
  $('vcBranch').value = S.config.vencordBranch;
  $('buildInfo').innerHTML = `
    <div class="kv"><span class="k">Исходники Vencord</span><span class="v">${S.vencord.cloned ? 'workspace на месте' + (S.vencord.head ? ' · ' + esc(S.vencord.head) : '') : 'ещё не скачаны'}</span></div>
    <div class="kv"><span class="k">Сборка (dist)</span><span class="v">${S.vencord.distReady ? esc(S.paths.dist) : 'нет'}</span></div>
    <div class="kv"><span class="k">Последняя сборка</span><span class="v">${S.vencord.lastBuild ? new Date(S.vencord.lastBuild.time).toLocaleString('ru-RU') : '—'}</span></div>`;
  $('buildPluginHint').textContent = `В сборку войдут плагины: ${S.config.plugins.map((p) => p.name).join(', ') || '—'}`;

  // настройки
  $('setAutoCheck').checked = !!S.settings.autoCheckOnStart;
  $('setEnablePlugins').checked = !!S.settings.enablePlugins;
  $('setOpenAsar').checked = !!S.settings.installOpenAsar;
  $('setInterval').value = String(S.settings.intervalHours || 6);
  $('scheduleState').textContent = S.schedule.enabled ? `включено (каждые ${S.schedule.hours} ч)` : 'выключено';
  $('pathsList').innerHTML = `
    <div class="kv"><span class="k">Данные</span><span class="v">${esc(S.paths.root)}</span></div>
    <div class="kv"><span class="k">Workspace</span><span class="v">${esc(S.paths.workspace)}</span></div>
    <div class="kv"><span class="k">Сборка</span><span class="v">${esc(S.paths.dist)}</span></div>
    <div class="kv"><span class="k">Лог</span><span class="v">${esc(S.paths.log)}</span></div>`;
  $('logPath').textContent = S.paths.log;

  // статус-бар справа
  $('statusRight').textContent = S.running.length ? 'запущено: ' + S.running.join(', ') : '';

  // task chip
  const task = S.task;
  const chip = $('taskChip');
  if (task && task.state === 'run') {
    chip.classList.remove('hidden');
    $('taskLabel').textContent = task.label + '…';
    setControlsEnabled(false);
    $('statusText').textContent = task.label + '…';
  } else {
    chip.classList.add('hidden');
    setControlsEnabled(true);
    if (task && task.state === 'fail') {
      const d = document.createElement('div');
      d.innerHTML = `<span class="dot fail"></span> <span style="color:#ff9d9e">${esc(task.detail || 'ошибка')}</span>`;
      $('topStatus').replaceChildren(d);
      return;
    }
  }
  if (task && task.state !== 'run') {
    const kind = task.state === 'done' ? 'ok' : 'fail';
    $('topStatus').innerHTML = `<span class="dot ${kind}"></span> ${esc(task.detail || (task.state === 'done' ? 'готово' : 'ошибка'))}`;
  } else if (!task) {
    $('topStatus').innerHTML = '';
  }
}

// ---------------------------------------------------------------- flows
async function guardTask(fn) {
  if (isBusy()) { toast('Дождись окончания текущей задачи', 'warn'); return; }
  await fn();
}

async function doUpdateAll() {
  await guardTask(async () => {
    const r = await invoke('task:updateAll', {});
    if (!r) { refresh(); return; }
    const res = r.result || {};
    if (res.needClose) {
      const ok = await ask({
        title: 'Закрыть клиенты?',
        body: `Сейчас запущены: <b>${esc(res.needClose.join(', '))}</b>.<br>Чтобы применить сборку, их нужно закрыть. Несохранённые данные Discord будут потеряны.`,
        okText: 'Закрыть и продолжить', danger: true,
      });
      if (ok) {
        await invoke('task:updateAllForce', {});
        toast('Готово — можно запускать Discord', 'ok', 6000);
      }
    } else if (r.task && r.task.state === 'done') {
      toast('Готово! Запускай Discord', 'ok', 6000);
    }
    refresh();
  });
}

async function doPatchFix() {
  await guardTask(async () => {
    const r = await invoke('task:patchOnly', {});
    if (!r) { refresh(); return; }
    const res = r.result || {};
    if (res.needClose) {
      const ok = await ask({
        title: 'Закрыть клиенты?',
        body: `Запущены: <b>${esc(res.needClose.join(', '))}</b>. Закрыть их и пропатчить?`,
        okText: 'Закрыть и пропатчить', danger: true,
      });
      if (ok) await invoke('task:patchOnly', { force: true });
    }
    toast('Discord пропатчен текущей сборкой', 'ok');
    refresh();
  });
}

async function doBuild() {
  await guardTask(async () => {
    await invoke('task:buildOnly', {});
    toast('Сборка обновлена', 'ok');
    refresh();
  });
}

async function doUninstall() {
  const ok = await ask({
    title: 'Убрать VencForge с клиентов?',
    body: 'Discord вернётся к оригиналу (Vencord, OpenAsar и шим будут сняты), задача автообновления удалится. Папка данных останется.',
    okText: 'Убрать', danger: true,
  });
  if (!ok) return;
  await guardTask(async () => {
    const r = await invoke('task:uninstall', {});
    if (r && r.result && r.result.needClose) {
      const ok2 = await ask({
        title: 'Закрыть клиенты?',
        body: `Запущены: <b>${esc(r.result.needClose.join(', '))}</b>. Закрыть и продолжить?`,
        okText: 'Да', danger: true,
      });
      if (ok2) await invoke('task:uninstall', { force: true });
    }
    toast('Клиенты возвращены к оригиналу', 'ok');
    refresh();
  });
}

// ---------------------------------------------------------------- init
function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab').forEach((t) => t.classList.add('hidden'));
  $('tab-' + tab).classList.remove('hidden');
  $('tabTitle').textContent = {
    home: 'Главная', clients: 'Клиенты', plugins: 'Плагины',
    build: 'Сборка', logs: 'Логи', settings: 'Настройки',
  }[tab];
}

async function refresh() {
  S = await vf.invoke('state:get');
  if (S) {
    if (!logLines.length && S.logTail && S.logTail.length) {
      for (const l of S.logTail) appendLog(l);
    }
    renderAll();
  }
}

function wire() {
  document.querySelectorAll('.nav-btn').forEach((b) => {
    b.onclick = () => switchTab(b.dataset.tab);
  });
  $('btnUpdateAll').onclick = doUpdateAll;
  $('btnBuildOnly').onclick = doBuild;
  $('btnPatchFix').onclick = doPatchFix;
  $('btnUninstall').onclick = doUninstall;
  $('btnDoctor').onclick = async () => { await invoke('task:doctor', {}); switchTab('logs'); };
  $('btnOpenRoot').onclick = () => invoke('client:reveal', { p: S ? S.paths.root : '' });

  $('btnAddGit').onclick = () => guardTask(async () => {
    const url = $('gitUrl').value.trim();
    if (!url) { toast('Вставь ссылку на репозиторий', 'warn'); return; }
    const r = await invoke('plugins:add', { mode: 'git', value: url });
    if (r && r.task && r.task.state === 'done') { $('gitUrl').value = ''; toast('Плагин добавлен — теперь «Обновить исходники и собрать»', 'ok', 6000); }
    refresh();
  });
  $('btnAddFolder').onclick = () => guardTask(async () => {
    const r = await invoke('dialog:pickFolder', {});
    if (!r || !r.path) return;
    const rr = await invoke('plugins:add', { mode: 'folder', value: r.path });
    if (rr && rr.task && rr.task.state === 'done') toast('Плагин добавлен — теперь «Обновить исходники и собрать»', 'ok', 6000);
    refresh();
  });
  $('btnAddFile').onclick = () => guardTask(async () => {
    const r = await invoke('dialog:pickFile', {});
    if (!r || !r.path) return;
    const rr = await invoke('plugins:add', { mode: 'file', value: r.path });
    if (rr && rr.task && rr.task.state === 'done') toast('Плагин добавлен — теперь «Обновить исходники и собрать»', 'ok', 6000);
    refresh();
  });

  $('btnSaveVc').onclick = async () => {
    await invoke('config:vencord', { repo: $('vcRepo').value.trim(), branch: $('vcBranch').value.trim() });
    toast('Сохранено', 'ok');
    refresh();
  };
  $('btnBuild').onclick = doBuild;

  $('btnCopyLog').onclick = () => {
    const text = logLines.map((l) => `[${l.ts}] ${l.level.toUpperCase()} ${l.text}`).join('\n');
    navigator.clipboard.writeText(text).then(() => toast('Лог скопирован', 'ok'));
  };
  $('btnOpenLog').onclick = () => invoke('log:open', {});

  $('setAutoCheck').onchange = async (e) => { await invoke('settings:set', { key: 'autoCheckOnStart', value: e.target.checked }); refresh(); };
  $('setEnablePlugins').onchange = async (e) => { await invoke('settings:set', { key: 'enablePlugins', value: e.target.checked }); refresh(); };
  $('setOpenAsar').onchange = async (e) => {
    await invoke('settings:set', { key: 'installOpenAsar', value: e.target.checked });
    toast(e.target.checked ? 'OpenAsar будет ставиться при следующем патче' : 'OpenAsar выключен — снимется при следующем патче', 'ok');
    refresh();
  };
  $('btnSaveToken').onclick = async () => {
    await invoke('settings:set', { key: 'githubToken', value: $('setToken').value.trim() });
    $('setToken').value = '';
    toast('Токен сохранён', 'ok');
  };
  $('btnScheduleOn').onclick = () => guardTask(async () => {
    await invoke('schedule:set', { enabled: true, hours: Number($('setInterval').value) });
    refresh();
  });
  $('btnScheduleOff').onclick = () => guardTask(async () => {
    await invoke('schedule:set', { enabled: false });
    refresh();
  });

  $('ghLink').onclick = (e) => { e.preventDefault(); vf.invoke('app:openExternal', { url: 'https://github.com/shxtai/VencForge' }); };

  vf.on('evt:log', (line) => appendLog(line));
  vf.on('evt:task', async (task) => {
    if (S) S.task = task;
    renderAll();
    if (task && task.state !== 'run') refresh();
  });

  setInterval(refresh, 15000);
}

window.addEventListener('DOMContentLoaded', async () => {
  wire();
  await refresh();
  switchTab('home');
});
