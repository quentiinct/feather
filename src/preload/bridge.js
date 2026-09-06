'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * Pont IPC. `contextIsolation` est actif et `nodeIntegration` désactivé : les
 * fenêtres n'ont accès qu'aux canaux listés ici, rien d'autre.
 */

/** Canaux appelables par le rendu et attendant une réponse du principal. */
const INVOKE_CHANNELS = new Set([
  'config:get',
  'config:update',
  'config:reset',
  'stats:summary',
  'stats:history',
  'stats:clearHistory',
  'stats:reset',
  'engine:status',
  'engine:models',
  'engine:downloadModel',
  'engine:cancelDownload',
  'engine:deleteModel',
  'engine:installBinaries',
  'engine:testInjection',
  'ollama:probe',
  'cleanup:preview',
  'dictation:toggle',
  'dictation:cancel',
  'audio:devices',
  'audio:reinit',
  'app:info',
  'app:openPath',
  'app:openExternal',
  'app:setLaunchAtLogin',
  'window:minimize',
  'window:close',
  'window:quit'
]);

/** Messages envoyés par le rendu sans attendre de réponse. */
const SEND_CHANNELS = new Set([
  'capture:booted',
  'capture:ready',
  'capture:started',
  'capture:result',
  'capture:cancelled',
  'capture:discarded',
  'capture:error',
  'capture:level',
  'capture:devicechange',
  'overlay:click',
  'overlay:resize'
]);

/** Messages poussés par le principal vers le rendu. */
const RECEIVE_CHANNELS = new Set([
  'capture:start',
  'capture:stop',
  'capture:cancel',
  'capture:reinit',
  'state',
  'level',
  'config:changed',
  'stats:changed',
  'toast',
  'download:progress',
  'transcript'
]);

const listeners = new Map();
const handlers = new Map();

/**
 * Le principal ne peut pas « invoke » vers le rendu : on implémente une
 * requête/réponse minimale au-dessus des messages simples.
 */
ipcRenderer.on('rpc:request', async (_event, payload) => {
  const { id, channel, args } = payload || {};
  const handler = handlers.get(channel);
  if (!handler) {
    ipcRenderer.send('rpc:response', { id, error: 'aucun gestionnaire pour ' + channel });
    return;
  }
  try {
    const result = await handler(...(args || []));
    ipcRenderer.send('rpc:response', { id, result });
  } catch (err) {
    ipcRenderer.send('rpc:response', { id, error: err.message });
  }
});

const api = {
  invoke(channel, ...args) {
    if (!INVOKE_CHANNELS.has(channel)) {
      return Promise.reject(new Error('canal non autorisé : ' + channel));
    }
    return ipcRenderer.invoke(channel, ...args);
  },

  send(channel, payload) {
    if (!SEND_CHANNELS.has(channel)) {
      console.warn('[bridge] canal non autorisé :', channel);
      return;
    }
    ipcRenderer.send(channel, payload);
  },

  on(channel, callback) {
    if (!RECEIVE_CHANNELS.has(channel)) {
      console.warn('[bridge] canal non autorisé :', channel);
      return () => {};
    }
    const wrapped = (_event, payload) => callback(payload);
    ipcRenderer.on(channel, wrapped);
    if (!listeners.has(channel)) listeners.set(channel, new Set());
    listeners.get(channel).add(wrapped);
    return () => {
      ipcRenderer.removeListener(channel, wrapped);
      listeners.get(channel)?.delete(wrapped);
    };
  },

  /** Enregistre un gestionnaire interrogeable depuis le processus principal. */
  handle(channel, handler) {
    handlers.set(channel, handler);
  }
};

contextBridge.exposeInMainWorld('feather', api);
