'use strict';

/** Espace insécable, utilisé par la typographie française. */
const NBSP = ' ';

/**
 * Hallucinations classiques de Whisper sur du silence ou du bruit de fond.
 * Si le segment ne contient QUE ça, on renvoie une chaîne vide.
 */
const HALLUCINATIONS = [
  /^sous-?titr(es|age)[^.]*$/i,
  /^merci d['’]avoir regard[ée].*$/i,
  /^abonnez-vous.*$/i,
  /^.*amara\.org.*$/i,
  /^thanks? for watching.*$/i,
  /^\s*(you|bye|merci|thank you)\s*[.!]?\s*$/i
];

/** Balises non verbales : [Musique], (rires), passages entre notes de musique. */
const NON_SPEECH =
  /[[(（【]\s*(musique|music|rires?|laughter|applaudissements|applause|silence|bruit|noise|inaudible|soupir)[^\])）】]*[\])）】]|♪[^♪]*♪/gi;

/** Hésitations pures. Tout le reste du vocabulaire est conservé tel quel. */
const FILLERS_FR = [
  'euh', 'heu', 'heuh', 'euhm', 'hum', 'hmm', 'mmh', 'mmm',
  'bah', 'ben', 'bein', 'hein'
];
const FILLERS_EN = ['uh', 'um', 'uhm', 'erm', 'hmm', 'mmm', 'you know', 'i mean'];

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildFillerRegex(list) {
  const alt = list
    .map(escapeRe)
    .sort((a, b) => b.length - a.length)
    .join('|');
  return new RegExp('(^|[\\s,;:.!?\\u2014\\u2013-])(?:' + alt + ')(?=[\\s,;:.!?\\u2026]|$)', 'giu');
}

const RE_FILLERS = buildFillerRegex([...FILLERS_FR, ...FILLERS_EN]);

/** Répétitions légitimes qu'il ne faut surtout pas dédupliquer. */
const LEGIT_DOUBLES = new Set([
  'tres', 'très', 'non', 'oui', 'ha', 'hi', 'ho', 'chut',
  'no', 'yes', 'very', 'nous', 'vous'
]);

/** « le le chat » devient « le chat ». */
function dedupeWords(text) {
  // Les groupes de mots sont traités avant les mots isolés, du plus long au plus
  // court, pour attraper les bégaiements de reprise (« on va on va commencer »).
  let out = text;
  for (let span = 4; span >= 2; span -= 1) {
    const phrase = new RegExp(
      '(?<![\\p{L}\\p{N}])((?:[\\p{L}\'’-]+\\s+){' +
        (span - 1) +
        '}[\\p{L}\'’-]+)\\s+\\1(?![\\p{L}\\p{N}])',
      'giu'
    );
    out = out.replace(phrase, '$1');
  }
  return out.replace(/\b([\p{L}'’-]+)(\s+)\1\b/giu, (match, word) =>
    LEGIT_DOUBLES.has(word.toLowerCase()) ? match : word
  );
}

function fixSpacing(text) {
  return text
    .replace(/ /g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s+([,.;:!?…%])/g, '$1')
    .replace(/([,;])(?=[^\s\d])/g, '$1 ')
    // Un « : » ne prend pas d'espace dans une heure (14:30) ni dans une URL (https://)
    .replace(/:(?=[^\s\d/])/g, ': ')
    .replace(/([.!?…])(?=[\p{Lu}])/gu, '$1 ')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Espace insécable avant la ponctuation double, à la française. */
function frenchTypography(text) {
  return text
    .replace(/\s*([;:!?])/g, NBSP + '$1')
    .replace(/«\s*/g, '«' + NBSP)
    .replace(/\s*»/g, NBSP + '»')
    // Une heure (14:30) ou une URL ne prend pas d'espace avant les deux-points
    .replace(new RegExp('(\\d)' + NBSP + ':(?=\\d)', 'g'), '$1:')
    .replace(new RegExp('(https?)' + NBSP + ':', 'gi'), '$1:');
}

function capitalizeSentences(text) {
  return text
    .replace(/(^|[.!?…]\s+|\n\s*)(\p{Ll})/gu, (m, pre, ch) => pre + ch.toUpperCase())
    .replace(/\bi\b(?=[ '’])/g, 'I');
}

/** Remplacements du dictionnaire personnel (noms propres, jargon, acronymes). */
function applyDictionary(text, dictionary) {
  if (!Array.isArray(dictionary) || dictionary.length === 0) return text;
  let out = text;
  for (const entry of dictionary) {
    if (!entry || !entry.from) continue;
    const flags = entry.caseSensitive ? 'gu' : 'giu';
    const body = escapeRe(entry.from);
    const pattern =
      entry.wholeWord === false
        ? body
        : '(?<![\\p{L}\\p{N}])' + body + '(?![\\p{L}\\p{N}])';
    try {
      out = out.replace(new RegExp(pattern, flags), entry.to ?? '');
    } catch {
      /* motif invalide : on ignore l'entrée plutôt que de casser la dictée */
    }
  }
  return out;
}

/** Nettoyage déterministe, local et instantané. Aucun coût, aucune dépendance. */
function cleanWithRules(rawText, rules = {}, dictionary = []) {
  let text = String(rawText || '').replace(/\r/g, '').trim();
  if (!text) return '';

  text = text.replace(NON_SPEECH, ' ');
  const compact = text.replace(/\s+/g, ' ').trim();
  if (!compact) return '';
  if (HALLUCINATIONS.some((re) => re.test(compact))) return '';

  if (rules.removeFillers !== false) {
    text = text.replace(RE_FILLERS, '$1');
    // Nettoie la ponctuation devenue orpheline après la suppression
    text = text.replace(/(^|\s)[,;]\s*/g, '$1').replace(/\s{2,}/g, ' ');
  }
  if (rules.dedupeWords !== false) text = dedupeWords(text);
  if (rules.fixSpacing !== false) text = fixSpacing(text);
  if (rules.capitalizeSentences !== false) text = capitalizeSentences(text);
  if (rules.frenchTypography) text = frenchTypography(text);
  if (rules.trimTrailingPeriod) text = text.replace(/\s*\.\s*$/, '');

  return applyDictionary(text, dictionary).trim();
}

/**
 * Nettoyage par LLM local via l'API Ollama : le modèle tourne sur la machine,
 * donc aucun token payant. Retombe sur les règles en cas d'échec ou de délai dépassé.
 */
async function cleanWithLlm(rawText, llmConfig, rules, dictionary) {
  const base = cleanWithRules(rawText, { ...rules, capitalizeSentences: false }, []);
  if (!base) return '';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), llmConfig.timeoutMs || 8000);

  const glossary = (dictionary || []).filter((d) => d && d.to).map((d) => d.to).slice(0, 40);
  let system = llmConfig.systemPrompt || '';
  if (glossary.length) {
    system += '\nOrthographes imposées pour ces termes : ' + glossary.join(', ') + '.';
  }

  try {
    const res = await fetch(String(llmConfig.endpoint || '').replace(/\/+$/, '') + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: llmConfig.model,
        stream: false,
        options: { temperature: 0.1, num_predict: Math.max(128, base.length) },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: base }
        ]
      })
    });
    if (!res.ok) throw new Error('Ollama a répondu ' + res.status);

    const json = await res.json();
    let out = (json.message?.content || '').trim();

    // Certains modèles raisonnent à voix haute ou encadrent leur réponse
    out = out.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    out = out.replace(/^```[a-z]*\n?|\n?```$/g, '').trim();
    out = out.replace(/^["«]\s*|\s*["»]$/g, '').trim();

    // Garde-fou : un LLM qui part en vrille ne doit jamais polluer la dictée
    if (!out || out.length > base.length * 3 + 80) {
      throw new Error('Sortie du LLM incohérente');
    }
    return applyDictionary(out, dictionary);
  } catch (err) {
    if (llmConfig.fallbackToRules === false) throw err;
    console.warn('[cleanup] LLM indisponible (' + err.message + '), retour aux règles.');
    return cleanWithRules(rawText, rules, dictionary);
  } finally {
    clearTimeout(timer);
  }
}

/** Point d'entrée unique, piloté par la configuration. */
async function cleanup(rawText, cleanupConfig) {
  const cfg = cleanupConfig || {};
  const dictionary = cfg.dictionary || [];
  const raw = String(rawText || '').trim();
  if (!raw) return '';

  if (cfg.mode === 'off') {
    const compact = raw.replace(NON_SPEECH, ' ').replace(/\s+/g, ' ').trim();
    if (!compact || HALLUCINATIONS.some((re) => re.test(compact))) return '';
    return applyDictionary(compact, dictionary);
  }
  if (cfg.mode === 'llm') {
    return cleanWithLlm(raw, cfg.llm || {}, cfg.rules || {}, dictionary);
  }
  return cleanWithRules(raw, cfg.rules || {}, dictionary);
}

/** Vérifie qu'Ollama tourne et renvoie la liste des modèles installés. */
async function probeOllama(endpoint = 'http://127.0.0.1:11434') {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2500);
  try {
    const res = await fetch(String(endpoint).replace(/\/+$/, '') + '/api/tags', {
      signal: controller.signal
    });
    if (!res.ok) return { available: false, models: [], error: 'HTTP ' + res.status };
    const json = await res.json();
    return { available: true, models: (json.models || []).map((m) => m.name) };
  } catch (err) {
    return {
      available: false,
      models: [],
      error: err.name === 'AbortError' ? 'Délai dépassé' : err.message
    };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { cleanup, cleanWithRules, cleanWithLlm, probeOllama, applyDictionary };
