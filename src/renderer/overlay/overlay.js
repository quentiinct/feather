'use strict';

/**
 * Overlay flottant. Il ne pilote rien : il reflète l'état envoyé par le
 * processus principal, et relaie un clic pour arrêter la dictée en cours.
 */

const api = window.feather;

const BAR_COUNT = 13;
const els = {
  body: document.body,
  pill: document.getElementById('pill'),
  bars: document.getElementById('bars'),
  label: document.getElementById('label'),
  timer: document.getElementById('timer'),
  hint: document.getElementById('hint')
};

const bars = [];
for (let i = 0; i < BAR_COUNT; i += 1) {
  const bar = document.createElement('span');
  els.bars.appendChild(bar);
  bars.push(bar);
}

let currentState = 'idle';
let startedAt = 0;
let timerHandle = null;
let hideHandle = null;

/** Historique glissant des niveaux : la barre la plus à droite est la plus récente. */
const levels = new Array(BAR_COUNT).fill(0);

function setState(next, payload = {}) {
  currentState = next;
  els.body.className = '';
  clearTimeout(hideHandle);

  if (next === 'idle') {
    els.body.classList.remove('visible');
    stopTimer();
    return;
  }

  els.body.classList.add('visible', 'state-' + next);

  if (next === 'recording') {
    els.label.textContent = payload.label || 'À l\'écoute…';
    startTimer();
  } else if (next === 'processing') {
    els.label.textContent = payload.label || 'Transcription…';
    stopTimer();
    levels.fill(0);
    render();
  } else if (next === 'done') {
    const words = payload.words ?? 0;
    els.label.textContent = payload.label || (words + (words > 1 ? ' mots insérés' : ' mot inséré'));
    stopTimer();
    hideHandle = setTimeout(() => setState('idle'), 1400);
  } else if (next === 'error') {
    els.label.textContent = payload.label || 'Échec de la transcription';
    stopTimer();
    hideHandle = setTimeout(() => setState('idle'), 3200);
  }
}

function startTimer() {
  startedAt = Date.now();
  els.timer.textContent = '0:00';
  clearInterval(timerHandle);
  timerHandle = setInterval(() => {
    const s = Math.floor((Date.now() - startedAt) / 1000);
    els.timer.textContent = Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }, 250);
}

function stopTimer() {
  clearInterval(timerHandle);
  timerHandle = null;
}

function render() {
  for (let i = 0; i < BAR_COUNT; i += 1) {
    // Racine carrée : les niveaux de parole courants occupent mieux la hauteur
    const amplitude = Math.min(1, Math.sqrt(levels[i] * 7));
    bars[i].style.height = (4 + amplitude * 18).toFixed(1) + 'px';
  }
}

api.on('state', (payload) => setState(payload.state, payload));

api.on('level', (payload) => {
  if (currentState !== 'recording') return;
  levels.shift();
  levels.push(payload.peak ?? payload.rms ?? 0);
  render();
});

els.pill.addEventListener('click', () => {
  if (currentState === 'recording') api.send('overlay:click', { action: 'stop' });
});

els.pill.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  if (currentState === 'recording') api.send('overlay:click', { action: 'cancel' });
});

render();
setState('idle');
