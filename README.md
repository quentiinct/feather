<img src="assets/feather-pixel.png" alt="Feather" width="156" />

# Feather

Vous maintenez un raccourci, vous parlez, et le texte s'écrit dans la fenêtre qui a le
focus — votre éditeur, votre navigateur, une conversation, un champ de recherche. La
transcription tourne entièrement sur votre machine, avec
[whisper.cpp](https://github.com/ggml-org/whisper.cpp). Aucun compte, aucune clé d'API,
aucun octet d'audio ne quitte l'ordinateur.

Feather est une alternative hors ligne à [Wispr Flow](https://wisprflow.ai).

---

## Sommaire

- [Ce que ça fait](#ce-que-ça-fait)
- [Systèmes pris en charge](#systèmes-pris-en-charge)
- [Prérequis](#prérequis)
- [Installation](#installation)
- [Utilisation](#utilisation)
- [Fonctionnement](#fonctionnement)
- [Performances](#performances)
- [Configuration](#configuration)
- [Architecture](#architecture)
- [Construire une version](#construire-une-version)
- [Données et vie privée](#données-et-vie-privée)
- [Licence](#licence)

---

## Ce que ça fait

**Un raccourci, partout.** Deux modificateurs — `Ctrl + Maj` par défaut, au choix parmi
Ctrl, Maj, Alt et la touche Windows. Un appui bref démarre puis arrête, un appui
maintenu fonctionne en talkie-walkie. Il cohabite avec vos raccourcis habituels : si une
troisième touche arrive dans la foulée (`Ctrl + Maj + T`), Feather annule sans rien
écrire.

**Transcription locale et rapide.** whisper.cpp, avec accélération CUDA si une carte
NVIDIA est présente. Le modèle reste chargé en mémoire vidéo entre deux dictées : une
phrase revient en 200 ms environ, au lieu des deux secondes que coûterait un
rechargement.

**De l'oral, pas de l'écrit.** Whisper est fidèle, mais on ne parle pas comme on écrit.
Feather supprime les hésitations et les répétitions, corrige l'espacement et les
majuscules, applique la typographie française, et passe votre dictionnaire personnel sur
les noms propres et le jargon qu'il écrit mal.

**Sauts de ligne dictés.** Dites *« à la ligne »*, *« nouveau paragraphe »* ou *« point à
la ligne »*, et vous obtenez un vrai saut de ligne au lieu des mots.

**Le texte arrive partout.** Collage par le presse-papiers par défaut, avec restauration
immédiate de son contenu précédent ; frappe Unicode caractère par caractère en repli,
pour les champs qui refusent le collage.

**Un retour discret.** Une pastille flottante affiche le niveau d'entrée et un
chronomètre pendant que vous parlez, et deux brefs bips marquent le début et la fin. La
pastille ne prend jamais le focus — une fenêtre qui le prendrait recevrait le collage à
la place de votre éditeur.

**Statistiques.** Mots dictés, temps gagné par rapport au clavier, débit de parole, série
de jours consécutifs, et un graphique sur 30 jours en barres, en ligne ou en tableau.

---

## Systèmes pris en charge

Feather fonctionne sous Windows, macOS et Linux. Ce qui change d'un système à l'autre,
c'est la façon d'obtenir les trois pièces qui ne sont pas portables : le moteur de
transcription, le raccourci global, et l'écriture dans une autre fenêtre.

| | Windows | macOS | Linux (X11) | Linux (Wayland) |
|---|---|---|---|---|
| Moteur | téléchargé par `npm run setup` | `brew install whisper-cpp` | téléchargé par `npm run setup` | idem |
| GPU | build CUDA disponible | Metal, via votre propre build | build CPU seulement | build CPU seulement |
| Raccourci global | fonctionne | autorisation d'accessibilité | fonctionne | **impossible** |
| Écriture dans les applications | intégrée | autorisation d'accessibilité | nécessite `xdotool` | `wtype` ou `ydotool` |
| Démarrage automatique | élément d'ouverture | élément d'ouverture | `~/.config/autostart` | idem |

**Wayland ne peut pas fonctionner, et aucune application n'y changera rien.** Le
protocole interdit délibérément à un client d'écouter le clavier global ou d'envoyer des
frappes à une autre fenêtre. Feather le dit au démarrage plutôt que de faire semblant.
Ouvrez une session Xorg pour l'utiliser.

**macOS demande une autorisation, une fois.** La première dictée déclenche la demande
système ; tant que Feather n'a pas accès dans Réglages Système → Confidentialité et
sécurité → Accessibilité, le raccourci comme la frappe restent muets.

**Linux a besoin de libgomp1.** Le moteur publié se lie à la bibliothèque OpenMP de GNU
sans l'embarquer. La plupart des installations de bureau l'ont déjà, les installations
minimales non, et le symptôme est un moteur qui démarre et ne dit rien. Feather nomme
désormais la bibliothèque manquante au lieu de prétendre que whisper.cpp n'est pas
installé.

**Linux a besoin d'un petit outil** pour la frappe elle-même : `xdotool` sous X11 (le
paquet `.deb` le recommande), `wtype` ou `ydotool` sous Wayland. Sans lui, le texte
atterrit quand même dans le presse-papiers, prêt à être collé à la main.

---

## Prérequis

| | |
|---|---|
| Système | Windows 10/11, macOS 12+, ou Linux en session X11 |
| Node.js | 20 ou plus récent, pour lancer depuis les sources |
| GPU | Facultatif. Sous Windows, une carte NVIDIA avec CUDA 12 va environ dix fois plus vite |
| Disque | 10 Mo à 640 Mo pour le moteur, plus 500 Mo à 1,5 Go par modèle |
| Mémoire | ~2 Go de mémoire vidéo avec le modèle recommandé |

Sans GPU, tout fonctionne quand même : prenez le modèle `Small` et comptez deux ou trois
secondes par phrase au lieu d'une fraction de seconde.

---

## Installation

```bash
git clone https://github.com/quentiinct/feather.git
cd feather
npm install
npm run setup     # télécharge whisper.cpp et le modèle par défaut
npm start
```

`npm run setup` choisit ce qui correspond à la machine. Sous Windows il télécharge le
build CUDA si une carte NVIDIA est présente, sous Linux le build CPU publié ; sous macOS
il cherche une installation existante, faute de binaires publiés en amont :

```bash
brew install whisper-cpp             # macOS : le moteur qu'utilisera Feather
sudo apt install libgomp1 xdotool    # Linux : bibliothèque du moteur + outil de frappe
```

Options :

| Commande | Effet |
|---|---|
| `npm run setup` | build CUDA si une carte NVIDIA est trouvée (Windows), build CPU sinon |
| `npm run setup -- --cpu` | force le build CPU (8 Mo au lieu de 640 Mo) |
| `npm run setup -- --cuda` | force le build CUDA 12.4 |
| `npm run setup -- --model ggml-small` | choisit un autre modèle |
| `npm run setup -- --model-only` | ne retélécharge que le modèle |

### Modèles

| Modèle | Taille | Remarques |
|---|---|---|
| `ggml-small` | 488 Mo | Le choix raisonnable sur processeur seul |
| `ggml-medium` | 1,5 Go | Précis, lent sans GPU |
| `ggml-large-v3-turbo-q5_0` | 574 Mo | **Recommandé.** Le meilleur rapport qualité/temps |
| `ggml-large-v3-q5_0` | 1,1 Go | Qualité maximale ; demande un GPU pour rester confortable |

Les modèles sont téléchargés depuis Hugging Face dans le dossier `models` du répertoire
de données de Feather (voir [Données et vie privée](#données-et-vie-privée)), vérifiés
sur leur taille attendue et leur nombre magique GGML, puis écrits de façon atomique : un
téléchargement interrompu ne peut jamais laisser un demi-fichier qui échouerait plus
tard, au moment d'une dictée.

---

## Utilisation

| Action | Effet |
|---|---|
| Appui bref sur les deux modificateurs | Démarre l'enregistrement ; un second appui l'arrête et insère |
| Appui maintenu | Enregistre tant que les touches sont tenues, insère au relâchement |
| Une troisième touche | Annule — votre raccourci habituel passe intact |
| `Échap` pendant l'enregistrement | Jette l'enregistrement |
| Fermer la fenêtre | Feather continue dans la zone de notification |

Feather vit dans la zone de notification. Fermer la fenêtre de réglages la masque au lieu
de quitter ; on quitte depuis le menu de la zone de notification.

### Commandes dictées

| Vous dites | Vous obtenez |
|---|---|
| « à la ligne », « retour à la ligne » | un saut de ligne |
| « point à la ligne » | un point, puis un saut de ligne |
| « nouveau paragraphe », « nouvelle ligne » | une ligne vide |

Elles ne sont interprétées que lorsqu'elles forment une commande à elles seules. « Je
pense à la ligne budgétaire » garde ses mots, parce qu'un mot ou un chiffre qui suit la
formule annule la substitution.

---

## Fonctionnement

```
   Ctrl + Maj              uiohook-napi, hook clavier bas niveau
        │                  Electron ne sait pas enregistrer des modificateurs seuls
        ▼
   fenêtre cachée          le micro reste ouvert, PCM 16 kHz mono
        │                  le rouvrir à chaque dictée ferait clignoter l'indicateur
        ▼                  du système et couperait les premiers mots
   WAV temporaire
        │
        ▼
   whisper-server          serveur HTTP résident, modèle gardé en mémoire vidéo
        │   └─ repli       whisper-cli, ~2 s, si le serveur n'est pas prêt
        ▼
   nettoyage               hésitations, répétitions, espacement, majuscules,
        │                  typographie, dictionnaire, sauts de ligne dictés
        ▼
   injection               collage + Ctrl+V (Cmd+V sur macOS), envoyé par
        │                  l'outil de frappe propre au système
        ▼
   votre application
```

Quelques choix qui méritent une explication :

**Le raccourci passe par un hook clavier, pas par `globalShortcut`.** Electron ne sait
pas enregistrer une combinaison de modificateurs seuls. Dès que les deux touches sont
enfoncées, la capture démarre en silence ; elle n'est confirmée qu'après 160 ms, le délai
pendant lequel une troisième touche peut encore arriver et transformer le geste en
raccourci ordinaire.

**whisper.cpp tourne en serveur, pas en ligne de commande.** Chaque appel à `whisper-cli`
recharge le modèle — environ deux secondes pour un `large-v3-turbo-q5`. Feather garde
`whisper-server` vivant et lui envoie le WAV en HTTP local. Le modèle est préchargé au
lancement, pour que la toute première dictée soit déjà rapide.

**Le démarrage du serveur ne bloque jamais une dictée.** C'est une tâche de fond. Une
dictée l'attend au plus 2,5 secondes, puis part sur le CLI pendant que le modèle finit de
charger ; la suivante trouve le serveur prêt. L'initialisation de CUDA peut prendre une
minute au premier lancement après un redémarrage, et c'est ce qui rend cette minute
invisible.

**Le modèle est déchargé au repos.** Après 30 minutes sans dictée, le serveur s'arrête et
rend la mémoire vidéo. La dictée suivante coûte un aller-retour par le CLI (~2 s) le
temps du rechargement. Mettez `whisper.serverIdleMinutes` à `0` pour le garder chargé en
permanence.

**L'injection est une interface à trois implantations.** Le presse-papiers vient
d'Electron et se comporte partout pareil ; seule la frappe change. Windows garde un
helper PowerShell vivant — compiler l'interop Win32 coûte environ une seconde, et la
payer à chaque dictée serait intenable, alors il démarre une fois et répond ensuite en
une milliseconde. macOS appelle `osascript`, Linux appelle `xdotool` ou son équivalent
Wayland ; l'un comme l'autre démarrent en quelques millisecondes, donc un processus par
frappe coûte moins cher qu'un protocole à maintenir. Si l'un d'eux échoue, le texte reste
dans le presse-papiers au lieu d'être perdu.

**L'overlay ne peut pas prendre le focus.** Toute autre solution le ferait recevoir le
collage à la place de votre éditeur.

---

## Performances

Mesuré sur une RTX 3060 (12 Go) avec `large-v3-turbo-q5`, sur huit secondes de parole :

| Situation | Latence |
|---|---|
| Serveur chaud | 180–330 ms |
| Première dictée après un déchargement | ~1,9 s |
| La suivante | ~180 ms |
| Premier démarrage du serveur après un redémarrage | jusqu'à 80 s, en tâche de fond |

Sur une machine froide, le coût dominant est la création du contexte CUDA, pas Whisper
lui-même. C'est pour cette raison que le serveur est lancé au démarrage puis maintenu en
vie.

---

## Configuration

La fenêtre de réglages couvre ce qui se change au quotidien :

| Section | Contenu |
|---|---|
| **Tableau de bord** | Statistiques et graphique sur 30 jours |
| **Général** | Thème, overlay, retour sonore, démarrage automatique, mises à jour, dossier de données |
| **Raccourci** | Modificateurs, bascule ou maintien, seuil de maintien |
| **Micro** | Périphérique d'entrée, niveau, durée maximale, seuil de silence |
| **Transcription** | Modèle, langue, GPU, amorce de contexte, dictionnaire personnel |

Le reste vit dans le `config.json` du répertoire de données, du JSON fusionné par-dessus
les valeurs par défaut de [`src/shared/defaults.js`](src/shared/defaults.js) :

| Clé | Défaut | Rôle |
|---|---|---|
| `output.mode` | `paste` | `type` écrit caractère par caractère, pour les champs qui refusent le collage |
| `output.restoreClipboard` | `true` | Remet votre presse-papiers après le collage |
| `output.appendSpace` | `true` | Espace finale, pour enchaîner les dictées |
| `whisper.serverIdleMinutes` | `30` | `0` garde le modèle en mémoire vidéo indéfiniment |
| `whisper.binDir` | `""` | Dossier des exécutables whisper.cpp ; indispensable sur macOS |
| `whisper.initialPrompt` | `""` | Quelques mots de votre jargon améliorent les noms propres |
| `cleanup.rules.*` | tout activé | Les passes de nettoyage, une par une |
| `cleanup.mode` | `rules` | `llm` passe par un modèle Ollama local ; `off` désactive le nettoyage |
| `history.maxEntries` | `200` | Historique local des transcriptions |
| `audio.silenceThreshold` | `0.006` | À monter si des dictées vides passent |

Le mode `llm` n'a pas d'interface. Il envoie la transcription à un modèle
[Ollama](https://ollama.com) local pour une reformulation plus fine — les
auto-corrections du type « mardi, non, vendredi » — retombe sur le nettoyage par règles à
la moindre erreur ou au moindre dépassement de délai, et reste gratuit et hors ligne.

---

## Architecture

```
src/
  main/                    processus principal Electron
    index.js               cycle de vie, fenêtres, zone de notification, pipeline
    config.js              réglages persistés, fusionnés avec les défauts
    stats.js               compteurs, séries quotidiennes, historique
    hotkey.js              raccourci de modificateurs seuls, via un hook bas niveau
    whisper.js             pilote whisper.cpp : serveur, repli CLI, déchargement
    cleanup.js             nettoyage par règles, sauts de ligne dictés, dictionnaire
    injector.js            presse-papiers et stratégie d'insertion
    keystroke.js           la frappe elle-même, une implantation par système
    platform.js            tout ce sur quoi les trois systèmes divergent
    downloader.js          téléchargements avec progression et vérification
    install-binaries.js    installation de whisper.cpp
    updater.js             branchement d'electron-updater
  preload/bridge.js        pont IPC, une liste d'autorisation par direction
  renderer/
    capture/               fenêtre cachée : micro, PCM 16 kHz, encodage WAV
    overlay/               pastille flottante pendant la dictée
    settings/              réglages et statistiques
    fonts/                 sous-ensembles Google Sans Flex et Sansation embarqués
resources/inject.ps1       helper Win32 SendInput, gardé vivant (Windows seulement)
scripts/                   installation de whisper.cpp, génération des icônes
```

Le rendu est cloisonné comme il se doit : `contextIsolation` activé, `nodeIntegration`
désactivé, et une CSP qui n'autorise aucune origine distante. Les polices sont embarquées
pour exactement cette raison. Chaque canal IPC est déclaré explicitement dans
[`src/preload/bridge.js`](src/preload/bridge.js) — invoke, send et receive ont chacun
leur liste.

### Système graphique

Trois couleurs, appliquées aux deux thèmes : Coconut White `#F2F1EA`, Obsidian Ink
`#151311`, Velvet Curfew `#4B262F`. Le thème sombre est composé, pas déduit : ses valeurs
sont choisies séparément, pas inversées. Les marques du graphique utilisent un pas plus
clair de la même teinte, parce que Velvet Curfew est sous la bande de luminosité lisible
pour une donnée.

Les icônes viennent de `npm run icons`, engendrées depuis une seule géométrie — une plume
dont les barbes sont les barres d'une forme d'onde — avec moins de barbes, plus épaisses,
sur les petites tailles, pour que la forme survive à 16 px. Aucune dépendance graphique :
le script encode lui-même le PNG et le ICO, ainsi que la plume en pixel art de ce fichier.

---

## Construire une version

```bash
npm run build         # installateur pour le système courant, dans dist/
npm run build:win     # installateur NSIS
npm run build:mac     # dmg + zip, arm64 et x64
npm run build:linux   # AppImage + deb
npm run pack          # dossier non empaqueté, pour une vérification rapide
npm run release       # construit et publie sur GitHub Releases
```

Chaque installateur doit être construit sur son propre système : electron-builder ne sait
signer et empaqueter que pour la plateforme sur laquelle il tourne. Les versions macOS
sont non signées tant que vous ne fournissez pas d'identifiant de développeur, donc le
premier lancement demande un clic droit → Ouvrir.

Les mises à jour passent par `electron-updater` et GitHub Releases : l'application
vérifie au lancement puis toutes les six heures, télécharge en tâche de fond, vous
prévient, et installe à la fermeture. Rien à réinstaller à la main. Cela ne fonctionnera
qu'une fois le dépôt et ses versions publics.

---

## Données et vie privée

Aucun appel réseau pendant l'usage normal. Les seules requêtes sortantes que Feather
émette sont les téléchargements de modèles que vous déclenchez et la vérification des
mises à jour.

Tout est stocké dans le répertoire de données — **Général → Ouvrir** l'ouvre, quel que
soit le système :

| | |
|---|---|
| Windows | `%APPDATA%\Feather\` |
| macOS | `~/Library/Application Support/Feather/` |
| Linux | `~/.config/Feather/` |

| Fichier | Contenu |
|---|---|
| `config.json` | Réglages |
| `stats.json` | Compteurs et séries quotidiennes |
| `history.json` | Historique local des transcriptions |
| `models/` | Modèles GGML téléchargés |

L'audio est écrit dans un WAV temporaire, remis au moteur local, puis supprimé
immédiatement — sauf si vous activez `privacy.keepAudioFiles` pour du débogage.

---

## Licence

MIT. Voir [LICENSE](LICENSE).
