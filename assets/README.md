# Icônes

Tout est produit par `scripts/make-icons.js`, à partir d'une seule géométrie :
une plume dont les barbes sont les barres d'une forme d'onde. Le script n'a
aucune dépendance graphique — il encode lui-même le PNG et le ICO.

| Fichier | Rôle |
|---|---|
| `icon.ico`, `icon.png` | exécutable, fenêtre, barre des tâches |
| `tray-light.png`, `tray-dark.png`, `tray-active.png` | zone de notification |
| `mark.svg` | même tracé en vectoriel ; la barre de titre en embarque une copie |
| `feather-pixel.png` | en-tête du README ; illustration fournie, pas générée |

Régénérer : `npm run icons`.

Le `.ico` contient toutes les tailles que Windows demande réellement, de 256 à
16 px : sans correspondance exacte il réduit la plus proche, et le trait
s'empâte. Le nombre de barbes diminue et leur épaisseur augmente aux petites
tailles, pour que la forme survive à 16 px.

## Couleurs

Elles suivent la palette de l'application : Coconut White `#F2F1EA`, Obsidian
Ink `#151311`, Velvet Curfew `#4B262F`.

La pastille de l'icône applicative dégrade en diagonale de l'obsidienne au
velours — deux tons proches, mais assez pour éviter l'aplat — et la plume est en
coco, qui porte tout le contraste.

Les icônes de la zone de notification sont monochromes sur fond transparent.
Windows les pose sur une barre claire ou sombre selon le réglage système, sans
équivalent des « template images » de macOS : on produit donc les deux versions,
coco et obsidienne, et l'application choisit à l'exécution. La version `active`,
pendant une dictée, est en `#B0223A`, le rouge d'alerte de la palette.
