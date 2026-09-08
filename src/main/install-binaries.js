'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, execFile } = require('child_process');

const { downloadFile } = require('./downloader');
const { IS_WIN, IS_MAC, exeName } = require('./platform');

/**
 * bsdtar livré avec Windows (depuis 1803). Le chemin est absolu à dessein :
 * une installation de Git place son propre `tar` (GNU) plus tôt dans le PATH,
 * et celui-là ne sait pas lire un zip. Ailleurs, le `tar` du système suffit et
 * lit aussi bien le zip que le tar.gz.
 */
const TAR = IS_WIN
  ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
  : 'tar';

function runTar(args, timeoutMs = 10 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    if (IS_WIN && !fs.existsSync(TAR)) {
      reject(new Error('tar.exe introuvable dans System32 : Windows 10 1803 ou plus récent requis'));
      return;
    }
    execFile(
      TAR,
      args,
      { windowsHide: true, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) reject(new Error((stderr || err.message).trim()));
        else resolve(stdout);
      }
    );
  });
}

/**
 * Refuse une archive avant de l'ouvrir si elle sort de son dossier.
 *
 * bsdtar bloque déjà les chemins absolus et les « .. » — c'est précisément la
 * faille qui vaut à extract-zip son avis GHSA-jmr9-qjv8-65gv, sans correctif en
 * amont. GNU tar, lui, se contente d'avertir. On vérifie donc nous-mêmes, pour
 * que la garantie soit la même sur les trois systèmes.
 */
async function assertSafeArchive(archivePath) {
  const listing = await runTar(['-tf', archivePath], 60000);
  for (const brut of listing.split(/\r?\n/)) {
    const entree = brut.trim();
    if (!entree) continue;
    if (path.isAbsolute(entree) || /^[a-z]:/i.test(entree)) {
      throw new Error("l'archive contient un chemin absolu (" + entree + '), installation refusée');
    }
    if (entree.split(/[\\/]/).includes('..')) {
      throw new Error("l'archive remonte hors de son dossier (" + entree + '), installation refusée');
    }
  }
}

/**
 * Deuxième barrière : aucun lien ne doit sortir du dossier d'installation.
 *
 * Interdire tout lien serait plus simple, mais faux : la distribution Linux de
 * whisper.cpp en contient huit, la chaîne de versions habituelle des
 * bibliothèques partagées — libwhisper.so → .so.1 → .so.1.9.3. Ce qui est
 * dangereux n'est pas le lien, c'est sa cible : un lien absolu, ou qui remonte
 * hors du dossier, permettrait d'écrire n'importe où au moment de la copie.
 */
function assertLinksStayInside(dir, racine = dir) {
  const limite = path.resolve(racine) + path.sep;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      const cible = fs.readlinkSync(full);
      const resolue = path.resolve(path.dirname(full), cible);
      // Une cible absolue n'est pas dangereuse en soi — les jonctions Windows
      // en sont toujours — ce qui compte est l'endroit où elle atterrit.
      if (!(resolue + path.sep).startsWith(limite)) {
        throw new Error(
          "l'archive contient un lien qui sort du dossier (" +
            entry.name +
            ' → ' +
            cible +
            '), installation refusée'
        );
      }
      continue;
    }
    if (entry.isDirectory()) assertLinksStayInside(full, racine);
  }
}

const WHISPER_TAG = process.env.FEATHER_WHISPER_TAG || 'b4938';
const RELEASE_BASE = 'https://github.com/ggml-org/whisper.cpp/releases/download/' + WHISPER_TAG;

/**
 * Ce que publie whisper.cpp, par système.
 *
 * Rien pour macOS : la release ne contient qu'un xcframework, destiné à être
 * intégré dans une application Xcode, pas des exécutables en ligne de commande.
 * Sur macOS on s'appuie donc sur une installation existante — Homebrew en
 * fournit une — plutôt que de faire croire à un téléchargement possible.
 */
const ASSETS = {
  win32: {
    x64: { cuda: 'whisper-cublas-12.4.0-bin-x64.zip', cpu: 'whisper-bin-x64.zip' }
  },
  linux: {
    x64: { cpu: 'whisper-bin-ubuntu-x64.tar.gz' },
    arm64: { cpu: 'whisper-bin-ubuntu-arm64.tar.gz' }
  }
};

/** L'asset correspondant à la machine, ou null s'il n'y en a pas. */
function assetFor(kind) {
  const parSysteme = ASSETS[process.platform];
  if (!parSysteme) return null;
  const parArch = parSysteme[process.arch];
  if (!parArch) return null;
  return parArch[kind] || parArch.cpu || null;
}

/** Détecte une carte NVIDIA exploitable par le build cuBLAS. */
function detectNvidia() {
  try {
    const out = execFileSync('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 8000
    });
    return out.trim().split('\n')[0]?.trim() || null;
  } catch {
    return null;
  }
}

/** Les noms sous lesquels whisper.cpp livre son exécutable principal. */
const EXECUTABLES = [exeName('whisper-cli'), exeName('main')];

/**
 * Certaines archives rangent les fichiers dans un sous-dossier — c'est le cas
 * de toutes celles de Linux. L'exécutable et ses bibliothèques doivent finir
 * côte à côte, sinon le chargement échoue.
 */
function flatten(binDir) {
  const entries = fs.readdirSync(binDir, { withFileTypes: true });
  const isExe = (name) => EXECUTABLES.some((e) => e.toLowerCase() === name.toLowerCase());
  if (entries.some((e) => e.isFile() && isExe(e.name))) return;

  for (const dir of entries.filter((e) => e.isDirectory())) {
    const sub = path.join(binDir, dir.name);
    const inner = fs.readdirSync(sub, { withFileTypes: true });
    if (!inner.some((f) => f.isFile() && isExe(f.name))) continue;
    // Les liens comptent autant que les fichiers : la chaîne de versions des
    // bibliothèques Linux n'est faite que de ça, et la perdre casse le chargement.
    for (const f of inner) {
      if (f.isDirectory()) continue;
      fs.renameSync(path.join(sub, f.name), path.join(binDir, f.name));
    }
    fs.rmSync(sub, { recursive: true, force: true });
    return;
  }
}

/**
 * Le bit exécutable ne survit pas à toutes les extractions, et un binaire sans
 * ce bit échoue avec un EACCES qui n'aide personne à comprendre.
 */
function makeExecutable(binDir) {
  if (IS_WIN) return;
  for (const nom of fs.readdirSync(binDir, { withFileTypes: true })) {
    if (!nom.isFile()) continue;
    if (/\.(so|dylib|txt|md)/i.test(nom.name) || nom.name === 'LICENSE') continue;
    try {
      fs.chmodSync(path.join(binDir, nom.name), 0o755);
    } catch {
      /* pas grave : seul l'exécutable compte vraiment, et il est traité plus bas */
    }
  }
}

/**
 * Télécharge et installe les binaires whisper.cpp dans `binDir`.
 * @param {string} binDir
 * @param {(p:{percent:number,received:number,total:number})=>void} [onProgress]
 * @param {'cuda'|'cpu'} [forceKind]
 */
async function installBinaries(binDir, onProgress, forceKind) {
  if (IS_MAC) {
    throw new Error(
      "whisper.cpp ne publie pas d'exécutables pour macOS. Installez-les avec " +
        '« brew install whisper-cpp », ou compilez le dépôt et indiquez le dossier ' +
        'obtenu dans whisper.binDir.'
    );
  }

  const kind = forceKind || (detectNvidia() ? 'cuda' : 'cpu');
  const asset = assetFor(kind);
  if (!asset) {
    throw new Error(
      'aucun binaire whisper.cpp publié pour ' + process.platform + '/' + process.arch + '.'
    );
  }

  const archivePath = path.join(os.tmpdir(), 'feather-' + asset);
  await downloadFile(RELEASE_BASE + '/' + asset, archivePath, onProgress);

  // On installe à côté avant de remplacer : un échec ne doit pas laisser
  // l'utilisateur sans moteur du tout.
  const stagingDir = binDir + '.new';
  fs.rmSync(stagingDir, { recursive: true, force: true });
  fs.mkdirSync(stagingDir, { recursive: true });

  try {
    await assertSafeArchive(archivePath);
    await runTar(['-xf', archivePath, '-C', stagingDir]);
  } finally {
    fs.rmSync(archivePath, { force: true });
  }

  assertLinksStayInside(stagingDir);
  flatten(stagingDir);
  makeExecutable(stagingDir);

  const exe = EXECUTABLES.find((n) => fs.existsSync(path.join(stagingDir, n)));
  if (!exe) {
    fs.rmSync(stagingDir, { recursive: true, force: true });
    throw new Error("l'archive ne contient pas " + EXECUTABLES[0]);
  }

  fs.rmSync(binDir, { recursive: true, force: true });
  fs.renameSync(stagingDir, binDir);

  // Le build téléchargé pour Linux n'a pas de variante GPU : le dire ici évite
  // que l'interface annonce « cuda » sur la foi de la carte détectée.
  const buildKind = assetFor('cuda') === asset ? 'cuda' : 'cpu';
  return { buildKind, executable: exe, tag: WHISPER_TAG, asset };
}

module.exports = {
  installBinaries,
  detectNvidia,
  assetFor,
  WHISPER_TAG,
  ASSETS,
  EXECUTABLES
};
