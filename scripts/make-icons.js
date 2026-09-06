#!/usr/bin/env node
'use strict';

/**
 * Génère les icônes de Feather sans dépendance graphique.
 *
 * Le motif : une plume dont les barbes sont les barres d'une forme d'onde.
 * Les deux objets ont la même structure — des segments répartis de part et
 * d'autre d'un axe — il suffit d'incliner l'axe et de donner aux longueurs
 * l'enveloppe d'une plume pour que le dessin se lise dans les deux sens.
 *
 * Contrainte dominante : rester lisible à 16 px dans la zone de notification.
 * D'où le nombre de barbes réduit sur les petites tailles, et l'absence de
 * tout détail qui disparaîtrait à la réduction.
 *
 * On encode nous-mêmes le PNG (zlib fait le gros du travail) et le ICO, plutôt
 * que d'ajouter sharp ou canvas au projet pour quatre fichiers.
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
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
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
    entry.writeUInt32LE(buffer.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    offset += buffer.length;
  }

  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.buffer)]);
}

/* ---------------------------- rendu ---------------------------------- */

/**
 * Suréchantillonnage 4× combiné à une couverture analytique sur le bord des
 * formes. Le suréchantillonnage seul laisserait des marches visibles sur les
 * diagonales, qui sont justement partout dans ce dessin.
 */
const SS = 4;

function createCanvas(size) {
  return { size, data: new Float32Array(size * size * 4) };
}

function blend(canvas, x, y, [r, g, b], a) {
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
      blend(canvas, x, y, colorAt(x, y), 1);
    }
  }
}

/** Distance d'un point au segment [a, b]. */
function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq > 0 ? ((px - x1) * dx + (py - y1) * dy) / lenSq : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = x1 + t * dx;
  const cy = y1 + t * dy;
  return Math.hypot(px - cx, py - cy);
}

/**
 * Segment épais à extrémités arrondies, dans n'importe quelle orientation.
 * C'est la primitive unique du dessin : le rachis comme les barbes.
 */
function capsule(canvas, x1, y1, x2, y2, thickness, color) {
  const r = thickness / 2;
  const minX = Math.max(0, Math.floor(Math.min(x1, x2) - r - 1));
  const maxX = Math.min(canvas.size - 1, Math.ceil(Math.max(x1, x2) + r + 1));
  const minY = Math.max(0, Math.floor(Math.min(y1, y2) - r - 1));
  const maxY = Math.min(canvas.size - 1, Math.ceil(Math.max(y1, y2) + r + 1));

  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const d = distToSegment(x + 0.5, y + 0.5, x1, y1, x2, y2);
      // Couverture progressive sur le dernier pixel : adoucit les diagonales
      const a = Math.max(0, Math.min(1, r + 0.5 - d));
      if (a > 0) blend(canvas, x, y, color, a);
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

/* ---------------------------- la plume ------------------------------- */

/**
 * Longueur relative des barbes, de la base vers la pointe. C'est ce tableau
 * qui porte la double lecture : son profil général dessine la plume, ses
 * irrégularités (indices 3 et 4) donnent le rythme d'une forme d'onde.
 */
const BARBS_FULL = [0.58, 0.84, 0.96, 1.0, 0.88, 0.94, 0.74, 0.52, 0.3];

/** Sous 48 px, neuf barbes se referment en un bloc illisible. */
const BARBS_SMALL = [0.72, 1.0, 0.82, 0.96, 0.6];

/** À 16 px, chaque barbe ne dispose que d'un pixel ou deux : il en faut trois. */
const BARBS_TINY = [0.85, 1.0, 0.7];

/**
 * Le dessin ne se contente pas d'être réduit, il est simplifié par palier :
 * moins de barbes, traits plus épais, marge plus fine. Une simple mise à
 * l'échelle du dessin à neuf barbes donne une tache grise en dessous de 24 px.
 */
function variantFor(size) {
  if (size <= 24) return { barbs: BARBS_TINY, barbW: 0.13, shaftW: 0.1, margin: 0.02 };
  if (size <= 48) return { barbs: BARBS_SMALL, barbW: 0.08, shaftW: 0.066, margin: 0.04 };
  return { barbs: BARBS_FULL, barbW: 0.046, shaftW: 0.05, margin: 0.06 };
}

const lerp = (a, b, t) => a + (b - a) * t;

/**
 * Construit la plume comme une liste de segments dans un espace arbitraire,
 * puis la recadre pour occuper la zone demandée. Séparer géométrie et cadrage
 * permet de retoucher les proportions sans avoir à réajuster les marges.
 */
function featherSegments(barbs, barbWidth, shaftWidth) {
  // Axe de la plume : le calamus dépasse sous la première barbe
  const quill = { x: 0.2, y: 0.92 };
  const first = { x: 0.34, y: 0.7 };
  const tip = { x: 0.78, y: 0.14 };

  const dx = tip.x - first.x;
  const dy = tip.y - first.y;
  const len = Math.hypot(dx, dy);
  const ux = dx / len;
  const uy = dy / len;
  // Perpendiculaire unitaire à l'axe
  const px = -uy;
  const py = ux;

  // Les barbes ne sont pas perpendiculaires au rachis : elles filent vers la
  // pointe. C'est ce qui distingue une plume d'une arête de poisson, et c'est
  // le seul indice qui survive à la réduction en 16 px.
  const sweep = (34 * Math.PI) / 180;
  const cos = Math.cos(sweep);
  const sin = Math.sin(sweep);

  // Demi-largeur maximale ≈ un quart de la longueur de l'axe : au-delà, la
  // silhouette s'arrondit et cesse de se lire comme une plume.
  const maxHalf = 0.2;
  const segments = [{ x1: quill.x, y1: quill.y, x2: tip.x, y2: tip.y, w: shaftWidth }];

  barbs.forEach((rel, i) => {
    // On s'arrête avant la pointe pour que celle-ci reste nette
    const t = lerp(0.02, 0.9, barbs.length === 1 ? 0 : i / (barbs.length - 1));
    const cx = lerp(first.x, tip.x, t);
    const cy = lerp(first.y, tip.y, t);
    const half = maxHalf * rel;

    // Une capsule par côté, chacune ouverte vers la pointe
    for (const side of [1, -1]) {
      segments.push({
        x1: cx,
        y1: cy,
        x2: cx + (px * side * cos + ux * sin) * half,
        y2: cy + (py * side * cos + uy * sin) * half,
        w: barbWidth
      });
    }
  });

  return segments;
}

/** Met les segments à l'échelle pour remplir un carré de côté `box`, centré. */
function fitSegments(segments, box, margin) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const s of segments) {
    const r = s.w / 2;
    minX = Math.min(minX, s.x1 - r, s.x2 - r);
    maxX = Math.max(maxX, s.x1 + r, s.x2 + r);
    minY = Math.min(minY, s.y1 - r, s.y2 - r);
    maxY = Math.max(maxY, s.y1 + r, s.y2 + r);
  }
  const available = box - margin * 2;
  const scale = available / Math.max(maxX - minX, maxY - minY);
  const offsetX = margin + (available - (maxX - minX) * scale) / 2 - minX * scale;
  const offsetY = margin + (available - (maxY - minY) * scale) / 2 - minY * scale;

  return segments.map((s) => ({
    x1: s.x1 * scale + offsetX,
    y1: s.y1 * scale + offsetY,
    x2: s.x2 * scale + offsetX,
    y2: s.y2 * scale + offsetY,
    w: s.w * scale
  }));
}

/**
 * @param {number} box côté de la zone de dessin, en pixels suréchantillonnés
 * @param {number} size taille finale de l'icône, qui détermine la simplification
 * @param {number} pad marge supplémentaire (la pastille de l'icône applicative)
 */
function drawFeather(canvas, box, size, color, pad = 0) {
  // L'épaisseur vaut environ la moitié de l'écart entre deux barbes : c'est le
  // vide entre elles qui fait lire « forme d'onde » plutôt que « plumeau ».
  const v = variantFor(size);
  const segments = fitSegments(
    featherSegments(v.barbs, v.barbW, v.shaftW),
    box,
    box * (v.margin + pad)
  );
  for (const s of segments) capsule(canvas, s.x1, s.y1, s.x2, s.y2, s.w, color);
}

/* ---------------------------- les icônes ----------------------------- */

/** Icône applicative : plume blanche sur pastille dégradée. */
function drawAppIcon(size) {
  const S = size * SS;
  const canvas = createCanvas(S);

  roundedRect(canvas, 0, 0, S, S, S * 0.22, (x, y) => {
    const t = (x / S) * 0.45 + (y / S) * 0.55;
    return [lerp(99, 168, t), lerp(102, 85, t), lerp(241, 247, t)];
  });

  // La pastille impose sa propre marge, en plus de celle du dessin
  drawFeather(canvas, S, size, [255, 255, 255], size <= 24 ? 0.05 : 0.12);
  return downsample(canvas, size);
}

/**
 * Icône de la zone de notification : monochrome sur fond transparent.
 *
 * Windows pose cette icône sur une barre claire ou sombre selon le réglage
 * système, et ne propose aucun équivalent des « template images » de macOS.
 * Un ton unique est donc impossible : un gris clair disparaît sur une barre
 * claire. On produit les deux versions, l'application choisit à l'exécution.
 *
 * @param {'light'|'dark'|'active'} tone  `light` = tracé clair pour barre
 *   sombre, `dark` = tracé sombre pour barre claire, `active` = enregistrement.
 */
function drawTrayIcon(size, tone = 'light') {
  const S = size * SS;
  const canvas = createCanvas(S);
  const color =
    tone === 'active' ? [244, 63, 94] : tone === 'dark' ? [38, 38, 40] : [240, 240, 240];
  drawFeather(canvas, S, size, color);
  return downsample(canvas, size);
}

/**
 * Même géométrie, exportée en SVG pour la barre de titre de l'application.
 * Passer par la source commune évite que le logo de l'interface et celui des
 * icônes divergent à la première retouche.
 */
function featherSvg(box = 16, sizeHint = 64) {
  const v = variantFor(sizeHint);
  const segments = fitSegments(
    featherSegments(v.barbs, v.barbW, v.shaftW),
    box,
    box * v.margin
  );
  const round = (n) => Math.round(n * 100) / 100;
  const lines = segments
    .map(
      (s) =>
        '<path d="M' + round(s.x1) + ' ' + round(s.y1) + 'L' + round(s.x2) + ' ' + round(s.y2) +
        '" stroke-width="' + round(s.w) + '"/>'
    )
    .join('');
  return (
    '<svg viewBox="0 0 ' + box + ' ' + box + '" fill="none" stroke="currentColor" ' +
    'stroke-linecap="round">' + lines + '</svg>'
  );
}

/* ---------------------------- écriture ------------------------------- */

function main() {
  fs.mkdirSync(ASSETS, { recursive: true });

  const sizes = [256, 128, 64, 48, 32, 16];
  const pngs = sizes.map((size) => ({ size, buffer: encodePng(drawAppIcon(size), size) }));

  fs.writeFileSync(path.join(ASSETS, 'icon.png'), pngs[0].buffer);
  fs.writeFileSync(path.join(ASSETS, 'icon.ico'), encodeIco(pngs));

  // La zone de notification affiche 16 px : on rend à cette taille plutôt que
  // de laisser Electron réduire un 32 px, ce qui empâterait le trait.
  fs.writeFileSync(path.join(ASSETS, 'tray-light.png'), encodePng(drawTrayIcon(16, 'light'), 16));
  fs.writeFileSync(path.join(ASSETS, 'tray-dark.png'), encodePng(drawTrayIcon(16, 'dark'), 16));
  fs.writeFileSync(path.join(ASSETS, 'tray-active.png'), encodePng(drawTrayIcon(16, 'active'), 16));

  // Le logo de la barre de titre sort de la même géométrie que les icônes
  fs.writeFileSync(path.join(ASSETS, 'mark.svg'), featherSvg(16, 64) + '\n');

  for (const name of ['icon.png', 'icon.ico', 'tray-light.png', 'tray-dark.png', 'tray-active.png', 'mark.svg']) {
    const bytes = fs.statSync(path.join(ASSETS, name)).size;
    process.stdout.write('  ' + name.padEnd(16) + (bytes / 1024).toFixed(1) + ' Ko\n');
  }
}

if (require.main === module) main();

module.exports = { drawAppIcon, drawTrayIcon, featherSvg, encodePng, encodeIco };
