// VencForge — логирование: файл + рассылка в рендерер
const fs = require('fs');
const { LogDir, LogFile } = require('./paths');

let broadcast = null; // (event, payload) => void
const buffer = [];    // последние N строк для нового окна
const MAX_BUFFER = 1200;

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function setBroadcast(fn) { broadcast = fn; }

function push(level, text) {
  const line = { ts: stamp(), level, text: String(text) };
  buffer.push(line);
  if (buffer.length > MAX_BUFFER) buffer.shift();
  try {
    fs.mkdirSync(LogDir, { recursive: true });
    fs.appendFileSync(LogFile, `[${line.ts}] ${level.toUpperCase()} ${line.text}\n`, 'utf8');
  } catch { }
  try { if (broadcast) broadcast('evt:log', line); } catch { }
}

module.exports = {
  setBroadcast,
  info: (t) => push('info', t),
  ok: (t) => push('ok', t),
  warn: (t) => push('warn', t),
  err: (t) => push('err', t),
  raw: (t) => push('raw', t),
  tail: (n = 50) => buffer.slice(-n),
  LogFile,
};
