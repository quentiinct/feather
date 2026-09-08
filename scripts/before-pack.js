'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Garde-fou d'empaquetage.
 *
 * Feather se développe avec le moteur CUDA dans `resources/bin` — c'est ce qui
 * rend les dictées instantanées sur une machine NVIDIA. Mais ce moteur pèse
 * 1,1 Go, et l'installateur publié ne doit contenir que le moteur processeur :
 * les rares machines qui profitent de CUDA le téléchargent depuis
 * l'application, sans l'imposer à toutes les autres.
 *
 * Rien ne distingue les deux dossiers au premier coup d'œil, et l'erreur ne se
 * verrait qu'à la taille du fichier produit — trop tard. On la refuse ici.
 *
 * Pour construire volontairement un installateur CUDA :
 *   FEATHER_CUDA_INSTALLER=1 npm run build:win
 */

/** Les bibliothèques qui n'existent que dans le build cuBLAS. */
const CUDA = /^(cublas|cublasLt|cudart|nvblas|nvrtc|ggml-cuda)/i;

module.exports = async function beforePack() {
  const binDir = path.join(__dirname, '..', 'resources', 'bin');
  if (!fs.existsSync(binDir)) {
    throw new Error(
      'resources/bin est absent : lancez « npm run setup -- --cpu » avant de construire.'
    );
  }

  const fichiers = fs.readdirSync(binDir).filter((n) => CUDA.test(n));
  if (!fichiers.length) return;

  const octets = fichiers.reduce((total, n) => total + fs.statSync(path.join(binDir, n)).size, 0);
  const mo = Math.round(octets / (1024 * 1024));

  if (process.env.FEATHER_CUDA_INSTALLER) {
    process.stdout.write(
      '  ⚠ installateur CUDA demandé : ' + fichiers.length + ' bibliothèques, ' + mo + ' Mo\n'
    );
    return;
  }

  throw new Error(
    'resources/bin contient le moteur CUDA (' +
      fichiers.length +
      ' bibliothèques, ' +
      mo +
      " Mo). L'installateur publié embarque le moteur processeur ; CUDA se " +
      "télécharge depuis l'application.\n\n" +
      '  Pour construire :      npm run setup -- --cpu\n' +
      '  Puis revenir au dev :  npm run setup -- --cuda\n' +
      '  Ou forcer CUDA :       FEATHER_CUDA_INSTALLER=1 npm run build:win\n'
  );
};
