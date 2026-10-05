// VencForge — очередь задач (долгие операции) с событиями для UI
const log = require('./log');

let current = null; // { id, label, state: 'run'|'done'|'fail', detail }
let broadcast = null;
const queue = [];
let draining = false;

function setBroadcast(fn) { broadcast = fn; }

function emitTask() {
  try { if (broadcast) broadcast('evt:task', current); } catch { }
}

function snapshot() {
  return current ? { ...current } : null;
}

async function runTask(id, label, fn) {
  if (current && current.state === 'run') {
    return { queued: false, busy: true, task: snapshot() };
  }
  current = { id, label, state: 'run', detail: '', startedAt: Date.now() };
  emitTask();
  try {
    const result = await fn();
    current.state = 'done';
    current.detail = (result && result.detail) || '';
    current.result = result || {};
    emitTask();
    // авто-очистка через 6 сек
    setTimeout(() => { if (current && current.state !== 'run') { current = null; emitTask(); } }, 6000);
    return { queued: false, busy: false, ok: true, result };
  } catch (e) {
    current.state = 'fail';
    current.detail = (e && e.message) || String(e);
    log.err(`${label}: ${current.detail}`);
    emitTask();
    setTimeout(() => { if (current && current.state !== 'run') { current = null; emitTask(); } }, 10000);
    return { queued: false, busy: false, ok: false, error: current.detail };
  }
}

module.exports = { runTask, snapshot, setBroadcast, isBusy: () => !!(current && current.state === 'run') };
