# Polices embarquées

Feather fonctionne hors ligne et sa CSP interdit toute ressource distante :
les polices sont donc livrées avec l'application plutôt que chargées depuis
Google Fonts.

| Famille | Usage | Auteur | Licence |
|---|---|---|---|
| Google Sans Flex | corps de texte, libellés, chiffres | Google | OFL 1.1 |
| Sansation | titres (`h1`, `h2`) | Bernd Montag | OFL 1.1 |

Seuls les sous-ensembles `latin` et `latin-ext` sont embarqués — 99 Ko au
total. Les notices de copyright exigées par l'OFL sont dans la table `name`
de chaque fichier.

Google Sans Flex est une police variable : un seul fichier couvre les
graisses 300 à 700. Sansation n'existe qu'en 400 et 700, donc tout poids
demandé au-dessus de 500 retombe sur 700.

`faces.css` déclare les `@font-face` et est chargée par la fenêtre de
réglages comme par l'overlay. Les plages Unicode viennent de Google Fonts :
elles laissent le navigateur ne télécharger que le sous-ensemble utile.

## Régénérer

Les fichiers viennent de l'API `css2` de Google Fonts :

    https://fonts.googleapis.com/css2?family=Google+Sans+Flex:wght@300..700
    https://fonts.googleapis.com/css2?family=Sansation:wght@400;700

Il faut demander cette CSS avec un `User-Agent` de navigateur récent, sans
quoi Google renvoie du TTF au lieu du WOFF2, puis ne garder que les blocs
`latin` et `latin-ext`.
