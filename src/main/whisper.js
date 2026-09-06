'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

/**
 * Pilote whisper.cpp. On appelle l'exécutable `whisper-cli.exe` en sous-processus
 * plutôt qu'un binding natif : aucune compilation nécessaire, et on peut échanger
 * le build CPU contre le build CUDA sans retoucher au code.
 */
class WhisperEngine {
  /**
   * @param {{binDir:string, modelsDir:string, tmpDir:string}} paths
   */
  constructor(paths) {
    this.binDir = paths.binDir;
    this.modelsDir = paths.modelsDir;
    this.tmpDir = paths.tmpDir;
    this.binary = null;
    this.flags = new Set();
    this.buildKind = 'inconnu';
    this.current = null;
    this._initPromise = null;
  }

  /** Emplacements possibles de l'exécutable, du plus spécifique au plus générique. */
  _candidateBinaries() {
    const names = ['whisper-cli.exe', 'main.exe', 'whisper-cli', 'main'];
    const dirs = [this.binDir, path.join(this.binDir, 'Release'), path.join(this.binDir, 'bin')];
    const out = [];
    for (const dir of dirs) {
      for (const name of names) out.push(path.join(dir, name));
    }
    return out;
  }

  findBinary() {
    for (const candidate of this._candidateBinaries()) {
      if (fs.existsSync(candidate)) return candidate;
    }
    return null;
  }

  /**
   * Localise le binaire et détecte les options qu'il supporte.
   * Les versions de whisper.cpp ne partagent pas toutes les mêmes drapeaux,
   * donc on lit `--help` une fois au démarrage plutôt que de deviner.
   */
  async init() {
    if (this._initPromise) return this._initPromise;
    this._initPromise = (async () => {
      this.binary = this.findBinary();
      if (!this.binary) {
        return { ready: false, reason: 'binaire-absent' };
      }

      const help = await this._runHelp();
      this.flags = new Set(help.match(/(?:^|\s)(--?[a-z0-9][a-z0-9-]*)/gi)?.map((s) => s.trim()) || []);

      // Le build cuBLAS embarque les DLL CUDA à côté de l'exécutable
      const siblings = fs.existsSync(path.dirname(this.binary))
        ? fs.readdirSync(path.dirname(this.binary))
        : [];
      this.buildKind = siblings.some((f) => /^(cublas|cudart|cublasLt)/i.test(f))
        ? 'cuda'
        : siblings.some((f) => /openblas/i.test(f))
          ? 'blas'
          : 'cpu';

      return { ready: true, binary: this.binary, buildKind: this.buildKind };
    })();
    return this._initPromise;
  }

  _runHelp() {
    return new Promise((resolve) => {
      let out = '';
      const child = spawn(this.binary, ['--help'], { windowsHide: true });
      const done = () => resolve(out);
      child.stdout.on('data', (d) => (out += d.toString('utf8')));
      child.stderr.on('data', (d) => (out += d.toString('utf8')));
      child.on('close', done);
      child.on('error', done);
      setTimeout(done, 5000);
    });
  }

  supports(flag) {
    return this.flags.has(flag);
  }

  modelPath(modelId) {
    return path.join(this.modelsDir, modelId + '.bin');
  }

  hasModel(modelId) {
    try {
      return fs.statSync(this.modelPath(modelId)).size > 1024 * 1024;
    } catch {
      return false;
    }
  }

  listInstalledModels() {
    try {
      return fs
        .readdirSync(this.modelsDir)
        .filter((f) => f.endsWith('.bin'))
        .map((f) => ({
          id: f.replace(/\.bin$/, ''),
          sizeMB: Math.round(fs.statSync(path.join(this.modelsDir, f)).size / 1048576)
        }));
    } catch {
      return [];
    }
  }

  /** Construit la ligne de commande à partir de la config utilisateur. */
  _buildArgs(wavPath, cfg, outPrefix) {
    const args = ['-m', this.modelPath(cfg.model), '-f', wavPath];

    const threads = Number(cfg.threads) > 0 ? Number(cfg.threads) : Math.max(2, Math.min(8, os.cpus().length - 2));
    args.push('-t', String(threads));

    args.push('-l', cfg.language && cfg.language !== 'auto' ? cfg.language : 'auto');
    if (cfg.translate) args.push('-tr');

    if (cfg.strategy === 'beam' && Number(cfg.beamSize) > 1) {
      args.push('-bs', String(cfg.beamSize));
    } else {
      args.push('-bs', '1');
    }

    if (Number.isFinite(Number(cfg.temperature))) args.push('-tp', String(Number(cfg.temperature)));
    if (cfg.initialPrompt && cfg.initialPrompt.trim()) args.push('--prompt', cfg.initialPrompt.trim());

    // Désactive le GPU si l'utilisateur l'a demandé ou si le build n'est pas CUDA
    if (!cfg.useGpu && this.supports('-ng')) args.push('-ng');

    if (cfg.suppressNonSpeech) {
      if (this.supports('--suppress-nst')) args.push('--suppress-nst');
      else if (this.supports('-sns')) args.push('-sns');
    }

    // Sortie JSON : évite tout problème d'encodage de la console Windows
    args.push('-oj', '-of', outPrefix, '-np', '-nt');
    return args;
  }

  /** Concatène les segments du JSON produit par whisper.cpp. */
  _readJsonOutput(outPrefix) {
    const file = outPrefix + '.json';
    try {
      const json = JSON.parse(fs.readFileSync(file, 'utf8'));
      const segments = json.transcription || [];
      const text = segments.map((s) => (s.text || '').trim()).filter(Boolean).join(' ');
      const language = json.result?.language || json.params?.language || null;
      return { text: text.replace(/\s+/g, ' ').trim(), language };
    } catch {
      return null;
    } finally {
      try {
        fs.unlinkSync(file);
      } catch {
        /* fichier déjà absent */
      }
    }
  }

  /**
   * Transcrit un fichier WAV 16 kHz mono.
   * @returns {Promise<{text:string, language:string|null, ms:number}>}
   */
  async transcribe(wavPath, cfg) {
    const state = await this.init();
    if (!state.ready) {
      throw new Error("whisper.cpp n'est pas installé. Lancez « npm run setup ».");
    }
    if (!this.hasModel(cfg.model)) {
      throw new Error('Modèle « ' + cfg.model + ' » introuvable. Téléchargez-le depuis les réglages.');
    }

    const outPrefix = path.join(this.tmpDir, 'vox-' + Date.now());
    const args = this._buildArgs(wavPath, cfg, outPrefix);
    const startedAt = Date.now();

    return new Promise((resolve, reject) => {
      const child = spawn(this.binary, args, {
        windowsHide: true,
        cwd: path.dirname(this.binary)
      });
      this.current = child;

      let stderr = '';
      let stdout = '';
      child.stdout.on('data', (d) => (stdout += d.toString('utf8')));
      child.stderr.on('data', (d) => {
        stderr += d.toString('utf8');
        if (stderr.length > 20000) stderr = stderr.slice(-20000);
      });

      child.on('error', (err) => {
        this.current = null;
        reject(new Error('Impossible de lancer whisper.cpp : ' + err.message));
      });

      child.on('close', (code, signal) => {
        this.current = null;
        if (signal || child.killed) {
          resolve({ text: '', language: null, ms: Date.now() - startedAt, cancelled: true });
          return;
        }
        if (code !== 0) {
          reject(new Error('whisper.cpp a échoué (code ' + code + ') : ' + stderr.trim().split('\n').slice(-3).join(' ')));
          return;
        }
        const parsed = this._readJsonOutput(outPrefix);
        const text = parsed ? parsed.text : stdout.trim();
        resolve({
          text,
          language: parsed ? parsed.language : null,
          ms: Date.now() - startedAt,
          cancelled: false
        });
      });
    });
  }

  /** Interrompt la transcription en cours, s'il y en a une. */
  cancel() {
    if (this.current && !this.current.killed) {
      this.current.kill();
      this.current = null;
      return true;
    }
    return false;
  }

  status() {
    return {
      installed: Boolean(this.binary || this.findBinary()),
      binary: this.binary,
      buildKind: this.buildKind,
      gpuCapable: this.buildKind === 'cuda',
      models: this.listInstalledModels()
    };
  }
}

module.exports = { WhisperEngine };
