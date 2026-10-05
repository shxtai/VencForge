// VencForge — сборка минимального asar-шима для Discord
// Формат 1:1 повторяет рабочий вариант из VencForge.ps1 (проверен @electron/asar):
// Discord грузит наш app.asar, который делает require("<DistDir>\\patcher.js")
const fs = require('fs');

function buildAsarShim(patcherPath, outFile) {
  const esc = patcherPath.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const idx = 'require("' + esc + '")';
  const pkg = '{"name":"discord","main":"index.js"}';
  const idxB = Buffer.from(idx, 'utf8');
  const pkgB = Buffer.from(pkg, 'utf8');
  const hdr = JSON.stringify({
    files: {
      'index.js': { size: idxB.length, offset: '0' },
      'package.json': { size: pkgB.length, offset: String(idxB.length) },
    },
  });
  const hdrB = Buffer.from(hdr, 'utf8');
  const aligned = Math.ceil(hdrB.length / 4) * 4;
  const pad = aligned - hdrB.length;

  const total = 16 + aligned + idxB.length + pkgB.length;
  const out = Buffer.alloc(total, 0);
  out.writeUInt32LE(4, 0);
  out.writeUInt32LE(aligned + 8, 4);
  out.writeUInt32LE(aligned + 4, 8);
  out.writeUInt32LE(hdrB.length, 12);
  hdrB.copy(out, 16);
  if (pad > 0) Buffer.from('0'.repeat(pad), 'utf8').copy(out, 16 + hdrB.length);
  idxB.copy(out, 16 + aligned);
  pkgB.copy(out, 16 + aligned + idxB.length);
  fs.writeFileSync(outFile, out);
}

module.exports = { buildAsarShim };
