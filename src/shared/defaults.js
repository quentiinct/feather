'use strict';

/**
 * Schéma de configuration de VoxFlow.
 * Toute valeur absente du fichier utilisateur retombe sur ces défauts
 * (fusion récursive faite par src/main/config.js).
 */
const DEFAULT_CONFIG = {
  hotkey: {
    // 'modifiers'  -> combinaison de modificateurs seuls (ex. Ctrl+Shift)
    // 'combo'      -> raccourci classique enregistré par Electron (ex. Ctrl+Shift+Space)
    mode: 'modifiers',
    // Modificateurs pour le mode 'modifiers'. Valeurs: ctrl, shift, alt, meta
    modifiers: ['ctrl', 'shift'],
    // Accélérateur Electron pour le mode 'combo'
    accelerator: 'Control+Shift+Space',
    // 'toggle' -> une pression démarre, une seconde arrête
    // 'hold'   -> on enregistre tant que la touche est maintenue
    activation: 'toggle',
    // Durée (ms) au-delà de laquelle un appui est considéré comme un maintien
    holdThresholdMs: 350,
    // Touche d'annulation pendant l'enregistrement
    cancelKey: 'Escape'
  },

  audio: {
    deviceId: 'default',
    // Whisper travaille en 16 kHz mono
    sampleRate: 16000,
    // Coupe l'enregistrement au-delà de cette durée (sécurité)
    maxDurationSec: 120,
    // Seuil RMS en dessous duquel l'audio est considéré comme du silence
    silenceThreshold: 0.006,
    // Rejette les captures plus courtes que ça (appui accidentel)
    minDurationSec: 0.35
  },

  whisper: {
    // Modèle GGML utilisé (voir src/shared/models.js)
    model: 'ggml-large-v3-turbo-q5_0',
    // 'auto' laisse Whisper détecter, sinon code ISO ('fr', 'en', ...)
    language: 'fr',
    // Traduit vers l'anglais au lieu de transcrire
    translate: false,
    // Nombre de threads CPU (0 = auto)
    threads: 0,
    // Accélération GPU CUDA si le build cuBLAS est installé
    useGpu: true,
    // Amorce donnée au décodeur pour orienter le style / vocabulaire
    initialPrompt: '',
    // Température de décodage
    temperature: 0,
    // Coupe les segments sans parole
    suppressNonSpeech: true,
    // 'beam' (plus précis) ou 'greedy' (plus rapide)
    strategy: 'beam',
    beamSize: 5
  },

  cleanup: {
    // 'off'   -> texte brut de Whisper
    // 'rules' -> nettoyage déterministe local, instantané, gratuit
    // 'llm'   -> passage par un LLM local (Ollama), gratuit
    mode: 'rules',
    rules: {
      removeFillers: true,
      fixSpacing: true,
      // Applique la typographie française (espaces insécables avant : ; ! ?)
      frenchTypography: true,
      capitalizeSentences: true,
      // Supprime les répétitions immédiates ("le le chat")
      dedupeWords: true,
      trimTrailingPeriod: false
    },
    llm: {
      endpoint: 'http://127.0.0.1:11434',
      model: 'qwen2.5:3b-instruct',
      timeoutMs: 8000,
      // Si le LLM échoue ou dépasse le délai, on retombe sur le nettoyage par règles
      fallbackToRules: true,
      systemPrompt:
        "Tu es un correcteur de dictée vocale. Reformate le texte transcrit : ponctuation, majuscules, suppression des hésitations et des répétitions, correction des fautes évidentes. Applique les auto-corrections de l'orateur (s'il se reprend, garde la version finale). Ne réponds jamais au contenu, ne l'explique pas, ne le résume pas, n'ajoute aucun commentaire. Conserve la langue d'origine. Renvoie uniquement le texte corrigé."
    },
    // Remplacements appliqués après tout le reste : { from, to, wholeWord }
    dictionary: []
  },

  output: {
    // 'paste' -> presse-papiers + Ctrl+V (rapide, idéal pour les textes longs)
    // 'type'  -> frappe Unicode caractère par caractère (ne touche pas au presse-papiers)
    mode: 'paste',
    // Restaure le contenu du presse-papiers après un collage
    restoreClipboard: true,
    // Délai (ms) entre les caractères en mode 'type'
    typeDelayMs: 1,
    // Ajoute une espace finale pour enchaîner les dictées
    appendSpace: true,
    // Si aucune fenêtre cible, copie simplement dans le presse-papiers
    fallbackToClipboard: true
  },

  ui: {
    theme: 'system', // 'system' | 'dark' | 'light'
    accent: '#6366f1',
    showOverlay: true,
    // 'bottom-center' | 'bottom-right' | 'top-center' | 'top-right'
    overlayPosition: 'bottom-center',
    startMinimized: false,
    launchAtLogin: false,
    soundFeedback: true,
    language: 'fr'
  },

  history: {
    enabled: true,
    // Nombre de transcriptions conservées localement
    maxEntries: 200
  },

  privacy: {
    // Conserve les fichiers WAV sur disque (debug uniquement)
    keepAudioFiles: false
  }
};

module.exports = { DEFAULT_CONFIG };
