#!/usr/bin/env node
'use strict';

/**
 * Installe les prérequis natifs de Feather :
 *   1. les binaires whisper.cpp pour Windows x64 (build CUDA si une carte NVIDIA est détectée) ;
 *   2. le modèle de transcription par défaut.
 *
 * Rien de tout ça n'est versionné dans Git : ce script rend le dépôt clonable
 * et fonctionnel en une commande (`npm run setup`).
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { downloadFile, formatBytes, checkGgmlFile } = require('../src/main/downloader');
const { installBinaries, detectNvidia, WHISPER_TAG } = require('../src/main/install-binaries');
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

function verify(exeName) {
  try {
    const out = execFileSync(path.join(BIN_DIR, exeName), ['--help'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      // Le binaire doit tourner depuis son dossier pour trouver ses DLL, et
      // la première initialisation CUDA peut prendre une bonne dizaine de secondes.
      cwd: BIN_DIR,
      timeout: 60000
    });
    return out.length > 0;
  } catch (err) {
    // whisper-cli renvoie un code non nul sur --help selon les versions
    return Boolean(err.stdout || err.stderr);
  }
}

async function main() {
  log('Feather — installation des composants natifs');
  log('════════════════════════════════════════════');

  if (process.platform !== 'win32') {
    log('⚠ Ce script cible Windows x64. Les binaires téléchargés ne fonctionneront pas ici.');
  }

  const gpu = detectNvidia();
  const wantCuda = hasFlag('--cuda') || (!hasFlag('--cpu') && Boolean(gpu));
  if (gpu) log('\nGPU détecté : ' + gpu + (wantCuda ? ' → build CUDA' : ' → build CPU (forcé)'));
  else log('\nAucun GPU NVIDIA détecté → build CPU');

  const modelId = argValue('--model', DEFAULT_CONFIG.whisper.model);

  let exeName;
  if (hasFlag('--model-only')) {
    log('\n(--model-only : les binaires ne sont pas retéléchargés)');
    exeName = ['whisper-cli.exe', 'main.exe'].find((n) => fs.existsSync(path.join(BIN_DIR, n)));
  } else {
    exeName = await installEngine(wantCuda ? 'cuda' : 'cpu');
  }

  if (!hasFlag('--bin-only')) await installModel(modelId);

  log('\n════════════════════════════════════════════');
  if (exeName && verify(exeName)) {
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
