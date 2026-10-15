// Essai « éléments repositionnés » : exporte les arbres et les bâtiments d'une section
// pour que la visionneuse les place elle-même sur le sol rendu sans eux (variante « sol »).
//
// - Arbres : position, hauteur, rayon et sprite (images rendues par build_scene.py --sprites).
// - Bâtiments : emprise BD TOPO, hauteur, couleur du toit lue sur l'orthophoto.
//
// Usage : node scripts/export-elements.ts --region nom --section id
// Sortie : public/tiles/{nom}/elements/{id}.json ({ trees, buildings } en GeoJSON lon/lat),
// et elements/index.json (sections exportées et leurs emprises)

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { mercatorToLonLat } from '../lib/geo.ts';
import { regionFromArgs } from '../lib/region.ts';

const PATHS = regionFromArgs();
if (!PATHS.section) throw new Error('Préciser la section avec --section id');

const region = JSON.parse(await readFile(join(PATHS.data, 'region.json'), 'utf8'));
const trees: { x: number; y: number; h: number; r: number; k: string }[] = JSON.parse(
  await readFile(join(PATHS.data, region.trees.file), 'utf8'),
);
const vectors = JSON.parse(await readFile(join(PATHS.data, region.vectors.file), 'utf8'));
const spritesDir = join(PATHS.tiles, 'elements/sprites');
const sprites: Record<string, { model: number; side: number; footY: number }> = JSON.parse(
  await readFile(join(spritesDir, 'sprites.json'), 'utf8'),
);

const [bx0, by0] = region.bbox;
const W = region.widthM;
const H = region.heightM;
const toLonLat = (x: number, y: number) => mercatorToLonLat(bx0 + x, by0 + y).map((v) => +v.toFixed(7));
const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < W && y < H; // sans la marge : pas de doublon entre sections

/** Hachage entier reproductible d'une position (même tirage d'une section à l'autre). */
const hash = (x: number, y: number) => {
  let h = Math.imul(Math.round((bx0 + x) * 10), 73856093) ^ Math.imul(Math.round((by0 + y) * 10), 19349663);
  h = Math.imul(h ^ (h >>> 13), 0x5bd1e995);
  return (h ^ (h >>> 15)) >>> 0;
};

// Modèle de build_scene.py (tropical_models) selon le type ; deux silhouettes de feuillus
const MODEL: Record<string, number> = { broadleaf: 0, palm: 2, mangrove: 3, banana: 4, orchard: 5 };
const byModel = new Map<number, string[]>();
for (const [name, s] of Object.entries(sprites)) {
  if (!byModel.has(s.model)) byModel.set(s.model, []);
  byModel.get(s.model)!.push(name);
}

// Éclaircie des zones denses (fluidité de la visionneuse) : dans une cellule de DENSE_CELL m comptant
// au moins DENSE_MIN arbres, un arbre sur deux (tirage reproductible), les autres un peu grossis pour
// garder une canopée fermée. Les arbres isolés et les lisières clairsemées restent tous.
const DENSE_CELL = 20;
const DENSE_MIN = 12;
const DENSE_GROW = 1.15;
const cellOf = (x: number, y: number) => `${Math.floor((bx0 + x) / DENSE_CELL)}_${Math.floor((by0 + y) / DENSE_CELL)}`;
const density = new Map<string, number>();
for (const t of trees) density.set(cellOf(t.x, t.y), (density.get(cellOf(t.x, t.y)) ?? 0) + 1);

let thinned = 0;
const treeFeatures = [];
for (const t of trees) {
  if (!inside(t.x, t.y)) continue;
  const hsh = hash(t.x, t.y);
  const dense = (density.get(cellOf(t.x, t.y)) ?? 0) >= DENSE_MIN;
  if (dense && (hsh >>> 20) % 2 === 1) {
    thinned++;
    continue;
  }
  const grow = dense ? DENSE_GROW : 1;
  let model = MODEL[t.k] ?? 0;
  if (model === 0 && hsh % 100 < 45) model = 1;
  const names = byModel.get(model)!;
  const name = names[(hsh >>> 8) % names.length];
  const s = sprites[name];
  treeFeatures.push({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: toLonLat(t.x, t.y) },
    // i : sprite ; s : côté de l'image en mètres ; f : pied dans l'image (fraction depuis le haut)
    properties: { i: name, s: +(t.h * grow * s.side).toFixed(2), f: +s.footY.toFixed(3), r: +(t.r * grow).toFixed(2), h: t.h },
  });
}

// Orthophoto en mémoire pour la couleur des toits
const ortho = await sharp(join(PATHS.data, region.ortho.file)).removeAlpha().raw().toBuffer({ resolveWithObject: true });
const [lx0, , , ly1] = region.localBbox;
const OPX = region.ortho.pxM;
function orthoColor(points: [number, number][]): string {
  let r = 0, g = 0, b = 0, n = 0;
  for (const [x, y] of points) {
    const i = Math.floor((x - lx0) / OPX);
    const j = Math.floor((ly1 - y) / OPX);
    if (i < 0 || j < 0 || i >= ortho.info.width || j >= ortho.info.height) continue;
    const o = (j * ortho.info.width + i) * 3;
    r += ortho.data[o];
    g += ortho.data[o + 1];
    b += ortho.data[o + 2];
    n++;
  }
  if (!n) return '#b9aa98';
  // Un peu éclairci : l'ortho est plus sombre que les toits illustrés
  const c = (v: number) => Math.min(255, Math.round((v / n) * 1.12 + 8)).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

const buildingFeatures = [];
for (const f of vectors.batiment ?? []) {
  const p = f.properties;
  const polys: number[][][][] = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
  for (const poly of polys) {
    const ring = poly[0];
    const cx = ring.reduce((a, c) => a + c[0], 0) / ring.length;
    const cy = ring.reduce((a, c) => a + c[1], 0) / ring.length;
    if (!inside(cx, cy)) continue;
    let height = p.hauteur ?? (p.altitude_maximale_toit != null && p.altitude_minimale_sol != null
      ? p.altitude_maximale_toit - p.altitude_minimale_sol : null) ?? 3;
    height = Math.max(3, height);
    // Couleur du toit : moyenne de points entre le centre et les sommets (évite les bords)
    const samples: [number, number][] = [[cx, cy]];
    for (const [x, y] of ring) samples.push([cx + 0.5 * (x - cx), cy + 0.5 * (y - cy)]);
    buildingFeatures.push({
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: poly.map((rg) => rg.map(([x, y]) => toLonLat(x, y))) },
      properties: { h: +height.toFixed(1), c: orthoColor(samples) },
    });
  }
}

const out = join(PATHS.tiles, 'elements');
await mkdir(out, { recursive: true });
await writeFile(
  join(out, `${PATHS.section}.json`),
  JSON.stringify({
    section: PATHS.section,
    bounds: region.lonLatBounds,
    trees: { type: 'FeatureCollection', features: treeFeatures },
    buildings: { type: 'FeatureCollection', features: buildingFeatures },
  }),
);
// Index des sections exportées, lu par la visionneuse
const indexFile = join(out, 'index.json');
let index: { id: string; bounds: number[] }[] = [];
try {
  index = JSON.parse(await readFile(indexFile, 'utf8'));
} catch {
  // premier export
}
index = [...index.filter((e) => e.id !== PATHS.section), { id: PATHS.section, bounds: region.lonLatBounds }];
await writeFile(indexFile, JSON.stringify(index.sort((a, b) => a.id.localeCompare(b.id)), null, 1));
console.log(`${PATHS.section} : ${treeFeatures.length} arbres (${thinned} retirés en zone dense), ${buildingFeatures.length} bâtiments → ${out}`);
