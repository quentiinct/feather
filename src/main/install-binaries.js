'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const extract = require('extract-zip');

const { downloadFile } = require('./downloader');

const WHISPER_TAG = process.env.VOXFLOW_WHISPER_TAG || 'b4938';
const RELEASE_BASE = 'https://github.com/ggml-org/whisper.cpp/releases/download/' + WHISPER_TAG;

const ASSETS = {
  cuda: 'whisper-cublas-12.4.0-bin-x64.zip',
  cpu: 'whisper-bin-x64.zip'
};

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

/**
 * Certaines archives rangent les fichiers dans un sous-dossier.
 * L'exécutable et ses DLL doivent finir côte à côte, sinon le chargement échoue.
 */
function flatten(binDir) {
  const entries = fs.readdirSync(binDir, { withFileTypes: true });
  const isExe = (name) => /^(whisper-cli|main)\.exe$/i.test(name);
  if (entries.some((e) => e.isFile() && isExe(e.name))) return;

  for (const dir of entries.filter((e) => e.isDirectory())) {
    const sub = path.join(binDir, dir.name);
    const inner = fs.readdirSync(sub, { withFileTypes: true });
    if (!inner.some((f) => f.isFile() && isExe(f.name))) continue;
    for (const f of inner) {
      if (f.isFile()) fs.renameSync(path.join(sub, f.name), path.join(binDir, f.name));
    }
    fs.rmSync(sub, { recursive: true, force: true });
    return;
  }
}

/**
 * Télécharge et installe les binaires whisper.cpp dans `binDir`.
 * @param {string} binDir
 * @param {(p:{percent:number,received:number,total:number})=>void} [onProgress]
 * @param {'cuda'|'cpu'} [forceKind]
 */
async function installBinaries(binDir, onProgress, forceKind) {
  const kind = forceKind || (detectNvidia() ? 'cuda' : 'cpu');
  const asset = ASSETS[kind];
  const zipPath = path.join(os.tmpdir(), 'voxflow-' + asset);

  await downloadFile(RELEASE_BASE + '/' + asset, zipPath, onProgress);

  // On installe à côté avant de remplacer : un échec ne doit pas laisser
  // l'utilisateur sans moteur du tout.
  const stagingDir = binDir + '.new';
  fs.rmSync(stagingDir, { recursive: true, force: true });
  fs.mkdirSync(stagingDir, { recursive: true });
  await extract(zipPath, { dir: stagingDir });
  fs.unlinkSync(zipPath);
  flatten(stagingDir);

  const exe = ['whisper-cli.exe', 'main.exe'].find((n) => fs.existsSync(path.join(stagingDir, n)));
  if (!exe) {
    fs.rmSync(stagingDir, { recursive: true, force: true });
    throw new Error("l'archive ne contient pas whisper-cli.exe");
  }

  fs.rmSync(binDir, { recursive: true, force: true });
  fs.renameSync(stagingDir, binDir);

  return { buildKind: kind, executable: exe, tag: WHISPER_TAG };
}

module.exports = { installBinaries, detectNvidia, WHISPER_TAG, ASSETS };
