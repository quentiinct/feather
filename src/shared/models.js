'use strict';

const HF_BASE = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main';

/**
 * Catalogue des modèles GGML disponibles au téléchargement.
 * `sizeMB` est approximatif et sert uniquement à l'affichage.
 */
const MODELS = [
  {
    id: 'ggml-small',
    label: 'Small',
    sizeMB: 488,
    multilingual: true,
    quality: 3,
    speed: 4,
    note: 'Bon compromis sur CPU seul.'
  },
  {
    id: 'ggml-medium',
    label: 'Medium',
    sizeMB: 1530,
    multilingual: true,
    quality: 4,
    speed: 2,
    note: 'Précis, mais lent sans GPU.'
  },
  {
    id: 'ggml-large-v3-turbo-q5_0',
    label: 'Large v3 Turbo (Q5)',
    sizeMB: 574,
    multilingual: true,
    quality: 5,
    speed: 4,
    recommended: true,
    note: 'Le meilleur rapport qualité/vitesse. Recommandé avec une carte NVIDIA.'
  },
  {
    id: 'ggml-large-v3-q5_0',
    label: 'Large v3 (Q5)',
    sizeMB: 1080,
    multilingual: true,
    quality: 5,
    speed: 2,
    note: 'Qualité maximale. Nécessite un GPU pour rester confortable.'
  }
];

function modelUrl(id) {
  return `${HF_BASE}/${id}.bin`;
}

function findModel(id) {
  return MODELS.find((m) => m.id === id) || null;
}

module.exports = { MODELS, modelUrl, findModel, HF_BASE };
