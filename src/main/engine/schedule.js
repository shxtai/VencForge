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
  const r = await exec('schtasks', ['/Create', '/F', '/TN', TASK_NAME, '/SC', 'HOURLY', '/MO', String(hours || 6), '/TR', tr]);
  if (r.code !== 0) {
    log.err('schtasks не смог создать задачу: ' + (r.stderr || r.stdout || '').trim());
    throw new Error('Не удалось создать задачу планировщика');
  }
  log.ok(`Автообновление включено: каждые ${hours || 6} ч (задача «${TASK_NAME}»)`);
  return true;
}

async function removeSchedule() {
  const r = await exec('schtasks', ['/Delete', '/TN', TASK_NAME, '/F']);
  if (r.code === 0) log.ok('Задача автообновления удалена');
  else log.info('Задача автообновления не найдена');
  return true;
}

module.exports = { TASK_NAME, scheduleExists, createSchedule, removeSchedule };
