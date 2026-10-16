# Relief Studio

Générateur de **posters** et d'**objets 3D imprimables** à partir d'un lieu : une ou plusieurs traces GPX, un sommet, une ville, ou un pays entier. Tout est calculé dans le navigateur, sans serveur ni compte, et les fichiers GPX ne quittent pas l'ordinateur.

## Ce que fait l'application

**1. Lieu.** Import de traces GPX (Strava, Garmin, Komoot…), plusieurs à la fois avec une couleur par trace ; recherche de lieux ; pays du monde, régions et départements français, États américains. Le cadrage se règle sur une carte (portrait, paysage, carré).

**2. Atelier.**
- *Poster* : cinq styles (crêtes, courbes de niveau avec cotes, strates, ombrage, rivières), 19 palettes avec inversion clair/sombre, typographies classique ou géométrique, unités métriques ou impériales, fondu des bords, formats A4 à 61 × 91 cm et 18 × 24 in.
- *Objet 3D* : rectangle, disque, hexagone ou contour du pays/de la région ; hauteur du relief, socle, finesse du maillage ; trace en relief ; plaque de texte à l'avant (deux lignes, lettres en relief ou gravées, dans leur propre couleur) ; découpe en tuiles pour le plateau de l'imprimante.
- *Couleurs d'impression* : forêts, prairies, cultures, bâti, roche, neige, eau et traces, chacune avec sa couleur ; ou paliers d'altitude. Ruisseaux et rivières OpenStreetMap, eau en creux, limite de neige, fusion des petites zones. Les couleurs identiques partagent un filament.
- Annuler / rétablir, projets enregistrés dans le navigateur, import/export JSON.

**3. Téléchargement.** PNG, PDF et SVG pour les posters ; 3MF multicolore (PrusaSlicer, Bambu Studio, OrcaSlicer), STL et GLB pour les objets 3D.

## Lancer en local

Prérequis : [Node.js](https://nodejs.org) 20 ou plus.

Sous Windows, double-cliquer sur **`Lancer Relief Studio.bat`** (installe les dépendances au premier lancement, puis ouvre le navigateur). Sinon :

```bash
npm install
npm run dev
```

`npm run build` produit un site statique dans `dist/` (chemins relatifs, publiable tel quel, par exemple sur GitHub Pages). `npm test` lance les tests (maillage étanche, traces GPX, couleurs, nettoyage des zones).

## Organisation du code

| Dossier | Rôle |
| --- | --- |
| `src/geo/` | projection locale, altitudes, GPX, recherche, contours, occupation du sol |
| `src/poster/` | rendu SVG des posters, palettes, réseau hydrographique, polices embarquées |
| `src/model/` | maillage 3D étanche, zones de couleur, aperçu three.js, exports STL/3MF/GLB |
| `src/main.js` | interface en trois étapes, historique, projets, exports |
| `test/` | tests `node --test` |

## Données

| Donnée | Source | Conditions |
| --- | --- | --- |
| Altitudes | [Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) (AWS Open Data : SRTM, GMTED, ETOPO1, etc.) | attribution des sources |
| Fond de carte | [OpenFreeMap](https://openfreemap.org) | © contributeurs OpenStreetMap |
| Recherche de lieux | [Photon](https://photon.komoot.io) (Komoot) | © contributeurs OpenStreetMap |
| Cours d'eau | OpenStreetMap via [Overpass](https://overpass-api.de) | ODbL, © contributeurs OpenStreetMap |
| Occupation du sol | [ESA WorldCover 2021](https://esa-worldcover.org) via Microsoft Planetary Computer | CC BY 4.0, © ESA WorldCover project, données Copernicus Sentinel modifiées |
| Contours | Natural Earth (world-atlas, us-atlas), [france-geojson](https://github.com/gregoiredavid/france-geojson) | domaine public / licence ouverte |
