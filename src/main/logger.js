'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

/**
 * Journal sur disque.
 *
 * Feather tourne empaqueté, fenêtre fermée, sans console : `console.log` n'a
 * alors aucun destinataire. Sans trace écrite, un rapport de bug se résume à
 * « ça ne marche pas », et il n'y a rien à demander à la personne qui l'ouvre.
 *
 * Deux règles tiennent ce module :
 *
 *  - Écrire ne doit jamais faire tomber l'application. Un disque plein, un
 *    dossier en lecture seule, un antivirus qui verrouille le fichier : tout
 *    est avalé. Un journal muet vaut mieux qu'un plantage au moment précis où
 *    l'on cherchait à comprendre un plantage.
 *  - Le fichier ne doit pas grossir sans fin. Au-delà d'un mégaoctet il est
 *    versé dans `feather.1.log` et un nouveau commence ; on garde donc deux
 *    fichiers, soit largement de quoi couvrir la session en cours et la
 *    précédente.
 */

const TAILLE_MAX = 1024 * 1024;
const CONSERVE = 1;

let dossier = null;
let fichier = null;

function prepare() {
  if (fichier) return fichier;
  try {
    // `logs` vit sous le dossier de données : le bouton « Ouvrir » des
    // réglages y mène déjà, on n'a pas de second chemin à expliquer.
    dossier = app.getPath('logs');
    fs.mkdirSync(dossier, { recursive: true });
    fichier = path.join(dossier, 'feather.log');
  } catch {
    fichier = null;
  }
  return fichier;
}

function tourne(cible) {
  try {
    if (fs.statSync(cible).size < TAILLE_MAX) return;
  } catch {
    return; // pas encore de fichier : rien à faire tourner
  }
  try {
    fs.renameSync(cible, cible.replace(/\.log$/, '.' + CONSERVE + '.log'));
  } catch {
    /* le fichier est verrouillé : on continuera d'écrire dedans */
  }
}

/** Une valeur quelconque rendue lisible sur une ligne. */
function texte(valeur) {
  if (typeof valeur === 'string') return valeur;
  if (valeur instanceof Error) return valeur.stack || valeur.message;
  try {
    return JSON.stringify(valeur);
  } catch {
    return String(valeur);
  }
}

function horodatage() {
  const d = new Date();
  const deux = (n) => String(n).padStart(2, '0');
  return (
    d.getFullYear() +
    '-' +
    deux(d.getMonth() + 1) +
    '-' +
    deux(d.getDate()) +
    ' ' +
    deux(d.getHours()) +
    ':' +
    deux(d.getMinutes()) +
    ':' +
    deux(d.getSeconds())
  );
}

function ecrire(niveau, args) {
  const ligne = horodatage() + ' ' + niveau + ' ' + args.map(texte).join(' ');
  // La console reste utile en développement, et ne coûte rien en production.
  (niveau === 'ERR' ? console.error : console.log)('[feather]', ...args);
  const cible = prepare();
  if (!cible) return;
  try {
    tourne(cible);
    fs.appendFileSync(cible, ligne + '\n');
  } catch {
    /* voir l'en-tête : le journal n'a pas le droit de faire tomber l'app */
  }
}

const log = (...args) => ecrire('INFO', args);
const logError = (...args) => ecrire('ERR ', args);

/** Chemin du journal, pour le dire à l'utilisateur au démarrage. */
function logPath() {
  return prepare() || '(indisponible)';
}

module.exports = { log, logError, logPath };
