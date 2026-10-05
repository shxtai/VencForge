// Смоук-тест VencForge 1.3: asar-шим, патч сломанных состояний, унипатч, verifyPluginsInDist
// Запуск: node scripts/test_v13.js  (на Linux fsx === fs; на Windows в Electron fsx === original-fs)
const fs = require('fs');
const path = require('path');
const os = require('os');

// изолируем «AppData» теста от реальной системы ДО загрузки движка
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'vencforge-test-'));
process.env.APPDATA = path.join(TMP, 'roaming');
process.env.LOCALAPPDATA = path.join(TMP, 'local');
fs.mkdirSync(process.env.APPDATA, { recursive: true });
fs.mkdirSync(process.env.LOCALAPPDATA, { recursive: true });

let passed = 0, failed = 0;
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log('  OK  ' + name); }
  else { failed++; console.error('FAIL  ' + name + (extra ? ' — ' + extra : '')); }
}

const util = require('../src/main/engine/util');
const { buildAsarShim } = require('../src/main/engine/asar');
const install = require('../src/main/engine/install');
const { verifyPluginsInDist } = require('../src/main/engine/build');

// минимальный разбор asar (того же формата, что пишет buildAsarShim)
function asarIndex(p) {
  const b = fs.readFileSync(p);
  const headerSize = b.readUInt32LE(12);
  const headerJson = b.slice(16, 16 + headerSize).toString('utf8').replace(/0+$/, '').trim();
  const header = JSON.parse(headerJson);
  const aligned = Math.ceil(headerSize / 4) * 4;
  const base = 16 + aligned; // данные начинаются сразу после выровненного заголовка
  const files = {};
  for (const [name, e] of Object.entries(header.files)) {
    files[name] = b.slice(base + Number(e.offset), base + Number(e.offset) + e.size).toString('utf8');
  }
  return files;
}

const FAKE_ASAR = 'fake-original-discord-asar-bytes-'.repeat(10);
const OPENASAR_FAKE = Buffer.from('x'.repeat(8192) + ' OpenAsar version 1.2.3 ' + 'y'.repeat(100));

// ---------------------------------------------------------------- 1. шим: формат
{
  const out = path.join(TMP, 'shim.asar');
  buildAsarShim('C:\\AppData\\VencForge\\dist\\patcher.js', out);
  const files = asarIndex(out);
  check('шим: package.json main=index.js', files['package.json'] === '{"name":"discord","main":"index.js"}');
  check('шим: index.js требует patcher.js', files['index.js'] === 'require("C:\\\\AppData\\\\VencForge\\\\dist\\\\patcher.js")');
}

// ---------------------------------------------------------------- 2-5: последовательные кейсы
(async () => {
  // кейс A: app.asar — ПАПКА, _app.asar есть (точный кейс пользователя)
  {
    const res = path.join(TMP, 'case-a', 'resources');
    fs.mkdirSync(path.join(res, 'app.asar'), { recursive: true });
    fs.writeFileSync(path.join(res, 'app.asar', 'junk.txt'), 'x');
    fs.writeFileSync(path.join(res, '_app.asar'), FAKE_ASAR);
    const di = { label: 'TestA', resources: res };
    try {
      await install.patchOne(di, { patcher: 'C:\\pf\\patcher.js', wantOpenAsar: false });
      check('кейс A: app.asar стал файлом-шимом', util.pathKind(path.join(res, 'app.asar')) === 'file');
      const files = asarIndex(path.join(res, 'app.asar'));
      check('кейс A: шим читается', !!files['index.js']);
      check('кейс A: _app.asar цел', fs.readFileSync(path.join(res, '_app.asar'), 'utf8') === FAKE_ASAR);
      check('кейс A: app-original.asar создан из _app.asar', fs.readFileSync(path.join(res, 'app-original.asar'), 'utf8') === FAKE_ASAR);
    } catch (e) {
      check('кейс A: не упал', false, e.message);
    }
  }

  // кейс B: нет _app.asar, app.asar — файл
  {
    const res = path.join(TMP, 'case-b', 'resources');
    fs.mkdirSync(res, { recursive: true });
    fs.writeFileSync(path.join(res, 'app.asar'), FAKE_ASAR);
    const di = { label: 'TestB', resources: res };
    try {
      await install.patchOne(di, { patcher: 'C:\\pf\\patcher.js', wantOpenAsar: false });
      check('кейс B: оригинал переименован в _app.asar', fs.readFileSync(path.join(res, '_app.asar'), 'utf8') === FAKE_ASAR);
      check('кейс B: app.asar — шим', util.pathKind(path.join(res, 'app.asar')) === 'file' && !!asarIndex(path.join(res, 'app.asar'))['index.js']);
    } catch (e) {
      check('кейс B: не упал', false, e.message);
    }
  }

  // кейс C: всё сломано (app.asar — папка), бэкапов нет, OpenAsar выключен → честная ошибка
  {
    const res = path.join(TMP, 'case-c', 'resources');
    fs.mkdirSync(path.join(res, 'app.asar'), { recursive: true });
    const di = { label: 'TestC', resources: res };
    try {
      await install.patchOne(di, { patcher: 'C:\\pf\\patcher.js', wantOpenAsar: false });
      check('кейс C: бросил ошибку', false, 'не бросил');
    } catch (e) {
      check('кейс C: бросил ошибку', /нет ни app\.asar/.test(e.message), e.message);
    }
    check('кейс C: папку app.asar почистил', util.pathKind(path.join(res, 'app.asar')) === null);
  }

  // кейс D: унипатч при app.asar-папке (EISDIR-кейс пользователя)
  {
    const res = path.join(TMP, 'case-d', 'resources');
    fs.mkdirSync(res, { recursive: true });
    fs.writeFileSync(path.join(res, 'app-original.asar'), FAKE_ASAR);
    fs.writeFileSync(path.join(res, '_app.asar'), FAKE_ASAR);
    fs.mkdirSync(path.join(res, 'app.asar', 'nested'), { recursive: true });
    fs.writeFileSync(path.join(res, 'app.asar', 'nested', 'junk.bin'), 'zz');
    const clients = require('../src/main/engine/clients');
    const origFind = clients.findDiscordInstalls;
    clients.findDiscordInstalls = () => [{ label: 'TestD', resources: res, version: 'x' }];
    try {
      await install.unpatchDiscord();
      check('кейс D: вложенная папка app.asar удалена рекурсивно', util.pathKind(path.join(res, 'app.asar')) === 'file');
      check('кейс D: оригинал восстановлен', fs.readFileSync(path.join(res, 'app.asar'), 'utf8') === FAKE_ASAR);
      check('кейс D: бэкапы вычищены', !fs.existsSync(path.join(res, '_app.asar')) && !fs.existsSync(path.join(res, 'app-original.asar')));
    } catch (e) {
      check('кейс D: не упал', false, e.message);
    } finally {
      clients.findDiscordInstalls = origFind;
    }
  }

  // детект OpenAsar
  {
    const oa = path.join(TMP, 'openasar.asar');
    fs.writeFileSync(oa, OPENASAR_FAKE);
    check('детект OpenAsar: да', install.isOpenAsarAsar(oa) === true);
    const notOa = path.join(TMP, 'notoa.asar');
    fs.writeFileSync(notOa, FAKE_ASAR);
    check('детект OpenAsar: нет', install.isOpenAsarAsar(notOa) === false);
  }

  // verifyPluginsInDist
  {
    const dist = path.join(TMP, 'dist');
    fs.mkdirSync(dist, { recursive: true });
    fs.writeFileSync(path.join(dist, 'renderer.js'), '// bundle ... name:"P2PStream" ... '.repeat(50));
    fs.writeFileSync(path.join(dist, 'vencordDesktopRenderer.js'), 'name:"P2PStream"');
    fs.writeFileSync(path.join(dist, 'vencordDesktopMain.js'), 'VencordPluginNative_P2PStream');
    const r = verifyPluginsInDist(['P2PStream', 'soundboardPermissionsBypass.web'], dist);
    check('verify: P2PStream найден в renderer+main', r[0].inWeb && r[0].inMain);
    check('verify: отсутствующий плагин помечен', !r[1].inWeb && !r[1].inDesktop);
  }

  console.log(`\nИтог: ${passed} OK, ${failed} FAIL`);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
})();
