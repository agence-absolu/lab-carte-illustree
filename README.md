# Carte illustrée

Fond de carte illustré rendu dans Blender à partir des données IGN, découpé en
tuiles XYZ et affiché avec MapLibre : la Martinique entière (z10–z18), avec les
noms des communes, lieux-dits et rues d'OpenStreetMap.

Démo du lab Absolu, publiée sur **https://lab.agence-absolu.com/carte-illustree/**.

## Développement

```bash
npm install
npm run dev       # http://localhost:5173/carte-illustree/
npm run build     # compile dans dist/ (sans les tuiles)
npm run preview   # prévisualise dist/ sur le même sous-chemin
```

Le site est servi depuis un sous-répertoire du lab : `vite.config.ts` déduit la
base des chemins du nom npm (`carte-illustree`). `BASE_PATH=/ npm run build` pour
une racine de domaine.

## Tuiles

Les tuiles (≈ 1,8 Go, ~100 000 fichiers) ne sont **pas** dans le dépôt ni dans le
build : elles sont hébergées sur **Cloudflare R2** (bucket `map-illustration`),
dont l'adresse publique est dans `.env` (`VITE_TILES_URL`). En développement, la
case « Tuiles hébergées (R2) » bascule vers les tuiles locales (`public/tiles/`,
générées par le pipeline) ; elle n'existe pas dans la version publiée.

Envoi ou mise à jour des tuiles :

```bash
rclone copy public/tiles r2:map-illustration --exclude ".DS_Store" \
  --transfers 64 --checkers 64 --fast-list --progress \
  --header-upload "Cache-Control: public, max-age=86400"
```

La règle CORS du bucket doit autoriser `https://lab.agence-absolu.com` (et
`http://localhost:5173` pour le développement).

## Pipeline de rendu

Données IGN → scène Blender → rendu par blocs → tuiles WebP. Détails, pièges et
choix techniques dans `CLAUDE.md`.

```bash
node scripts/run-tiled.ts --region martinique --jobs 1   # rendu de l'île par sections
node scripts/fetch-labels.ts --region martinique         # libellés OSM (Overpass)
```

Prérequis du pipeline : Node ≥ 22 (TypeScript exécuté nativement), npm, Blender 5.

## Publication

`.github/workflows/deploy.yml` compile et envoie `dist/` par rsync sur SSH dans
`lab.agence-absolu.com/lab-projects/carte-illustree/` à chaque push sur `main` —
ou à la demande, onglet Actions. Le hub sert ce dossier sur `/carte-illustree/`
sans aucune configuration de son côté.

```bash
gh repo create agence-absolu/lab-carte-illustree --public --source=. --push
```

**Public, obligatoirement** : les secrets SSH (`LAB_SSH_HOST`, `LAB_SSH_USER`,
`LAB_SSH_PASSWORD`, `LAB_SSH_KNOWN_HOSTS` facultatif) sont définis au niveau de
l'organisation `agence-absolu`, et GitHub ne les partage qu'avec les dépôts
publics. Rien à créer dans le dépôt.

## Données et licences

- Relief, orthophotos, BD TOPO, RPG : © IGN, licence ouverte Etalab 2.0.
- Occupation du sol : ESA WorldCover 2021 (CC BY 4.0).
- Libellés : © contributeurs OpenStreetMap, licence ODbL.
