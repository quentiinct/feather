'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const { pipeline } = require('stream/promises');

const MAX_REDIRECTS = 8;

/** Suit les redirections et renvoie la réponse finale. */
function openStream(url, redirectsLeft = MAX_REDIRECTS) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { headers: { 'User-Agent': 'VoxFlow', Accept: '*/*' } },
      (res) => {
        const { statusCode, headers } = res;
        if (statusCode >= 300 && statusCode < 400 && headers.location) {
          res.resume();
          if (redirectsLeft <= 0) {
            reject(new Error('Trop de redirections'));
            return;
          }
          const next = new URL(headers.location, url).toString();
          openStream(next, redirectsLeft - 1).then(resolve, reject);
          return;
        }
        if (statusCode !== 200) {
          res.resume();
          reject(new Error('HTTP ' + statusCode + ' sur ' + url));
          return;
        }
        resolve(res);
      }
    );
    req.on('error', reject);
    req.setTimeout(60000, () => req.destroy(new Error('Délai de connexion dépassé')));
  });
}

/**
 * Télécharge une URL vers un fichier, avec progression et écriture atomique.
 * @param {string} url
 * @param {string} destPath
 * @param {(p:{received:number,total:number,percent:number,speedBps:number})=>void} [onProgress]
 * @param {AbortSignal} [signal]
 */
async function downloadFile(url, destPath, onProgress, signal) {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  const tmpPath = destPath + '.part';

  const res = await openStream(url);
  const total = Number(res.headers['content-length']) || 0;

  let received = 0;
  let lastEmit = 0;
  const startedAt = Date.now();

  const onAbort = () => res.destroy(new Error('Téléchargement annulé'));
  if (signal) {
    if (signal.aborted) {
      res.destroy();
      throw new Error('Téléchargement annulé');
    }
    signal.addEventListener('abort', onAbort, { once: true });
  }

  res.on('data', (chunk) => {
    received += chunk.length;
    const now = Date.now();
    // On limite la fréquence des notifications pour ne pas saturer l'IPC
    if (onProgress && (now - lastEmit > 200 || received === total)) {
      lastEmit = now;
      const elapsed = Math.max(1, now - startedAt) / 1000;
      onProgress({
        received,
        total,
        percent: total ? Math.min(100, (received / total) * 100) : 0,
        speedBps: received / elapsed
      });
    }
  });

  try {
    await pipeline(res, fs.createWriteStream(tmpPath));
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      /* déjà supprimé */
    }
    throw err;
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort);
  }

  if (total && received !== total) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      /* déjà supprimé */
    }
    throw new Error('Téléchargement incomplet (' + received + '/' + total + ' octets)');
  }

  fs.renameSync(tmpPath, destPath);
  return { path: destPath, bytes: received };
}

function formatBytes(n) {
  if (!n) return '0 o';
  const units = ['o', 'Ko', 'Mo', 'Go'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return (n / 1024 ** i).toFixed(i === 0 ? 0 : 1) + ' ' + units[i];
}

module.exports = { downloadFile, formatBytes };
