# Icônes

Deux origines, pour deux usages qui n'ont pas les mêmes contraintes.

| Fichier | Rôle | Origine |
|---|---|---|
| `icon.ico`, `icon.png` | exécutable, fenêtre, barre des tâches | logo fourni, retravaillé |
| `tray-light.png`, `tray-dark.png`, `tray-active.png` | zone de notification | `scripts/make-icons.js` |
| `mark.svg` | barre de titre, qui en embarque une copie | `scripts/make-icons.js` |
| `feather-pixel.png` | en-tête du README | illustration fournie |

Régénérer ce qui est produit par le script : `npm run icons`. Il n'écrit que
les icônes de la zone de notification et `mark.svg` — **pas** l'icône
applicative, qu'il écraserait sinon à chaque `npm install`, puisqu'il tourne au
`postinstall`.

## L'icône applicative

Elle vient de `Gemini_Generated_Image_*.jfif`, gardé ici pour la provenance et
exclu de l'installateur (voir `build.files` dans `package.json`). Le motif est
découpé puis masqué par un rectangle arrondi de 22,7 % du côté, et recadré pour
occuper 90 % de la tuile : tel quel il n'en remplissait que 63 %, ce qui donnait
un dessin illisible à la taille de la barre des tâches. Pas plus de 90 % non
plus — au-delà, la pointe vient buter dans les coins arrondis.

Le fond « transparent » de l'image source n'en est pas un : c'est un JPEG, son
damier est peint dans les pixels et a dû être retiré.

Le `.ico` contient sept tailles, de 256 à 16 px. Windows y pioche celle qu'il
lui faut selon la mise à l'échelle de l'écran plutôt que de rééchantillonner.

Pour revenir au logo tracé, `scripts/make-icons.js` garde `drawAppIcon` et
`encodeIco`, et le bloc à restaurer est en commentaire dans `main()`.

## Zone de notification et barre de titre

Une seule géométrie : une plume dont les barbes sont les barres d'une forme
d'onde, avec moins de barbes et plus épaisses aux petites tailles, pour que la
forme survive à 16 px. Aucune dépendance graphique — le script encode lui-même
le PNG.

Les icônes de la zone de notification sont monochromes sur fond transparent.
Windows les pose sur une barre claire ou sombre selon le réglage système, sans
équivalent des « template images » de macOS : on produit donc les deux
versions, coco et obsidienne, et l'application choisit à l'exécution. La version
`active`, pendant une dictée, est en `#B0223A`, le rouge d'alerte de la palette.

## Couleurs

La palette de l'application : Coconut White `#F2F1EA`, Obsidian Ink `#151311`,
Velvet Curfew `#4B262F`.
