#!/usr/bin/env node
'use strict';

/**
 * Installe les prérequis natifs de Feather :
 *   1. les binaires whisper.cpp correspondant à la machine ;
 *   2. le modèle de transcription par défaut.
 *
 * Windows x64 a droit au build CUDA si une carte NVIDIA est présente ; Linux
 * n'a qu'un build CPU publié ; macOS n'en a aucun et passe par une installation
 * existante — Homebrew, ou une compilation maison.
 *
 * Rien de tout ça n'est versionné dans Git : ce script rend le dépôt clonable
 * et fonctionnel en une commande (`npm run setup`).
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { downloadFile, formatBytes, checkGgmlFile } = require('../src/main/downloader');
const {
  installBinaries,
  detectNvidia,
  assetFor,
  WHISPER_TAG
} = require('../src/main/install-binaries');
const { IS_MAC, IS_WIN, exeName, libraryEnv } = require('../src/main/platform');
const { MODELS, modelUrl, findModel } = require('../src/shared/models');
const { DEFAULT_CONFIG } = require('../src/shared/defaults');

const ROOT = path.join(__dirname, '..');
const BIN_DIR = path.join(ROOT, 'resources', 'bin');
const MODELS_DIR = path.join(ROOT, 'resources', 'models');

const args = process.argv.slice(2);
const hasFlag = (f) => args.includes(f);
const argValue = (f, fallback) => {
  const i = args.indexOf(f);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const log = (msg) => process.stdout.write(msg + '\n');

function drawProgress(label, p) {
  const width = 28;
  const filled = Math.round((p.percent / 100) * width);
  const bar = '█'.repeat(filled) + '░'.repeat(width - filled);
  const speed = formatBytes(p.speedBps) + '/s';
  const line =
    '  ' + label + ' [' + bar + '] ' +
    p.percent.toFixed(1).padStart(5) + '%  ' +
    formatBytes(p.received) + ' / ' + formatBytes(p.total) + '  ' + speed + '   ';
  process.stdout.write('\r' + line);
}

async function installEngine(kind) {
  log('\n▸ Binaires whisper.cpp (' + WHISPER_TAG + ', build ' + kind + ')');
  const result = await installBinaries(BIN_DIR, (p) => drawProgress('téléchargement', p), kind);
  process.stdout.write('\n');
  log('  ✔ ' + result.executable + ' installé (' + fs.readdirSync(BIN_DIR).length + ' fichiers)');
  return result.executable;
}

async function installModel(modelId) {
  const model = findModel(modelId);
  if (!model) {
    throw new Error(
      'modèle inconnu « ' + modelId + ' ». Disponibles : ' + MODELS.map((m) => m.id).join(', ')
    );
  }
  const dest = path.join(MODELS_DIR, model.id + '.bin');
  if (fs.existsSync(dest) && fs.statSync(dest).size > 1048576) {
    log('\n▸ Modèle ' + model.label + ' déjà présent, ignoré.');
    return dest;
  }

  log('\n▸ Modèle ' + model.label + ' (~' + model.sizeMB + ' Mo)');
  await downloadFile(
    modelUrl(model.id),
    dest,
    (p) => drawProgress('téléchargement', p),
    undefined,
    (tmpPath) => checkGgmlFile(tmpPath, model.sizeMB * 1048576)
  );
  process.stdout.write('\n');
  log('  ✔ ' + path.relative(ROOT, dest));
  return dest;
}

/**
 * Le binaire répond-il ?
 *
 * `whisper-cli --help` écrit la totalité de son aide sur **stderr** et sort
 * avec le code 0. Ne regarder que stdout faisait donc passer toute
 * installation saine pour un échec, et affichait un avertissement à chaque
 * `npm run setup` — de quoi faire croire à une panne qui n'existait pas.
 *
 * On lit les deux flux, et on ignore le code de sortie : il varie d'une version
 * de whisper.cpp à l'autre. Ce qu'on veut savoir tient en une question — le
 * binaire s'est-il chargé assez pour dire quelque chose ?
 */
function verify(nom) {
  const chemin = path.isAbsolute(nom) ? nom : path.join(BIN_DIR, nom);
  const res = spawnSync(chemin, ['--help'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    // Le binaire doit tourner depuis son dossier pour trouver ses bibliothèques,
    // et la première initialisation CUDA peut prendre une dizaine de secondes.
    cwd: path.dirname(chemin),
    env: libraryEnv(path.dirname(chemin)),
    timeout: 60000
  });
  if (res.error) return false;
  return ((res.stdout || '') + (res.stderr || '')).trim().length > 0;
}

/** Cherche un whisper.cpp déjà installé : c'est la voie normale sur macOS. */
function findInPath(nom) {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidat = path.join(dir, nom);
    try {
      if (fs.statSync(candidat).isFile()) return candidat;
    } catch {
      /* dossier du PATH inexistant */
    }
  }
  return null;
}

/**
 * macOS : la release de whisper.cpp ne contient qu'un xcframework, bon pour une
 * application Xcode mais pas pour nous. On vérifie donc une installation
 * existante plutôt que de télécharger quelque chose d'inutilisable.
 */
function checkMac() {
  const trouve = findInPath('whisper-cli') || findInPath('main');
  if (trouve) {
    log('');
    log('▸ whisper.cpp trouvé : ' + trouve);
    log('  Rien à télécharger — Feather le prendra dans le PATH.');
    return trouve;
  }
  log('');
  log('▸ whisper.cpp introuvable');
  log('  whisper.cpp ne publie pas de binaires pour macOS. Deux façons de faire :');
  log('');
  log('    brew install whisper-cpp');
  log('');
  log('  ou, pour un build Metal à jour :');
  log('    git clone https://github.com/ggml-org/whisper.cpp && cd whisper.cpp');
  log('    cmake -B build -DWHISPER_METAL=ON && cmake --build build -j --config Release');
  log('    puis renseignez whisper.binDir dans config.json avec le dossier obtenu.');
  return null;
}

async function main() {
  log('Feather — installation des composants natifs');
  log('════════════════════════════════════════════');

  log('');
  log('Système : ' + process.platform + '/' + process.arch);

  const modelId = argValue('--model', DEFAULT_CONFIG.whisper.model);
  const noms = [exeName('whisper-cli'), exeName('main')];

  let executable;
  if (IS_MAC) {
    executable = checkMac();
  } else if (hasFlag('--model-only')) {
    log('');
    log('(--model-only : les binaires ne sont pas retéléchargés)');
    executable = noms.find((n) => fs.existsSync(path.join(BIN_DIR, n)));
  } else {
    const gpu = detectNvidia();
    // Seul Windows a un build GPU publié : ailleurs, annoncer CUDA serait faux.
    const cudaPossible = IS_WIN && Boolean(assetFor('cuda'));
    const wantCuda = cudaPossible && (hasFlag('--cuda') || (!hasFlag('--cpu') && Boolean(gpu)));
    if (gpu && cudaPossible) {
      log('GPU détecté : ' + gpu + (wantCuda ? ' → build CUDA' : ' → build CPU (forcé)'));
    } else if (gpu) {
      log('GPU détecté : ' + gpu + ' → build CPU (aucun build GPU publié pour ce système)');
    } else {
      log('Aucun GPU NVIDIA détecté → build CPU');
    }
    executable = await installEngine(wantCuda ? 'cuda' : 'cpu');
  }

  if (!hasFlag('--bin-only')) await installModel(modelId);

  log('\n════════════════════════════════════════════');
  if (executable && verify(executable)) {
    log('✔ Installation terminée. Lancez l\'application avec : npm start');
  } else {
    log('⚠ Installation terminée, mais l\'exécutable n\'a pas répondu.');
    log('  Sur un build CUDA, installez le pilote NVIDIA à jour, ou relancez avec :');
    log('    npm run setup -- --cpu');
  }
}

main().catch((err) => {
  process.stdout.write('\n');
  console.error('✖ Échec de l\'installation : ' + err.message);
  console.error('\nOptions disponibles :');
  console.error('  npm run setup -- --cpu            build CPU (léger, ~8 Mo)');
  console.error('  npm run setup -- --cuda           build CUDA 12.4 (~640 Mo)');
  console.error('  npm run setup -- --model <id>     choisir le modèle');
  console.error('  npm run setup -- --model-only     ne télécharger que le modèle');
  process.exitCode = 1;
});
