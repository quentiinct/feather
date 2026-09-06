# Feather

Dictée vocale pour Windows, entièrement locale. Vous appuyez sur **Ctrl + Maj**, vous
parlez, et le texte s'écrit dans l'application où se trouve votre curseur — éditeur de
code, navigateur, messagerie, champ de recherche.

Une alternative à [Wispr Flow](https://wisprflow.ai) qui ne dépend d'aucun service en
ligne : la transcription tourne sur votre machine avec [whisper.cpp](https://github.com/ggml-org/whisper.cpp),
et aucun octet d'audio ne quitte l'ordinateur.

---

## Ce que ça fait

- **Un raccourci, n'importe où.** `Ctrl + Maj` par défaut. Appui bref pour démarrer et
  arrêter, appui maintenu pour un fonctionnement talkie-walkie. Le raccourci cohabite
  avec vos autres raccourcis : si vous enchaînez sur une troisième touche
  (`Ctrl + Maj + T`), Feather annule sans rien écrire.
- **Transcription locale et rapide.** whisper.cpp avec accélération CUDA quand une carte
  NVIDIA est présente. Le modèle reste chargé en mémoire vidéo entre deux dictées :
  **~210 ms** pour huit secondes de parole sur une RTX 3060 (modèle `large-v3-turbo-q5`).
- **Nettoyage du texte.** Whisper est fidèle, mais l'oral n'est pas de l'écrit. Feather
  supprime les hésitations, les répétitions, ponctue et applique votre dictionnaire
  personnel. Trois modes, tous gratuits — voir plus bas.
- **Insertion partout.** Collage via le presse-papiers (restauré juste après) ou frappe
  Unicode caractère par caractère pour les champs qui refusent le collage.
- **Statistiques.** Mots dictés, temps gagné par rapport au clavier, débit de parole,
  série de jours, historique local des transcriptions.

## Captures

L'application vit dans la zone de notification. Pendant une dictée, une pastille
discrète affiche le niveau sonore et le chronomètre ; elle ne prend jamais le focus,
sinon le texte atterrirait dans Feather au lieu de votre éditeur.

---

## Installation

Prérequis : **Windows 10/11 x64** et **Node.js 20+**.

```bash
git clone https://github.com/quentiinct/feather.git
cd feather
npm install
npm run setup     # télécharge whisper.cpp + le modèle par défaut
npm start
```

`npm run setup` détecte votre GPU et choisit le bon build :

| Commande | Effet |
| --- | --- |
| `npm run setup` | build CUDA si une carte NVIDIA est détectée, sinon CPU |
| `npm run setup -- --cpu` | force le build CPU (8 Mo au lieu de 640 Mo) |
| `npm run setup -- --cuda` | force le build CUDA 12.4 |
| `npm run setup -- --model ggml-small` | choisit un autre modèle |
| `npm run setup -- --model-only` | ne retélécharge que le modèle |

Pour produire un installateur : `npm run build` (sortie dans `dist/`).

---

## Le nettoyage du texte, gratuitement

C'est la partie qui distingue une dictée utilisable d'une transcription brute. Les trois
modes fonctionnent **sans aucun service payant** :

### `off` — brut

Le texte de Whisper est inséré tel quel. Les balises non verbales (`[Musique]`) et les
hallucinations connues sur du silence (« Sous-titres réalisés par… ») sont tout de même
retirées, sinon elles pollueraient vos documents.

### `rules` — règles locales *(défaut)*

Traitement déterministe, instantané, sans dépendance ni coût :

- suppression des hésitations (« euh », « hum », « ben »…) ;
- suppression des répétitions, y compris les groupes de mots
  (« on va on va commencer » → « on va commencer ») ;
- espacement et ponctuation, majuscules en début de phrase ;
- typographie française optionnelle (espace insécable avant `: ; ! ?`) ;
- dictionnaire personnel pour les noms propres et le jargon.

### `llm` — modèle local via Ollama

Pour une reformulation plus fine (auto-corrections du type « mardi, non, vendredi »), un
petit modèle tourne **sur votre machine**. Gratuit, hors ligne, aucun token facturé :

```bash
winget install Ollama.Ollama
ollama pull qwen2.5:3b-instruct
```

Puis, dans Feather : **Nettoyage → LLM local → Tester**. Un modèle de 3 milliards de
paramètres tient largement dans la mémoire d'une RTX 3060 et ajoute environ une seconde.
Si Ollama ne répond pas ou dépasse le délai configuré, Feather retombe automatiquement
sur les règles — une dictée n'est jamais perdue à cause du LLM.

---

## Architecture

```
src/
  main/                 processus principal Electron
    index.js            cycle de vie, fenêtres, tray, pipeline de dictée
    config.js           réglages persistés, fusionnés avec les défauts
    stats.js            compteurs, séries quotidiennes, historique
    hotkey.js           raccourci global (hook clavier bas niveau)
    whisper.js          pilote whisper.cpp en sous-processus
    cleanup.js          nettoyage par règles + LLM local
    injector.js         insertion du texte dans l'application active
    downloader.js       téléchargements avec progression
    install-binaries.js installation de whisper.cpp
  preload/bridge.js     pont IPC (canaux explicitement autorisés)
  renderer/
    capture/            fenêtre cachée : micro, PCM 16 kHz, encodage WAV
    overlay/            pastille flottante pendant la dictée
    settings/           réglages et statistiques
resources/inject.ps1    helper Win32 SendInput, gardé vivant
scripts/                setup whisper.cpp, génération des icônes
```

Quelques choix qui méritent une explication :

- **Le raccourci passe par un hook clavier**, pas par `globalShortcut` : Electron ne sait
  pas enregistrer une combinaison de modificateurs seuls. Dès que `Ctrl + Maj` est
  complet, la capture démarre en silence ; elle n'est confirmée qu'après 160 ms, le temps
  de voir si vous tapiez en fait un vrai raccourci.
- **whisper.cpp tourne en serveur, pas en ligne de commande.** Un appel à `whisper-cli`
  recharge le modèle à chaque fois — 2 s pour un `large-v3-turbo-q5`. Feather garde
  `whisper-server` vivant et lui envoie le WAV en HTTP local : 210 ms au lieu de 2 s.
  Le modèle est même préchargé au démarrage de l'application, pour que la toute
  première dictée soit déjà rapide. Si le serveur ne démarre pas, meurt, ou refuse une
  requête, le chemin ligne de commande reprend la main — la dictée aboutit quand même.
- **L'injection passe par un processus PowerShell persistant.** Compiler le code Win32
  coûte environ une seconde ; le faire à chaque dictée serait intenable. Le helper est
  lancé au démarrage et répond ensuite en 1 ms.
- **Le micro reste ouvert** dans une fenêtre cachée. Le rouvrir à chaque dictée ferait
  clignoter l'indicateur Windows et ajouterait de la latence sur les premiers mots.
- **L'overlay n'est pas focusable.** Une fenêtre qui prend le focus recevrait le collage
  à la place de votre éditeur.

---

## Réglages notables

| Réglage | Où | Pourquoi y toucher |
| --- | --- | --- |
| Modèle | Transcription | `large-v3-turbo-q5` est le bon défaut ; descendez à `small` sans GPU |
| Amorce de contexte | Transcription | Quelques mots de votre jargon améliorent nettement les noms propres |
| Dictionnaire | Nettoyage | Corrige définitivement les mots que Whisper écrit mal |
| Méthode de sortie | Sortie | Passez en « frappe » si une application refuse le collage |
| Seuil de silence | Micro | Montez-le si des dictées vides passent à travers |

Réglages, statistiques et historique sont stockés en clair dans
`%APPDATA%\Feather\` (bouton **Général → Ouvrir**).

---

## Licence

MIT.
