// Téléchargement des données IGN pour une région : emprise calée sur la grille des
// tuiles, MNT (et bathymétrie côtière), arbres, orthophoto et vecteurs BD TOPO.
// Tout est écrit dans data/{région}/, en coordonnées Mercator locales (origine =
// coin sud-ouest de l'emprise des tuiles, x vers l'est, y vers le nord).
//
// Arbres : détectés un par un dans le MNH LiDAR HD quand il existe ; sinon (DOM…)
// plantés de façon procédurale d'après l'ortho et les zones de végétation BD TOPO.
//
// Usage : node scripts/fetch-data.ts [--region nom] [--force]

import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { computeRegion, type RegionConfig } from '../lib/geo.ts';
import { ROOT, regionFromArgs } from '../lib/region.ts';
import { mercatorToLonLat } from '../lib/geo.ts';
import { boxBlur, distanceTo, inpaint, sampleBilinear } from '../lib/raster.ts';

const PATHS = regionFromArgs();
const DATA = PATHS.data;
const FORCE = process.argv.includes('--force');

const WMS = 'https://data.geopf.fr/wms-r';
const WFS = 'https://data.geopf.fr/wfs/ows';
const MAX_PX = 2048; // taille max d'une requête WMS (par prudence)
const PARALLEL = 4; // requêtes WMS simultanées

/** Applique f à chaque élément, au plus `n` à la fois ; résultats dans l'ordre. */
async function mapPool<T, R>(items: T[], n: number, f: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await f(items[i]);
    }
  }));
  return out;
}

const LAYERS = {
  mnt: 'IGNF_LIDAR-HD_MNT_ELEVATION.ELEVATIONGRIDCOVERAGE.LAMB93',
  mnh: 'IGNF_LIDAR-HD_MNH_ELEVATION.ELEVATIONGRIDCOVERAGE.LAMB93',
  rgeAlti: 'ELEVATION.ELEVATIONGRIDCOVERAGE.HIGHRES',
  ortho: 'ORTHOIMAGERY.ORTHOPHOTOS',
};

// Couches WFS : BD TOPO, plus les parcelles agricoles du RPG (type de culture)
const RPG_LAYER = 'RPG.LATEST:parcelles_graphiques';
const WFS_LAYERS = [
  'batiment',
  'troncon_de_route',
  'zone_de_vegetation',
  'troncon_hydrographique',
  'surface_hydrographique',
  'transport_par_cable',
  'zone_d_estran',
  'terrain_de_sport',
  'cimetiere',
];

// Attributs conservés par couche (le reste est jeté).
const KEEP: Record<string, string[]> = {
  batiment: ['hauteur', 'nombre_d_etages', 'usage_1', 'altitude_minimale_sol', 'altitude_maximale_toit'],
  troncon_de_route: ['nature', 'importance', 'largeur_de_chaussee', 'nom_collaboratif_gauche', 'position_par_rapport_au_sol'],
  zone_de_vegetation: ['nature'],
  troncon_hydrographique: ['nature', 'position_par_rapport_au_sol'],
  surface_hydrographique: ['nature'],
  transport_par_cable: ['nature', 'toponyme'],
  zone_d_estran: ['nature'],
  terrain_de_sport: ['nature', 'nature_detaillee'],
  cimetiere: ['nature'],
  rpg: ['code_cultu', 'code_group'],
};

/** Options propres à une région, en plus de RegionConfig. */
interface RegionOptions {
  climate?: 'alpine' | 'tropical';
  lidar?: boolean; // false : pas de LiDAR HD ici (DOM…), on ne le demande pas
  sea?: boolean; // compléter les zones sans donnée du relief par une mer profonde
  seaDepth?: number; // profondeur de remplissage (m, négative)
  // Bathymétrie de comblement commune aux sections d'une grande région (run-tiled.ts)
  seaFill?: { file: string; bbox: BBox; px: number; width: number; height: number };
}

type BBox = [number, number, number, number];

// ---------------------------------------------------------------------------
// Utilitaires réseau

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function fetchBuffer(url: string, tries = 4): Promise<Buffer> {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const type = res.headers.get('content-type') ?? '';
      if (type.includes('xml') || type.includes('html')) {
        throw new Error(`réponse inattendue (${type}) : ${buf.toString('utf8', 0, 300)}`);
      }
      return buf;
    } catch (err) {
      if (i >= tries) throw err;
      console.warn(`  échec (${(err as Error).message}), nouvel essai ${i + 1}/${tries}…`);
      await new Promise((r) => setTimeout(r, 1000 * i));
    }
  }
}

function wmsUrl(layer: string, format: string, bbox: BBox, w: number, h: number): string {
  const p = new URLSearchParams({
    SERVICE: 'WMS',
    VERSION: '1.3.0',
    REQUEST: 'GetMap',
    STYLES: '',
    CRS: 'EPSG:3857',
    BBOX: bbox.join(','),
    WIDTH: String(w),
    HEIGHT: String(h),
    LAYERS: layer,
    FORMAT: format,
  });
  return `${WMS}?${p}`;
}

/** Découpe une grille de w×h px en blocs ≤ MAX_PX. */
function blocks(w: number, h: number): { x: number; y: number; w: number; h: number }[] {
  const out = [];
  for (let y = 0; y < h; y += MAX_PX) {
    for (let x = 0; x < w; x += MAX_PX) {
      out.push({ x, y, w: Math.min(MAX_PX, w - x), h: Math.min(MAX_PX, h - y) });
    }
  }
  return out;
}

/** Emprise Mercator d'un bloc de pixels (ligne 0 = nord). */
function blockBbox(bbox: BBox, px: number, b: { x: number; y: number; w: number; h: number }): BBox {
  const [minx, , , maxy] = bbox;
  return [minx + b.x * px, maxy - (b.y + b.h) * px, minx + (b.x + b.w) * px, maxy - b.y * px];
}

/** Raster float32 (BIL little-endian), lignes du nord vers le sud. */
async function fetchFloatGrid(layer: string, bbox: BBox, w: number, h: number, px: number): Promise<Float32Array> {
  const out = new Float32Array(w * h);
  await mapPool(blocks(w, h), PARALLEL, async (b) => {
    const buf = await fetchBuffer(wmsUrl(layer, 'image/x-bil;bits=32', blockBbox(bbox, px, b), b.w, b.h));
    if (buf.length !== b.w * b.h * 4) {
      throw new Error(`${layer} : taille ${buf.length} octets, ${b.w * b.h * 4} attendus`);
    }
    const src = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length));
    for (let j = 0; j < b.h; j++) {
      out.set(src.subarray(j * b.w, (j + 1) * b.w), (b.y + j) * w + b.x);
    }
  });
  return out;
}

function stats(a: Float32Array, nodata = -1000): { min: number; max: number; missing: number } {
  let min = Infinity;
  let max = -Infinity;
  let missing = 0;
  for (const v of a) {
    if (!(v > nodata)) {
      missing++;
      continue;
    }
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { min, max, missing };
}

/** Générateur pseudo-aléatoire reproductible (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const smoothstep = (lo: number, hi: number, v: number) => {
  const t = clamp((v - lo) / (hi - lo), 0, 1);
  return t * t * (3 - 2 * t);
};

/** Filtre min ou max séparable sur un carré de côté 2r + 1. */
function rankFilter(v: Float32Array, w: number, h: number, r: number, op: 'min' | 'max'): Float32Array {
  const f = op === 'min' ? Math.min : Math.max;
  const tmp = new Float32Array(v.length);
  const out = new Float32Array(v.length);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      let m = v[j * w + i];
      for (let d = Math.max(0, i - r); d <= Math.min(w - 1, i + r); d++) m = f(m, v[j * w + d]);
      tmp[j * w + i] = m;
    }
  }
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      let m = tmp[j * w + i];
      for (let d = Math.max(0, j - r); d <= Math.min(h - 1, j + r); d++) m = f(m, tmp[d * w + i]);
      out[j * w + i] = m;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Arbres

type TreeKind = 'conifer' | 'broadleaf' | 'palm' | 'mangrove' | 'banana' | 'orchard';

/**
 * Classe d'une parcelle du RPG pour le rendu : bananeraie (bananiers instanciés),
 * verger (petits arbres ronds), canne à sucre (champ dense, sans arbres) ou culture
 * ouverte (prairies, maraîchage, ananas, jachères : sans arbres).
 */
function rpgClass(code: string, group: string): 'banana' | 'orchard' | 'cane' | 'open' {
  if (code === 'BEF' || code === 'BCA' || code === 'BAN*') return 'banana';
  if (code === 'CSA' || code === 'MSW') return 'cane';
  if (group === '20' && code !== 'ANA') return 'orchard';
  return 'open';
}

interface Tree {
  x: number;
  y: number;
  h: number; // hauteur réelle (m)
  r: number; // rayon du houppier (m réels)
  k?: TreeKind; // type imposé (plantation procédurale) ; sinon choisi dans Blender
}

/**
 * Maxima locaux du MNH lissé : un pixel est un sommet d'arbre s'il est le plus
 * haut dans un disque dont le rayon croît avec la hauteur (houppiers plus larges
 * pour les grands arbres).
 */
function detectTrees(chm: Float32Array, w: number, h: number, pxGround: number, minH: number): { i: number; j: number; h: number }[] {
  // Lissage 3×3 pour éviter les faux sommets dus au bruit.
  const s = new Float32Array(w * h);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      let sum = 0;
      let wt = 0;
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          const ii = i + di;
          const jj = j + dj;
          if (ii < 0 || jj < 0 || ii >= w || jj >= h) continue;
          const v = chm[jj * w + ii];
          if (!(v > -1000)) continue;
          const k = di === 0 && dj === 0 ? 4 : di === 0 || dj === 0 ? 2 : 1;
          sum += v * k;
          wt += k;
        }
      }
      s[j * w + i] = wt ? sum / wt : 0;
    }
  }

  const peaks = [];
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const v = s[j * w + i];
      if (v < minH) continue;
      // Rayon de recherche (m réels) : 1,5 m pour un arbuste, jusqu'à 3,5 m.
      const rM = Math.min(3.5, Math.max(1.5, 0.12 * v + 1));
      const rPx = Math.max(1, Math.round(rM / pxGround));
      let isMax = true;
      for (let dj = -rPx; dj <= rPx && isMax; dj++) {
        const jj = j + dj;
        if (jj < 0 || jj >= h) continue;
        for (let di = -rPx; di <= rPx; di++) {
          if (di * di + dj * dj > rPx * rPx || (di === 0 && dj === 0)) continue;
          const ii = i + di;
          if (ii < 0 || ii >= w) continue;
          const u = s[jj * w + ii];
          // Égalité : on ne garde que le premier pixel dans l'ordre de balayage.
          if (u > v || (u === v && (dj < 0 || (dj === 0 && di < 0)))) {
            isMax = false;
            break;
          }
        }
      }
      if (isMax) peaks.push({ i, j, h: chm[j * w + i] > v ? chm[j * w + i] : v });
    }
  }
  return peaks;
}

// ---------------------------------------------------------------------------
// ESA WorldCover 2021 (10 m, mondial, CC BY 4.0) : occupation du sol, pour savoir où
// il y a vraiment des arbres quand on n'a pas de MNH. Tuiles GeoTIFF de 3° × 3° en
// EPSG:4326 (12 000 px par degré), palette lue par sharp en RVB.

const WORLDCOVER = 'https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map';

/** Par classe (couleur de la palette WorldCover) : part d'arbres 0–1, sol nu ou lit de rivière 0–1. */
const WC_CLASSES: [number, number, number, number, number][] = [
  [0, 100, 0, 1, 0], // 10 couvert arboré
  [255, 187, 34, 0.6, 0], // 20 arbustes
  [255, 255, 76, 0.05, 0], // 30 prairies
  [240, 150, 255, 0.05, 0], // 40 cultures
  [250, 0, 0, 0.1, 0], // 50 bâti (jardins)
  [180, 180, 180, 0.02, 1], // 60 sol nu (galets des rivières, coulées, carrières)
  [0, 100, 200, 0.5, 1], // 80 eau : sur terre, lits de rivière… ou ombres de ravines (incertain)
  [0, 150, 160, 0.3, 0], // 90 zones humides herbacées
  [0, 207, 117, 1, 0], // 95 mangrove
];

/**
 * Grille des poids « arbres » WorldCover sur l'emprise lon/lat donnée, et fonction
 * d'échantillonnage bilinéaire (lon, lat) → 0–1.
 */
async function worldCover(west: number, south: number, east: number, north: number): Promise<{ trees: (lon: number, lat: number) => number; bare: (lon: number, lat: number) => number }> {
  const tlat = Math.floor(south / 3) * 3;
  const tlon = Math.floor(west / 3) * 3;
  if (Math.floor(north / 3) * 3 !== tlat || Math.floor(east / 3) * 3 !== tlon) throw new Error('WorldCover : emprise sur plusieurs tuiles, non géré');
  const name = `${tlat >= 0 ? 'N' : 'S'}${String(Math.abs(tlat)).padStart(2, '0')}${tlon >= 0 ? 'E' : 'W'}${String(Math.abs(tlon)).padStart(3, '0')}`;
  const dir = join(ROOT, 'data/_cache/worldcover');
  const file = join(dir, `${name}.tif`);
  if (!(await exists(file))) {
    console.log(`  WorldCover ${name}…`);
    await mkdir(dir, { recursive: true });
    await writeFile(file, await fetchBuffer(`${WORLDCOVER}/ESA_WorldCover_10m_2021_v200_${name}_Map.tif`));
  }
  const P = 12000;
  const x0 = Math.max(0, Math.floor((west - tlon) * P) - 2);
  const y0 = Math.max(0, Math.floor((tlat + 3 - north) * P) - 2);
  const w = Math.min(3 * P - x0, Math.ceil((east - west) * P) + 4);
  const h = Math.min(3 * P - y0, Math.ceil((north - south) * P) + 4);
  const rgb = await sharp(file, { limitInputPixels: false }).extract({ left: x0, top: y0, width: w, height: h }).removeAlpha().raw().toBuffer();
  const wt = new Float32Array(w * h);
  const wb = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    let best = Infinity;
    for (const [r, g, b, v, bare] of WC_CLASSES) {
      const d = Math.abs(rgb[i * 3] - r) + Math.abs(rgb[i * 3 + 1] - g) + Math.abs(rgb[i * 3 + 2] - b);
      if (d < best) (best = d), (wt[i] = v), (wb[i] = bare);
    }
  }
  const at = (g: Float32Array) => (lon: number, lat: number) => sampleBilinear(g, w, h, (lon - tlon) * P - x0, (tlat + 3 - lat) * P - y0);
  return { trees: at(wt), bare: at(wb) };
}

// ---------------------------------------------------------------------------
// Vecteurs

type Ring = [number, number][];
interface Feature {
  type: 'Feature';
  geometry: { type: string; coordinates: any };
  properties: Record<string, unknown>;
}

async function fetchWfsLayer(layer: string, bbox: BBox): Promise<Feature[]> {
  const features: Feature[] = [];
  const count = 5000;
  for (let start = 0; ; start += count) {
    const p = new URLSearchParams({
      SERVICE: 'WFS',
      VERSION: '2.0.0',
      REQUEST: 'GetFeature',
      TYPENAMES: layer.includes(':') ? layer : `BDTOPO_V3:${layer}`,
      SRSNAME: 'EPSG:3857',
      BBOX: `${bbox.join(',')},EPSG:3857`,
      OUTPUTFORMAT: 'application/json',
      COUNT: String(count),
      STARTINDEX: String(start),
    });
    const res = await fetch(`${WFS}?${p}`);
    if (!res.ok) throw new Error(`WFS ${layer} : HTTP ${res.status}`);
    const json = (await res.json()) as { features: Feature[] };
    features.push(...json.features);
    if (json.features.length < count) break;
  }
  return features;
}

/** Applique f à chaque coordonnée, quelle que soit la profondeur d'imbrication. */
function mapCoords(c: any, f: (p: [number, number]) => [number, number]): any {
  return typeof c[0] === 'number' ? f(c) : c.map((x: any) => mapCoords(x, f));
}

function pointInRing(x: number, y: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Polygones extérieurs (et trous) d'une géométrie Polygon/MultiPolygon. */
function polygons(g: Feature['geometry']): Ring[][] {
  if (g.type === 'Polygon') return [g.coordinates];
  if (g.type === 'MultiPolygon') return g.coordinates;
  return [];
}

function lines(g: Feature['geometry']): Ring[] {
  if (g.type === 'LineString') return [g.coordinates];
  if (g.type === 'MultiLineString') return g.coordinates;
  return [];
}

/**
 * Rastérise des géométries locales sur une grille (via SVG + sharp) : renvoie un
 * masque 0–255 de w×h px. `px` = taille d'un pixel, (lx0, ly1) = coin nord-ouest.
 */
async function rasterize(
  w: number,
  h: number,
  toPx: (p: [number, number]) => string,
  polys: Ring[][],
  strokes: { line: Ring; width: number }[] = [],
): Promise<Uint8Array> {
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="#000"/>`];
  for (const poly of polys) {
    const d = poly.map((ring) => `M${ring.map(toPx).join('L')}Z`).join('');
    parts.push(`<path d="${d}" fill="#fff" fill-rule="evenodd"/>`);
  }
  for (const { line, width } of strokes) {
    parts.push(`<path d="M${line.map(toPx).join('L')}" fill="none" stroke="#fff" stroke-width="${width.toFixed(2)}" stroke-linecap="round"/>`);
  }
  parts.push('</svg>');
  const { data } = await sharp(Buffer.from(parts.join('')), { limitInputPixels: false })
    .extractChannel(0)
    .raw()
    .toBuffer({ resolveWithObject: true });
  return new Uint8Array(data.buffer, data.byteOffset, w * h);
}

async function blurMask(m: Uint8Array, w: number, h: number, sigma: number): Promise<Uint8Array> {
  // extractChannel : sharp peut ressortir plusieurs canaux d'une image à un seul canal
  const buf = await sharp(Buffer.from(m), { raw: { width: w, height: h, channels: 1 } }).blur(sigma).extractChannel(0).raw().toBuffer();
  if (buf.length !== w * h) throw new Error(`blurMask : ${buf.length} octets, ${w * h} attendus`);
  return new Uint8Array(buf.buffer, buf.byteOffset, w * h);
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const cfg = JSON.parse(await readFile(PATHS.config, 'utf8')) as RegionConfig & RegionOptions;
  const region = computeRegion(cfg);
  await mkdir(DATA, { recursive: true });

  // Les données couvrent l'emprise des tuiles + la marge de rendu des blocs
  // (arrondie au mètre supérieur), pour que le terrain déborde sous les marges.
  const margin = Math.max(50, Math.ceil(region.chunkMarginPx * region.res) + 10);
  const [minx, miny, maxx, maxy] = region.bbox;
  const dataBbox: BBox = [minx - margin, miny - margin, maxx + margin, maxy + margin];
  const toLocal = ([x, y]: [number, number]): [number, number] => [
    Math.round((x - minx) * 100) / 100,
    Math.round((y - miny) * 100) / 100,
  ];
  const localBbox: BBox = [-margin, -margin, region.widthM + margin, region.heightM + margin];
  const pxGroundFactor = 1 / region.k; // m réels par m Mercator

  const demPx = 1; // 1 px ≈ 1 m Mercator
  const demW = Math.round((dataBbox[2] - dataBbox[0]) / demPx);
  const demH = Math.round((dataBbox[3] - dataBbox[1]) / demPx);
  // Ortho : au plus la résolution native (20 cm au sol), au moins celle des tuiles ;
  // inutile de dépasser deux fois la résolution des tuiles (z18 : grandes régions).
  const orthoPx = Math.max(Math.min(region.res, 0.2 * region.k), region.res / 2);
  const orthoW = Math.round((dataBbox[2] - dataBbox[0]) / orthoPx);
  const orthoH = Math.round((dataBbox[3] - dataBbox[1]) / orthoPx);

  // Cache par jeu de données : on retélécharge ce dont la clé (emprise, résolution,
  // options) a changé depuis le dernier passage.
  // Incrémenter les versions quand le traitement change.
  const keys: Record<string, string> = {
    dem: JSON.stringify([5, dataBbox, ...(cfg.lidar === false ? ['sans-lidar'] : []), ...(cfg.seaFill ? ['seafill-2'] : []), ...(cfg.lidar === false ? ['lisse-5m-2'] : []), demPx, cfg.sea ?? false, cfg.seaDepth ?? null]),
    vectors: JSON.stringify([dataBbox, WFS_LAYERS, RPG_LAYER]),
    ortho: JSON.stringify([dataBbox, orthoPx]),
  };
  keys.seabed = JSON.stringify([1, keys.ortho]);
  keys.trees = JSON.stringify([17, keys.dem, keys.vectors, keys.ortho, cfg.climate ?? 'alpine']);
  const prevFile = join(DATA, 'region.json');
  const prevKeys: Record<string, string> = (await exists(prevFile)) ? (JSON.parse(await readFile(prevFile, 'utf8')).cacheKeys ?? {}) : {};
  const stale = async (name: string, ...files: string[]) =>
    FORCE || prevKeys[name] !== keys[name] || !(await Promise.all(files.map((f) => exists(join(DATA, f))))).every(Boolean);

  console.log(`Région ${region.name} : tuiles z${region.maxZoom} x ${region.tiles.x0}–${region.tiles.x1}, y ${region.tiles.y0}–${region.tiles.y1}`);
  console.log(`  emprise ${region.widthM.toFixed(1)} × ${region.heightM.toFixed(1)} m Mercator, k = ${region.k.toFixed(4)}, marge données ${margin} m`);

  // --- MNT -----------------------------------------------------------------
  const demFile = join(DATA, 'dem.f32');
  let dem: Float32Array;
  if (await stale('dem', 'dem.f32')) {
    let st;
    if (cfg.lidar !== false) {
      console.log(`MNT LiDAR HD ${demW}×${demH}…`);
      dem = await fetchFloatGrid(LAYERS.mnt, dataBbox, demW, demH, demPx);
      st = stats(dem);
    } else {
      dem = new Float32Array(demW * demH).fill(NaN);
      st = { missing: dem.length };
    }
    if (st.missing > 0) {
      console.log(`  ${st.missing} px sans LiDAR : RGE ALTI`);
      const alti = await fetchFloatGrid(LAYERS.rgeAlti, dataBbox, demW, demH, demPx);
      for (let i = 0; i < dem.length; i++) if (!(dem[i] > -1000)) dem[i] = alti[i];
    }
    if (cfg.lidar === false) {
      // Hors métropole, le RGE ALTI n'a qu'une résolution native de 5 m, que le WMS
      // rend au plus proche voisin : marches de 5 m, visibles en rayures à l'ombrage
      // (et rubans de routes en pointillés). Lissage à la mesure de la résolution
      // native, normalisé pour ne pas mêler les valeurs sans donnée.
      const ok = new Float32Array(dem.length);
      const vz = new Float32Array(dem.length);
      // Sous seaDepth : valeurs aberrantes du levé (−197…), à ne pas étaler
      const floor = cfg.sea ? (cfg.seaDepth ?? -60) : -1000;
      for (let i = 0; i < dem.length; i++) if (dem[i] > floor) (ok[i] = 1), (vz[i] = dem[i]);
      const num = boxBlur(vz, demW, demH, 2, 2);
      const den = boxBlur(ok, demW, demH, 2, 2);
      for (let i = 0; i < dem.length; i++) if (ok[i] && den[i] > 0.5) dem[i] = num[i] / den[i];
    }
    if (cfg.sea) {
      // Au large, le RGE ALTI n'a plus de bathymétrie : valeurs aberrantes (−99999,
      // −64402, −197…). On bouche ces trous en prolongeant les fonds voisins
      // (push-pull), puis on lisse les fonds : la bathymétrie est bien plus
      // grossière que le relief terrestre et ferait des marches d'escalier.
      const depth = cfg.seaDepth ?? -60;
      const valid = new Uint8Array(dem.length);
      let filled = 0;
      for (let i = 0; i < dem.length; i++) {
        if (dem[i] > depth) valid[i] = 1;
        else filled++;
      }
      if (filled && cfg.seaFill) {
        const f = cfg.seaFill;
        const buf = await readFile(f.file);
        const fill = new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
        for (let j = 0; j < demH; j++) {
          for (let i = 0; i < demW; i++) {
            if (valid[j * demW + i]) continue;
            const mx = dataBbox[0] + (i + 0.5) * demPx;
            const my = dataBbox[3] - (j + 0.5) * demPx;
            dem[j * demW + i] = sampleBilinear(fill, f.width, f.height, (mx - f.bbox[0]) / f.px, (f.bbox[3] - my) / f.px);
          }
        }
        // Fondu sur ~60 m côté fonds mesurés : sans lui, la marche entre levé et
        // comblement dessine un liseré sombre (ombrage de la pente) en mer.
        const invalid = new Uint8Array(dem.length);
        for (let i = 0; i < dem.length; i++) invalid[i] = valid[i] ? 0 : 1;
        const dist = distanceTo(invalid, demW, demH);
        for (let j = 0; j < demH; j++) {
          for (let i = 0; i < demW; i++) {
            const k = j * demW + i;
            const d = dist[k] * demPx;
            if (!valid[k] || d >= 60 || dem[k] > 0) continue;
            const mx = dataBbox[0] + (i + 0.5) * demPx;
            const my = dataBbox[3] - (j + 0.5) * demPx;
            const t = smoothstep(0, 60, d);
            dem[k] = dem[k] * t + sampleBilinear(fill, f.width, f.height, (mx - f.bbox[0]) / f.px, (f.bbox[3] - my) / f.px) * (1 - t);
          }
        }
        console.log(`  ${filled} px de mer sans bathymétrie : comblés par la bathymétrie commune`);
      } else if (filled === dem.length) {
        dem.fill(depth); // section entièrement au large
      } else if (filled) {
        // Seuls les fonds marins servent de germes : avec la terre, un trou loin de toute
        // bathymétrie prenait la moyenne globale (positive) et devenait une île fantôme.
        const seaSeed = new Uint8Array(dem.length);
        for (let i = 0; i < dem.length; i++) if (valid[i] && dem[i] <= 0) seaSeed[i] = 1;
        const sea = inpaint(dem, seaSeed, demW, demH);
        for (let i = 0; i < dem.length; i++) if (!valid[i]) dem[i] = Math.min(sea[i], -1);
        console.log(`  ${filled} px de mer sans bathymétrie : comblés à partir des fonds voisins`);
      }
      // Ouverture morphologique (min puis max) : le levé bathymétrique a enregistré les
      // coques des bateaux au mouillage comme des hauts-fonds ponctuels, effacés ici.
      const opened = rankFilter(rankFilter(dem, demW, demH, 8, 'min'), demW, demH, 8, 'max');
      for (let i = 0; i < dem.length; i++) if (dem[i] < -0.5) dem[i] = Math.min(dem[i], opened[i]);
      const smoothSea = boxBlur(dem, demW, demH, 4);
      for (let i = 0; i < dem.length; i++) {
        // Seuls les fonds sont lissés ; transition douce sur le premier mètre du rivage
        const t = smoothstep(0.5, -1.0, dem[i]);
        if (t > 0) dem[i] = Math.max(depth, Math.min(dem[i] * (1 - t) + smoothSea[i] * t, 0.5 * (1 - t) + dem[i] * t));
      }
    }
    st = stats(dem);
    if (st.missing > 0) throw new Error(`MNT : ${st.missing} px toujours sans donnée`);
    await writeFile(demFile, dem);
  } else {
    const buf = await readFile(demFile);
    dem = new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
  }
  const demStats = stats(dem);
  console.log(`  altitudes ${demStats.min.toFixed(1)}–${demStats.max.toFixed(1)} m`);

  // --- Vecteurs BD TOPO ----------------------------------------------------
  const vecFile = join(DATA, 'vectors.json');
  let vectors: Record<string, Feature[]>;
  if (await stale('vectors', 'vectors.json')) {
    vectors = {};
    for (const layer of [...WFS_LAYERS, 'rpg']) {
      const feats = await fetchWfsLayer(layer === 'rpg' ? RPG_LAYER : layer, dataBbox);
      vectors[layer] = feats.map((f) => ({
        type: 'Feature',
        geometry: { type: f.geometry.type, coordinates: mapCoords(f.geometry.coordinates, toLocal) },
        properties: Object.fromEntries((KEEP[layer] ?? []).map((k) => [k, f.properties[k] ?? null])),
      }));
      console.log(`BD TOPO ${layer} : ${feats.length} objets`);
    }
    await writeFile(vecFile, JSON.stringify(vectors));
  } else {
    vectors = JSON.parse(await readFile(vecFile, 'utf8'));
  }

  // --- Orthophoto ---------------------------------------------------------
  const orthoFile = join(DATA, 'ortho.jpg');
  if (await stale('ortho', 'ortho.jpg')) {
    console.log(`Orthophoto ${orthoW}×${orthoH}…`);
    const parts = await mapPool(blocks(orthoW, orthoH), PARALLEL, async (b) => ({
      input: await fetchBuffer(wmsUrl(LAYERS.ortho, 'image/jpeg', blockBbox(dataBbox, orthoPx, b), b.w, b.h)),
      left: b.x,
      top: b.y,
    }));
    await sharp({ create: { width: orthoW, height: orthoH, channels: 3, background: '#000' }, limitInputPixels: false })
      .composite(parts)
      .jpeg({ quality: 92 })
      .toFile(orthoFile);
  }

  // --- Fond marin -----------------------------------------------------------
  // Ortho à ~1 m/px débarrassée des petits objets clairs (bateaux, sillages) par une
  // ouverture morphologique canal par canal : motifs du fond (récifs, herbiers,
  // sable) pour le matériau de la mer.
  const seabedFile = join(DATA, 'seabed.jpg');
  if (cfg.sea && (await stale('seabed', 'seabed.jpg'))) {
    console.log('Fond marin (ortho sans bateaux)…');
    const rgbBuf = await sharp(orthoFile, { limitInputPixels: false }).resize(demW, demH, { kernel: 'cubic' }).removeAlpha().raw().toBuffer();
    const out = Buffer.alloc(demW * demH * 3);
    for (let c = 0; c < 3; c++) {
      const ch = new Float32Array(demW * demH);
      for (let i = 0; i < ch.length; i++) ch[i] = rgbBuf[i * 3 + c];
      const opened = rankFilter(rankFilter(ch, demW, demH, 7, 'min'), demW, demH, 7, 'max');
      for (let i = 0; i < ch.length; i++) out[i * 3 + c] = opened[i];
    }
    await sharp(out, { raw: { width: demW, height: demH, channels: 3 } }).jpeg({ quality: 90 }).toFile(seabedFile);
  }

  // --- Arbres et masques ---------------------------------------------------
  // canopy.png : 0 = sol nu, 255 = sous les arbres (grille du MNT). Sert au
  // matériau du sol pour neutraliser les arbres « photographiés » de l'ortho.
  // masks.png (RVB, grille du MNT) : R = plage (estran sableux).
  const treesFile = join(DATA, 'trees.json');
  const canopyFile = join(DATA, 'canopy.png');
  const masksFile = join(DATA, 'masks.png');
  let treeSource = 'lidar';
  if (await stale('trees', 'trees.json', 'canopy.png', 'masks.png')) {
    const lx0 = localBbox[0];
    const ly1 = localBbox[3];
    const toPx = ([x, y]: [number, number]) => `${((x - lx0) / demPx).toFixed(2)},${((ly1 - y) / demPx).toFixed(2)}`;
    const buildings = (vectors.batiment ?? []).flatMap((f) => polygons(f.geometry));
    const sand = await rasterize(demW, demH, toPx, (vectors.zone_d_estran ?? []).filter((f) => f.properties.nature === 'Sable').flatMap((f) => polygons(f.geometry)));
    // Les cultures tournent : une parcelle déclarée en canne mais nettement sombre sur
    // l'ortho (luminosité moyenne < 0,355 ; médianes mesurées 0,34 contre 0,40) porte des bananiers.
    {
      const rgb = await sharp(orthoFile, { limitInputPixels: false }).resize(demW, demH).removeAlpha().raw().toBuffer();
      let moved = 0;
      for (const f of vectors.rpg ?? []) {
        if (f.properties.code_cultu !== 'CSA') continue;
        let n = 0;
        let sum = 0;
        for (const poly of polygons(f.geometry)) {
          const ring = poly[0];
          let [bx0, by0, bx1, by1] = [Infinity, Infinity, -Infinity, -Infinity];
          for (const [x, y] of ring) (bx0 = Math.min(bx0, x)), (by0 = Math.min(by0, y)), (bx1 = Math.max(bx1, x)), (by1 = Math.max(by1, y));
          for (let y = by0; y <= by1; y += 2) {
            for (let x = bx0; x <= bx1; x += 2) {
              const pi = Math.floor((x - lx0) / demPx);
              const pj = Math.floor((ly1 - y) / demPx);
              if (pi < 0 || pj < 0 || pi >= demW || pj >= demH || !pointInRing(x, y, ring)) continue;
              const i = pj * demW + pi;
              sum += (0.3 * rgb[i * 3] + 0.59 * rgb[i * 3 + 1] + 0.11 * rgb[i * 3 + 2]) / 255;
              n++;
            }
          }
        }
        if (n > 100 && sum / n < 0.355) (f.properties.code_cultu = 'BAN*'), moved++;
      }
      if (moved) console.log(`  ${moved} parcelles « canne » sombres sur l'ortho traitées en bananeraies`);
    }
    const rpg = (cls: string) =>
      rasterize(demW, demH, toPx, (vectors.rpg ?? []).filter((f) => rpgClass(String(f.properties.code_cultu ?? ''), String(f.properties.code_group ?? '')) === cls).flatMap((f) => polygons(f.geometry)));
    const crops = { banana: await rpg('banana'), orchard: await rpg('orchard'), cane: await rpg('cane'), open: await rpg('open') };
    // WorldCover (sans MNH seulement) : part d'arbres par pixel, pour que les prairies,
    // friches et jardins verts de l'ortho ne deviennent pas des forêts ; sols nus et lits
    // de rivière (galets). Lissés : les pixels de 10 m dessineraient des lisières carrées.
    let wc: Float32Array = new Float32Array(demW * demH).fill(1);
    let bare: Float32Array = new Float32Array(demW * demH);
    if (cfg.lidar === false) {
      const [w0, s0] = mercatorToLonLat(dataBbox[0], dataBbox[1]);
      const [e0, n0] = mercatorToLonLat(dataBbox[2], dataBbox[3]);
      const wcAt = await worldCover(w0, s0, e0, n0);
      // Les galets sont clairs et gris sur l'ortho ; WorldCover classe aussi en eau ou sol nu
      // les ombres profondes des ravines, sombres, qu'on écarte ainsi.
      const rgb = await sharp(orthoFile, { limitInputPixels: false }).resize(demW, demH).removeAlpha().raw().toBuffer();
      for (let j = 0; j < demH; j++) {
        const lat = mercatorToLonLat(0, dataBbox[3] - (j + 0.5) * demPx)[1];
        for (let i = 0; i < demW; i++) {
          const lon = mercatorToLonLat(dataBbox[0] + (i + 0.5) * demPx, 0)[0];
          // Ombre profonde (ravines) : WorldCover y voit de l'eau ou du sol nu, l'ortho n'y
          // dit rien ; sous les tropiques ces versants sont boisés.
          const kk = j * demW + i;
          const shadow = smoothstep(0.22, 0.16, (0.3 * rgb[kk * 3] + 0.59 * rgb[kk * 3 + 1] + 0.11 * rgb[kk * 3 + 2]) / 255);
          wc[kk] = Math.max(wcAt.trees(lon, lat), 0.85 * shadow);
          const k = j * demW + i;
          const [r, g, b] = [rgb[k * 3], rgb[k * 3 + 1], rgb[k * 3 + 2]];
          // Galets au soleil (gris clair) ou à l'ombre (gris-bleu) : assez clair, sans verdeur
          const grey =
            smoothstep(0.24, 0.36, (0.3 * r + 0.59 * g + 0.11 * b) / 255) *
            smoothstep(0.03, -0.01, (g - r) / 255) *
            smoothstep(0.14, 0.06, (Math.max(r, g, b) - Math.min(r, g, b)) / 255);
          bare[k] = dem[k] > 0.3 ? wcAt.bare(lon, lat) * grey : 0;
        }
      }
      wc = boxBlur(wc, demW, demH, Math.round(4 / demPx), 2);
      bare = boxBlur(bare, demW, demH, Math.round(2 / demPx), 2);
    }
    // masks.png (RVBA) : R plage, G canne, B cultures ouvertes, A sol nu / galets
    const masks = Buffer.alloc(demW * demH * 4);
    for (let i = 0; i < demW * demH; i++) {
      masks[i * 4] = sand[i];
      masks[i * 4 + 1] = crops.cane[i];
      masks[i * 4 + 2] = crops.open[i];
      masks[i * 4 + 3] = Math.round(255 * clamp(bare[i], 0, 1));
    }
    await sharp(masks, { raw: { width: demW, height: demH, channels: 4 } }).png().toFile(masksFile);

    let chm: Float32Array;
    if (cfg.lidar !== false) {
      console.log(`MNH LiDAR HD ${demW}×${demH}…`);
      chm = await fetchFloatGrid(LAYERS.mnh, dataBbox, demW, demH, demPx);
    } else {
      chm = new Float32Array(demW * demH).fill(NaN);
    }
    const st = stats(chm);
    let trees: Tree[];
    const canopy = Buffer.alloc(demW * demH);

    if (st.missing < chm.length * 0.5) {
      console.log(`  hauteurs ${st.min.toFixed(1)}–${st.max.toFixed(1)} m, ${st.missing} px sans donnée`);
      for (let i = 0; i < chm.length; i++) canopy[i] = Math.round(255 * clamp((chm[i] - 1.5) / 2.5, 0, 1));
      const peaks = detectTrees(chm, demW, demH, demPx * pxGroundFactor, 3);
      // Le MNH contient aussi les toits : on écarte les sommets dans les bâtiments.
      trees = [];
      for (const p of peaks) {
        const [x, y] = toLocal([dataBbox[0] + (p.i + 0.5) * demPx, dataBbox[3] - (p.j + 0.5) * demPx]);
        const inBuilding = buildings.some((poly) => pointInRing(x, y, poly[0]) && !poly.slice(1).some((hole) => pointInRing(x, y, hole)));
        if (inBuilding) continue;
        const h = Math.round(p.h * 10) / 10;
        // Houppier : proportionnellement plus large pour les arbustes (aulnes verts…)
        const r = Math.round(clamp(0.18 * h + 1, 1.2, 4.5) * 10) / 10;
        trees.push({ x, y, h, r });
      }
      console.log(`  ${trees.length} arbres détectés (${peaks.length - trees.length} sommets écartés sur des toits)`);
    } else {
      treeSource = 'procedural';
      console.log('  pas de MNH ici : plantation procédurale (ortho + zones de végétation)');
      trees = await plantTrees();
    }

    async function plantTrees(): Promise<Tree[]> {
      // Ortho ramenée sur la grille du MNT (~1 m), pour juger la végétation
      const rgbBuf = await sharp(orthoFile, { limitInputPixels: false }).resize(demW, demH, { kernel: 'cubic' }).removeAlpha().raw().toBuffer();
      // Exclusions : bâtiments et routes (largeur ~6 m)
      const roads = (vectors.troncon_de_route ?? [])
        .filter((f) => !String(f.properties.nature ?? '').startsWith('Bac'))
        .flatMap((f) => lines(f.geometry).map((line) => ({ line, width: 6 / demPx })));
      // Stades, terrains de sport, cimetières et plans d'eau (bassins d'irrigation…) : jamais d'arbres
      const grounds = ['terrain_de_sport', 'cimetiere', 'surface_hydrographique'].flatMap((l) => (vectors[l] ?? []).flatMap((f) => polygons(f.geometry)));
      const built = await rasterize(demW, demH, toPx, [...buildings, ...grounds], roads);
      // Zones de végétation BD TOPO par type
      const zone = (pred: (n: string) => boolean) =>
        rasterize(demW, demH, toPx, (vectors.zone_de_vegetation ?? []).filter((f) => pred(String(f.properties.nature ?? ''))).flatMap((f) => polygons(f.geometry)));
      const forest = await zone((n) => n.startsWith('Forêt fermée') || n === 'Bois');
      const open = await zone((n) => n === 'Forêt ouverte' || n === 'Lande ligneuse' || n === 'Haie' || n.startsWith('Verger') || n === 'Peupleraie');
      const mangrove = await zone((n) => n === 'Mangrove');
      const nearSand = await blurMask(sand, demW, demH, 25 / demPx);

      // Indice de végétation de l'ortho : vert plus fort que rouge, et ton sombre
      // (canopée ombrée). Pas d'ExG (2G − R − B) : la brume tropicale bleuit la forêt
      // (≈ 73/81/81) et ferait chuter l'indice.
      const score = new Float32Array(demW * demH);
      for (let i = 0; i < demW * demH; i++) {
        if (dem[i] < 0.3 || built[i] > 64) continue; // mer, bâti, routes
        const r = rgbBuf[i * 3];
        const g = rgbBuf[i * 3 + 1];
        const b = rgbBuf[i * 3 + 2];
        const gr = (g - r) / 255;
        const lum = (0.3 * r + 0.59 * g + 0.11 * b) / 255;
        let s = smoothstep(-0.01, 0.04, gr) * smoothstep(0.5, 0.34, lum);
        if (forest[i] > 128 || mangrove[i] > 128) s = Math.max(s, 0.85 * smoothstep(0.55, 0.38, lum));
        score[i] = s * wc[i];
      }
      if (process.env.DEBUG_MASKS) {
        const dump = (name: string, m: Uint8Array | Buffer) =>
          sharp(Buffer.from(m), { raw: { width: demW, height: demH, channels: 1 } }).png().toFile(join(DATA, `debug_${name}.png`));
        const sc = Buffer.alloc(demW * demH);
        for (let i = 0; i < score.length; i++) sc[i] = Math.round(score[i] * 255);
        const wc8 = Buffer.alloc(demW * demH);
        for (let i = 0; i < wc.length; i++) wc8[i] = Math.round(wc[i] * 255);
        await Promise.all([dump('built', built), dump('forest', forest), dump('open', open), dump('sand_near', nearSand), dump('score', sc), dump('worldcover', wc8)]);
      }
      // Lissage léger : les houppiers font plusieurs mètres
      const s8 = Buffer.alloc(demW * demH);
      for (let i = 0; i < score.length; i++) s8[i] = Math.round(score[i] * 255);
      const smooth = await blurMask(new Uint8Array(s8), demW, demH, 1.5);
      // Pas de sous-bois sombre dans les champs et prairies (seuls des arbres isolés y poussent)
      // Interrangs des bananeraies : sol ombré, comme sur l'ortho
      for (let i = 0; i < smooth.length; i++) canopy[i] = crops.cane[i] > 128 || crops.open[i] > 128 ? 0 : crops.banana[i] > 128 ? 170 : smooth[i];

      // Grille jitterée : un candidat par cellule de ~4,5 m au sol, gardé selon le score.
      // Grille et tirages calés sur les coordonnées Mercator absolues : deux sections
      // voisines plantent les mêmes arbres dans leur recouvrement (pas de raccord visible).
      const cellM = Math.round(4.5 * region.k * 20) / 20;
      const out: Tree[] = [];
      for (let gy = Math.floor(dataBbox[1] / cellM); gy * cellM < dataBbox[3]; gy++) {
        for (let gx = Math.floor(dataBbox[0] / cellM); gx * cellM < dataBbox[2]; gx++) {
          const rand = rng(Math.imul(gx, 73856093) ^ Math.imul(gy, 19349663) ^ 1234);
          const mx = (gx + rand()) * cellM;
          const my = (gy + rand()) * cellM;
          const pi = Math.floor((mx - dataBbox[0]) / demPx);
          const pj = Math.floor((dataBbox[3] - my) / demPx);
          if (pi < 0 || pj < 0 || pi >= demW || pj >= demH) continue;
          const i = pj * demW + pi;
          if (crops.banana[i] > 128) continue; // plantés à part, plus serrés
          let s = smooth[i] / 255;
          if (crops.cane[i] > 128 || crops.open[i] > 128) {
            // Champs et prairies : seulement les arbres isolés, nettement sombres sur l'ortho
            const r = rgbBuf[i * 3];
            const g = rgbBuf[i * 3 + 1];
            const b = rgbBuf[i * 3 + 2];
            // (WorldCover ignoré ici : il voit souvent les cultures hautes comme des arbres)
            s = Math.min(1, smooth[i] / 255 / Math.max(0.05, wc[i])) * 0.25 * smoothstep(0.26, 0.17, (0.3 * r + 0.59 * g + 0.11 * b) / 255);
          }
          if (rand() > s * 1.15) continue;
          const [x, y] = toLocal([mx, my]);
          const v = rand();
          let k: TreeKind = 'broadleaf';
          let h: number;
          if (crops.orchard[i] > 128) {
            k = 'orchard';
            h = 4 + v * 3;
          } else if (mangrove[i] > 128) {
            k = 'mangrove';
            h = 5 + v * 4;
          } else if (nearSand[i] > 20 || (dem[i] < 6 && v < 0.35) || (built[i] > 0 && v < 0.25)) {
            k = 'palm'; // cocotiers en bord de plage, dans le bourg et sur le littoral
            h = 8 + v * 8;
          } else if (forest[i] > 128) {
            h = 12 + v * 12;
          } else if (open[i] > 128) {
            h = 7 + v * 7;
          } else {
            h = 6 + v * 8;
          }
          const r = k === 'palm' ? clamp(0.3 * h, 3.5, 5) : k === 'orchard' ? clamp(0.4 * h + 0.8, 2, 3.5) : clamp(0.28 * h + 1.2, 2, 7);
          out.push({ x, y, h: Math.round(h * 10) / 10, r: Math.round(r * 10) / 10, k });
        }
      }

      // Bananeraies (RPG) : bananiers en rangs alignés, comme sur le terrain. Pour chaque
      // parcelle, l'orientation des rangs est lue sur l'ortho (tenseur de structure : les
      // rangs font des rayures), puis calée sur un bord de la parcelle quand elle en est
      // proche ; l'origine de la grille est un sommet de la parcelle. Deux sections
      // voisines plantent donc les mêmes rangs.
      const W2 = demW * 2;
      const H2 = demH * 2;
      const hiBuf = await sharp(orthoFile, { limitInputPixels: false }).resize(W2, H2, { kernel: 'cubic' }).removeAlpha().raw().toBuffer();
      const Lhi = new Float32Array(W2 * H2);
      for (let k = 0; k < Lhi.length; k++) Lhi[k] = (0.3 * hiBuf[k * 3] + 0.59 * hiBuf[k * 3 + 1] + 0.11 * hiBuf[k * 3 + 2]) / 255;
      const Lb = boxBlur(Lhi, W2, H2, 1, 2); // efface le grain des feuilles, garde les rangs (~3 m)
      const hiPx = demPx / 2;
      const rowM = 3.5 * region.k;
      const stepM = 2.4 * region.k;
      let parcels = 0;
      for (const f of vectors.rpg ?? []) {
        if (rpgClass(String(f.properties.code_cultu ?? ''), String(f.properties.code_group ?? '')) !== 'banana') continue;
        for (const poly of polygons(f.geometry)) {
          const ring = poly[0];
          if (ring.length < 4) continue;
          let [bx0, by0, bx1, by1] = [Infinity, Infinity, -Infinity, -Infinity];
          for (const [x, y] of ring) (bx0 = Math.min(bx0, x)), (by0 = Math.min(by0, y)), (bx1 = Math.max(bx1, x)), (by1 = Math.max(by1, y));
          const inside = (x: number, y: number) => pointInRing(x, y, ring) && !poly.slice(1).some((hole) => pointInRing(x, y, hole));
          // Tenseur de structure sur la partie de la parcelle couverte par les données
          let jxx = 0;
          let jyy = 0;
          let jxy = 0;
          const i0 = Math.max(1, Math.floor((bx0 - localBbox[0]) / hiPx));
          const i1 = Math.min(W2 - 2, Math.ceil((bx1 - localBbox[0]) / hiPx));
          const j0 = Math.max(1, Math.floor((localBbox[3] - by1) / hiPx));
          const j1 = Math.min(H2 - 2, Math.ceil((localBbox[3] - by0) / hiPx));
          for (let jj = j0; jj <= j1; jj += 2) {
            for (let ii = i0; ii <= i1; ii += 2) {
              if (!inside(localBbox[0] + (ii + 0.5) * hiPx, localBbox[3] - (jj + 0.5) * hiPx)) continue;
              const k = jj * W2 + ii;
              const gx = Lb[k + 1] - Lb[k - 1];
              const gy = Lb[k - W2] - Lb[k + W2]; // vers le nord
              jxx += gx * gx;
              jyy += gy * gy;
              jxy += gx * gy;
            }
          }
          const coherence = Math.hypot(jxx - jyy, 2 * jxy) / Math.max(1e-9, jxx + jyy);
          let theta = 0.5 * Math.atan2(2 * jxy, jxx - jyy) + Math.PI / 2; // rangs ⟂ gradient
          // Directions des bords (> 15 m) : calage si proche, repli sur le plus long bord
          let longest = 0;
          let longAngle = 0;
          let snap: number | null = null;
          let snapDiff = (15 * Math.PI) / 180;
          for (let e = 0; e + 1 < ring.length; e++) {
            const dx = ring[e + 1][0] - ring[e][0];
            const dy = ring[e + 1][1] - ring[e][1];
            const len = Math.hypot(dx, dy);
            if (len < 15) continue;
            const a = Math.atan2(dy, dx);
            if (len > longest) (longest = len), (longAngle = a);
            const d = Math.abs(((a - theta + Math.PI / 2) % Math.PI + Math.PI) % Math.PI - Math.PI / 2);
            if (d < snapDiff) (snapDiff = d), (snap = a);
          }
          if (coherence < 0.08) theta = longAngle;
          else if (snap !== null) theta = snap;
          const ux = Math.cos(theta);
          const uy = Math.sin(theta);
          const [ox, oy] = ring[0];
          // Plage (u le long des rangs, v en travers) couvrant la parcelle
          let [u0, u1, v0, v1] = [Infinity, -Infinity, Infinity, -Infinity];
          for (const [x, y] of [[bx0, by0], [bx1, by0], [bx0, by1], [bx1, by1]]) {
            const u = (x - ox) * ux + (y - oy) * uy;
            const v = -(x - ox) * uy + (y - oy) * ux;
            (u0 = Math.min(u0, u)), (u1 = Math.max(u1, u)), (v0 = Math.min(v0, v)), (v1 = Math.max(v1, v));
          }
          const seed = Math.imul(Math.round(ox + minx), 73856093) ^ Math.imul(Math.round(oy + miny), 19349663);
          for (let rv = Math.floor(v0 / rowM); rv * rowM <= v1; rv++) {
            for (let ru = Math.floor(u0 / stepM); ru * stepM <= u1; ru++) {
              const rand = rng(seed ^ Math.imul(rv, 83492791) ^ Math.imul(ru, 2654435761));
              const u = (ru + 0.5) * stepM + (rand() - 0.5) * 0.5;
              const v = (rv + 0.5) * rowM + (rand() - 0.5) * 0.4;
              const x = ox + u * ux - v * uy;
              const y = oy + u * uy + v * ux;
              if (x < localBbox[0] || y < localBbox[1] || x >= localBbox[2] || y >= localBbox[3] || !inside(x, y)) continue;
              const pi = Math.floor((x - localBbox[0]) / demPx);
              const pj = Math.floor((localBbox[3] - y) / demPx);
              const i = pj * demW + pi;
              if (built[i] > 64) continue;
              // Trous de l'ortho (replantation, récolte) : on n'y plante pas
              if (rand() > 1.6 * smoothstep(-0.02, 0.03, (rgbBuf[i * 3 + 1] - rgbBuf[i * 3]) / 255)) continue;
              const h = 3.5 + rand() * 1.8;
              out.push({ x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100, h: Math.round(h * 10) / 10, r: Math.round((1.75 + 0.1 * h * rand()) * 10) / 10, k: 'banana' });
            }
          }
          parcels++;
        }
      }
      console.log(`  ${parcels} parcelles de bananes plantées en rangs`);

      const byKind = out.reduce<Record<string, number>>((a, t) => ((a[t.k!] = (a[t.k!] ?? 0) + 1), a), {});
      console.log(`  ${out.length} arbres plantés ${JSON.stringify(byKind)}`);
      return out;
    }

    await sharp(canopy, { raw: { width: demW, height: demH, channels: 1 } }).blur(1.2).extractChannel(0).png().toFile(canopyFile);
    await writeFile(treesFile, JSON.stringify(trees));
  } else {
    treeSource = JSON.parse(await readFile(prevFile, 'utf8')).trees?.source ?? 'lidar';
  }
  const treeCount = JSON.parse(await readFile(treesFile, 'utf8')).length;

  // --- Métadonnées ---------------------------------------------------------
  const meta = {
    ...region,
    climate: cfg.climate ?? 'alpine',
    dataBbox,
    localBbox, // emprise des données en coordonnées locales
    dem: { file: 'dem.f32', width: demW, height: demH, pxM: demPx, min: demStats.min, max: demStats.max },
    ortho: { file: 'ortho.jpg', width: orthoW, height: orthoH, pxM: orthoPx },
    trees: { file: 'trees.json', count: treeCount, source: treeSource },
    canopy: { file: 'canopy.png', width: demW, height: demH },
    ...(cfg.sea ? { seabed: { file: 'seabed.jpg', width: demW, height: demH } } : {}),
    masks: { file: 'masks.png', width: demW, height: demH, channels: { r: 'plage', g: 'canne à sucre', b: 'cultures ouvertes et prairies', a: 'sol nu, lits de rivière' } },
    vectors: { file: 'vectors.json', layers: Object.fromEntries(Object.entries(vectors).map(([k, v]) => [k, v.length])) },
    cacheKeys: keys,
  };
  await writeFile(prevFile, JSON.stringify(meta, null, 2));
  console.log(`${prevFile.replace(PATHS.data, `data/${PATHS.name}${PATHS.section ? `/sections/${PATHS.section}` : ''}`)} écrit.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
