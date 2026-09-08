'use strict';

const { EventEmitter } = require('events');
const { createKeystroke } = require('./keystroke');

/**
 * Injecte le texte transcrit dans l'application qui a le focus.
 *
 * Deux stratégies :
 *  - `paste` : on place le texte dans le presse-papiers et on envoie Ctrl+V
 *    (Cmd+V sur macOS). Instantané quelle que soit la longueur, mais touche au
 *    presse-papiers — on le restaure juste après.
 *  - `type`  : frappe caractère par caractère. Ne touche à rien, marche dans
 *    les champs qui refusent le collage, mais plus lent sur un long texte.
 *
 * Le presse-papiers vient d'Electron et marche partout à l'identique. Ce qui
 * change d'un système à l'autre — envoyer une frappe à la fenêtre d'à côté —
 * est isolé dans keystroke.js.
 */
class Injector extends EventEmitter {
  /**
   * @param {{scriptPath?:string, clipboard?:object, keystroke?:object}} options
   */
  constructor(options = {}) {
    super();
    this._clipboard = options.clipboard || null;
    this._clipboardItem = options.clipboardItem;
    this.keys = options.keystroke || createKeystroke({ scriptPath: options.scriptPath });
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

  async start() {
    const ok = await this.keys.start();
    this.emit('ready');
    return ok;
  }

  async ping() {
    await this.start();
    return this.keys.ping();
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
        return {
          method: 'presse-papiers',
          chars: payload.length,
          degraded: true,
          reason: err.message
        };
      }
      throw err;
    }

    if (options.mode === 'type') {
      const delay = Math.max(0, Math.min(50, options.typeDelayMs ?? 1));
      // Un long texte tapé caractère par caractère serait interminable : on colle
      const budgetMs = payload.length * (delay + 2);
      if (budgetMs < 4000) {
        try {
          await this.keys.type(payload, delay, budgetMs);
          return { method: 'frappe', chars: payload.length };
        } catch (err) {
          // La frappe a échoué, mais le collage passera peut-être : on continue
          this.emit('degraded', err);
        }
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
      await this.keys.paste();
    } catch (err) {
      if (options.fallbackToClipboard !== false) {
        // On laisse volontairement le texte dans le presse-papiers : l'utilisateur
        // le collera lui-même. Le restaurer ici lui reprendrait sa dictée.
        return {
          method: 'presse-papiers',
          chars: payload.length,
          degraded: true,
          reason: err.message
        };
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
    this.keys.stop();
  }

  status() {
    return this.keys.status();
  }
}

module.exports = { Injector };
