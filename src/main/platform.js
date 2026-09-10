'use strict';

const path = require('path');

/**
 * Ce que Feather doit savoir du système sous ses pieds.
 *
 * Tout est rassemblé ici plutôt que dispersé en `process.platform === 'win32'`
 * un peu partout : quand un quatrième cas apparaîtra, il y aura un seul fichier
 * à lire pour savoir ce qu'il faut fournir.
 */

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
const IS_LINUX = process.platform === 'linux';

/** Nom d'un exécutable, suffixé sur Windows uniquement. */
function exeName(base) {
  return IS_WIN ? base + '.exe' : base;
}

/**
 * Variables d'environnement pour lancer un binaire livré avec ses bibliothèques
 * à côté de lui.
 *
 * Les archives publiées par whisper.cpp portent un RUNPATH `$ORIGIN` et se
 * suffisent donc à elles-mêmes. Ce n'est pas garanti d'un build compilé
 * ailleurs — et whisper.binDir existe précisément pour en désigner un — d'où
 * cette ceinture en plus des bretelles.
 */
function libraryEnv(binDir, base = process.env) {
  if (IS_WIN) return base;
  const key = IS_MAC ? 'DYLD_LIBRARY_PATH' : 'LD_LIBRARY_PATH';
  const existant = base[key];
  return { ...base, [key]: existant ? binDir + path.delimiter + existant : binDir };
}

/**
 * Nom affiché de la touche « meta ». La même touche physique s'appelle Windows,
 * Command ou Super selon le système, et un raccourci qui nomme la mauvaise
 * touche est un raccourci qu'on n'ose pas essayer.
 */
function metaKeyLabel() {
  if (IS_MAC) return 'Cmd';
  if (IS_LINUX) return 'Super';
  return 'Win';
}

/**
 * Sous Wayland, aucun client ne peut écouter le clavier global ni injecter des
 * frappes dans une autre fenêtre : le protocole l'interdit par construction.
 * Ce n'est pas un défaut de Feather, et le dire clairement vaut mieux qu'un
 * raccourci qui ne répond jamais.
 */
function isWayland() {
  if (!IS_LINUX) return false;
  if (process.env.XDG_SESSION_TYPE === 'wayland') return true;
  // `WAYLAND_DISPLAY` seul ne suffit pas : WSLg le pose alors que les
  // applications tournent sous XWayland, où le raccourci global et xdotool
  // fonctionnent parfaitement. Sans serveur X, en revanche, il n'y a pas de
  // repli possible et l'avertissement est mérité.
  return Boolean(process.env.WAYLAND_DISPLAY) && !process.env.DISPLAY;
}

/**
 * Où l'utilisateur doit aller rouvrir l'accès au micro.
 *
 * Envoyer quelqu'un dans « Paramètres Windows » sur un bureau Linux, c'est le
 * faire chercher un écran qui n'existe pas — autant ne rien dire. Sous Linux il
 * n'y a d'ailleurs pas de permission à accorder : un micro refusé y signifie
 * presque toujours un périphérique d'entrée absent ou capté par autre chose.
 */
function micDeniedMessage() {
  if (IS_WIN) {
    return "L'accès au micro a été refusé. Autorisez-le dans Paramètres > Confidentialité et sécurité > Microphone.";
  }
  if (IS_MAC) {
    return "L'accès au micro a été refusé. Autorisez-le dans Réglages Système > Confidentialité et sécurité > Microphone.";
  }
  return "Le micro n'est pas accessible. Vérifiez le périphérique d'entrée dans les réglages son de votre bureau.";
}

module.exports = {
  IS_WIN,
  IS_MAC,
  IS_LINUX,
  exeName,
  libraryEnv,
  metaKeyLabel,
  isWayland,
  micDeniedMessage
};
