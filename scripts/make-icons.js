#!/usr/bin/env node
'use strict';

/**
 * Génère les icônes de Feather sans dépendance graphique.
 *
 * On dessine dans un tampon RGBA puis on encode nous-mêmes le PNG (zlib fait le
 * gros du travail) et le ICO — ça évite d'ajouter sharp ou canvas au projet
 * pour quatre fichiers qui ne changent jamais.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ASSETS = path.join(__dirname, '..', 'assets');

/* ---------------------------- encodage PNG --------------------------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

/** @param {Uint8Array} rgba tampon de size*size*4 octets */
function encodePng(rgba, size) {
  const stride = size * 4;
  // Chaque ligne est préfixée par son octet de filtre (0 = aucun)
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(
      raw,
      y * (stride + 1) + 1
    );
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // 8 bits par canal
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/** ICO acceptant des PNG embarqués (Windows Vista et suivants). */
function encodeIco(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // type icône
  header.writeUInt16LE(pngs.length, 4);

  const entries = [];
  let offset = 6 + pngs.length * 16;
  for (const { size, buffer } of pngs) {
    const entry = Buffer.alloc(16);
    entry[0] = size >= 256 ? 0 : size; // 0 signifie 256
    entry[1] = size >= 256 ? 0 : size;
    entry[2] = 0; // palette
    entry[3] = 0;
    entry.writeUInt16LE(1, 4); // plans
    entry.writeUInt16LE(32, 6); // bits par pixel
    entry.writeUInt32BE(0, 8);
    entry.writeUInt32LE(buffer.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    offset += buffer.length;
  }

  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.buffer)]);
}

/* ---------------------------- dessin --------------------------------- */

/** Antialiasing par suréchantillonnage : on dessine 4× plus grand puis on réduit. */
const SS = 4;

function createCanvas(size) {
  return { size, data: new Float32Array(size * size * 4) };
}

function blend(canvas, x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= canvas.size || y >= canvas.size || a <= 0) return;
  const i = (y * canvas.size + x) * 4;
  const d = canvas.data;
  const inv = 1 - a;
  d[i] = d[i] * inv + r * a;
  d[i + 1] = d[i + 1] * inv + g * a;
  d[i + 2] = d[i + 2] * inv + b * a;
  d[i + 3] = d[i + 3] * inv + a;
}

/** Rectangle à coins arrondis, rempli par une fonction de couleur (x, y). */
function roundedRect(canvas, x0, y0, w, h, radius, colorAt) {
  for (let y = Math.floor(y0); y < Math.ceil(y0 + h); y += 1) {
    for (let x = Math.floor(x0); x < Math.ceil(x0 + w); x += 1) {
      const dx = Math.max(x0 + radius - x, 0, x - (x0 + w - radius - 1));
      const dy = Math.max(y0 + radius - y, 0, y - (y0 + h - radius - 1));
      if (dx > 0 && dy > 0 && dx * dx + dy * dy > radius * radius) continue;
      const [r, g, b, a] = colorAt(x, y);
      blend(canvas, x, y, r, g, b, a);
    }
  }
}

/** Réduit le canevas suréchantillonné en tampon RGBA final. */
function downsample(canvas, targetSize) {
  const factor = canvas.size / targetSize;
  const out = new Uint8Array(targetSize * targetSize * 4);
  for (let y = 0; y < targetSize; y += 1) {
    for (let x = 0; x < targetSize; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < factor; sy += 1) {
        for (let sx = 0; sx < factor; sx += 1) {
          const i = ((y * factor + sy) * canvas.size + (x * factor + sx)) * 4;
          const alpha = canvas.data[i + 3];
          r += canvas.data[i] * alpha;
          g += canvas.data[i + 1] * alpha;
          b += canvas.data[i + 2] * alpha;
          a += alpha;
        }
      }
      const n = factor * factor;
      const o = (y * targetSize + x) * 4;
      // Moyenne pondérée par l'alpha, sinon les bords tirent vers le noir
      out[o] = a > 0 ? Math.round(r / a) : 0;
      out[o + 1] = a > 0 ? Math.round(g / a) : 0;
      out[o + 2] = a > 0 ? Math.round(b / a) : 0;
      out[o + 3] = Math.round((a / n) * 255);
    }
  }
  return out;
}

/** Hauteurs relatives des barres : une petite forme d'onde. */
const WAVE = [0.34, 0.62, 1.0, 0.78, 0.46];

function drawAppIcon(size) {
  const S = size * SS;
  const canvas = createCanvas(S);

  // Fond dégradé indigo -> violet, en diagonale
  roundedRect(canvas, 0, 0, S, S, S * 0.22, (x, y) => {
    const t = (x / S) * 0.45 + (y / S) * 0.55;
    return [99 + (168 - 99) * t, 102 + (85 - 102) * t, 241 + (247 - 241) * t, 1];
  });

  // Barres blanches centrées
  const barW = S * 0.075;
  const gap = S * 0.055;
  const totalW = WAVE.length * barW + (WAVE.length - 1) * gap;
  const startX = (S - totalW) / 2;
  const maxH = S * 0.46;

  WAVE.forEach((ratio, i) => {
    const h = maxH * ratio;
    const x = startX + i * (barW + gap);
    const y = (S - h) / 2;
    roundedRect(canvas, x, y, barW, h, barW / 2, () => [255, 255, 255, 0.97]);
  });

  return downsample(canvas, size);
}

function drawTrayIcon(size, active) {
  const S = size * SS;
  const canvas = createCanvas(S);

  // Monochrome : Windows affiche l'icône sur une barre claire ou sombre
  const barW = S * 0.11;
  const gap = S * 0.075;
  const totalW = WAVE.length * barW + (WAVE.length - 1) * gap;
  const startX = (S - totalW) / 2;
  const maxH = S * 0.74;

  WAVE.forEach((ratio, i) => {
    const h = maxH * ratio;
    const x = startX + i * (barW + gap);
    const y = (S - h) / 2;
    const color = active ? [244, 63, 94] : [235, 235, 235];
    roundedRect(canvas, x, y, barW, h, barW / 2, () => [...color, 1]);
  });

  return downsample(canvas, size);
}

/* ---------------------------- écriture ------------------------------- */

function main() {
  fs.mkdirSync(ASSETS, { recursive: true });

  const sizes = [256, 128, 64, 48, 32, 16];
  const pngs = sizes.map((size) => ({
    size,
    buffer: encodePng(drawAppIcon(size), size)
  }));

  fs.writeFileSync(path.join(ASSETS, 'icon.png'), pngs[0].buffer);
  fs.writeFileSync(path.join(ASSETS, 'icon.ico'), encodeIco(pngs));
  fs.writeFileSync(path.join(ASSETS, 'tray.png'), encodePng(drawTrayIcon(32, false), 32));
  fs.writeFileSync(path.join(ASSETS, 'tray-active.png'), encodePng(drawTrayIcon(32, true), 32));

  const list = ['icon.png', 'icon.ico', 'tray.png', 'tray-active.png'];
  for (const name of list) {
    const bytes = fs.statSync(path.join(ASSETS, name)).size;
    process.stdout.write('  ' + name.padEnd(16) + (bytes / 1024).toFixed(1) + ' Ko\n');
  }
}

main();
