'use strict';

const { spawn, execFile } = require('child_process');
const { IS_WIN, IS_MAC, isWayland } = require('./platform');

/**
 * Envoi de frappes clavier à l'application qui a le focus.
 *
 * Une implémentation par système, derrière la même interface :
 *   start()             prépare ce qui doit l'être
 *   paste()             envoie Ctrl+V (Cmd+V sur macOS)
 *   type(texte, delai)  frappe le texte caractère par caractère
 *   stop(), status()
 *
 * Windows garde un helper PowerShell vivant : compiler l'interop Win32 coûte
 * environ une seconde, hors de question de la payer à chaque dictée. macOS et
 * Linux ont des outils qui démarrent en quelques millisecondes, donc un
 * processus par frappe suffit — et évite d'avoir à maintenir un protocole.
 */

/* ------------------------------------------------------------------ *
 * Windows — helper PowerShell persistant
 * ------------------------------------------------------------------ */

class WindowsKeystroke {
  constructor({ scriptPath }) {
    this.scriptPath = scriptPath;
    this.child = null;
    this.ready = false;
    this.starting = null;
    this.seq = 0;
    this.pending = new Map();
    this.buffer = '';
    this.lastError = null;
  }

  get name() {
    return 'powershell';
  }

  /** Idempotent : plusieurs appels partagent la même promesse. */
  start() {
    if (this.ready) return Promise.resolve(true);
    if (this.starting) return this.starting;

    this.starting = new Promise((resolve, reject) => {
      let settled = false;
      const finish = (ok, err) => {
        if (settled) return;
        settled = true;
        this.starting = null;
        if (ok) resolve(true);
        else reject(err);
      };

      try {
        this.child = spawn(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.scriptPath],
          { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
        );
      } catch (err) {
        finish(false, new Error('impossible de lancer PowerShell : ' + err.message));
        return;
      }

      this.child.stdout.setEncoding('utf8');
      this.child.stdout.on('data', (chunk) => {
        this.buffer += chunk;
        let index;
        while ((index = this.buffer.indexOf('\n')) >= 0) {
          const line = this.buffer.slice(0, index).replace(/\r$/, '');
          this.buffer = this.buffer.slice(index + 1);
          if (!line) continue;

          const [id, status, info = ''] = line.split('|');
          if (id === '0' && status === 'READY') {
            this.ready = true;
            finish(true);
            continue;
          }
          const waiter = this.pending.get(id);
          if (!waiter) continue;
          this.pending.delete(id);
          clearTimeout(waiter.timer);
          if (status === 'OK') waiter.resolve(info);
          else waiter.reject(new Error(info || "échec de l'injection"));
        }
      });

      this.child.stderr.setEncoding('utf8');
      this.child.stderr.on('data', (d) => {
        this.lastError = String(d).trim();
      });

      this.child.on('error', (err) => {
        this.ready = false;
        finish(false, err);
      });

      this.child.on('close', (code) => {
        this.ready = false;
        this.child = null;
        for (const [, waiter] of this.pending) {
          clearTimeout(waiter.timer);
          waiter.reject(new Error("helper d'injection arrêté"));
        }
        this.pending.clear();
        finish(
          false,
          new Error('helper arrêté au démarrage (code ' + code + ') ' + (this.lastError || ''))
        );
      });

      setTimeout(() => {
        finish(false, new Error("le helper d'injection n'a pas répondu à temps"));
      }, 20000);
    });

    return this.starting;
  }

  _send(cmd, payload = '', timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      if (!this.child || !this.ready) {
        reject(new Error("helper d'injection indisponible"));
        return;
      }
      const id = String(++this.seq);
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('délai dépassé sur la commande ' + cmd));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(id + '|' + cmd + '|' + payload + '\n');
    });
  }

  ping() {
    return this._send('PING', '', 5000);
  }

  paste() {
    return this._send('PASTE', '', 8000);
  }

  type(text, delayMs, budgetMs) {
    const b64 = Buffer.from(text, 'utf8').toString('base64');
    return this._send('TYPE', delayMs + ':' + b64, Math.max(15000, budgetMs * 2));
  }

  stop() {
    if (!this.child) return;
    try {
      this.child.stdin.write('0|QUIT|\n');
    } catch {
      /* stdin déjà fermé */
    }
    const child = this.child;
    setTimeout(() => {
      if (child && !child.killed) child.kill();
    }, 1000);
    this.child = null;
    this.ready = false;
  }

  status() {
    return { ready: this.ready, backend: this.name, lastError: this.lastError };
  }
}

/* ------------------------------------------------------------------ *
 * Commun aux systèmes qui lancent un outil par frappe
 * ------------------------------------------------------------------ */

function run(cmd, args, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 65536 }, (err, _out, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim() || cmd + ' a échoué'));
      else resolve('');
    });
  });
}

function exists(cmd) {
  return new Promise((resolve) => {
    execFile('which', [cmd], { timeout: 3000 }, (err, out) => resolve(!err && Boolean(out.trim())));
  });
}

/* ------------------------------------------------------------------ *
 * macOS — osascript
 * ------------------------------------------------------------------ */

class MacKeystroke {
  constructor() {
    this.ready = false;
    this.lastError = null;
  }

  get name() {
    return 'osascript';
  }

  async start() {
    // Rien à préparer. La seule vraie condition est l'autorisation
    // d'accessibilité, qui ne se vérifie qu'en essayant : le premier envoi
    // déclenche la demande système, et échoue tant qu'elle n'est pas accordée.
    this.ready = true;
    return true;
  }

  async ping() {
    await run('osascript', ['-e', 'return "ok"'], 5000);
    return 'ok';
  }

  _script(corps) {
    return ['-e', 'on run argv', '-e', 'tell application "System Events" to ' + corps, '-e', 'end run'];
  }

  async paste() {
    try {
      await run('osascript', this._script('keystroke "v" using command down'), 8000);
    } catch (err) {
      throw this._traduire(err);
    }
  }

  /**
   * Le texte passe en argument et non dans le script : c'est ce qui évite
   * d'avoir à échapper les guillemets, les antislashs et les sauts de ligne
   * dans un langage qui n'a pas de littéral brut.
   */
  async type(text) {
    try {
      await run('osascript', [...this._script('keystroke (item 1 of argv)'), text], 20000);
    } catch (err) {
      throw this._traduire(err);
    }
  }

  _traduire(err) {
    const msg = String(err.message || '');
    if (/not allowed|assistive|1002|accessibility/i.test(msg)) {
      this.lastError = 'accessibilité refusée';
      return new Error(
        "macOS refuse l'envoi de frappes : autorisez Feather dans Réglages Système → " +
          'Confidentialité et sécurité → Accessibilité, puis relancez.'
      );
    }
    this.lastError = msg;
    return err;
  }

  stop() {}

  status() {
    return { ready: this.ready, backend: this.name, lastError: this.lastError };
  }
}

/* ------------------------------------------------------------------ *
 * Linux — xdotool (X11), wtype ou ydotool (Wayland)
 * ------------------------------------------------------------------ */

const OUTILS_LINUX = [
  {
    nom: 'xdotool',
    wayland: false,
    paste: ['key', '--clearmodifiers', 'ctrl+v'],
    type: (texte, delai) => ['type', '--clearmodifiers', '--delay', String(delai), '--', texte]
  },
  {
    nom: 'wtype',
    wayland: true,
    paste: ['-M', 'ctrl', '-k', 'v', '-m', 'ctrl'],
    type: (texte) => ['--', texte]
  },
  {
    nom: 'ydotool',
    wayland: true,
    paste: ['key', '29:1', '47:1', '47:0', '29:0'], // ctrl down, v down, v up, ctrl up
    type: (texte) => ['type', '--', texte]
  }
];

class LinuxKeystroke {
  constructor() {
    this.outil = null;
    this.ready = false;
    this.lastError = null;
  }

  get name() {
    return this.outil ? this.outil.nom : 'aucun';
  }

  /**
   * Choisit l'outil disponible. Sous X11 xdotool passe d'abord : c'est le plus
   * répandu et le seul qui sache viser la fenêtre active sans démon. Sous
   * Wayland il ne peut rien faire, on ne le propose donc pas.
   */
  async start() {
    if (this.ready) return true;
    const wayland = isWayland();
    const candidats = OUTILS_LINUX.filter((o) => (wayland ? o.wayland : !o.wayland));
    for (const outil of candidats) {
      if (await exists(outil.nom)) {
        this.outil = outil;
        this.ready = true;
        return true;
      }
    }
    const noms = candidats.map((o) => o.nom).join(' ou ');
    this.lastError = 'aucun outil de frappe';
    throw new Error(
      'aucun outil de frappe clavier trouvé. Installez ' + noms + ' (paquet du même nom).'
    );
  }

  async ping() {
    await this.start();
    return this.outil.nom;
  }

  async paste() {
    await this.start();
    await run(this.outil.nom, this.outil.paste, 8000);
  }

  async type(text, delayMs, budgetMs) {
    await this.start();
    await run(this.outil.nom, this.outil.type(text, delayMs), Math.max(15000, budgetMs * 2));
  }

  stop() {}

  status() {
    return { ready: this.ready, backend: this.name, lastError: this.lastError };
  }
}

/** @param {{scriptPath?:string}} options */
function createKeystroke(options = {}) {
  if (IS_WIN) return new WindowsKeystroke(options);
  if (IS_MAC) return new MacKeystroke();
  return new LinuxKeystroke();
}

module.exports = { createKeystroke, WindowsKeystroke, MacKeystroke, LinuxKeystroke };
