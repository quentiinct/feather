'use strict';

const { app, Notification } = require('electron');

/**
 * Mises à jour automatiques via electron-updater, adossées aux releases GitHub
 * du dépôt (voir `build.publish` dans package.json).
 *
 * Deux contraintes dictent la forme de ce module :
 *
 *  - Feather tourne le plus souvent fenêtre fermée. Une bannière dans les
 *    réglages ne serait jamais vue, d'où la notification Windows.
 *  - Rien ne s'installe pendant qu'on dicte : le paquet est téléchargé en
 *    arrière-plan et posé au moment où l'application se ferme.
 *
 * En développement (`app.isPackaged` faux) tout est court-circuité : il n'y a
 * pas de version installée à remplacer.
 */

/** Intervalle entre deux vérifications pour une application qui reste ouverte. */
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

let updater = null;
let state = { status: 'inconnu', version: null, error: null };

function toast(title, body) {
  if (!Notification.isSupported()) return;
  // L'AppUserModelID est déjà posé au démarrage : sans lui, Windows refuse
  // d'afficher les notifications d'une application non installée.
  new Notification({ title, body, silent: true }).show();
}

/**
 * @param {{log:Function, onState:Function}} hooks
 * @returns {{check:Function, state:Function}|null}
 */
function setupUpdater({ log, onState }) {
  const publish = (next) => {
    state = { ...state, ...next };
    onState?.(state);
  };

  if (!app.isPackaged) {
    publish({ status: 'développement' });
    log('mises à jour : désactivées hors installation');
    return { check: async () => state, state: () => state };
  }

  try {
    ({ autoUpdater: updater } = require('electron-updater'));
  } catch (err) {
    publish({ status: 'indisponible', error: err.message });
    log('mises à jour : module absent (' + err.message + ')');
    return null;
  }

  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;
  updater.logger = null;

  updater.on('checking-for-update', () => publish({ status: 'vérification', error: null }));
  updater.on('update-not-available', () => publish({ status: 'à jour', version: null }));
  updater.on('update-available', (info) => {
    publish({ status: 'téléchargement', version: info.version });
    log('mise à jour ' + info.version + ' disponible, téléchargement…');
  });
  updater.on('update-downloaded', (info) => {
    publish({ status: 'prête', version: info.version });
    log('mise à jour ' + info.version + ' prête');
    toast('Feather ' + info.version + ' est prête', 'Elle sera installée à la fermeture de Feather.');
  });
  updater.on('error', (err) => {
    // Une release absente ou un dépôt privé donnent une 404 : ce n'est pas une
    // panne, juste rien à installer. On le note sans importuner l'utilisateur.
    publish({ status: 'échec', error: err?.message || String(err) });
    log('mises à jour :', err?.message || err);
  });

  const check = async () => {
    try {
      await updater.checkForUpdates();
    } catch (err) {
      publish({ status: 'échec', error: err?.message || String(err) });
    }
    return state;
  };

  // Au démarrage, puis périodiquement pour les sessions qui durent des jours.
  setTimeout(check, 8000).unref?.();
  setInterval(check, CHECK_EVERY_MS).unref?.();

  return { check, state: () => state };
}

module.exports = { setupUpdater };
