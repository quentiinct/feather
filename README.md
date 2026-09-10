<img src="assets/feather-pixel.png" alt="Feather" width="156" />

# Feather

Vous maintenez un raccourci, vous parlez, et le texte s'écrit dans la fenêtre qui a le
focus — éditeur, navigateur, conversation, champ de recherche. Tout tourne sur votre
machine avec [whisper.cpp](https://github.com/ggml-org/whisper.cpp) : aucun compte,
aucune clé d'API, aucun octet d'audio ne quitte l'ordinateur.

Une alternative hors ligne à [Wispr Flow](https://wisprflow.ai). Windows et Linux (X11).

---

## Installation

### Windows — l'installateur

Téléchargez `Feather Setup <version>.exe` depuis la
[page des versions](https://github.com/quentiinct/feather/releases) et lancez-le. Aucun
droit administrateur n'est nécessaire : l'installation se fait pour votre compte, et pose
un raccourci dans le menu Démarrer et sur le bureau.

Au premier lancement, un guide vous fait choisir un modèle de transcription et vous
montre votre raccourci. Comptez quelques minutes pour le téléchargement du modèle.

L'installateur embarque le moteur processeur, qui fonctionne partout. Si vous avez une
carte NVIDIA, Feather vous proposera d'installer le moteur CUDA — environ dix fois plus
rapide, 1,1 Go à télécharger, et rien à faire d'autre que cliquer.

Windows affichera « Éditeur inconnu » : l'exécutable n'est pas signé
cryptographiquement. Passez par **Informations complémentaires → Exécuter quand même**.

Pour désinstaller : Paramètres → Applications → Feather, ou `Uninstall Feather.exe` dans
le dossier d'installation.

### Linux, ou depuis les sources

```bash
git clone https://github.com/quentiinct/feather.git
cd feather
npm install
npm run setup     # télécharge whisper.cpp et le modèle recommandé
npm start
```

Il faut Node.js 20 ou plus récent. `npm run setup` choisit le moteur qui correspond à la
machine : le build CUDA si une carte NVIDIA est présente sous Windows, le build
processeur sinon.

**Sous Linux, deux paquets système sont nécessaires :**

```bash
sudo apt install libgomp1 xdotool
```

`libgomp1` est la bibliothèque OpenMP à laquelle le moteur se lie sans l'embarquer — sans
elle il démarre et reste muet. `xdotool` est l'outil qui écrit dans les autres fenêtres.
Le paquet `.deb` de Feather installe les deux automatiquement.

Sur une installation minimale — WSL, conteneur, serveur — il manque en plus la pile
graphique dont Electron a besoin, et `libXt` pour le raccourci global :

```bash
sudo apt install libnspr4 libnss3 libgtk-3-0 libgbm1 libasound2 libxt6
```

Sur un bureau Linux ordinaire, tout cela est déjà là.

Options de `npm run setup` : `--cpu` force le build processeur (8 Mo au lieu de 640 Mo),
`--cuda` force le build CUDA, `--model <id>` choisit un autre modèle, `--model-only` ne
retélécharge que le modèle.

---

## Utilisation

Le raccourci par défaut est **`Ctrl + Maj`**, modifiable dans les réglages.

| Action | Effet |
|---|---|
| Appui bref sur les deux touches | Démarre l'enregistrement ; un second appui l'arrête et insère le texte |
| Appui maintenu | Enregistre tant que les touches sont tenues, insère au relâchement |
| Une troisième touche | Annule — `Ctrl + Maj + T` reste votre raccourci habituel |
| `Échap` pendant l'enregistrement | Jette l'enregistrement |
| Fermer la fenêtre | Feather continue dans la zone de notification |

Feather vit dans la zone de notification : fermer la fenêtre la masque, on quitte depuis
le menu de l'icône.

### Sauts de ligne dictés

| Vous dites | Vous obtenez |
|---|---|
| « à la ligne », « retour à la ligne » | un saut de ligne |
| « point à la ligne » | un point, puis un saut de ligne |
| « nouveau paragraphe » | une ligne vide |

Uniquement lorsque la formule est seule : « je pense à la ligne budgétaire » garde ses
mots, parce qu'un mot qui suit annule la substitution.

---

## Modèles

| Modèle | Taille | Pour qui |
|---|---|---|
| `ggml-small` | 488 Mo | Processeur seul |
| `ggml-medium` | 1,5 Go | Précis, lent sans GPU |
| `ggml-large-v3-turbo-q5_0` | 574 Mo | **Recommandé** — le meilleur rapport qualité/temps |
| `ggml-large-v3-q5_0` | 1,1 Go | Qualité maximale, demande un GPU |

Ils se téléchargent depuis l'onglet **Transcription**, ou avec
`npm run setup -- --model <id>`.

Sur une RTX 3060 avec le modèle recommandé, une phrase de huit secondes revient en
**180 à 330 ms** serveur chaud. Sans GPU, comptez deux à trois secondes avec `small`.

---

## Réglages

| Section | Contenu |
|---|---|
| **Tableau de bord** | Statistiques et graphique sur 30 jours |
| **Général** | Thème, overlay, retour sonore, démarrage automatique, mises à jour |
| **Raccourci** | Modificateurs, bascule ou maintien |
| **Micro** | Périphérique, niveau, durée maximale, seuil de silence |
| **Transcription** | Modèle, langue, GPU, amorce de contexte, dictionnaire personnel |

Le reste vit dans `config.json`, fusionné par-dessus
[`src/shared/defaults.js`](src/shared/defaults.js). Les clés les plus utiles :

| Clé | Défaut | Rôle |
|---|---|---|
| `output.mode` | `paste` | `type` écrit caractère par caractère, pour les champs qui refusent le collage |
| `whisper.serverIdleMinutes` | `30` | `0` garde le modèle en mémoire vidéo indéfiniment |
| `whisper.initialPrompt` | `""` | Quelques mots de votre jargon améliorent les noms propres |
| `audio.silenceThreshold` | `0.006` | À monter si des dictées vides passent |

---

## Systèmes pris en charge

| | Windows | Linux (X11) | Linux (Wayland) |
|---|---|---|---|
| Moteur | `npm run setup` | `npm run setup` | idem |
| GPU | build CUDA | processeur seulement | processeur seulement |
| Raccourci global | oui | oui | **impossible** |
| Écriture dans les applications | intégrée | `xdotool` | `wtype` ou `ydotool` |

**Wayland ne peut pas fonctionner, et aucune application n'y changera rien.** Le
protocole interdit délibérément à un client d'écouter le clavier global ou d'envoyer des
frappes à une autre fenêtre. Feather le dit au démarrage plutôt que de faire semblant :
ouvrez une session Xorg.

---

## Comment ça marche

```
   Ctrl + Maj          hook clavier bas niveau — Electron ne sait pas
        │              enregistrer des modificateurs seuls
        ▼
   fenêtre cachée      micro maintenu ouvert, PCM 16 kHz mono
        │
        ▼
   whisper-server      serveur HTTP local, modèle gardé en mémoire vidéo
        │  └─ repli    whisper-cli (~2 s) si le serveur n'est pas prêt
        ▼
   nettoyage           hésitations, répétitions, typographie française,
        │              dictionnaire personnel, sauts de ligne dictés
        ▼
   injection           collage + Ctrl+V, avec restauration du presse-papiers
        ▼
   votre application
```

Trois décisions expliquent le reste :

**Le serveur reste vivant.** Chaque appel à `whisper-cli` rechargerait le modèle, deux
secondes à chaque dictée. Feather précharge au lancement, garde `whisper-server` en vie,
et décharge après 30 minutes d'inactivité pour rendre la mémoire vidéo.

**Le raccourci se confirme après 160 ms.** La capture démarre en silence dès les deux
touches enfoncées, mais n'est confirmée qu'après ce délai — le temps qu'une troisième
touche puisse encore arriver et rendre le geste à votre raccourci habituel.

**L'overlay ne prend jamais le focus.** Une fenêtre qui le prendrait recevrait le collage
à la place de votre éditeur.

---

## Données et vie privée

Aucun appel réseau pendant l'usage normal. Les seules requêtes sortantes sont les
téléchargements de modèles que vous déclenchez et la vérification des mises à jour.

Tout est stocké localement — **Général → Ouvrir** y mène :
`%APPDATA%\Feather\` sous Windows, `~/.config/Feather/` sous Linux. On y trouve
`config.json`, `stats.json`, `history.json`, les modèles dans `models/`, et le journal
dans `logs/`.

L'audio est écrit dans un WAV temporaire, remis au moteur local, puis supprimé
immédiatement.

Côté cloisonnement : `contextIsolation` activé, `nodeIntegration` désactivé, une CSP qui
n'autorise aucune origine distante — les polices sont embarquées pour cette raison — et
chaque canal IPC déclaré explicitement dans
[`src/preload/bridge.js`](src/preload/bridge.js).

---

## Construire

```bash
npm run setup -- --cpu   # l'installateur embarque le moteur processeur
npm run build:win        # installateur NSIS
npm run build:linux      # AppImage + deb
npm run setup -- --cuda  # revenir au moteur GPU pour développer
```

**L'installateur n'embarque que le moteur processeur.** Le moteur CUDA pèse 1,1 Go et ne
sert qu'aux machines NVIDIA : Feather le télécharge à la demande, depuis l'onglet
Transcription ou le guide de premier lancement, dans le dossier de données de
l'utilisateur — donc sans droits administrateur. Un garde-fou refuse de construire si
`resources/bin` contient encore les bibliothèques CUDA ; `FEATHER_CUDA_INSTALLER=1` le
lève, pour qui veut délibérément un installateur complet.

Chaque installateur doit être construit sur son propre système : electron-builder
n'empaquette que pour la plateforme sur laquelle il tourne. Les mises à jour passent
ensuite par `electron-updater` et GitHub Releases — vérification au lancement puis toutes
les six heures, téléchargement en tâche de fond, installation à la fermeture.

L'organisation du code est décrite dans [`src/`](src/) : `main/` pour le processus
principal, `preload/` pour le pont IPC, `renderer/` pour les trois fenêtres (capture
cachée, overlay, réglages).

---

## Licence

MIT, voir [LICENSE](LICENSE). Les composants tiers livrés avec l'application — Electron,
whisper.cpp, les redistribuables CUDA, les polices — sont listés dans
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
