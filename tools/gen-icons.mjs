// Gera icons/icon{16,32,48,128}.png sem dependências (zlib do Node).
// Uso: node tools/gen-icons.mjs
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'icons');
fs.mkdirSync(outDir, { recursive: true });

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filtro none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y, size);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // RGBA 8-bit
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Desenho: logo "Clássico" do design system — cabeça do robô com fone, em pixel art 12x8.
// Escala inteira por tamanho (sem suavização), centralizada no quadrado.
const ART = [
  '...pppppp...',
  '..p......p..',
  '.p.bbbbbb.p.',
  'qpbccddddbpq',
  'qpbcddWdWbpq',
  'qpbcdddddbpq',
  'qpbbdddddbpq',
  '....bbbbb...',
];
const PALETTE = {
  b: [13, 70, 43], // verde escuro (contorno)
  c: [30, 117, 73], // verde médio (sombra)
  d: [42, 158, 77], // verde do corpo
  W: [255, 255, 255], // olhos
  p: [245, 245, 245], // fone
  q: [179, 179, 179], // sombra do fone
};
const ART_W = ART[0].length;
const ART_H = ART.length;
const SCALE = { 16: 1, 32: 2, 48: 3, 128: 10 };

function pixel(x, y, size) {
  const k = SCALE[size];
  const ox = Math.floor((size - ART_W * k) / 2);
  const oy = Math.floor((size - ART_H * k) / 2);
  const ax = Math.floor((x - ox) / k);
  const ay = Math.floor((y - oy) / k);
  const ch = ART[ay]?.[ax];
  if (x < ox || y < oy || !PALETTE[ch]) return [0, 0, 0, 0];
  return [...PALETTE[ch], 255];
}

for (const size of [16, 32, 48, 128]) {
  const file = path.join(outDir, `icon${size}.png`);
  fs.writeFileSync(file, png(size, pixel));
  console.log('ok', path.relative(root, file));
}
