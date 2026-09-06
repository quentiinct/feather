'use strict';

const fs = require('fs');
const path = require('path');

/** Vitesse de frappe de référence (mots/minute) pour estimer le temps gagné. */
const TYPING_WPM = 40;

const todayKey = (d = new Date()) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

function countWords(text) {
  if (!text) return 0;
  const matches = text.trim().match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu);
  return matches ? matches.length : 0;
}

const emptyDay = () => ({ words: 0, chars: 0, sessions: 0, audioSec: 0, activeSec: 0 });

class StatsStore {
  constructor(userDataPath) {
    this.file = path.join(userDataPath, 'stats.json');
    this.historyFile = path.join(userDataPath, 'history.json');
    this.data = this._defaults();
    this.history = [];
    this._writeTimer = null;
    this.load();
  }

  _defaults() {
    return {
      version: 1,
      createdAt: new Date().toISOString(),
      totals: { words: 0, chars: 0, sessions: 0, audioSec: 0, activeSec: 0 },
      daily: {},
      records: { bestDayWords: 0, bestDayKey: null, longestSessionSec: 0 },
      lastSessionAt: null
    };
  }

  load() {
    try {
      this.data = { ...this._defaults(), ...JSON.parse(fs.readFileSync(this.file, 'utf8')) };
    } catch {
      this.data = this._defaults();
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(this.historyFile, 'utf8'));
      this.history = Array.isArray(parsed) ? parsed : [];
    } catch {
      this.history = [];
    }
  }

  /**
   * Enregistre une dictée terminée.
   * @param {{text:string, audioSec:number, processingSec:number, model:string,
   *          language:string, cleanupMode:string, keepHistory:boolean, maxEntries:number}} session
   */
  record(session) {
    const words = countWords(session.text);
    const chars = (session.text || '').length;
    const audioSec = Number(session.audioSec) || 0;
    const activeSec = audioSec + (Number(session.processingSec) || 0);
    const key = todayKey();

    const day = this.data.daily[key] || emptyDay();
    day.words += words;
    day.chars += chars;
    day.sessions += 1;
    day.audioSec += audioSec;
    day.activeSec += activeSec;
    this.data.daily[key] = day;

    const t = this.data.totals;
    t.words += words;
    t.chars += chars;
    t.sessions += 1;
    t.audioSec += audioSec;
    t.activeSec += activeSec;

    if (day.words > this.data.records.bestDayWords) {
      this.data.records.bestDayWords = day.words;
      this.data.records.bestDayKey = key;
    }
    if (audioSec > this.data.records.longestSessionSec) {
      this.data.records.longestSessionSec = audioSec;
    }
    this.data.lastSessionAt = new Date().toISOString();

    this._pruneDaily();

    if (session.keepHistory) {
      this.history.unshift({
        at: new Date().toISOString(),
        text: session.text,
        words,
        audioSec: Math.round(audioSec * 10) / 10,
        processingSec: Math.round((session.processingSec || 0) * 100) / 100,
        model: session.model,
        language: session.language,
        cleanupMode: session.cleanupMode
      });
      const max = Math.max(0, session.maxEntries ?? 200);
      if (this.history.length > max) this.history.length = max;
    }

    this.persist();
    return { words, chars };
  }

  /** Ne conserve que 400 jours d'historique quotidien. */
  _pruneDaily() {
    const keys = Object.keys(this.data.daily).sort();
    if (keys.length <= 400) return;
    for (const k of keys.slice(0, keys.length - 400)) delete this.data.daily[k];
  }

  /** Série de jours consécutifs (jusqu'à aujourd'hui ou hier) avec au moins une dictée. */
  streak() {
    let count = 0;
    const cursor = new Date();
    if (!this.data.daily[todayKey(cursor)]) cursor.setDate(cursor.getDate() - 1);
    while (this.data.daily[todayKey(cursor)]) {
      count += 1;
      cursor.setDate(cursor.getDate() - 1);
    }
    return count;
  }

  /** Agrégat prêt pour l'affichage. */
  summary(days = 30) {
    const series = [];
    const cursor = new Date();
    cursor.setDate(cursor.getDate() - (days - 1));
    for (let i = 0; i < days; i += 1) {
      const key = todayKey(cursor);
      series.push({ date: key, ...(this.data.daily[key] || emptyDay()) });
      cursor.setDate(cursor.getDate() + 1);
    }

    const t = this.data.totals;
    const today = this.data.daily[todayKey()] || emptyDay();
    const week = series.slice(-7).reduce((a, d) => a + d.words, 0);
    // Temps gagné = temps qu'aurait pris la frappe manuelle - temps réellement passé
    const typingSec = (t.words / TYPING_WPM) * 60;
    const savedSec = Math.max(0, typingSec - t.activeSec);

    return {
      totals: t,
      today,
      week,
      series,
      records: this.data.records,
      streak: this.streak(),
      avgWordsPerSession: t.sessions ? Math.round(t.words / t.sessions) : 0,
      // Débit de parole réel
      wpm: t.audioSec > 0 ? Math.round(t.words / (t.audioSec / 60)) : 0,
      savedSec: Math.round(savedSec),
      lastSessionAt: this.data.lastSessionAt
    };
  }

  getHistory(limit = 50) {
    return this.history.slice(0, limit);
  }

  clearHistory() {
    this.history = [];
    this.persistNow();
  }

  resetAll() {
    this.data = this._defaults();
    this.history = [];
    this.persistNow();
  }

  persist() {
    clearTimeout(this._writeTimer);
    this._writeTimer = setTimeout(() => this.persistNow(), 400);
  }

  persistNow() {
    clearTimeout(this._writeTimer);
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data), 'utf8');
      fs.writeFileSync(this.historyFile, JSON.stringify(this.history), 'utf8');
    } catch (err) {
      console.error('[stats] échec de l\'écriture :', err.message);
    }
  }
}

module.exports = { StatsStore, countWords, TYPING_WPM };
