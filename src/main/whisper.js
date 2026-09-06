'use strict';

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

/** Délai de garde avant de retenter le serveur après un démarrage raté. */
const SERVER_RETRY_MS = 60000;

/**
 * Ce qu'une dictée accepte d'attendre que le serveur soit prêt. Au-delà, le CLI
 * répond en ~2 s pendant que le chargement se poursuit : mieux vaut ça qu'une
 * fenêtre figée le temps d'initialiser CUDA, qui peut prendre une minute à froid.
 */
const SERVER_WAIT_MS = 2500;

/**
 * Pilote whisper.cpp. On appelle les exécutables en sous-processus plutôt qu'un
 * binding natif : aucune compilation nécessaire, et on peut échanger le build CPU
 * contre le build CUDA sans retoucher au code.
 *
 * Deux chemins, dans cet ordre :
 *
 *  1. `whisper-server.exe`, gardé vivant. Le modèle reste chargé en mémoire vidéo,
 *     et une dictée de huit secondes revient en ~220 ms.
 *  2. `whisper-cli.exe` en repli. Correct, mais chaque appel recharge le modèle —
 *     environ deux secondes pour un large-v3-turbo quantifié.
 *
 * Le repli n'est pas décoratif : si le port est pris, si le serveur meurt ou si
 * une requête échoue, la dictée aboutit quand même.
 */
class WhisperEngine {
  /**
   * @param {{binDir:string, modelsDirs:string[], tmpDir:string}} paths
   *   `modelsDirs` est ordonné : les modèles téléchargés depuis l'application
   *   (dossier utilisateur) priment sur ceux livrés avec le dépôt.
   */
  constructor(paths) {
    this.binDir = paths.binDir;
    this.modelsDirs = paths.modelsDirs.filter(Boolean);
    this.tmpDir = paths.tmpDir;
    this.binary = null;
    this.serverBinary = null;
    this.flags = new Set();
    this.buildKind = 'inconnu';
    this.current = null;
    this.currentRequest = null;
    this._initPromise = null;
    /** Incrémenté par cancel() : toute transcription d'une génération périmée est jetée. */
    this.generation = 0;

    /** Processus `whisper-server` maintenu en vie, et sa configuration. */
    this.server = null;
    this.serverPort = 0;
    this.serverSignature = null;
    this.serverStarting = null;
    this.serverEnabled = true;
    /** Vrai seulement quand le serveur répond : le processus existe bien avant. */
    this.serverReady = false;
    /** Instant avant lequel on ne retente pas le serveur, après un échec. */
    this.serverRetryAt = 0;
    /** Dernières lignes d'erreur du serveur, pour diagnostiquer une panne. */
    this.serverLog = [];
    this.lastPath = null;

    /**
     * Le modèle occupe la mémoire vidéo tant que le serveur vit. On le libère
     * après une période sans dictée, quitte à repayer le chargement (~2 s) à la
     * reprise. `0` garde le serveur en vie indéfiniment.
     */
    this.idleTimer = null;
    this.idleMs = 0;
  }

  /** Repousse le déchargement du modèle ; appelé après chaque transcription. */
  scheduleIdleUnload(cfg) {
    clearTimeout(this.idleTimer);
    this.idleTimer = null;

    const minutes = Number(cfg?.serverIdleMinutes ?? 0);
    this.idleMs = Number.isFinite(minutes) && minutes > 0 ? minutes * 60000 : 0;
    if (!this.idleMs || !this.server) return;

    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (!this.server) return;
      console.log('[whisper] inactif depuis ' + minutes + ' min, déchargement du modèle.');
      this.stopServer();
    }, this.idleMs);
    // Un modèle déchargé ne doit pas empêcher l'application de se fermer.
    this.idleTimer.unref?.();
  }

  _cancelIdleUnload() {
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
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

      const serverCandidate = path.join(path.dirname(this.binary), 'whisper-server.exe');
      this.serverBinary = fs.existsSync(serverCandidate) ? serverCandidate : null;

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

  /** Premier dossier contenant réellement le modèle, sinon le chemin préféré. */
  modelPath(modelId) {
    for (const dir of this.modelsDirs) {
      const candidate = path.join(dir, modelId + '.bin');
      try {
        if (fs.statSync(candidate).size > 1024 * 1024) return candidate;
      } catch {
        /* absent de ce dossier */
      }
    }
    return path.join(this.modelsDirs[0], modelId + '.bin');
  }

  hasModel(modelId) {
    return this.modelsDirs.some((dir) => {
      try {
        return fs.statSync(path.join(dir, modelId + '.bin')).size > 1024 * 1024;
      } catch {
        return false;
      }
    });
  }

  /** Union des modèles présents, sans doublon (le premier dossier gagne). */
  listInstalledModels() {
    const seen = new Map();
    for (const dir of this.modelsDirs) {
      let files;
      try {
        files = fs.readdirSync(dir);
      } catch {
        continue;
      }
      for (const file of files) {
        if (!file.endsWith('.bin')) continue;
        const id = file.replace(/\.bin$/, '');
        if (seen.has(id)) continue;
        seen.set(id, {
          id,
          sizeMB: Math.round(fs.statSync(path.join(dir, file)).size / 1048576),
          dir
        });
      }
    }
    return Array.from(seen.values());
  }

  /** Construit la ligne de commande à partir de la config utilisateur. */
  _buildArgs(wavPath, cfg, outPrefix) {
    const args = ['-m', this.modelPath(cfg.model), '-f', wavPath];

    args.push('-t', String(this._threadCount(cfg)));

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

  /* ---------------- serveur persistant ---------------- */

  /** Demande un port libre au système plutôt que d'en supposer un. */
  _findFreePort() {
    return new Promise((resolve, reject) => {
      const probe = net.createServer();
      probe.unref();
      probe.on('error', reject);
      probe.listen(0, '127.0.0.1', () => {
        const { port } = probe.address();
        probe.close(() => resolve(port));
      });
    });
  }

  /** Seuls ces réglages imposent un redémarrage : le reste passe par requête. */
  _serverSignature(cfg) {
    return [cfg.model, cfg.useGpu ? 'gpu' : 'cpu', cfg.threads || 0].join('|');
  }

  _threadCount(cfg) {
    return Number(cfg.threads) > 0
      ? Number(cfg.threads)
      : Math.max(2, Math.min(8, os.cpus().length - 2));
  }

  /** Attend que le serveur réponde. Toute réponse HTTP vaut « prêt ». */
  async _waitForServer(port, deadlineMs = 90000) {
    const started = Date.now();
    while (Date.now() - started < deadlineMs) {
      if (!this.server) throw new Error('le serveur whisper s\'est arrêté au démarrage');
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 1500);
        await fetch('http://127.0.0.1:' + port + '/', { signal: controller.signal });
        clearTimeout(timer);
        return true;
      } catch {
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    throw new Error('le serveur whisper n\'a pas répondu à temps');
  }

  /**
   * Démarre le serveur si besoin ; le redémarre si le modèle ou le GPU changent.
   *
   * @param {object} cfg
   * @param {number} [waitMs] Budget d'attente. Passé ce délai on rend `null`
   *   sans annuler le démarrage : la dictée en cours part sur le CLI pendant que
   *   le modèle finit de charger, et la suivante trouvera le serveur prêt.
   *   Le préchauffage, lui, n'a personne derrière : il attend sans limite.
   */
  async ensureServer(cfg, waitMs = Infinity) {
    if (!this.serverEnabled || !this.serverBinary) return null;

    // Une panne de serveur ne condamne plus la session : on repasse par le CLI
    // le temps du délai de garde, puis on retente.
    if (this.serverRetryAt && Date.now() < this.serverRetryAt) return null;

    const signature = this._serverSignature(cfg);

    // `serverReady` est capital : entre le spawn et la fin du chargement du
    // modèle, `this.server` existe déjà mais rien n'écoute. Rendre le port à ce
    // moment-là envoyait la dictée sur un port fermé, et son échec tuait le
    // serveur que le préchauffage attendait encore.
    if (this.server && this.serverReady && this.serverSignature === signature) {
      return this.serverPort;
    }

    if (!this.serverStarting || this.serverSignature !== signature) {
      if (this.serverSignature !== signature) this.stopServer();
      this._startServer(cfg, signature);
    }

    if (waitMs === Infinity) {
      await this.serverStarting.catch(() => {});
    } else {
      let minuteur;
      await Promise.race([
        this.serverStarting.catch(() => {}),
        new Promise((r) => {
          minuteur = setTimeout(r, waitMs);
          minuteur.unref?.();
        })
      ]);
      clearTimeout(minuteur);
    }

    return this.server && this.serverReady && this.serverSignature === signature
      ? this.serverPort
      : null;
  }

  /** Lance le serveur en tâche de fond ; personne n'est obligé d'attendre. */
  _startServer(cfg, signature) {
    this.serverStarting = (async () => {
      const port = await this._findFreePort();
      const args = [
        '-m', this.modelPath(cfg.model),
        '--host', '127.0.0.1',
        '--port', String(port),
        '-t', String(this._threadCount(cfg)),
        '-nt'
      ];
      if (!cfg.useGpu) args.push('-ng');
      if (cfg.suppressNonSpeech) args.push('-sns');

      const child = spawn(this.serverBinary, args, {
        windowsHide: true,
        cwd: path.dirname(this.serverBinary)
      });
      this.server = child;
      this.serverPort = port;
      this.serverSignature = signature;
      this.serverReady = false;
      this.serverLog = [];

      child.stdout.resume();
      // La sortie d'erreur porte le diagnostic de whisper.cpp (VRAM, modèle
      // illisible, backend absent). La jeter rendait toute panne opaque.
      child.stderr.on('data', (chunk) => {
        for (const line of String(chunk).split(/\r?\n/)) {
          if (line.trim()) this.serverLog.push(line.trim());
        }
        if (this.serverLog.length > 40) this.serverLog.splice(0, this.serverLog.length - 40);
      });
      const forget = () => {
        if (this.server === child) {
          this.server = null;
          this.serverSignature = null;
          this.serverReady = false;
        }
      };
      child.on('exit', forget);
      child.on('error', forget);

      await this._waitForServer(port);
      this.serverReady = true;
      return port;
    })();

    // Le bilan du démarrage est tenu par la tâche elle-même : celui qui a
    // renoncé à attendre ne doit pas rater une panne survenue après son départ.
    this.serverStarting = this.serverStarting.then(
      (port) => {
        this.serverRetryAt = 0;
        this.serverStarting = null;
        return port;
      },
      (err) => {
        // Un serveur qui ne démarre pas ne doit pas condamner la dictée : le CLI
        // prend le relais, mais seulement pour un temps — désactiver le chemin
        // rapide pour toute la session sur un seul incident coûtait dix fois le
        // temps de transcription à chaque dictée suivante.
        const detail = this.serverLog.slice(-3).join(' | ');
        this.stopServer();
        this.serverStarting = null;
        this.serverRetryAt = Date.now() + SERVER_RETRY_MS;
        console.warn(
          '[whisper] serveur indisponible (' + err.message + '), repli sur le CLI' +
            (detail ? ' — ' + detail : '') +
            '. Nouvelle tentative dans ' + Math.round(SERVER_RETRY_MS / 1000) + ' s.'
        );
        return null;
      }
    );
  }

  stopServer() {
    this._cancelIdleUnload();
    if (this.server && !this.server.killed) {
      try {
        this.server.kill();
      } catch {
        /* déjà mort */
      }
    }
    this.server = null;
    this.serverSignature = null;
    this.serverPort = 0;
    this.serverReady = false;
  }

  /** Envoie le WAV au serveur en multipart. */
  async _transcribeViaServer(port, wavPath, cfg) {
    const buffer = fs.readFileSync(wavPath);
    const form = new FormData();
    form.append('file', new Blob([buffer], { type: 'audio/wav' }), 'dictee.wav');
    form.append('response_format', 'json');
    form.append('temperature', String(Number(cfg.temperature) || 0));
    form.append('language', cfg.language && cfg.language !== 'auto' ? cfg.language : 'auto');
    if (cfg.translate) form.append('translate', 'true');
    if (cfg.initialPrompt && cfg.initialPrompt.trim()) {
      form.append('prompt', cfg.initialPrompt.trim());
    }

    const controller = new AbortController();
    this.currentRequest = controller;
    const timer = setTimeout(() => controller.abort(), 120000);

    try {
      const res = await fetch('http://127.0.0.1:' + port + '/inference', {
        method: 'POST',
        body: form,
        signal: controller.signal
      });
      if (!res.ok) throw new Error('le serveur a répondu ' + res.status);
      const json = await res.json();
      return String(json.text || '').replace(/\s+/g, ' ').trim();
    } finally {
      clearTimeout(timer);
      this.currentRequest = null;
    }
  }

  /**
   * Transcrit un fichier WAV 16 kHz mono.
   * @returns {Promise<{text:string, language:string|null, ms:number, via:string}>}
   */
  async transcribe(wavPath, cfg) {
    // Le minuteur ne court qu'entre deux dictées, jamais pendant l'une d'elles.
    this._cancelIdleUnload();
    try {
      return await this._transcribe(wavPath, cfg);
    } finally {
      this.scheduleIdleUnload(cfg);
    }
  }

  async _transcribe(wavPath, cfg) {
    const state = await this.init();
    if (!state.ready) {
      throw new Error("whisper.cpp n'est pas installé. Lancez « npm run setup ».");
    }
    if (!this.hasModel(cfg.model)) {
      throw new Error(
        'Modèle « ' + cfg.model + ' » introuvable. Téléchargez-le depuis l\'onglet Transcription.'
      );
    }

    const startedAt = Date.now();
    const generation = this.generation;
    const abandoned = () => this.generation !== generation;

    // Le démarrage du serveur peut durer plusieurs secondes ; une annulation
    // pendant cette fenêtre doit être honorée, pas seulement pendant la requête.
    const port = await this.ensureServer(cfg, SERVER_WAIT_MS);
    if (abandoned()) {
      return { text: '', language: null, ms: Date.now() - startedAt, cancelled: true, via: 'serveur' };
    }

    // Deux tentatives : un serveur mort (déchargé, tombé) se relance en ~2 s,
    // ce qui reste dix fois plus rapide que le CLI. Le repli ne sert qu'après.
    for (let essai = 0, activePort = port; essai < 2 && activePort; essai += 1) {
      try {
        const text = await this._transcribeViaServer(activePort, wavPath, cfg);
        if (abandoned()) {
          return { text: '', language: null, ms: Date.now() - startedAt, cancelled: true, via: 'serveur' };
        }
        return { text, language: null, ms: Date.now() - startedAt, cancelled: false, via: 'serveur' };
      } catch (err) {
        if (err.name === 'AbortError' || abandoned()) {
          return { text: '', language: null, ms: Date.now() - startedAt, cancelled: true, via: 'serveur' };
        }
        this.stopServer();
        if (essai === 0) {
          console.warn('[whisper] requête serveur échouée (' + err.message + '), relance du serveur.');
          activePort = await this.ensureServer(cfg, SERVER_WAIT_MS);
          if (abandoned()) {
            return { text: '', language: null, ms: Date.now() - startedAt, cancelled: true, via: 'serveur' };
          }
        } else {
          console.warn('[whisper] serveur toujours injoignable (' + err.message + '), repli sur le CLI.');
        }
      }
    }

    const result = await this._transcribeViaCli(wavPath, cfg);
    return abandoned() ? { ...result, text: '', cancelled: true } : result;
  }

  /** Chemin de repli : un processus par transcription, modèle rechargé à chaque fois. */
  _transcribeViaCli(wavPath, cfg) {
    const outPrefix = path.join(this.tmpDir, 'feather-' + Date.now());
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
          resolve({ text: '', language: null, ms: Date.now() - startedAt, cancelled: true, via: 'cli' });
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
          cancelled: false,
          via: 'cli'
        });
      });
    });
  }

  /** Interrompt la transcription en cours, quelle que soit la voie utilisée. */
  cancel() {
    let stopped = false;
    this.generation += 1;
    if (this.currentRequest) {
      this.currentRequest.abort();
      this.currentRequest = null;
      stopped = true;
    }
    if (this.current && !this.current.killed) {
      this.current.kill();
      this.current = null;
      stopped = true;
    }
    return stopped;
  }

  status() {
    return {
      installed: Boolean(this.binary || this.findBinary()),
      binary: this.binary,
      buildKind: this.buildKind,
      gpuCapable: this.buildKind === 'cuda',
      serverAvailable: Boolean(this.serverBinary),
      serverRunning: Boolean(this.server),
      models: this.listInstalledModels()
    };
  }
}

module.exports = { WhisperEngine };
