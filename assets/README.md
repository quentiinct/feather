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
2. **Recadrage.** Telle quelle, la plume n'occupe que 63 % de la largeur de
   sa tuile — beaucoup de vide, et un motif illisible en dessous de 32 px. On
   recadre donc dans la tuile pour que la plume fasse 90 % du côté : carré de
   678 px à (98, 69) pour Gemini, de 840 px à (114, 83) pour ChatGPT. La
   boîte du motif se mesure sur la teinte (R − B > 32), pas sur la
   luminosité, sinon le liseré clair de la tuile fausse le résultat.
3. **Masque.** La tuile recadrée est d'abord réduite à la taille visée,
   puis peinte à travers un rectangle arrondi de rayon 22,7 % du côté
   (`TextureBrush` + `FillPath` anticrénelé). Réduire avant de masquer évite
   que le rééchantillonnage ne ronge les coins.
4. **Tailles.** 256, 128, 64, 48, 32, 24 et 16 px, empaquetées dans un ICO à
   entrées PNG.

`scripts/make-icons.js` ne produit plus `icon.ico` ni `icon.png` : le
relancer les écraserait par l'ancien tracé procédural.

## Lisibilité

Le motif reste détaillé : à 16 px les barbes se confondent encore un peu
avec le fond. Le recadrage à 90 % a été choisi là-dessus — au-delà, la
pointe de la plume vient toucher les coins arrondis. Les icônes de la zone
de notification sont restées sur le tracé procédural, dessiné dès le départ
pour tenir à 16 px.
