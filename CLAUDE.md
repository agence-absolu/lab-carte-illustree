# CLAUDE.md — Carte illustrée (POC)

Mémoire de démarrage du projet, rédigée le 14/10/2026 à la fin d'une session menée
depuis `~/Sites/lesarcs` (ticket Les Arcs #15398, test de la carte Grincat). Tout ce
qui suit a été **vérifié** dans cette session, sauf mention contraire.

## Démo du lab Absolu

Publiée sur https://lab.agence-absolu.com/carte-illustree/ (dépôt
`agence-absolu/lab-carte-illustree`, public), au format de `@absolu/create-lab-project` :
le slug est le nom npm (`carte-illustree`), `vite.config.ts` en déduit la base
(`/carte-illustree/`, aussi en dev), `.github/workflows/deploy.yml` publie `dist/` par
rsync à chaque push sur `main` (npm). Les tuiles sont sur Cloudflare R2
(`VITE_TILES_URL` dans `.env`), jamais dans le build (`publicDir` désactivé au build).
Voir README.md.

## Langue et règles de travail

- Tout en français : réponses, commentaires de code, messages de commit, docs.
  Identifiants et termes techniques tels quels.
- Commits : en français, à l'impératif, sujet ≤ 72 caractères, **jamais** de ligne
  `Co-Authored-By`, de lien de session ni de mention « Generated with Claude Code ».
  **Ne commiter que sur demande explicite.** Ne jamais pousser.
- Navigateur : demander avant d'ouvrir le navigateur de l'utilisateur
  (claude-in-chrome) ; Playwright headless autorisé pour une vérification automatique.
- Le serveur Vite : ici (contrairement au projet Les Arcs) aucune interdiction connue,
  mais demander avant de laisser tourner un serveur.

## Objectif

Produire **soi-même** un fond de carte **illustré**, « dans l'esprit » des cartes
Grincat (https://lesarcs.grincat.io), mais **pour n'importe quelle région** et **sans
réutiliser les dessins Grincat** (ni tuiles, ni données). La finalité est une
**illustration** : une très grande image rendue dans **Blender**, d'où l'on extrait des
**tuiles raster `z/x/y`** (standard XYZ / « slippy map », 256 px, Web Mercator).
**Pas de carte 3D interactive** : la 3D ne sert qu'à fabriquer l'image.

Le POC : un petit secteur (~1 km², Arc 1800, Les Arcs), une variante été et une hiver,
une visionneuse **Vite + MapLibre** pour juger le rendu des tuiles.

## Ce que fait Grincat (analyse de leurs tuiles, pour s'en inspirer)

Méthode déduite par comparaison avec l'orthophoto IGN et Esri (pas de doc publique) :

- **Rendu 3D vu de dessus**, en projection web, découpé en tuiles 256 px.
  Tuiles été : `https://grincat-maps.b-cdn.net/lesarcs3/webp/{z}/{x}/{y}.webp` (z 14–19),
  hiver : `https://maps.grin.cat/bsm/winter/2/webp/{z}/{x}/{y}.webp` (z 12–19).
  (Pour comparaison visuelle uniquement, **ne pas les réutiliser**.)
- **Sol** = orthophoto **IGN** plaquée et stylisée (saturée, adoucie) : un chantier
  avec grue, un chalet à panneaux solaires sont identiques à l'orthophoto IGN actuelle
  et absents de l'imagerie Esri plus ancienne. Voitures effacées, routes redessinées en
  tracés vectoriels propres.
- **Forêt** = instances d'arbres 3D (modèles low-poly) réparties selon les vraies zones
  boisées, ombres portées identiques partout (soleil unique).
- **Bâtiments** = volumes extrudés depuis les emprises, toits génériques (parfois
  texturés depuis la photo pour les petits chalets), **façades génériques** (même trame
  de fenêtres brun-orangé partout) ; bâtiments emblématiques modélisés à la main.
- **Remontées mécaniques** modélisées en 3D (pylônes, poulies, câbles).
- **Hiver** = même scène (arbres exactement aux mêmes positions), matériaux enneigés.
- **Libellés non intégrés aux tuiles** : couches vectorielles à part (noms de rues
  OSM en Outfit 500 12 px, blanc cerné #302757 ; noms de lieux en Outfit gras bleu
  #002b56 cerné de blanc). → Faire pareil : **ne pas « cuire » les textes** dans l'image.
- Leur vue est tournée de −125° (rotation d'affichage OpenLayers) ; les tuiles, elles,
  restent nord en haut.

## Pipeline retenu

1. **Données** (script Node, sans GDAL) : services IGN Géoplateforme interrogés
   **directement en EPSG:3857** (Web Mercator) sur une emprise **calée sur la grille des
   tuiles** au zoom max. Tout est converti en mètres Mercator **locaux** (origine = coin
   sud-ouest de l'emprise) pour Blender.
2. **Scène Blender** (script Python `bpy`, numpy fourni par Blender) : terrain,
   matériau du sol, arbres instanciés, bâtiments extrudés, routes et eau, soleil fixe.
3. **Rendu** : caméra **orthographique verticale**, nord en haut, rendu **par blocs**
   (ex. 8×8 tuiles = 2048 px) avec **marge de recouvrement** (ex. 64 px) recadrée ensuite,
   pour que les ombres ne soient pas coupées aux bords.
4. **Tuiles** (script Node + `sharp`) : découpe des blocs en tuiles 256 px au zoom max,
   puis pyramide des zooms inférieurs (assemblage 2×2 + réduction), sortie WebP dans
   `public/tiles/{saison}/{z}/{x}/{y}.webp`.
5. **Visionneuse** Vite + MapLibre : source raster XYZ, bascule été/hiver, rotation de
   la vue (bearing) pour tester un affichage à la Grincat.

Alternative documentée pour plus tard (grandes zones) : blocs en GeoTIFF →
`gdalbuildvrt` → `gdal2tiles.py --xyz` ; ou `vips dzsave --layout google`.

## Mathématiques à respecter (pièges)

- Résolution Web Mercator : `res(z) = 2π·6378137 / (256·2^z)` = **156543.03392 / 2^z**
  mètres **Mercator** par pixel (0,597 m au z18). En coordonnées EPSG:3857, **pas de
  facteur cos(lat)** sur la taille des pixels.
- **Altitudes** : les distances horizontales Mercator sont dilatées de `1/cos(lat)`.
  Multiplier les altitudes (et hauteurs de bâtiments et d'arbres) par **k = 1/cos(lat)**
  (≈ 1,43 à 45,6° N) pour garder les proportions et des ombres justes.
- `ortho_scale` de la caméra Blender = largeur rendue en mètres Mercator
  = (taille du bloc + 2 × marge) en px × res(zmax), image carrée.
- Tuile → Mercator : `x_m = x·256·res − 20037508.34`, `y_m = 20037508.34 − y·256·res`
  (y des tuiles vers le sud). Le coin sud-ouest de l'emprise sert d'origine locale.
- Lon/lat → Mercator : `x = R·λ`, `y = R·ln(tan(π/4 + φ/2))`, R = 6378137.

## Sources de données vérifiées (France, licence ouverte Etalab 2.0)

Toutes répondent en **EPSG:3857**, testées le 14/10/2026 sur la bbox
`755359.34,5711922.78,756359.34,5712922.78` (1 km autour de 45.5745 N, 6.7900 E,
Arc 1800). Préfixe WMS : `https://data.geopf.fr/wms-r?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&STYLES=&CRS=EPSG:3857&BBOX={bbox}&WIDTH={w}&HEIGHT={h}&LAYERS=…&FORMAT=…`

| Donnée | Couche | Format | Résultat du test |
|---|---|---|---|
| Relief LiDAR HD 1 m (MNT) | `IGNF_LIDAR-HD_MNT_ELEVATION.ELEVATIONGRIDCOVERAGE.LAMB93` | `image/x-bil;bits=32` | float32 **little-endian**, 1707–2006 m |
| Hauteur de végétation LiDAR HD 1 m (MNH) | `IGNF_LIDAR-HD_MNH_ELEVATION.ELEVATIONGRIDCOVERAGE.LAMB93` | `image/x-bil;bits=32` | 0–34,5 m (canopée) → **détection d'arbres individuels** (maxima locaux) |
| Relief RGE ALTI (repli si pas de LiDAR) | `ELEVATION.ELEVATIONGRIDCOVERAGE.HIGHRES` | `image/x-bil;bits=32` | 1709–2006 m |
| Modèle de surface (option) | `IGNF_LIDAR-HD_MNS_ELEVATION.ELEVATIONGRIDCOVERAGE.LAMB93` | idem | non testé |
| Orthophoto 20 cm | `ORTHOIMAGERY.ORTHOPHOTOS` | `image/jpeg` | OK en 2048×2048 |

Le suffixe `.LAMB93` est la projection native ; le WMS reprojette en 3857 sans souci.
Valeurs « sans donnée » probables très négatives : filtrer `< -1000`.
Taille max de requête WMS non déterminée : découper en blocs ≤ 2048 px par prudence.

**Vecteurs BD TOPO** (WFS, GeoJSON, 3857) :
`https://data.geopf.fr/wfs/ows?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature&TYPENAMES=BDTOPO_V3:{couche}&SRSNAME=EPSG:3857&BBOX={bbox},EPSG:3857&OUTPUTFORMAT=application/json&COUNT=5000`
(paginer avec `STARTINDEX` si besoin).

| Couche | Résultat sur la bbox test | Attributs utiles |
|---|---|---|
| `batiment` | 35 MultiPolygon | `hauteur`, `nombre_d_etages`, `usage_1`, `altitude_minimale_sol`, `altitude_maximale_toit` |
| `troncon_de_route` | 89 LineString | `nature` (Route à 1 chaussée, Route empierrée, Chemin, Sentier), `importance`, `largeur_de_chaussee` (souvent vide) |
| `zone_de_vegetation` | 5 MultiPolygon | `nature` (Forêt fermée de conifères, Forêt ouverte, Lande ligneuse, Haie) |
| `troncon_hydrographique` | 6 LineString | `nature` (Ecoulement naturel, Conduit buse) |
| `surface_hydrographique` | 2 MultiPolygon | `nature` |
| `transport_par_cable` | 3 LineString | `nature` (Télésiège, Télécabine, téléphérique), `toponyme` |

Hors France : Copernicus DEM GLO-30 (relief), ESA WorldCover 10 m (occupation du sol),
OSM / Overture (bâtiments, routes, `piste:type`, `aerialway`), Sentinel-2 (couleur).
Pistes de ski en France : non présentes dans la BD TOPO → OSM via Overpass
(`piste:type`), à ajouter plus tard.

## Choix techniques du POC

- **Node 22.23** (nvm) exécute le **TypeScript nativement** (`node script.ts`, type
  stripping) : pas de ts-node ni de build pour les scripts. Contraintes : imports avec
  extension `.ts`, pas d'`enum` ni de `namespace`, pas de paramètres de constructeur
  « propriétés ».
- Gestionnaire de paquets : **npm** (`package-lock.json`, `npm ci` en CI), comme les autres démos du lab.
- Dépendances prévues : `vite`, `typescript` (dev), `maplibre-gl`, `sharp`.
- Python système 3.14 sans numpy/rasterio : **ne pas** l'utiliser pour les données ;
  le traitement raster se fait en Node (Float32Array) ou dans Blender (numpy intégré).
- GDAL **non installé** en ligne de commande (QGIS l'embarque mais hors PATH).
- **Blender et QGIS installés** (vérifié) : **Blender 5.2.2 LTS** (cask brew, commande
  `blender` dans `/opt/homebrew/bin`), QGIS 4.2.3 (`/Applications/QGIS-final-4_2_3.app`)
  en plus de `QGIS-LTR.app` déjà présent.
  Binaire Blender : `/Applications/Blender.app/Contents/MacOS/Blender` ou `blender`
  (lancement sans interface : `Blender -b -P blender/build_scene.py -- --season summer`).
  Moteur : Eevee (nom de l'enum variable selon la version : `BLENDER_EEVEE_NEXT` en 4.2,
  `BLENDER_EEVEE` ensuite → tester les deux).

## Structure prévue

```
carte-illustree/
├── CLAUDE.md                 ← ce fichier
├── config/region.json        ← région du POC (centre, taille, zooms, blocs)
├── lib/geo.ts                ← Mercator, tuiles, résolutions (à écrire)
├── scripts/
│   ├── fetch-data.ts         ← emprise calée sur la grille, MNT, MNH→arbres, ortho, BD TOPO (à écrire)
│   ├── render.ts             ← lance Blender par saison (à écrire)
│   └── make-tiles.ts         ← blocs rendus → tuiles + pyramide, avec sharp (à écrire)
├── blender/build_scene.py    ← scène + rendu par blocs (à écrire)
├── data/                     ← données téléchargées (ignoré par git)
├── output/                   ← rendus Blender, .blend (ignoré par git)
├── public/tiles/             ← tuiles générées (ignoré par git)
├── index.html, src/main.ts   ← visionneuse MapLibre (à écrire)
└── package.json, .gitignore
```

## Détail des étapes à implémenter

### fetch-data.ts
1. Lire `config/region.json`, projeter le centre, calculer la plage de tuiles au zoom
   max couvrant `sizeMeters` (en mètres Mercator), l'**arrondir à un multiple de
   `chunkTiles`**, en déduire la bbox 3857 exacte. Écrire `data/region.json` (bbox,
   tuiles x0..x1 / y0..y1, grille de blocs, latitude centrale, facteur k, res).
2. MNT LiDAR 1 m → `data/dem.f32` (+ largeur/hauteur dans region.json), repli RGE ALTI
   si valeurs sans donnée.
3. MNH LiDAR 1 m → détection d'arbres : maxima locaux (fenêtre ~ rayon 2–3 m, hauteur
   ≥ 3 m), position + hauteur → `data/trees.json` (coordonnées locales).
   Rayon de houppier estimé ≈ 0,25 × hauteur, borné.
4. Orthophoto à ~0,5 m/px → `data/ortho.jpg` (assemblée avec sharp si plusieurs blocs).
5. BD TOPO (6 couches ci-dessus) → `data/vectors.json`, coordonnées locales.

### build_scene.py (Blender)
- Terrain : grille depuis le MNT (sous-échantillonnée à ~2 m), z = (alt − alt_min) × k,
  UV 0..1 pour l'ortho et les masques.
- Matériau du sol procédural (pente via normale, altitude) + ortho mélangée et
  étalonnée (facteur réglable) ; hiver : neige selon la pente.
- Arbres : 2–3 modèles low-poly (conifère en cônes empilés, feuillu en sphère) ;
  nuage de points + Geometry Nodes « Instance on Points », échelle = hauteur LiDAR,
  rotation aléatoire ; hiver : neige sur les faces orientées vers le haut.
- Bâtiments : extrusion des emprises à `hauteur` × k (min 3 m), base au sol (MNT),
  toit plat pour le POC, façades génériques.
- Routes / chemins : rubans drapés sur le MNT (largeur par `nature` : route 5 m,
  empierrée 3,5 m, chemin 2,5 m, sentier 1,2 m), légèrement surélevés.
- Eau : surfaces triangulées + cours d'eau en rubans.
- Remontées (`transport_par_cable`) : lignes de pylônes simplifiées (plus tard).
- Lumière : soleil fixe venant du nord-ouest (convention cartographique), hauteur ~35°,
  ombres + occlusion ambiante, ciel clair. Gestion des couleurs réglable (AgX / Standard).
- Caméra orthographique verticale, rendu de chaque bloc avec marge →
  `output/renders/{saison}/chunk_{cx}_{cy}.png` ; option de sauvegarde du `.blend`.

### make-tiles.ts
- Recadrer la marge de chaque bloc, découper en tuiles 256 au zoom max
  (x = x0 + cx·N + i, y = y0 + cy·N + j), WebP.
- Zooms inférieurs : parent (x>>1, y>>1) = assemblage des 4 enfants (manquants
  transparents) 512 px → réduit à 256.

### Visionneuse
- MapLibre, style minimal : fond + source raster `/tiles/{saison}/{z}/{x}/{y}.webp`,
  `tileSize: 256`, `bounds`, `minzoom`/`maxzoom` depuis la région ; bascule été/hiver ;
  curseur de rotation (bearing) ; couche OSM optionnelle pour comparaison.

## État (14/10/2026, fin de la 2e session)

Pipeline complet **fonctionnel de bout en bout** sur la région du POC :

```
node scripts/fetch-data.ts [--force]   # ~25 s, données IGN → data/
node scripts/render.ts [saison…] [-- options build_scene.py]   # ~5 s par saison
node scripts/make-tiles.ts [saison…]   # → public/tiles/{saison}/z/x/y.webp + region.json
npm run dev                            # visionneuse
```

- Dépendances installées : vite 8, typescript 7, maplibre-gl 6, sharp 0.35, @types/node.
- Région calculée : **z19** (z13–19), tuiles x 272025–272040, y 187402–187417
  (16×16 = **2×2 blocs** de 2048 px + marge 64 → rendus 2176 px), emprise 1223 m
  Mercator, k = 1,4286. Données = emprise + 50 m de marge (`localBbox`).
  `fetch-data` retélécharge tout seul si l'emprise a changé depuis le dernier passage.
- Tuiles **256 px** (choix de l'utilisateur). Le code sait aussi produire des @2x
  (`renderScale: 2` → `{y}@2x.webp` 512 px + 1x réduites) mais ce n'est pas utilisé.
- Données : MNT LiDAR complet (1664–2058 m, aucun trou), 5 732 arbres détectés
  (295 sommets écartés car dans des bâtiments : **le MNH contient les toits**),
  masque de canopée `data/canopy.png`, ortho 4424 px (≈ 0,3 m Mercator/px), BD TOPO.
- Scène Blender (`blender/build_scene.py`, options `--help`) : terrain 661×661,
  4 modèles d'arbres instanciés par Geometry Nodes (épicéa, mélèze, feuillu, buisson),
  bâtiments extrudés (toit = `altitude_maximale_toit`), routes en rubans drapés,
  eau, soleil NO 35°, Eevee, vue **Standard** (AgX délavait trop), ciel 0,55, soleil 3,5.
  Hiver : neige au sol selon la pente, neige sur les arbres, exposition −0,3.

### Constats et pièges découverts

- Blender 5.2 : seul moteur `BLENDER_EEVEE` ; le nœud Principled s'appelle
  `ShaderNodeBsdfPrincipled` ; `Material.use_nodes` est déprécié (encore présent).
  Sockets de `ShaderNodeMix` à viser par identifiant (`A_Color`, `Result_Color`…).
- La zone sud-est est une **lande d'aulnes verts** dense de 3–5 m : rendue en
  buissons (dômes larges) + sous-bois sombre via le masque de canopée. Rayon de
  houppier = clamp(0,18·h + 1, 1,2, 4,5) m.
- MapLibre 6 sous Vite : le worker doit être déclaré
  (`setWorkerUrl` + import `maplibre-gl-worker.mjs?url`), sinon « Worker failed to load ».
- **Zoom MapLibre ≠ zoom des tuiles XYZ** : MapLibre suit un monde de 512 px au
  zoom 0, donc une tuile 256 px de niveau z est au 1:1 au zoom carte **z − 1**.
  Au zoom carte 19 avec des tuiles z19, l'image est agrandie ×2 (floue) et plus
  aucune tuile n'est appelée. La visionneuse borne donc le zoom à zmax − 1 + 0,5
  et affiche le zoom des tuiles utilisées (`TILE_ZOOM_OFFSET` dans `src/main.ts`).
- Netteté du sol : limitée par l'ortho (20 cm natifs ≈ 0,29 m Mercator ≈ 1 px en z19).
  Texture en interpolation `Linear` (le `Cubic` de Blender lisse) et filtre de
  reconstruction Eevee à 1 px (1,5 par défaut).
- `bounds` de la source raster : à rentrer d'un epsilon, sinon MapLibre demande la
  rangée de tuiles voisine (inexistante → fallback HTML de Vite → erreur de décodage).
- La grille de blocs n'est pas alignée sur les zooms inférieurs (y0 impair) : sans
  conséquence (tuiles parentes partielles transparentes), mais on pourrait aligner
  x0/y0 sur un multiple de 2^(zmax−zmin) pour des pyramides plus propres.

### Multi-régions (depuis le 14/10/2026)

- Une config par région : `config/regions/{nom}.json` ; dossiers `data/{nom}/`,
  `output/{nom}/`, `public/tiles/{nom}/{saison}/`. Toutes les commandes prennent
  `--region nom` (`lib/region.ts`). `make-tiles` tient à jour `public/tiles/regions.json`,
  lu par la visionneuse (`?region=nom`).
- Régions : `arc1800` (alpin, été/hiver) et `martinique` (île entière, tropical, `jour`).
- Options de région : `climate` (`alpine` | `tropical`), `sea` (bathymétrie + mer),
  `seaDepth` (profondeur plancher, −60 m).
- `fetch-data` : cache **par jeu de données** (`cacheKeys` dans `data/{nom}/region.json`,
  avec un numéro de version à incrémenter quand un traitement change).

### Martinique : relief, mer et végétation (leçons des premiers essais)

- **Pas de LiDAR HD** (MNT ni MNH) : relief = RGE ALTI ; arbres **plantés de façon
  procédurale** (`plantTrees` dans fetch-data) : grille jitterée ~4,5 m, gardée selon un
  indice de végétation de l'ortho, boosté dans les zones BD TOPO (Forêt fermée, Bois,
  Mangrove) ; types : cocotiers près des plages / bas littoral / bourg, palétuviers en
  mangrove, feuillus ailleurs. ~90 000 arbres.
- Indice de végétation : **G − R** et ton sombre, **pas ExG** (2G − R − B) : la brume
  tropicale bleuit la forêt sur l'ortho (≈ 73/81/81).
- Le RGE ALTI contient une **bathymétrie côtière** (0 à −50 m, Litto3D) ; au large, valeurs
  aberrantes (−99999, −64402, −197…) → comblées par push-pull depuis les fonds voisins,
  puis fonds lissés (marches d'escalier sinon). Le levé a enregistré les **bateaux au
  mouillage** comme des hauts-fonds : ouverture morphologique (min puis max, r = 8 px).
- `seabed.jpg` : ortho 1 m/px sans bateaux (ouverture par canal) pour les motifs du fond.
- BD TOPO utile : `zone_d_estran` (nature Sable → plages, `masks.png` canal R) ;
  ignorer les tronçons « Bac ou liaison maritime ».
- Piège sharp : `blur()` sur une image raw à 1 canal peut ressortir plusieurs canaux →
  toujours `extractChannel(0)` avant `raw()`.
- Île entière à terme : **z18** (choix de l'utilisateur) ; nécessitera un pipeline par
  tuiles de données (ni les rasters ni la scène ne tiennent en un morceau).

### Grande région : Martinique entière (z18, `scripts/run-tiled.ts`)

- Config `config/regions/martinique.json` : `bounds` (lon/lat) + `tiled` (sections de 2×2 blocs,
  `keepDepth`, `coastChunks`), `lidar: false`. Grille calée sur 2^(zmax−zmin) tuiles.
- Blocs utiles d'après un relief grossier (25 m) : terre, hauts-fonds, + 1 bloc de mer autour
  (1 211 blocs, 334 sections). Le large n'est pas rendu (fond de la visionneuse).
- Chaque section = petite région (`--section id` dans les scripts, config générée dans
  `data/{nom}/sections/{id}/`), données et rendus effacés après découpe (`--keep` pour garder).
  Reprise : `data/{nom}/done/{id}` contient `v{PIPELINE}` ; changer `PIPELINE` refait tout.
- `make-tiles --cut-only` (z max d'une section) / `--pyramid-only` (zooms inférieurs + métadonnées).
- **Une section à la fois** (`--jobs 1`, `nice`) : 16 Go de RAM, Blender monte à ~7 Go ;
  3 en parallèle ont fait swapper la machine (environ 60 s par section en série, ~5 h 30 au total).
- Bathymétrie manquante comblée **une fois pour toute l'île** (`seafill.f32` : push-pull puis
  plongée vers seaDepth sur 800 m, lissée), sinon chaque section invente sa propre mer
  (carrés de bleus). Fondu de 60 m entre levé et comblement.
- Vite en `appType: 'mpa'` (`vite.config.ts`) : une tuile absente répond 404 au lieu d'index.html.

### Végétation sans MNH (Martinique) — leçons

- **RGE ALTI à 5 m natifs** hors métropole, rendu au plus proche voisin par le WMS → marches de
  5 m, rayures à l'ombrage, chemins en pointillés. Lissage normalisé (boîte r = 2, ×2), en
  excluant les valeurs aberrantes du levé (< seaDepth), sinon trous sombres en mer.
- L'ortho seule ne distingue pas forêt et prairie (texture et luminosité trop proches, mesuré).
  → **ESA WorldCover 2021** (10 m, tuiles 3° GeoTIFF sur S3, cache `data/_cache/worldcover/`,
  palette lue en RVB par sharp) pondère la plantation (arbres 1, arbustes 0,6, prairies et
  cultures 0,05).
- **RPG** (`RPG.LATEST:parcelles_graphiques`, `code_cultu`) : BEF/BCA bananeraies (bananiers
  en rangs de 3,5 × 2,4 m, orientation par tenseur de structure sur l'ortho, calée sur un bord
  de parcelle, origine = un sommet → identique entre sections) ; CSA/MSW canne (sol dense,
  `masks.png` G) ; vergers (groupe 20) petits fruitiers ; le reste sans arbres (`masks.png` B),
  sauf arbres isolés très sombres. Les cultures tournent : une « canne » sombre (lum < 0,355)
  est traitée en bananeraie. WorldCover voit souvent les cultures hautes comme des arbres.
- BD TOPO `terrain_de_sport`, `cimetiere`, `surface_hydrographique` : jamais d'arbres. Plan d'eau
  plat (bassin) posé au p90 du relief intérieur (la rive basse d'un MNT lissé est sous l'eau).
- WorldCover classe en eau / sol nu les **ombres profondes des ravines** : ombre (lum < 0,2) →
  boisée ; galets (`masks.png` A) seulement si WorldCover sol nu/eau **et** ortho claire sans
  verdeur. Roche au sol seulement au-delà d'une pente de 0,5–0,75 sous les tropiques.
- `run-tiled --only id…` refait ces sections même si faites ; `--keep` garde leurs données.
- Visionneuse : calque ortho IGN (WMTS `ORTHOIMAGERY.ORTHOPHOTOS`, grille PM) avec opacité.

### Mer du large et libellés (15/10/2026)

- Au-delà de 25→55 m de fond, la mer est une **émission unie `OPEN_SEA` (#0b3f78)** = fond de la
  visionneuse : plus de marche au bord des blocs rendus. `run-tiled` ne rend plus les blocs de
  pleine mer (relief grossier < −56 m partout, tuiles supprimées) et garde les sections sans eau
  de plus de 24 m faites dans une version listée dans `SHALLOW_OK`.
- `make-tiles` supprime une tuile parente dont les 4 enfants ont disparu.
- **Libellés OSM** : `node scripts/fetch-labels.ts --region nom` (Overpass, souvent 429/504 →
  essais espacés) → `public/tiles/{nom}/labels.json` (communes = relations admin_level 8 au nœud
  label/chef-lieu, lieux-dits = `place=*`, rues = `highway` nommées, tronçons assemblés par nom).
  Visionneuse : couches symbol, police **Metropolis** (glyphes fonts.openmaptiles.org, proche
  d'Outfit), couleurs Grincat ; attribution ODbL.

### Pistes suivantes

- Remontées mécaniques (`transport_par_cable`) : pylônes + câbles.
- Pistes de ski OSM (Overpass, `piste:type`) pour l'hiver.
- Toits en pente / façades, bâtiments emblématiques.
- Stylisation plus « illustration » (teintes plus franches, contours, AO plus marquée),
  comparaison côte à côte avec Grincat.
- Région plus grande pour tester le rendu multi-blocs et les raccords de marge.
