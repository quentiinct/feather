'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  ipcMain,
  nativeImage,
  nativeTheme,
  shell,
  screen,
  session
} = require('electron');

const { ConfigStore } = require('./config');
const { StatsStore, countWords } = require('./stats');
const { WhisperEngine } = require('./whisper');
const { HotkeyManager } = require('./hotkey');
const { Injector } = require('./injector');
const { cleanup } = require('./cleanup');
const { downloadFile, checkGgmlFile } = require('./downloader');
const { setupUpdater } = require('./updater');
const { MODELS, modelUrl, findModel } = require('../shared/models');

const IS_DEV = process.argv.includes('--dev');
const ROOT = path.join(__dirname, '..', '..');

/** En production les binaires sont dépaquetés à côté de l'app, pas dans l'asar. */
const BIN_DIR = app.isPackaged ? path.join(process.resourcesPath, 'bin') : path.join(ROOT, 'resources', 'bin');
const MODELS_DIR = path.join(app.getPath('userData'), 'models');
const BUNDLED_MODELS_DIR = path.join(ROOT, 'resources', 'models');
const TMP_DIR = path.join(os.tmpdir(), 'feather');
const INJECT_SCRIPT = app.isPackaged
  ? path.join(process.resourcesPath, 'app.asar.unpacked', 'resources', 'inject.ps1')
  : path.join(ROOT, 'resources', 'inject.ps1');

fs.mkdirSync(TMP_DIR, { recursive: true });
fs.mkdirSync(MODELS_DIR, { recursive: true });

/* ------------------------------------------------------------------ *
 * État global
 * ------------------------------------------------------------------ */

let config;
let stats;
let whisper;
let hotkey;
let injector;

let settingsWindow = null;
let overlayWindow = null;
let captureWindow = null;
let tray = null;
let updater = null;

/** 'idle' | 'armed' | 'recording' | 'processing' */
let dictationState = 'idle';
let confirmed = false;
let quitting = false;

const rpcPending = new Map();
let rpcSeq = 0;

/* ------------------------------------------------------------------ *
 * Utilitaires
 * ------------------------------------------------------------------ */

const log = (...args) => console.log('[feather]', ...args);

function toSettings(channel, payload) {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.webContents.send(channel, payload);
  }
}

function toOverlay(channel, payload) {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send(channel, payload);
  }
}

function toCapture(channel, payload) {
  if (captureWindow && !captureWindow.isDestroyed()) {
    captureWindow.webContents.send(channel, payload);
  }
}

/** Bip court joué par la fenêtre de capture, seule à pouvoir sortir du son. */
function playCue(kind) {
  if (!config.get('ui.soundFeedback', true)) return;
  toCapture('capture:cue', { kind });
}

function notify(message, kind = 'info') {
  toSettings('toast', { message, kind });
}

/** Interroge un rendu et attend sa réponse (Electron ne propose pas d'invoke inverse). */
function rpc(win, channel, args = [], timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    if (!win || win.isDestroyed()) {
      reject(new Error('fenêtre indisponible'));
      return;
    }
    const id = String(++rpcSeq);
    const timer = setTimeout(() => {
      rpcPending.delete(id);
      reject(new Error('délai dépassé sur ' + channel));
    }, timeoutMs);
    rpcPending.set(id, { resolve, reject, timer });
    win.webContents.send('rpc:request', { id, channel, args });
  });
}

ipcMain.on('rpc:response', (_event, payload) => {
  const waiter = rpcPending.get(payload.id);
  if (!waiter) return;
  rpcPending.delete(payload.id);
  clearTimeout(waiter.timer);
  if (payload.error) waiter.reject(new Error(payload.error));
  else waiter.resolve(payload.result);
});

/* ------------------------------------------------------------------ *
 * Fenêtres
 * ------------------------------------------------------------------ */

const PRELOAD = path.join(__dirname, '..', 'preload', 'bridge.js');

let cachedAppIcon = null;

/** Icône de fenêtre, donc de barre des tâches. Chargée une fois. */
function appIcon() {
  if (cachedAppIcon) return cachedAppIcon;
  // Le .ico embarque toutes les tailles : Windows pioche celle qu'il lui faut
  // selon la mise à l'échelle de l'écran, plutôt que de rééchantillonner.
  for (const name of ['icon.ico', 'icon.png']) {
    const file = path.join(ROOT, 'assets', name);
    if (!fs.existsSync(file)) continue;
    const image = nativeImage.createFromPath(file);
    if (!image.isEmpty()) {
      cachedAppIcon = image;
      return cachedAppIcon;
    }
  }
  return undefined;
}

function createCaptureWindow() {
  captureWindow = new BrowserWindow({
    width: 320,
    height: 200,
    show: false,
    skipTaskbar: true,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // Sans ça, Chromium ralentit la fenêtre cachée et hache l'audio
      backgroundThrottling: false
    }
  });
  captureWindow.loadFile(path.join(__dirname, '..', 'renderer', 'capture', 'capture.html'));
  captureWindow.on('closed', () => {
    captureWindow = null;
  });
}

function overlayBounds() {
  const display = screen.getPrimaryDisplay();
  const area = display.workArea;
  const width = 340;
  const height = 90;
  const position = config.get('ui.overlayPosition', 'bottom-center');

  let x = Math.round(area.x + (area.width - width) / 2);
  let y = Math.round(area.y + area.height - height - 28);

  if (position === 'bottom-right') x = area.x + area.width - width - 20;
  else if (position === 'top-center') y = area.y + 24;
  else if (position === 'top-right') {
    x = area.x + area.width - width - 20;
    y = area.y + 24;
  }
  return { x, y, width, height };
}

function createOverlayWindow() {
  const bounds = overlayBounds();
  overlayWindow = new BrowserWindow({
    ...bounds,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    // Capital : l'overlay ne doit jamais voler le focus, sinon le texte
    // serait collé dans Feather au lieu de l'application de l'utilisateur.
    focusable: false,
    show: false,
    hasShadow: false,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false
    }
  });

  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWindow.loadFile(path.join(__dirname, '..', 'renderer', 'overlay', 'overlay.html'));
  overlayWindow.on('closed', () => {
    overlayWindow = null;
  });
}

function showOverlay() {
  if (!config.get('ui.showOverlay', true)) return;
  if (!overlayWindow || overlayWindow.isDestroyed()) createOverlayWindow();
  overlayWindow.setBounds(overlayBounds());
  overlayWindow.showInactive();
}

function hideOverlay() {
  if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.hide();
}

function createSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }
  settingsWindow = new BrowserWindow({
    width: 940,
    height: 720,
    minWidth: 780,
    minHeight: 560,
    frame: false,
    show: false,
    // Icône de la barre des tâches. En production l'exécutable porte déjà
    // l'icône, mais la fenêtre doit la déclarer pour l'afficher en développement.
    icon: appIcon(),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1a1a19' : '#fcfcfb',
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  // FEATHER_PANEL ouvre directement une section — pratique pour itérer sur une
  // page de réglages sans re-cliquer à chaque relance.
  settingsWindow.loadFile(path.join(__dirname, '..', 'renderer', 'settings', 'index.html'), {
    hash: process.env.FEATHER_PANEL || ''
  });
  settingsWindow.once('ready-to-show', () => settingsWindow.show());

  // Le bouton d'agrandissement n'est pas le seul chemin : double-clic sur la
  // barre de titre, Win+Flèche haut, glissé vers le haut du bureau. L'icône
  // suit l'état réel de la fenêtre, pas la dernière chose cliquée.
  const sendWindowState = () => toSettings('window:state', settingsWindow?.isMaximized() === true);
  settingsWindow.on('maximize', sendWindowState);
  settingsWindow.on('unmaximize', sendWindowState);
  if (IS_DEV) settingsWindow.webContents.openDevTools({ mode: 'detach' });

  // Fermer la fenêtre remet l'app dans la zone de notification, elle ne quitte pas
  settingsWindow.on('close', (event) => {
    if (!quitting) {
      event.preventDefault();
      settingsWindow.hide();
    }
  });
  settingsWindow.on('closed', () => {
    settingsWindow = null;
  });
}

/* ------------------------------------------------------------------ *
 * Zone de notification
 * ------------------------------------------------------------------ */

/**
 * La barre des tâches suit le « mode Windows », réglable indépendamment du mode
 * des applications — `nativeTheme` ne le reflète donc pas. On lit la clé qui
 * fait foi, sinon une icône claire disparaît sur une barre claire.
 */
let lightTaskbar = null;

function readTaskbarTheme() {
  try {
    const out = require('child_process').execFileSync(
      'reg',
      [
        'query',
        'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize',
        '/v',
        'SystemUsesLightTheme'
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }
    );
    const match = out.match(/SystemUsesLightTheme\s+REG_DWORD\s+0x([0-9a-f]+)/i);
    return match ? parseInt(match[1], 16) === 1 : false;
  } catch {
    // Clé absente : Windows utilise alors une barre sombre
    return false;
  }
}

/** Interroger le registre coûte un processus : on le fait une fois, puis à chaque
 *  changement de thème signalé par Electron. */
function taskbarUsesLightTheme() {
  if (lightTaskbar === null) lightTaskbar = readTaskbarTheme();
  return lightTaskbar;
}

function trayImage(active) {
  const tone = active ? 'active' : taskbarUsesLightTheme() ? 'dark' : 'light';
  const file = path.join(ROOT, 'assets', 'tray-' + tone + '.png');
  // Les fichiers sont déjà rendus à 16 px, la taille qu'affiche la zone de
  // notification : les redimensionner ne ferait qu'empâter le trait.
  return fs.existsSync(file) ? nativeImage.createFromPath(file) : nativeImage.createEmpty();
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    {
      label: dictationState === 'idle' ? 'Démarrer une dictée' : 'Arrêter la dictée',
      click: () => toggleDictation()
    },
    { type: 'separator' },
    { label: 'Réglages et statistiques', click: () => createSettingsWindow() },
    {
      label: 'Raccourci : ' + (hotkey ? hotkey.describe() : '—'),
      enabled: false
    },
    { type: 'separator' },
    {
      label: 'Quitter Feather',
      click: () => {
        quitting = true;
        app.quit();
      }
    }
  ]);
}

function createTray() {
  tray = new Tray(trayImage(false));
  tray.setToolTip('Feather — dictée vocale locale');
  tray.setContextMenu(buildTrayMenu());
  tray.on('click', () => createSettingsWindow());
}

function refreshTray() {
  if (!tray) return;
  tray.setContextMenu(buildTrayMenu());
  tray.setImage(trayImage(dictationState === 'recording'));
  tray.setToolTip(
    dictationState === 'recording' ? 'Feather — à l\'écoute' : 'Feather — dictée vocale locale'
  );
}

/* ------------------------------------------------------------------ *
 * Pipeline de dictée
 * ------------------------------------------------------------------ */

function setState(state, payload = {}) {
  dictationState = state;
  refreshTray();

  if (state === 'idle') {
    hideOverlay();
    toOverlay('state', { state: 'idle' });
    return;
  }
  if (state === 'armed') return; // rien d'affiché tant que la dictée n'est pas confirmée

  showOverlay();
  toOverlay('state', { state: state === 'recording' ? 'recording' : state, ...payload });
}

/** Démarre la capture sans rien afficher : la confirmation viendra (ou pas). */
function armDictation() {
  if (dictationState !== 'idle') return;
  dictationState = 'armed';
  confirmed = false;
  toCapture('capture:start', config.all);
}

function confirmDictation() {
  if (dictationState !== 'armed' && dictationState !== 'recording') return;
  confirmed = true;
  // La capture tourne déjà depuis l'armement : le bip ne marque pas le début de
  // l'enregistrement mais celui de la dictée confirmée, sinon chaque Ctrl+Alt+T
  // ferait du bruit.
  playCue('start');
  setState('recording');
}

function stopDictation() {
  if (dictationState !== 'recording' && dictationState !== 'armed') return;
  if (!confirmed) {
    cancelDictation();
    return;
  }
  playCue('stop');
  setState('processing');
  toCapture('capture:stop', config.all);
}

function cancelDictation() {
  toCapture('capture:cancel', {});
  whisper.cancel();
  confirmed = false;
  setState('idle');
  hotkey.notifyStopped();
}

function toggleDictation() {
  if (dictationState === 'idle') {
    hotkey.notifyStarted();
    armDictation();
    confirmDictation();
  } else {
    hotkey.notifyStopped();
    stopDictation();
  }
}

/** Reçoit le WAV du rendu et déroule transcription → nettoyage → insertion. */
async function handleCapture(payload) {
  const wavPath = path.join(TMP_DIR, 'dictee-' + Date.now() + '.wav');
  const started = Date.now();

  try {
    fs.writeFileSync(wavPath, Buffer.from(payload.wav));

    const result = await whisper.transcribe(wavPath, config.get('whisper'));
    if (result.cancelled) {
      setState('idle');
      return;
    }

    const cleaned = await cleanup(result.text, config.get('cleanup'));
    const processingSec = (Date.now() - started) / 1000;

    if (!cleaned) {
      setState('error', { label: 'Rien de compréhensible' });
      setTimeout(() => setState('idle'), 1600);
      return;
    }

    const inserted = await injector.insert(cleaned, config.get('output'));

    stats.record({
      text: cleaned,
      audioSec: payload.durationSec,
      processingSec,
      model: config.get('whisper.model'),
      language: result.language || config.get('whisper.language'),
      cleanupMode: config.get('cleanup.mode'),
      keepHistory: config.get('history.enabled'),
      maxEntries: config.get('history.maxEntries')
    });
    toSettings('stats:changed', {});

    setState('done', { words: countWords(cleaned) });
    setTimeout(() => setState('idle'), 1500);

    if (inserted.degraded) {
      notify('Texte copié dans le presse-papiers (' + inserted.reason + ').', 'error');
    }
    log('dictée :', countWords(cleaned), 'mots en', processingSec.toFixed(2), 's');
  } catch (err) {
    log('échec de la dictée :', err.message);
    setState('error', { label: err.message.slice(0, 60) });
    notify(err.message, 'error');
    setTimeout(() => setState('idle'), 2600);
  } finally {
    if (!config.get('privacy.keepAudioFiles')) {
      try {
        fs.unlinkSync(wavPath);
      } catch {
        /* déjà supprimé */
      }
    }
    confirmed = false;
    hotkey.notifyStopped();
  }
}

/* ------------------------------------------------------------------ *
 * Messages du rendu
 * ------------------------------------------------------------------ */

ipcMain.on('capture:result', (_event, payload) => handleCapture(payload));

ipcMain.on('capture:level', (_event, payload) => {
  toOverlay('level', payload);
  toSettings('level', payload);
});

ipcMain.on('capture:discarded', (_event, payload) => {
  if (payload.reason === 'silence') {
    setState('error', { label: 'Aucun son détecté' });
    setTimeout(() => setState('idle'), 1800);
  } else {
    setState('idle');
  }
  confirmed = false;
  hotkey.notifyStopped();
});

ipcMain.on('capture:cancelled', () => {
  confirmed = false;
  setState('idle');
});

ipcMain.on('capture:error', (_event, payload) => {
  const message =
    payload.code === 'permission'
      ? "L'accès au micro a été refusé. Autorisez-le dans Paramètres Windows > Confidentialité > Microphone."
      : 'Problème de micro : ' + payload.message;
  notify(message, 'error');
  setState('error', { label: 'Micro indisponible' });
  setTimeout(() => setState('idle'), 2600);
  confirmed = false;
  hotkey.notifyStopped();
});

ipcMain.on('capture:devicechange', () => {
  toSettings('toast', { message: 'La liste des micros a changé.', kind: 'info' });
});

ipcMain.on('overlay:click', (_event, payload) => {
  if (payload.action === 'cancel') cancelDictation();
  else {
    hotkey.notifyStopped();
    stopDictation();
  }
});

/* ------------------------------------------------------------------ *
 * Canaux invocables
 * ------------------------------------------------------------------ */

function registerIpcHandlers() {
  ipcMain.handle('config:get', () => config.all);

  ipcMain.handle('config:update', (_event, partial) => {
    const next = config.update(partial);
    return next;
  });

  ipcMain.handle('config:reset', () => {
    const next = config.reset();
    return next;
  });

  ipcMain.handle('stats:summary', (_event, days) => stats.summary(days || 30));
  ipcMain.handle('stats:history', (_event, limit) => stats.getHistory(limit || 50));
  ipcMain.handle('stats:clearHistory', () => {
    stats.clearHistory();
    return true;
  });
  ipcMain.handle('stats:reset', () => {
    stats.resetAll();
    return true;
  });

  ipcMain.handle('engine:status', async () => {
    await whisper.init();
    return whisper.status();
  });

  ipcMain.handle('engine:models', () => MODELS);

  ipcMain.handle('engine:downloadModel', async (_event, modelId) => {
    const model = findModel(modelId);
    if (!model) throw new Error('modèle inconnu');
    const dest = path.join(MODELS_DIR, model.id + '.bin');
    await downloadFile(
      modelUrl(model.id),
      dest,
      (p) => {
        toSettings('download:progress', { id: model.id, percent: p.percent, received: p.received, total: p.total });
      },
      undefined,
      // Le fichier n'est publié que s'il ressemble vraiment à un modèle GGML.
      (tmpPath) => checkGgmlFile(tmpPath, model.sizeMB * 1048576)
    );
    return { id: model.id, path: dest };
  });

  ipcMain.handle('engine:deleteModel', (_event, modelId) => {
    const target = path.join(MODELS_DIR, modelId + '.bin');
    if (fs.existsSync(target)) fs.unlinkSync(target);
    return true;
  });

  ipcMain.handle('engine:installBinaries', async () => {
    const { installBinaries } = require('./install-binaries');
    const result = await installBinaries(BIN_DIR, (p) => {
      toSettings('download:progress', { id: '__binaries__', percent: p.percent });
    });
    whisper._initPromise = null; // force une nouvelle détection
    await whisper.init();
    return result;
  });

  ipcMain.handle('dictation:toggle', () => {
    toggleDictation();
    return dictationState;
  });

  ipcMain.handle('dictation:cancel', () => {
    cancelDictation();
    return true;
  });

  ipcMain.handle('audio:devices', () => rpc(captureWindow, 'capture:devices'));

  ipcMain.handle('audio:reinit', () => {
    toCapture('capture:reinit', config.all);
    return true;
  });

  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
    userData: app.getPath('userData'),
    modelsDir: MODELS_DIR,
    binDir: BIN_DIR,
    models: MODELS,
    repository: 'https://github.com/quentiinct/feather'
  }));

  ipcMain.handle('app:openPath', (_event, which) => {
    const target = which === 'models' ? MODELS_DIR : app.getPath('userData');
    return shell.openPath(target);
  });

  ipcMain.handle('app:openExternal', (_event, url) => {
    if (!/^https:\/\//i.test(url)) throw new Error('URL non autorisée');
    return shell.openExternal(url);
  });

  ipcMain.handle('app:checkUpdates', async () => {
    if (!updater) return { status: 'indisponible', error: 'module absent' };
    return updater.check();
  });

  ipcMain.handle('app:setLaunchAtLogin', (_event, enabled) => {
    app.setLoginItemSettings({
      openAtLogin: Boolean(enabled),
      args: ['--minimized']
    });
    return app.getLoginItemSettings().openAtLogin;
  });

  ipcMain.handle('window:minimize', () => settingsWindow?.minimize());
  ipcMain.handle('window:close', () => settingsWindow?.hide());
  ipcMain.handle('window:maximize', () => {
    if (!settingsWindow) return false;
    if (settingsWindow.isMaximized()) settingsWindow.unmaximize();
    else settingsWindow.maximize();
    return settingsWindow.isMaximized();
  });
  ipcMain.handle('window:quit', () => {
    quitting = true;
    app.quit();
  });
}

/* ------------------------------------------------------------------ *
 * Raccourci
 * ------------------------------------------------------------------ */

function wireHotkey() {
  hotkey = new HotkeyManager();

  hotkey.on('arm', () => armDictation());
  hotkey.on('start', () => confirmDictation());
  hotkey.on('stop', () => stopDictation());
  hotkey.on('cancel', (payload) => {
    if (payload?.silent && !confirmed) {
      // Ctrl+Maj utilisé comme préfixe d'un vrai raccourci : on jette la capture
      toCapture('capture:cancel', {});
      dictationState = 'idle';
      confirmed = false;
      return;
    }
    cancelDictation();
  });
  hotkey.on('error', (err) => {
    log('raccourci :', err.message);
    notify('Raccourci indisponible : ' + err.message, 'error');
  });

  hotkey.start(config.get('hotkey'));
}

function restartHotkey() {
  hotkey.stop();
  hotkey.start(config.get('hotkey'));
  refreshTray();
}

/* ------------------------------------------------------------------ *
 * Démarrage
 * ------------------------------------------------------------------ */

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => createSettingsWindow());

  // Sans identité déclarée, Windows regroupe la fenêtre sous « Electron » dans
  // la barre des tâches et l'épinglage ne retient pas la bonne application.
  app.setAppUserModelId('com.quentincourtade.feather');

  app.whenReady().then(async () => {
    config = new ConfigStore(app.getPath('userData'));
    stats = new StatsStore(app.getPath('userData'));

    // Deux emplacements : ce que l'application télécharge (dossier utilisateur)
    // et ce que « npm run setup » a posé dans le dépôt. Les deux restent valides.
    whisper = new WhisperEngine({
      binDir: BIN_DIR,
      modelsDirs: [MODELS_DIR, BUNDLED_MODELS_DIR],
      tmpDir: TMP_DIR
    });

    injector = new Injector({ scriptPath: INJECT_SCRIPT });

    // Le micro est demandé par une fenêtre locale : on l'autorise sans dialogue
    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
      callback(permission === 'media' || permission === 'audioCapture');
    });

    registerIpcHandlers();
    createCaptureWindow();
    createOverlayWindow();
    createTray();

    // Bascule clair/sombre de Windows : l'icône du tray doit changer de ton,
    // sinon elle devient invisible sur la nouvelle barre des tâches.
    nativeTheme.on('updated', () => {
      lightTaskbar = readTaskbarTheme();
      refreshTray();
    });
    wireHotkey();

    // Le helper d'injection compile du C# au premier lancement : on le prépare
    // en tâche de fond pour que la première dictée soit déjà instantanée.
    injector.start().catch((err) => log('injecteur :', err.message));
    whisper.init().then(async (state) => {
      log('moteur :', state.ready ? 'prêt (' + whisper.buildKind + ')' : state.reason);
      if (!state.ready) {
        notify('whisper.cpp n\'est pas installé. Ouvrez l\'onglet Transcription.', 'error');
        return;
      }
      if (!whisper.hasModel(config.get('whisper.model'))) {
        notify('Aucun modèle installé. Ouvrez l\'onglet Transcription.', 'error');
        return;
      }
      // Charger le modèle prend quelques secondes : on le fait maintenant plutôt
      // que de faire attendre l'utilisateur sur sa première dictée.
      const port = await whisper.ensureServer(config.get('whisper'));
      log(port ? 'modèle préchargé, serveur sur le port ' + port : 'repli sur le CLI');
      // Sans ça, un lancement suivi d'aucune dictée garderait le modèle en VRAM.
      whisper.scheduleIdleUnload(config.get('whisper'));
    });

    config.on('changed', (next, _prev, patch) => {
      if (patch.hotkey) restartHotkey();
      if (patch.ui && (patch.ui.overlayPosition || patch.ui.showOverlay !== undefined)) {
        if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.setBounds(overlayBounds());
      }
      // Changer de modèle, de GPU ou de threads impose de relancer le serveur.
      // On le fait tout de suite, pour ne pas pénaliser la dictée suivante.
      if (patch.whisper && ('model' in patch.whisper || 'useGpu' in patch.whisper || 'threads' in patch.whisper)) {
        whisper
          .ensureServer(config.get('whisper'))
          .then(() => whisper.scheduleIdleUnload(config.get('whisper')))
          .catch((err) => log('serveur :', err.message));
      }
      toSettings('config:changed', next);
    });

    const startMinimized =
      process.argv.includes('--minimized') || config.get('ui.startMinimized', false);
    if (!startMinimized) createSettingsWindow();

    // Après le reste : une vérification réseau ne doit retarder ni le
    // raccourci ni le préchargement du modèle.
    updater = setupUpdater({
      log,
      onState: (next) => toSettings('update:state', next)
    });

    log('prêt. Raccourci :', hotkey.describe());
  });

  app.on('window-all-closed', () => {
    // L'app vit dans la zone de notification : ne pas quitter.
  });

  app.on('before-quit', () => {
    quitting = true;
    hotkey?.stop();
    injector?.stop();
    whisper?.cancel();
    whisper?.stopServer();
    config?.persistNow();
    stats?.persistNow();
  });
}
