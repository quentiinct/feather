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
 * à côté de lui. Sous Windows le chargeur regarde le dossier de l'exécutable ;
 * ailleurs il faut le lui dire, sinon `libwhisper.so` reste introuvable alors
 * qu'elle est dans le même dossier.
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
  return (
    IS_LINUX &&
    (process.env.XDG_SESSION_TYPE === 'wayland' || Boolean(process.env.WAYLAND_DISPLAY))
  );
}

module.exports = { IS_WIN, IS_MAC, IS_LINUX, exeName, libraryEnv, metaKeyLabel, isWayland };
