'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { DEFAULT_CONFIG } = require('../shared/defaults');

const isPlainObject = (v) =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/** Fusion récursive : les tableaux sont remplacés, pas concaténés. */
function deepMerge(base, override) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  if (!isPlainObject(override)) return out;
  for (const [key, value] of Object.entries(override)) {
    if (isPlainObject(value) && isPlainObject(out[key])) {
      out[key] = deepMerge(out[key], value);
    } else if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

class ConfigStore extends EventEmitter {
  constructor(userDataPath) {
    super();
    this.file = path.join(userDataPath, 'config.json');
    this.data = deepMerge(DEFAULT_CONFIG, {});
    this._writeTimer = null;
    this.load();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      this.data = deepMerge(DEFAULT_CONFIG, JSON.parse(raw));
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.error('[config] fichier illisible, retour aux défauts :', err.message);
        this._backupCorrupted();
      }
      this.data = deepMerge(DEFAULT_CONFIG, {});
      this.persist();
    }
    return this.data;
  }

  _backupCorrupted() {
    try {
      fs.renameSync(this.file, `${this.file}.corrupt-${Date.now()}`);
    } catch {
      /* rien à faire */
    }
  }

  get all() {
    return this.data;
  }

  /** Lecture par chemin pointé : get('whisper.model') */
  get(pathStr, fallback) {
    const value = pathStr
      .split('.')
      .reduce((acc, key) => (acc == null ? undefined : acc[key]), this.data);
    return value === undefined ? fallback : value;
  }

  /** Applique un patch partiel et notifie les abonnés. */
  update(patch) {
    const previous = this.data;
    this.data = deepMerge(this.data, patch);
    this.persist();
    this.emit('changed', this.data, previous, patch);
    return this.data;
  }

  reset() {
    this.data = deepMerge(DEFAULT_CONFIG, {});
    this.persist();
    this.emit('changed', this.data, null, this.data);
    return this.data;
  }

  /** Écriture différée pour éviter d'écrire à chaque frappe dans les réglages. */
  persist() {
    clearTimeout(this._writeTimer);
    this._writeTimer = setTimeout(() => this.persistNow(), 150);
  }

  persistNow() {
    clearTimeout(this._writeTimer);
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error('[config] échec de l\'écriture :', err.message);
    }
  }
}

module.exports = { ConfigStore, deepMerge };
