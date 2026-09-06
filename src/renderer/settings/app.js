'use strict';

/**
 * Fenêtre principale : réglages et statistiques.
 * Toute écriture passe par `patch()`, qui envoie un patch partiel au processus
 * principal — la configuration complète n'est jamais recomposée côté rendu.
 */

const api = window.feather;

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

let config = null;
let summary = null;
let engine = null;
let appInfo = null;
let suppressWrites = false;

/* ------------------------------------------------------------------ *
 * Utilitaires
 * ------------------------------------------------------------------ */

const nf = new Intl.NumberFormat('fr-FR');

function compact(n) {
  if (n < 10000) return nf.format(n);
  if (n < 1000000) return (n / 1000).toFixed(n < 100000 ? 1 : 0).replace('.', ',') + ' k';
  return (n / 1000000).toFixed(1).replace('.', ',') + ' M';
}

function humanDuration(seconds) {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return s + ' s';
  const m = Math.round(s / 60);
  if (m < 60) return m + ' min';
  const h = Math.floor(m / 60);
  const rest = m % 60;
  // « 2 h 40 » plutôt que « 2 h 40 min » : la tuile est étroite et la notation
  // horaire française se passe très bien de l'unité finale.
  return rest ? h + ' h ' + String(rest).padStart(2, '0') : h + ' h';
}

function formatDate(iso) {
  const [y, m, d] = iso.split('-');
  return new Date(Number(y), Number(m) - 1, Number(d)).toLocaleDateString('fr-FR', {
    day: 'numeric',
    month: 'short'
  });
}

function toast(message, kind = 'info') {
  const el = document.createElement('div');
  el.className = 'toast' + (kind !== 'info' ? ' ' + kind : '');
  el.textContent = message;
  $('#toasts').appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity 200ms ease';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 220);
  }, 3600);
}

/** Envoie un patch partiel, sauf pendant le remplissage initial des champs. */
async function patch(partial) {
  if (suppressWrites) return;
  config = await api.invoke('config:update', partial);
}

/* ------------------------------------------------------------------ *
 * Navigation
 * ------------------------------------------------------------------ */

function showPanel(name) {
  $$('.panel').forEach((p) => {
    p.hidden = p.id !== 'panel-' + name;
  });
  $$('.nav-item').forEach((b) => {
    if (b.dataset.panel === name) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  $('.content').scrollTop = 0;
  if (name === 'dashboard') refreshStats();
  if (name === 'audio') loadMicrophones();
  if (name === 'transcription') refreshEngine();
}

const PANELS = ['dashboard', 'hotkey', 'transcription', 'cleanup', 'output', 'audio', 'general'];

$$('.nav-item').forEach((btn) => {
  btn.addEventListener('click', () => {
    window.location.hash = btn.dataset.panel;
    showPanel(btn.dataset.panel);
  });
});

/** L'ancre permet de rouvrir la fenêtre sur la section où l'on était. */
function panelFromHash() {
  const name = window.location.hash.replace(/^#/, '');
  return PANELS.includes(name) ? name : 'dashboard';
}

window.addEventListener('hashchange', () => showPanel(panelFromHash()));

/** Groupes de boutons exclusifs (segmented control). */
function bindSegmented(selector, onChange) {
  const group = $(selector);
  group.addEventListener('click', (event) => {
    const btn = event.target.closest('button[data-value]');
    if (!btn) return;
    setSegmented(selector, btn.dataset.value);
    onChange(btn.dataset.value);
  });
}

function setSegmented(selector, value) {
  $$(selector + ' button').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.value === value));
  });
}

/* ------------------------------------------------------------------ *
 * Graphique — une seule série, donc pas de légende : le titre suffit.
 * ------------------------------------------------------------------ */

const chartEl = $('#chart');
const tooltipEl = $('#chart-tooltip');

/** Arrondi 4px côté données, angle droit sur la ligne de base. */
function barPath(x, y, w, h, r = 4) {
  const radius = Math.min(r, w / 2, h);
  return (
    'M' + x + ',' + (y + h) +
    'L' + x + ',' + (y + radius) +
    'Q' + x + ',' + y + ' ' + (x + radius) + ',' + y +
    'L' + (x + w - radius) + ',' + y +
    'Q' + (x + w) + ',' + y + ' ' + (x + w) + ',' + (y + radius) +
    'L' + (x + w) + ',' + (y + h) +
    'Z'
  );
}

/** Choisit un maximum d'axe « rond » au-dessus de la valeur observée. */
function niceMax(value) {
  if (value <= 0) return 100;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 1.5, 2, 2.5, 3, 4, 5, 7.5, 10]) {
    const candidate = step * magnitude;
    if (candidate >= value) return candidate;
  }
  return 10 * magnitude;
}

function renderChart(series) {
  const rect = chartEl.getBoundingClientRect();
  const width = Math.max(320, rect.width || 640);
  const height = 168;
  const pad = { top: 8, right: 4, bottom: 20, left: 34 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;

  const max = niceMax(Math.max(...series.map((d) => d.words), 0));
  const band = plotW / series.length;
  const barW = Math.min(24, Math.max(3, band - 2)); // 2px de surface entre voisins

  const svgNS = 'http://www.w3.org/2000/svg';
  chartEl.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
  chartEl.setAttribute('preserveAspectRatio', 'none');
  chartEl.textContent = '';

  const make = (tag, attrs, text) => {
    const node = document.createElementNS(svgNS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    if (text !== undefined) node.textContent = text;
    return node;
  };

  // Grille et graduations : discrètes, elles portent les valeurs non étiquetées
  for (const frac of [0, 0.5, 1]) {
    const y = pad.top + plotH * (1 - frac);
    chartEl.appendChild(
      make('line', { class: 'grid-line', x1: pad.left, x2: width - pad.right, y1: y, y2: y })
    );
    chartEl.appendChild(
      make(
        'text',
        { class: 'axis-text', x: pad.left - 7, y: y + 3.5, 'text-anchor': 'end' },
        nf.format(Math.round(max * frac))
      )
    );
  }

  series.forEach((day, i) => {
    const x = pad.left + i * band + (band - barW) / 2;
    const h = max > 0 ? (day.words / max) * plotH : 0;
    const y = pad.top + plotH - h;

    if (day.words > 0) {
      chartEl.appendChild(make('path', { class: 'bar', d: barPath(x, y, barW, Math.max(2, h)) }));
    } else {
      // Talon d'un jour sans dictée : l'axe temporel reste continu
      chartEl.appendChild(
        make('rect', {
          class: 'bar empty',
          x,
          y: pad.top + plotH - 2,
          width: barW,
          height: 2,
          rx: 1
        })
      );
    }

    // Cible de survol pleine hauteur : plus large que la barre, comme recommandé
    const hit = make('rect', {
      class: 'bar-hit',
      x: pad.left + i * band,
      y: pad.top,
      width: band,
      height: plotH
    });
    hit.addEventListener('mouseenter', () => {
      tooltipEl.innerHTML =
        '<div class="tt-value">' +
        nf.format(day.words) +
        (day.words > 1 ? ' mots' : ' mot') +
        '</div><div class="tt-date">' +
        formatDate(day.date) +
        (day.sessions ? ' · ' + day.sessions + (day.sessions > 1 ? ' dictées' : ' dictée') : '') +
        '</div>';
      const cardRect = chartEl.parentElement.getBoundingClientRect();
      const svgRect = chartEl.getBoundingClientRect();
      const scale = svgRect.width / width;
      tooltipEl.style.left = svgRect.left - cardRect.left + (pad.left + i * band + band / 2) * scale + 'px';
      tooltipEl.style.top = svgRect.top - cardRect.top + (day.words > 0 ? y : pad.top + plotH) - 8 + 'px';
      tooltipEl.classList.add('visible');
    });
    hit.addEventListener('mouseleave', () => tooltipEl.classList.remove('visible'));
    chartEl.appendChild(hit);
  });

  // Étiquettes d'axe : premier, milieu, dernier — jamais une par barre
  [0, Math.floor(series.length / 2), series.length - 1].forEach((i, idx) => {
    const anchor = idx === 0 ? 'start' : idx === 2 ? 'end' : 'middle';
    chartEl.appendChild(
      make(
        'text',
        {
          class: 'axis-text',
          x: pad.left + i * band + band / 2,
          y: height - 5,
          'text-anchor': anchor
        },
        formatDate(series[i].date)
      )
    );
  });

  renderTable(series);
}

/** Vue tabulaire : aucune valeur n'est réservée au survol. */
function renderTable(series) {
  const rows = series.filter((d) => d.words > 0).reverse();
  const wrap = $('#table-wrap');
  if (rows.length === 0) {
    wrap.innerHTML = '<div class="empty-state">Aucune donnée sur la période.</div>';
    return;
  }
  wrap.innerHTML =
    '<table class="data-table"><thead><tr><th>Jour</th><th class="num">Mots</th>' +
    '<th class="num">Dictées</th><th class="num">Audio</th></tr></thead><tbody>' +
    rows
      .map(
        (d) =>
          '<tr><td>' +
          formatDate(d.date) +
          '</td><td class="num">' +
          nf.format(d.words) +
          '</td><td class="num">' +
          d.sessions +
          '</td><td class="num">' +
          humanDuration(d.audioSec) +
          '</td></tr>'
      )
      .join('') +
    '</tbody></table>';
}

$('#toggle-table').addEventListener('click', (event) => {
  const wrap = $('#table-wrap');
  wrap.hidden = !wrap.hidden;
  event.target.setAttribute('aria-expanded', String(!wrap.hidden));
  event.target.textContent = wrap.hidden
    ? 'Afficher les valeurs sous forme de tableau'
    : 'Masquer le tableau';
});

let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (summary) renderChart(summary.series);
  }, 120);
});

/* ------------------------------------------------------------------ *
 * Statistiques
 * ------------------------------------------------------------------ */

async function refreshStats() {
  summary = await api.invoke('stats:summary', 30);
  const t = summary.totals;

  $('#hero-words').textContent = compact(t.words);
  $('#hero-note').textContent = t.sessions
    ? nf.format(t.sessions) +
      (t.sessions > 1 ? ' dictées' : ' dictée') +
      ' · ' +
      summary.avgWordsPerSession +
      ' mots en moyenne · record de ' +
      nf.format(summary.records.bestDayWords) +
      ' mots en une journée'
    : 'Lancez votre première dictée pour voir vos statistiques apparaître.';

  $('#tile-today').textContent = nf.format(summary.today.words);
  $('#tile-today-note').textContent = summary.today.sessions
    ? summary.today.sessions + (summary.today.sessions > 1 ? ' dictées' : ' dictée')
    : 'aucune dictée';
  $('#tile-week').textContent = nf.format(summary.week);
  $('#tile-saved').textContent = humanDuration(summary.savedSec);
  $('#tile-wpm').textContent = summary.wpm ? nf.format(summary.wpm) : '—';
  $('#tile-streak').textContent = summary.streak + ' j';
  $('#tile-streak-note').textContent =
    summary.streak > 1 ? 'jours consécutifs' : summary.streak === 1 ? 'commencée aujourd\'hui' : 'aucune série';

  renderChart(summary.series);
  renderHistory(await api.invoke('stats:history', 25));
}

function renderHistory(entries) {
  const list = $('#history-list');
  if (!entries.length) {
    list.innerHTML = '<div class="empty-state">Aucune dictée pour le moment.</div>';
    return;
  }
  list.innerHTML = entries
    .map((e) => {
      const when = new Date(e.at).toLocaleString('fr-FR', {
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit'
      });
      const text = e.text.length > 220 ? e.text.slice(0, 220) + '…' : e.text;
      const escaped = text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
      return (
        '<div class="history-item"><div class="history-text">' +
        escaped +
        '</div><div class="history-meta">' +
        when +
        '<br>' +
        e.words +
        ' mots · ' +
        e.audioSec +
        ' s</div></div>'
      );
    })
    .join('');
}

$('#clear-history').addEventListener('click', async () => {
  await api.invoke('stats:clearHistory');
  renderHistory([]);
  toast('Historique effacé.', 'success');
});

/* ------------------------------------------------------------------ *
 * Moteur & modèles
 * ------------------------------------------------------------------ */

async function refreshEngine() {
  engine = await api.invoke('engine:status');

  const dot = $('#engine-dot');
  const label = $('#engine-status');
  dot.className = 'status-dot';

  if (!engine.installed) {
    dot.classList.add('err');
    label.textContent = 'Moteur non installé';
    $('#engine-detail').textContent =
      'whisper.cpp est absent. Lancez « npm run setup » dans le dossier du projet, ou utilisez le bouton ci-dessous.';
  } else if (!engine.models.length) {
    dot.classList.add('warn');
    label.textContent = 'Aucun modèle';
    $('#engine-detail').textContent =
      'Binaires installés (build ' + engine.buildKind + '). Il manque un modèle de transcription.';
  } else {
    dot.classList.add('ok');
    label.textContent = 'Prêt · ' + (engine.buildKind === 'cuda' ? 'GPU' : 'CPU');
    $('#engine-detail').textContent =
      'Binaires installés — build ' +
      engine.buildKind +
      (engine.buildKind === 'cuda'
        ? ' (accélération NVIDIA disponible).'
        : ' (calcul sur le processeur).');
  }

  $('#gpu-help').textContent =
    engine.gpuCapable
      ? 'Votre build supporte CUDA : laissez activé.'
      : 'Les binaires installés ne sont pas compilés avec CUDA — cette option restera sans effet.';

  renderModels();
}

function renderModels() {
  const installed = new Map((engine?.models || []).map((m) => [m.id, m]));
  const selected = config.whisper.model;

  $('#model-list').innerHTML = (appInfo?.models || [])
    .map((m) => {
      const isInstalled = installed.has(m.id);
      const isSelected = m.id === selected;
      return (
        '<div class="model-row" data-model="' + m.id + '">' +
        '<div><div class="model-name">' +
        m.label +
        (m.recommended ? '<span class="badge">recommandé</span>' : '') +
        (isSelected ? '<span class="badge installed">actif</span>' : '') +
        '</div><div class="model-meta">' +
        (isInstalled ? installed.get(m.id).sizeMB + ' Mo installés' : '≈ ' + m.sizeMB + ' Mo') +
        ' · ' +
        m.note +
        '</div><div class="progress" hidden><span style="width:0"></span></div></div>' +
        '<div class="row-control">' +
        (isInstalled
          ? (isSelected
              ? ''
              : '<button class="btn small" data-action="select">Utiliser</button>') +
            '<button class="btn small danger" data-action="delete">Supprimer</button>'
          : '<button class="btn small" data-action="download">Télécharger</button>') +
        '</div></div>'
      );
    })
    .join('');
}

$('#model-list').addEventListener('click', async (event) => {
  const btn = event.target.closest('button[data-action]');
  if (!btn) return;
  const row = btn.closest('.model-row');
  const modelId = row.dataset.model;

  if (btn.dataset.action === 'select') {
    await patch({ whisper: { model: modelId } });
    await refreshEngine();
    toast('Modèle actif : ' + modelId, 'success');
    return;
  }

  if (btn.dataset.action === 'delete') {
    await api.invoke('engine:deleteModel', modelId);
    await refreshEngine();
    toast('Modèle supprimé.');
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Téléchargement…';
  row.querySelector('.progress').hidden = false;
  try {
    await api.invoke('engine:downloadModel', modelId);
    toast('Modèle téléchargé.', 'success');
    await refreshEngine();
  } catch (err) {
    toast('Échec du téléchargement : ' + err.message, 'error');
    btn.disabled = false;
    btn.textContent = 'Télécharger';
    row.querySelector('.progress').hidden = true;
  }
});

api.on('download:progress', (payload) => {
  const row = document.querySelector('.model-row[data-model="' + payload.id + '"]');
  const bar = row ? row.querySelector('.progress > span') : null;
  if (bar) bar.style.width = payload.percent.toFixed(1) + '%';

  if (payload.id === '__binaries__') {
    const p = $('#binaries-progress');
    p.hidden = false;
    p.querySelector('span').style.width = payload.percent.toFixed(1) + '%';
  }
});

$('#install-binaries').addEventListener('click', async (event) => {
  event.target.disabled = true;
  event.target.textContent = 'Installation…';
  try {
    const result = await api.invoke('engine:installBinaries');
    toast('Binaires installés (build ' + result.buildKind + ').', 'success');
    await refreshEngine();
  } catch (err) {
    toast('Échec : ' + err.message, 'error');
  } finally {
    event.target.disabled = false;
    event.target.textContent = 'Réinstaller les binaires';
    $('#binaries-progress').hidden = true;
  }
});

/* ------------------------------------------------------------------ *
 * Raccourci
 * ------------------------------------------------------------------ */

const MOD_LABELS = { ctrl: 'Ctrl', shift: 'Maj', alt: 'Alt', meta: 'Win' };

function renderHotkey() {
  const h = config.hotkey;
  setSegmented('#hotkey-mode', h.mode);
  setSegmented('#activation-mode', h.activation);
  $('#row-modifiers').hidden = h.mode !== 'modifiers';
  $('#row-combo').hidden = h.mode !== 'combo';
  $('#accelerator').value = h.accelerator;
  $('#hold-threshold').value = h.holdThresholdMs;

  $$('#modifier-picker button').forEach((b) => {
    b.setAttribute('aria-pressed', String(h.modifiers.includes(b.dataset.mod)));
  });

  const keys =
    h.mode === 'combo'
      ? h.accelerator.split('+').map((k) => k.replace('Control', 'Ctrl'))
      : h.modifiers.map((m) => MOD_LABELS[m] || m);
  $('#kbd-preview').innerHTML = keys.map((k) => '<kbd>' + k + '</kbd>').join(' + ');

  $('#activation-help').textContent =
    h.activation === 'hold'
      ? 'La dictée dure tant que les touches sont maintenues.'
      : 'Un appui bref démarre puis arrête. Un appui maintenu se comporte comme un talkie-walkie.';

  $('#hotkey-dot').className = 'status-dot ok';
  $('#hotkey-status').textContent = keys.join(' + ');
}

bindSegmented('#hotkey-mode', async (value) => {
  await patch({ hotkey: { mode: value } });
  renderHotkey();
});

bindSegmented('#activation-mode', async (value) => {
  await patch({ hotkey: { activation: value } });
  renderHotkey();
});

$('#modifier-picker').addEventListener('click', async (event) => {
  const btn = event.target.closest('button[data-mod]');
  if (!btn) return;
  const current = new Set(config.hotkey.modifiers);
  if (current.has(btn.dataset.mod)) current.delete(btn.dataset.mod);
  else current.add(btn.dataset.mod);

  if (current.size < 2) {
    toast('Deux modificateurs au minimum, sinon le raccourci se déclencherait sans arrêt.', 'error');
    return;
  }
  // Ordre stable pour l'affichage
  const ordered = ['ctrl', 'shift', 'alt', 'meta'].filter((m) => current.has(m));
  await patch({ hotkey: { modifiers: ordered } });
  renderHotkey();
});

$('#accelerator').addEventListener('change', async (event) => {
  await patch({ hotkey: { accelerator: event.target.value.trim() } });
  renderHotkey();
});

$('#hold-threshold').addEventListener('change', async (event) => {
  await patch({ hotkey: { holdThresholdMs: Number(event.target.value) } });
});

$('#test-dictation').addEventListener('click', () => api.invoke('dictation:toggle'));

/* ------------------------------------------------------------------ *
 * Transcription
 * ------------------------------------------------------------------ */

$('#language').addEventListener('change', (e) => patch({ whisper: { language: e.target.value } }));
$('#use-gpu').addEventListener('change', (e) => patch({ whisper: { useGpu: e.target.checked } }));
$('#threads').addEventListener('change', (e) => patch({ whisper: { threads: Number(e.target.value) } }));
$('#initial-prompt').addEventListener('change', (e) =>
  patch({ whisper: { initialPrompt: e.target.value } })
);
bindSegmented('#strategy', (value) => patch({ whisper: { strategy: value } }));

/* ------------------------------------------------------------------ *
 * Nettoyage
 * ------------------------------------------------------------------ */

const CLEANUP_HELP = {
  off: 'Le texte de Whisper est inséré tel quel.',
  rules: 'Traitement local instantané. Aucune dépendance, aucun coût.',
  llm: 'Un modèle local reformule le texte. Gratuit, mais ajoute environ une seconde.'
};

function renderCleanup() {
  const c = config.cleanup;
  setSegmented('#cleanup-mode', c.mode);
  $('#cleanup-mode-help').textContent = CLEANUP_HELP[c.mode] || '';
  $('#rules-card').hidden = c.mode === 'off';
  $('#llm-card').hidden = c.mode !== 'llm';

  $$('input[data-rule]').forEach((input) => {
    input.checked = Boolean(c.rules[input.dataset.rule]);
  });

  $('#llm-model').value = c.llm.model;
  $('#llm-endpoint').value = c.llm.endpoint;
  $('#llm-timeout').value = c.llm.timeoutMs;

  renderDictionary();
  updatePreview();
}

bindSegmented('#cleanup-mode', async (value) => {
  await patch({ cleanup: { mode: value } });
  renderCleanup();
});

$$('input[data-rule]').forEach((input) => {
  input.addEventListener('change', async () => {
    await patch({ cleanup: { rules: { [input.dataset.rule]: input.checked } } });
    updatePreview();
  });
});

$('#llm-model').addEventListener('change', (e) => patch({ cleanup: { llm: { model: e.target.value.trim() } } }));
$('#llm-endpoint').addEventListener('change', (e) =>
  patch({ cleanup: { llm: { endpoint: e.target.value.trim() } } })
);
$('#llm-timeout').addEventListener('change', (e) =>
  patch({ cleanup: { llm: { timeoutMs: Number(e.target.value) } } })
);

$('#probe-ollama').addEventListener('click', async (event) => {
  event.target.disabled = true;
  const status = $('#ollama-status');
  status.textContent = 'Test en cours…';
  const result = await api.invoke('ollama:probe');
  if (result.available) {
    status.textContent = result.models.length
      ? 'Connecté. Modèles disponibles : ' + result.models.join(', ')
      : 'Connecté, mais aucun modèle installé. Lancez « ollama pull qwen2.5:3b-instruct ».';
  } else {
    status.textContent =
      'Injoignable (' + result.error + '). Installez Ollama depuis ollama.com, puis lancez « ollama pull qwen2.5:3b-instruct ».';
  }
  event.target.disabled = false;
});

function renderDictionary() {
  const list = $('#dict-list');
  const entries = config.cleanup.dictionary || [];
  list.innerHTML = entries
    .map(
      (entry, i) =>
        '<div class="dict-row" data-index="' + i + '">' +
        '<input type="text" data-field="from" placeholder="entendu" value="' +
        String(entry.from ?? '').replace(/"/g, '&quot;') +
        '"><span class="arrow">→</span>' +
        '<input type="text" data-field="to" placeholder="écrit" value="' +
        String(entry.to ?? '').replace(/"/g, '&quot;') +
        '"><button class="icon-btn" data-action="remove" title="Supprimer" aria-label="Supprimer">✕</button></div>'
    )
    .join('');
}

$('#dict-list').addEventListener('change', async (event) => {
  const row = event.target.closest('.dict-row');
  if (!row || !event.target.dataset.field) return;
  const dictionary = config.cleanup.dictionary.slice();
  dictionary[Number(row.dataset.index)] = {
    ...dictionary[Number(row.dataset.index)],
    [event.target.dataset.field]: event.target.value
  };
  await patch({ cleanup: { dictionary } });
  updatePreview();
});

$('#dict-list').addEventListener('click', async (event) => {
  if (!event.target.closest('button[data-action="remove"]')) return;
  const row = event.target.closest('.dict-row');
  const dictionary = config.cleanup.dictionary.filter((_, i) => i !== Number(row.dataset.index));
  await patch({ cleanup: { dictionary } });
  renderDictionary();
  updatePreview();
});

$('#dict-add').addEventListener('click', async () => {
  const dictionary = [...config.cleanup.dictionary, { from: '', to: '' }];
  await patch({ cleanup: { dictionary } });
  renderDictionary();
  $('#dict-list .dict-row:last-child input')?.focus();
});

let previewTimer = null;
const SAMPLE = 'euh bonjour, je voulais euh vous dire que le le projet est presque fini';

function updatePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(async () => {
    const raw = $('#preview-input').value.trim() || SAMPLE;
    const box = $('#preview-output');
    try {
      const result = await api.invoke('cleanup:preview', raw);
      box.textContent = result || '(le nettoyage a considéré ce texte comme du bruit)';
      box.classList.toggle('muted', !result);
    } catch (err) {
      box.textContent = 'Erreur : ' + err.message;
      box.classList.add('muted');
    }
  }, 220);
}

$('#preview-input').addEventListener('input', updatePreview);

/* ------------------------------------------------------------------ *
 * Sortie
 * ------------------------------------------------------------------ */

const OUTPUT_HELP = {
  paste: 'Le texte passe par le presse-papiers puis Ctrl+V. Instantané, même sur un long texte.',
  type: 'Frappe caractère par caractère. Ne touche pas au presse-papiers, mais plus lent.'
};

function renderOutput() {
  setSegmented('#output-mode', config.output.mode);
  $('#output-mode-help').textContent = OUTPUT_HELP[config.output.mode] || '';
  $('#restore-clipboard').checked = config.output.restoreClipboard;
  $('#append-space').checked = config.output.appendSpace;
}

bindSegmented('#output-mode', async (value) => {
  await patch({ output: { mode: value } });
  renderOutput();
});

$('#restore-clipboard').addEventListener('change', (e) =>
  patch({ output: { restoreClipboard: e.target.checked } })
);
$('#append-space').addEventListener('change', (e) => patch({ output: { appendSpace: e.target.checked } }));

$('#test-injection').addEventListener('click', async () => {
  try {
    const result = await api.invoke('engine:testInjection');
    toast('Texte inséré par ' + result.method + '.', 'success');
  } catch (err) {
    toast('Échec de l\'injection : ' + err.message, 'error');
  }
});

/* ------------------------------------------------------------------ *
 * Micro
 * ------------------------------------------------------------------ */

async function loadMicrophones() {
  const select = $('#mic-device');
  try {
    const devices = await api.invoke('audio:devices');
    select.innerHTML =
      '<option value="default">Périphérique par défaut</option>' +
      devices
        .filter((d) => d.id && d.id !== 'default')
        .map(
          (d) =>
            '<option value="' +
            d.id.replace(/"/g, '&quot;') +
            '">' +
            d.label.replace(/[&<>]/g, '') +
            '</option>'
        )
        .join('');
    select.value = config.audio.deviceId;
    if (!select.value) select.value = 'default';
    $('#mic-help').textContent = devices.length
      ? devices.length + ' périphérique(s) détecté(s).'
      : 'Aucun micro détecté. Vérifiez les autorisations Windows.';
  } catch (err) {
    $('#mic-help').textContent = 'Impossible de lister les micros : ' + err.message;
  }
}

$('#refresh-mics').addEventListener('click', loadMicrophones);

$('#mic-device').addEventListener('change', async (e) => {
  await patch({ audio: { deviceId: e.target.value } });
  await api.invoke('audio:reinit');
  toast('Micro changé.');
});

$('#max-duration').addEventListener('change', (e) =>
  patch({ audio: { maxDurationSec: Number(e.target.value) } })
);

$('#silence-threshold').addEventListener('input', (e) => {
  $('#silence-value').textContent = Number(e.target.value).toFixed(3);
});
$('#silence-threshold').addEventListener('change', (e) =>
  patch({ audio: { silenceThreshold: Number(e.target.value) } })
);

api.on('level', (payload) => {
  const meter = $('#mic-meter');
  if (!meter) return;
  const amplitude = Math.min(1, Math.sqrt((payload.peak ?? 0) * 7));
  meter.style.width = (amplitude * 100).toFixed(1) + '%';
});

/* ------------------------------------------------------------------ *
 * Général
 * ------------------------------------------------------------------ */

function applyTheme(theme) {
  const dark =
    theme === 'dark' ||
    (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  if (summary) renderChart(summary.series);
}

window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (config?.ui.theme === 'system') applyTheme('system');
});

bindSegmented('#theme', async (value) => {
  await patch({ ui: { theme: value } });
  applyTheme(value);
});

$('#show-overlay').addEventListener('change', (e) => patch({ ui: { showOverlay: e.target.checked } }));
$('#overlay-position').addEventListener('change', (e) =>
  patch({ ui: { overlayPosition: e.target.value } })
);
$('#history-enabled').addEventListener('change', (e) =>
  patch({ history: { enabled: e.target.checked } })
);

$('#launch-at-login').addEventListener('change', async (e) => {
  await api.invoke('app:setLaunchAtLogin', e.target.checked);
  await patch({ ui: { launchAtLogin: e.target.checked } });
});

$('#open-data').addEventListener('click', () => api.invoke('app:openPath', 'userData'));
$('#open-repo').addEventListener('click', () =>
  api.invoke('app:openExternal', appInfo?.repository || 'https://github.com')
);

$('#reset-stats').addEventListener('click', async () => {
  await api.invoke('stats:reset');
  await refreshStats();
  toast('Statistiques réinitialisées.', 'success');
});

$('#reset-config').addEventListener('click', async () => {
  config = await api.invoke('config:reset');
  renderAll();
  toast('Réglages réinitialisés.', 'success');
});

$('#btn-minimize').addEventListener('click', () => api.invoke('window:minimize'));
$('#btn-close').addEventListener('click', () => api.invoke('window:close'));

/* ------------------------------------------------------------------ *
 * Rendu global
 * ------------------------------------------------------------------ */

function renderAll() {
  suppressWrites = true;

  applyTheme(config.ui.theme);
  setSegmented('#theme', config.ui.theme);
  renderHotkey();
  renderCleanup();
  renderOutput();

  $('#language').value = config.whisper.language;
  $('#use-gpu').checked = config.whisper.useGpu;
  $('#threads').value = config.whisper.threads;
  $('#initial-prompt').value = config.whisper.initialPrompt;
  setSegmented('#strategy', config.whisper.strategy);

  $('#max-duration').value = config.audio.maxDurationSec;
  $('#silence-threshold').value = config.audio.silenceThreshold;
  $('#silence-value').textContent = Number(config.audio.silenceThreshold).toFixed(3);

  $('#show-overlay').checked = config.ui.showOverlay;
  $('#overlay-position').value = config.ui.overlayPosition;
  $('#launch-at-login').checked = config.ui.launchAtLogin;
  $('#history-enabled').checked = config.history.enabled;

  suppressWrites = false;
}

api.on('config:changed', (next) => {
  config = next;
  renderAll();
});

api.on('stats:changed', () => {
  if (!$('#panel-dashboard').hidden) refreshStats();
});

api.on('toast', (payload) => toast(payload.message, payload.kind));

async function boot() {
  config = await api.invoke('config:get');
  appInfo = await api.invoke('app:info');

  $('#app-version').textContent = 'v' + appInfo.version;
  $('#data-path').textContent = appInfo.userData;
  $('#about-text').textContent =
    'Feather ' +
    appInfo.version +
    ' — dictée vocale entièrement locale, basée sur whisper.cpp. Electron ' +
    appInfo.electron +
    ', Node ' +
    appInfo.node +
    '.';

  renderAll();
  showPanel(panelFromHash());
  await refreshEngine();
  await refreshStats();
}

boot().catch((err) => {
  console.error(err);
  toast('Erreur au démarrage : ' + err.message, 'error');
});
