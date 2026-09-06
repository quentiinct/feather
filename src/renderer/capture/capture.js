'use strict';

/**
 * Fenêtre de capture : invisible, elle ne sert qu'à tenir le micro.
 * Electron ne peut pas ouvrir un flux audio depuis le processus principal,
 * il faut un contexte de rendu — celui-ci vit tant que l'application tourne,
 * ce qui évite de redemander l'autorisation micro à chaque dictée.
 */

const api = window.feather;

const state = {
  context: null,
  stream: null,
  source: null,
  worklet: null,
  recording: false,
  chunks: [],
  totalSamples: 0,
  sampleRate: 16000,
  startedAt: 0,
  peak: 0,
  maxDurationSec: 120,
  autoStopTimer: null,
  deviceId: 'default'
};

const log = (...args) => console.log('[capture]', ...args);

/** Concatène les blocs Float32 en un seul buffer. */
function mergeChunks(chunks, total) {
  const out = new Float32Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * Encode du PCM flottant en WAV 16 bits mono — le format que whisper.cpp attend.
 */
function encodeWav(samples, sampleRate) {
  const bytesPerSample = 2;
  const buffer = new ArrayBuffer(44 + samples.length * bytesPerSample);
  const view = new DataView(buffer);

  const writeString = (offset, str) => {
    for (let i = 0; i < str.length; i += 1) view.setUint8(offset + i, str.charCodeAt(i));
  };

  const dataSize = samples.length * bytesPerSample;
  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true); // taille du bloc fmt
  view.setUint16(20, 1, true); // PCM entier
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true); // octets par seconde
  view.setUint16(32, bytesPerSample, true); // alignement de bloc
  view.setUint16(34, 16, true); // bits par échantillon
  writeString(36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i += 1) {
    let s = samples[i];
    if (s > 1) s = 1;
    else if (s < -1) s = -1;
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += bytesPerSample;
  }
  return buffer;
}

/** Ouvre le micro et branche le worklet. Rejoué si le périphérique change. */
async function initAudio(settings) {
  const deviceId = settings?.audio?.deviceId || 'default';
  const wanted = settings?.audio?.sampleRate || 16000;

  if (state.context && state.deviceId === deviceId && state.sampleRate === wanted) {
    if (state.context.state === 'suspended') await state.context.resume();
    return true;
  }

  await teardownAudio();

  const constraints = {
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
      ...(deviceId && deviceId !== 'default' ? { deviceId: { exact: deviceId } } : {})
    }
  };

  try {
    state.stream = await navigator.mediaDevices.getUserMedia(constraints);
  } catch (err) {
    // Le périphérique choisi a peut-être disparu : on retente sur celui par défaut
    if (deviceId !== 'default') {
      log('périphérique indisponible, retour au micro par défaut');
      state.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 }
      });
    } else {
      throw err;
    }
  }

  // On demande directement 16 kHz : Chromium rééchantillonne mieux que nous
  state.context = new AudioContext({ sampleRate: wanted, latencyHint: 'interactive' });
  state.sampleRate = state.context.sampleRate;
  state.deviceId = deviceId;

  await state.context.audioWorklet.addModule('./recorder-worklet.js');
  state.source = state.context.createMediaStreamSource(state.stream);
  state.worklet = new AudioWorkletNode(state.context, 'recorder-processor', {
    numberOfInputs: 1,
    numberOfOutputs: 0,
    channelCount: 1
  });

  state.worklet.port.onmessage = (event) => {
    const msg = event.data;
    if (msg.type === 'chunk') {
      if (!state.recording) return;
      state.chunks.push(msg.data);
      state.totalSamples += msg.data.length;
    } else if (msg.type === 'level') {
      if (msg.peak > state.peak) state.peak = msg.peak;
      api.send('capture:level', { rms: msg.rms, peak: msg.peak, recording: state.recording });
    }
  };

  state.source.connect(state.worklet);
  log('micro prêt à', state.sampleRate, 'Hz');
  return true;
}

async function teardownAudio() {
  try {
    if (state.worklet) state.worklet.disconnect();
    if (state.source) state.source.disconnect();
    if (state.stream) state.stream.getTracks().forEach((t) => t.stop());
    if (state.context) await state.context.close();
  } catch (err) {
    log('fermeture audio :', err.message);
  }
  state.worklet = null;
  state.source = null;
  state.stream = null;
  state.context = null;
}

async function startRecording(settings) {
  if (state.recording) return;
  try {
    await initAudio(settings);
  } catch (err) {
    api.send('capture:error', {
      code: err.name === 'NotAllowedError' ? 'permission' : 'device',
      message: err.message
    });
    return;
  }

  state.chunks = [];
  state.totalSamples = 0;
  state.peak = 0;
  state.startedAt = performance.now();
  state.maxDurationSec = settings?.audio?.maxDurationSec || 120;
  state.recording = true;
  state.worklet.port.postMessage('start');

  clearTimeout(state.autoStopTimer);
  state.autoStopTimer = setTimeout(() => {
    log('durée maximale atteinte, arrêt automatique');
    stopRecording(settings, 'max-duration');
  }, state.maxDurationSec * 1000);

  api.send('capture:started', { sampleRate: state.sampleRate });
}

function stopRecording(settings, reason = 'user') {
  if (!state.recording) return;
  clearTimeout(state.autoStopTimer);
  state.recording = false;
  if (state.worklet) state.worklet.port.postMessage('stop');

  const samples = mergeChunks(state.chunks, state.totalSamples);
  state.chunks = [];
  state.totalSamples = 0;

  const durationSec = samples.length / state.sampleRate;
  const minDuration = settings?.audio?.minDurationSec ?? 0.35;
  const silenceThreshold = settings?.audio?.silenceThreshold ?? 0.006;

  if (durationSec < minDuration) {
    api.send('capture:discarded', { reason: 'trop-court', durationSec });
    return;
  }
  if (state.peak < silenceThreshold) {
    api.send('capture:discarded', { reason: 'silence', durationSec, peak: state.peak });
    return;
  }

  const wav = encodeWav(samples, state.sampleRate);
  api.send('capture:result', {
    wav: new Uint8Array(wav),
    durationSec,
    sampleRate: state.sampleRate,
    peak: state.peak,
    reason
  });
}

function cancelRecording() {
  if (!state.recording) return;
  clearTimeout(state.autoStopTimer);
  state.recording = false;
  if (state.worklet) state.worklet.port.postMessage('stop');
  state.chunks = [];
  state.totalSamples = 0;
  api.send('capture:cancelled', {});
}

/* ------------------------------------------------------------------ *
 * Retour sonore
 * ------------------------------------------------------------------ */

/**
 * Contexte dédié aux bips : celui de la capture tourne à la fréquence du micro
 * et sert à l'entrée. On synthétise les sons plutôt que d'embarquer des fichiers
 * — rien à empaqueter, et le déclenchement ne dépend d'aucun chargement.
 */
let cueContext = null;

function playCue(kind) {
  try {
    if (!cueContext) cueContext = new AudioContext();
    if (cueContext.state === 'suspended') cueContext.resume();

    const now = cueContext.currentTime;
    const osc = cueContext.createOscillator();
    const gain = cueContext.createGain();

    // Montant au démarrage, descendant à l'arrêt : les deux se distinguent
    // sans avoir à les apprendre.
    const [from, to] = kind === 'stop' ? [880, 590] : [620, 950];
    osc.type = 'sine';
    osc.frequency.setValueAtTime(from, now);
    osc.frequency.exponentialRampToValueAtTime(to, now + 0.08);

    // Enveloppe douce : un créneau brut claque désagréablement dans un casque.
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.12, now + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.12);

    osc.connect(gain).connect(cueContext.destination);
    osc.start(now);
    osc.stop(now + 0.14);
  } catch (err) {
    log('bip impossible :', err.message);
  }
}

api.on('capture:cue', (payload) => playCue(payload && payload.kind));

api.on('capture:start', (settings) => startRecording(settings));
api.on('capture:stop', (settings) => stopRecording(settings));
api.on('capture:cancel', () => cancelRecording());
api.on('capture:reinit', async (settings) => {
  await teardownAudio();
  try {
    await initAudio(settings);
    api.send('capture:ready', { sampleRate: state.sampleRate });
  } catch (err) {
    api.send('capture:error', { code: 'device', message: err.message });
  }
});

/** Liste des micros disponibles, pour le sélecteur des réglages. */
api.handle('capture:devices', async () => {
  try {
    await navigator.mediaDevices.getUserMedia({ audio: true }).then((s) => s.getTracks().forEach((t) => t.stop()));
  } catch {
    /* la permission sera redemandée à la première dictée */
  }
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices
    .filter((d) => d.kind === 'audioinput')
    .map((d) => ({ id: d.deviceId, label: d.label || 'Micro sans nom' }));
});

navigator.mediaDevices.addEventListener('devicechange', () => {
  api.send('capture:devicechange', {});
});

api.send('capture:booted', {});
log('fenêtre de capture initialisée');
