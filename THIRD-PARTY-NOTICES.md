# Mentions des tiers

Feather est distribué sous licence MIT (voir `LICENSE`). Cette licence ne
couvre que le code de Feather. Les composants ci-dessous sont livrés avec
l'application ou téléchargés par elle, et restent régis par leurs propres
conditions.

---

## Livrés dans l'installateur

### Electron

Copyright (c) Electron contributors — licence MIT.
<https://github.com/electron/electron>

Electron embarque lui-même Chromium (BSD 3-Clause) et Node.js (MIT), dont les
licences complètes accompagnent chaque version d'Electron dans le fichier
`LICENSES.chromium.html` de l'application installée.

### whisper.cpp et ggml

Copyright (c) 2023-2024 The ggml authors — licence MIT.
<https://github.com/ggml-org/whisper.cpp>

Les exécutables et bibliothèques de `resources/bin` proviennent des binaires
publiés par le projet (version `b4938`) : `whisper-cli`, `whisper-server`, et
les bibliothèques `ggml*` qui les accompagnent.

### Polices

| Famille | Auteur | Licence |
|---|---|---|
| Google Sans Flex | Google | SIL Open Font License 1.1 |
| Sansation | Bernd Montag | SIL Open Font License 1.1 |

Seuls les sous-ensembles `latin` et `latin-ext` sont embarqués. Les notices de
copyright exigées par l'OFL sont conservées dans la table `name` de chaque
fichier WOFF2, comme la licence l'impose.

<https://openfontlicense.org/>

---

## Dépendances npm livrées

| Paquet | Licence |
|---|---|
| `electron-updater` | MIT |
| `uiohook-napi` | MIT |

---

## Téléchargés par l'application

### Modèles Whisper

Copyright (c) 2022 OpenAI — licence MIT.
<https://github.com/openai/whisper>

Les modèles ne sont **pas** livrés avec Feather : ils sont téléchargés à la
demande depuis le dépôt `ggerganov/whisper.cpp` sur Hugging Face, au format
GGML converti par le projet whisper.cpp, et déposés dans le dossier de données
de l'utilisateur.

<https://huggingface.co/ggerganov/whisper.cpp>

### Binaires whisper.cpp

Sous Linux, et sous Windows lorsque l'utilisateur demande l'accélération GPU,
les binaires décrits plus haut sont téléchargés depuis les *releases* GitHub du
projet whisper.cpp plutôt que livrés dans le paquet. Mêmes conditions.

### Bibliothèques d'exécution NVIDIA CUDA

Copyright (c) NVIDIA Corporation. Tous droits réservés.

L'installateur **ne contient aucune** bibliothèque CUDA : il embarque le moteur
processeur. Lorsque l'utilisateur demande l'accélération GPU, Feather télécharge
le build cuBLAS publié par whisper.cpp, qui inclut les redistribuables
`cudart64_12.dll`, `cublas64_12.dll`, `cublasLt64_12.dll`, `nvblas64_12.dll`,
`nvrtc64_120_0.dll` et `ggml-cuda.dll`. Ils sont déposés dans le dossier de
données de l'utilisateur.

Ces fichiers restent régis par le *NVIDIA CUDA Toolkit End User License
Agreement*, dont la clause de redistribution autorise leur livraison avec une
application qui les utilise, sous réserve d'en conserver la mention de
propriété — ce que fait cette notice.

<https://docs.nvidia.com/cuda/eula/>

---

## Outils du système appelés, jamais redistribués

Feather invoque des programmes déjà présents sur la machine et n'en embarque
aucun : `powershell.exe` et `tar.exe` sous Windows, `xdotool`, `wtype` ou
`ydotool` sous Linux. Ils restent régis par leurs licences respectives et par
les conditions de votre distribution.
