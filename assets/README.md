# Icônes

| Fichier | Rôle | Origine |
|---|---|---|
| `icon.ico`, `icon.png` | icône de l'exécutable, de la fenêtre et de la barre des tâches | `Gemini_Generated_Image_*.jfif` |
| `src/renderer/img/brand.png` | logo en haut à gauche de la fenêtre | `ChatGPT Image *.png` |
| `tray-*.png`, `mark.svg` | zone de notification | `scripts/make-icons.js` |

Les deux images source sont conservées telles qu'elles ont été générées. Les
icônes en sont dérivées ainsi :

1. **Découpe.** La tuile occupe (105, 110) → 814 × 805 dans l'image Gemini,
   et (129, 129) → 997 × 997 dans celle de ChatGPT. Le reste est du fond :
   l'image Gemini est un JPEG, son damier de « transparence » est peint dans
   les pixels et doit être retiré, pas interprété.
2. **Masque.** Un rectangle arrondi de rayon 22,7 % du côté, peint en
   anticrénelage avec une `TextureBrush` — la réduction se fait donc dans la
   brosse, avant le masque, pour que les bords restent nets.
3. **Tailles.** 256, 128, 64, 48, 32, 24 et 16 px, empaquetées dans un ICO à
   entrées PNG.

`scripts/make-icons.js` ne produit plus `icon.ico` ni `icon.png` : le
relancer les écraserait par l'ancien tracé procédural.

## Lisibilité

Le motif est détaillé : en dessous de 32 px, les barbes de la plume se
confondent avec le fond sombre. C'est visible dans la barre des tâches à
100 % de mise à l'échelle (24 px). Les icônes de la zone de notification
sont restées sur le tracé procédural, dessiné pour être lisible à 16 px.
