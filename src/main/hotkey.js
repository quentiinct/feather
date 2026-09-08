'use strict';

const { EventEmitter } = require('events');
const { metaKeyLabel } = require('./platform');

/**
 * Détection du raccourci global.
 *
 * Le raccourci est une combinaison de modificateurs seuls (Ctrl+Shift, Ctrl+Alt...).
 * Electron ne sait pas enregistrer ça, on passe donc par un hook clavier bas niveau.
 *
 * Il doit cohabiter avec les vrais raccourcis du système
 * (Ctrl+Shift+T, Ctrl+Shift+Échap...). La stratégie : dès que la combinaison est
 * complète on « arme » la capture (le micro démarre, sans rien afficher) ; si une
 * touche non-modificatrice arrive dans la foulée, c'était un raccourci de
 * l'utilisateur et on annule silencieusement. Sinon, passé le délai d'armement,
 * la dictée démarre pour de bon.
 *
 * Événements émis :
 *   'arm'    → démarrer la capture audio en silence
 *   'start'  → la dictée est confirmée (afficher l'overlay)
 *   'stop'   → terminer et transcrire
 *   'cancel' → abandonner, ne rien transcrire
 *   'error'  → le hook bas niveau est indisponible
 */
class HotkeyManager extends EventEmitter {
  constructor() {
    super();
    this.config = null;
    this.enabled = false;
    this.recording = false;

    this.hook = null;
    this.keys = null;
    this.hookRunning = false;

    this.held = new Set();
    this.comboComplete = false;
    this.polluted = false;
    this.pressStartedAt = 0;
    this.armTimer = null;
    this.armed = false;
    this.startedByCurrentPress = false;

    /** Délai avant de confirmer la dictée, pour laisser passer les vrais raccourcis. */
    this.armDelayMs = 160;
  }

  /** Charge uiohook-napi de façon défensive : son absence ne doit pas tuer l'app. */
  _loadHook() {
    if (this.hook) return true;
    try {
      const mod = require('uiohook-napi');
      this.hook = mod.uIOhook;
      this.keys = mod.UiohookKey;
      return true;
    } catch (err) {
      this.emit('error', new Error("hook clavier indisponible : " + err.message));
      return false;
    }
  }

  /** Associe un keycode uiohook à un nom de modificateur, gauche et droite confondues. */
  _modifierName(keycode) {
    const K = this.keys;
    if (!K) return null;
    if (keycode === K.Ctrl || keycode === K.CtrlRight) return 'ctrl';
    if (keycode === K.Shift || keycode === K.ShiftRight) return 'shift';
    if (keycode === K.Alt || keycode === K.AltRight) return 'alt';
    if (keycode === K.Meta || keycode === K.MetaRight) return 'meta';
    return null;
  }

  _required() {
    const list = this.config?.modifiers || [];
    return new Set(list.map((m) => String(m).toLowerCase()));
  }

  /** La combinaison est complète si les modificateurs tenus correspondent exactement. */
  _isComplete() {
    const required = this._required();
    if (required.size === 0) return false;
    if (this.held.size !== required.size) return false;
    for (const m of required) if (!this.held.has(m)) return false;
    return true;
  }

  start(config) {
    this.config = config;
    this.stop();

    this._startModifiers();
    this.enabled = true;
  }

  _startModifiers() {
    if (!this._loadHook()) return;

    this._onKeyDown = (event) => this._handleKeyDown(event);
    this._onKeyUp = (event) => this._handleKeyUp(event);
    this.hook.on('keydown', this._onKeyDown);
    this.hook.on('keyup', this._onKeyUp);

    try {
      this.hook.start();
      this.hookRunning = true;
    } catch (err) {
      this.emit('error', new Error("impossible de démarrer le hook clavier : " + err.message));
    }
  }

  _handleKeyDown(event) {
    const mod = this._modifierName(event.keycode);

    if (mod) {
      this.held.add(mod);
      if (!this.comboComplete && this._isComplete()) this._onComboComplete();
      return;
    }

    // Touche normale : annule l'échappement ou marque la combinaison comme « polluée »
    if (this.keys && event.keycode === this.keys.Escape && this.recording) {
      this._emitCancel();
      return;
    }
    if (this.comboComplete) this.polluted = true;
  }

  _handleKeyUp(event) {
    const mod = this._modifierName(event.keycode);
    if (!mod) return;

    this.held.delete(mod);
    if (this.comboComplete && !this._isComplete()) this._onComboBroken();
  }

  _onComboComplete() {
    this.comboComplete = true;
    this.polluted = false;
    this.pressStartedAt = Date.now();
    this.startedByCurrentPress = false;

    if (this.recording) return; // une dictée est déjà en cours : la relâche décidera

    this.armed = true;
    this.emit('arm');
    clearTimeout(this.armTimer);
    this.armTimer = setTimeout(() => {
      this.armTimer = null;
      if (!this.armed || this.polluted) return;
      this.startedByCurrentPress = true;
      this._emitStart();
    }, this.armDelayMs);
  }

  _onComboBroken() {
    const heldMs = Date.now() - this.pressStartedAt;
    const wasPolluted = this.polluted;
    this.comboComplete = false;
    this.polluted = false;

    // Relâché avant la fin de l'armement, ou combinaison utilisée comme raccourci
    if (this.armTimer || wasPolluted) {
      clearTimeout(this.armTimer);
      this.armTimer = null;
      const wasArmed = this.armed;
      this.armed = false;
      if (wasArmed && !this.recording) this.emit('cancel', { silent: true });
      return;
    }
    this.armed = false;

    if (!this.recording) return;

    const threshold = this.config?.holdThresholdMs ?? 350;
    const activation = this.config?.activation || 'toggle';

    if (activation === 'hold') {
      this._emitStop();
      return;
    }

    // Mode « toggle » hybride : appui bref = bascule, appui maintenu = talkie-walkie
    if (this.startedByCurrentPress && heldMs >= threshold) {
      this._emitStop();
      return;
    }
    if (!this.startedByCurrentPress) {
      this._emitStop();
    }
    // Appui bref ayant démarré la dictée : on laisse tourner jusqu'au prochain appui
  }

  _emitStart() {
    this.recording = true;
    this.emit('start');
  }

  _emitStop() {
    if (!this.recording) return;
    this.recording = false;
    this.armed = false;
    this.emit('stop');
  }

  _emitCancel(payload = {}) {
    const wasRecording = this.recording;
    this.recording = false;
    this.armed = false;
    clearTimeout(this.armTimer);
    this.armTimer = null;
    if (wasRecording || payload.silent) this.emit('cancel', payload);
  }

  /** Permet au reste de l'app (clic sur l'overlay, menu du tray) de piloter l'état. */
  notifyStopped() {
    this.recording = false;
    this.armed = false;
  }

  notifyStarted() {
    this.recording = true;
  }

  stop() {
    clearTimeout(this.armTimer);
    this.armTimer = null;
    this.held.clear();
    this.comboComplete = false;
    this.polluted = false;
    this.armed = false;
    this.enabled = false;

    if (this.hook && this._onKeyDown) {
      try {
        this.hook.off('keydown', this._onKeyDown);
        this.hook.off('keyup', this._onKeyUp);
      } catch {
        /* le hook n'était pas branché */
      }
    }
    if (this.hookRunning) {
      try {
        this.hook.stop();
      } catch {
        /* déjà arrêté */
      }
      this.hookRunning = false;
    }
  }

  /** Libellé lisible du raccourci courant, pour l'interface et le tray. */
  describe() {
    if (!this.config) return '—';
    const labels = { ctrl: 'Ctrl', shift: 'Maj', alt: 'Alt', meta: metaKeyLabel() };
    return (this.config.modifiers || []).map((m) => labels[m] || m).join(' + ');
  }
}

module.exports = { HotkeyManager };
