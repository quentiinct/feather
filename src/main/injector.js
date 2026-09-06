'use strict';

const path = require('path');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

/**
 * Injecte le texte transcrit dans l'application qui a le focus.
 *
 * Deux stratégies :
 *  - `paste` : on place le texte dans le presse-papiers et on envoie Ctrl+V.
 *    Instantané quelle que soit la longueur, mais touche au presse-papiers
 *    (on le restaure juste après).
 *  - `type`  : frappe Unicode caractère par caractère. Ne touche à rien, marche
 *    dans les champs qui refusent le collage, mais plus lent sur un long texte.
 *
 * Le helper PowerShell est démarré une fois et gardé en vie : compiler le code
 * Win32 coûte ~1 s, on ne veut pas le payer à chaque dictée.
 */
class Injector extends EventEmitter {
  /**
   * @param {{scriptPath:string, clipboard?:object}} options
   */
  constructor(options) {
    super();
    this.scriptPath = options.scriptPath;
    this._clipboard = options.clipboard || null;
    this._clipboardItem = options.clipboardItem;
    this.child = null;
    this.ready = false;
    this.starting = null;
    this.seq = 0;
    this.pending = new Map();
    this.buffer = '';
    this.lastError = null;
  }

  /**
   * Le presse-papiers d'Electron suit désormais l'API asynchrone du web :
   * `readText()` et `writeText()` renvoient des promesses, et l'écriture de
   * formats multiples passe par `ClipboardItem`, exporté par le module et non
   * disponible en global. Tout est chargé paresseusement pour que la classe
   * reste testable en dehors d'Electron.
   */
  get clipboard() {
    if (!this._clipboard) {
      this._clipboard = require('electron').clipboard;
    }
    return this._clipboard;
  }

  get ClipboardItem() {
    if (this._clipboardItem === undefined) {
      try {
        this._clipboardItem = require('electron').ClipboardItem || null;
      } catch {
        this._clipboardItem = null;
      }
    }
    return this._clipboardItem;
  }

  /** Mémorise le contenu courant pour pouvoir le remettre après le collage. */
  async _snapshotClipboard() {
    const snapshot = { text: '', html: null };
    try {
      snapshot.text = (await this.clipboard.readText()) || '';
    } catch {
      /* presse-papiers verrouillé par une autre application */
    }
    try {
      if (typeof this.clipboard.has === 'function' && (await this.clipboard.has('text/html'))) {
        const items = await this.clipboard.read();
        for (const item of items || []) {
          if (item?.types?.includes('text/html')) {
            snapshot.html = await (await item.getType('text/html')).text();
            break;
          }
        }
      }
    } catch {
      // Le texte seul sera restauré : mieux vaut ça que d'échouer la dictée
    }
    return snapshot;
  }

  async _restoreClipboard(snapshot) {
    const Item = this.ClipboardItem;
    try {
      if (snapshot.html && Item) {
        await this.clipboard.write([
          new Item({
            'text/plain': new Blob([snapshot.text], { type: 'text/plain' }),
            'text/html': new Blob([snapshot.html], { type: 'text/html' })
          })
        ]);
      } else if (snapshot.text) {
        await this.clipboard.writeText(snapshot.text);
      } else {
        await this.clipboard.clear();
      }
    } catch {
      /* rien à faire : on ne va pas casser la dictée pour une restauration */
    }
  }

  /** Démarre le helper. Idempotent : plusieurs appels partagent la même promesse. */
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
        finish(false, new Error("impossible de lancer PowerShell : " + err.message));
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
            this.emit('ready');
            finish(true);
            continue;
          }
          const waiter = this.pending.get(id);
          if (!waiter) continue;
          this.pending.delete(id);
          clearTimeout(waiter.timer);
          if (status === 'OK') waiter.resolve(info);
          else waiter.reject(new Error(info || 'échec de l\'injection'));
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
          waiter.reject(new Error('helper d\'injection arrêté'));
        }
        this.pending.clear();
        this.emit('closed', code);
        finish(false, new Error('helper arrêté au démarrage (code ' + code + ') ' + (this.lastError || '')));
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

  async ping() {
    await this.start();
    return this._send('PING', '', 5000);
  }

  /**
   * Écrit le texte dans l'application active.
   * @param {string} text
   * @param {{mode?:string, restoreClipboard?:boolean, typeDelayMs?:number,
   *          appendSpace?:boolean, fallbackToClipboard?:boolean}} options
   */
  async insert(text, options = {}) {
    const payload = options.appendSpace ? text + ' ' : text;
    if (!payload) return { method: 'aucun', chars: 0 };

    try {
      await this.start();
    } catch (err) {
      if (options.fallbackToClipboard !== false) {
        await this.clipboard.writeText(payload);
        return { method: 'presse-papiers', chars: payload.length, degraded: true, reason: err.message };
      }
      throw err;
    }

    if (options.mode === 'type') {
      const delay = Math.max(0, Math.min(50, options.typeDelayMs ?? 1));
      // Un long texte tapé caractère par caractère serait interminable : on colle
      const budgetMs = payload.length * (delay + 2);
      if (budgetMs < 4000) {
        const b64 = Buffer.from(payload, 'utf8').toString('base64');
        await this._send('TYPE', delay + ':' + b64, Math.max(15000, budgetMs * 2));
        return { method: 'frappe', chars: payload.length };
      }
    }

    return this._paste(payload, options);
  }

  async _paste(payload, options) {
    const restoring = options.restoreClipboard !== false;
    const snapshot = restoring ? await this._snapshotClipboard() : null;

    // L'écriture est asynchrone : il faut l'attendre, sinon le Ctrl+V part
    // avant que le texte soit réellement dans le presse-papiers.
    await this.clipboard.writeText(payload);
    // Laisse le temps aux applications qui écoutent le presse-papiers de suivre
    await new Promise((r) => setTimeout(r, 30));

    try {
      await this._send('PASTE', '', 8000);
    } catch (err) {
      if (options.fallbackToClipboard !== false) {
        // On laisse volontairement le texte dans le presse-papiers : l'utilisateur
        // le collera lui-même. Le restaurer ici lui reprendrait sa dictée.
        return { method: 'presse-papiers', chars: payload.length, degraded: true, reason: err.message };
      }
      if (restoring) await this._restoreClipboard(snapshot);
      throw err;
    }

    if (restoring) {
      // L'application cible doit avoir fini de lire le presse-papiers avant
      // qu'on le remette dans son état d'origine.
      setTimeout(() => {
        this._restoreClipboard(snapshot).catch(() => {});
      }, 250);
    }

    return { method: 'collage', chars: payload.length };
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
    return { ready: this.ready, lastError: this.lastError };
  }
}

module.exports = { Injector };
