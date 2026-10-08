// VencForge — автообновление по расписанию через schtasks
const { exec } = require('./util');
const log = require('./log');

const TASK_NAME = 'VencForge Auto-Update';

async function scheduleExists() {
  const r = await exec('schtasks', ['/Query', '/TN', TASK_NAME]);
  return r.code === 0;
}

async function createSchedule(hours, appExe) {
  if (!appExe || !appExe.toLowerCase().endsWith('.exe')) {
    throw new Error('Не знаю путь к VencForge.exe — запусти установленную версию и попробуй снова');
  }
  const tr = `"${appExe}" --silent-update`;
  // HOURLY /MO живёт в 1–23: «24» (раз в сутки) из UI даёт «Неверное значение
  // параметра /MO». От 24 часов — Daily с шагом в днях, семантика та же.
  const h = Number(hours) || 6;
  let code, label;
  if (h < 24) {
    const mo = Math.min(23, Math.max(1, Math.round(h)));
    const r = await exec('schtasks', ['/Create', '/F', '/TN', TASK_NAME, '/SC', 'HOURLY', '/MO', String(mo), '/TR', tr]);
    code = r; label = `каждые ${mo} ч`;
  } else {
    const days = Math.max(1, Math.round(h / 24));
    const r = await exec('schtasks', ['/Create', '/F', '/TN', TASK_NAME, '/SC', 'DAILY', '/MO', String(days), '/TR', tr]);
    code = r; label = days === 1 ? 'раз в сутки' : `раз в ${days} суток`;
  }
  if (code.code !== 0) {
    log.err('schtasks не смог создать задачу: ' + (code.stderr || code.stdout || '').trim());
    throw new Error('Не удалось создать задачу планировщика');
  }
  log.ok(`Автообновление включено: ${label} (задача «${TASK_NAME}»)`);
  return true;
}

async function removeSchedule() {
  const r = await exec('schtasks', ['/Delete', '/TN', TASK_NAME, '/F']);
  if (r.code === 0) log.ok('Задача автообновления удалена');
  else log.info('Задача автообновления не найдена');
  return true;
}

module.exports = { TASK_NAME, scheduleExists, createSchedule, removeSchedule };
