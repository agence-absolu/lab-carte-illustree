// Découpe les blocs rendus par Blender en tuiles XYZ (WebP) au zoom max, puis
// construit la pyramide des zooms inférieurs (assemblage 2×2 + réduction).
//
// Densités : si les blocs ont été rendus en ×2 (renderScale), on produit des tuiles
// HD 512 px nommées {y}@2x.webp (convention retina), et les tuiles 256 px {y}.webp
// sont obtenues en réduisant les HD (suréchantillonnage, plus fin qu'un rendu 1x).
// La densité est déduite de la taille de chaque bloc rendu.
//
// Usage : node scripts/make-tiles.ts [--region nom] [saison…]   (toutes les saisons par défaut)
//
// Grandes régions (scripts/run-tiled.ts) :
//   --section id --cut-only : découpe les blocs d'une section au zoom max, sans rien effacer ;
//   --pyramid-only          : construit les zooms inférieurs et les métadonnées de la région.

import { mkdir, readFile, rm, access, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp, { type Sharp } from 'sharp';
import type { Region } from '../lib/geo.ts';
import { ROOT, listRegions, regionFromArgs } from '../lib/region.ts';

const PATHS = regionFromArgs();
const flag = (f: string) => {
  const i = process.argv.indexOf(f);
  if (i >= 0) process.argv.splice(i, 1);
  return i >= 0;
};
const CUT_ONLY = flag('--cut-only');
const PYRAMID_ONLY = flag('--pyramid-only');
const WEBP = { 1: { quality: 88, effort: 5 }, 2: { quality: 82, effort: 5 } } as const;

type Scale = 1 | 2;

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

const suffix = (s: Scale) => (s === 1 ? '' : `@${s}x`);
const tilePath = (dir: string, z: number, x: number, y: number, s: Scale) =>
  join(dir, String(z), String(x), `${y}${suffix(s)}.webp`);

async function writeTile(dir: string, z: number, x: number, y: number, s: Scale, img: Sharp): Promise<void> {
  await mkdir(join(dir, String(z), String(x)), { recursive: true });
  await img.webp(WEBP[s]).toFile(tilePath(dir, z, x, y, s));
}

/** Exécute les tâches avec au plus `n` en parallèle. */
async function pool<T>(items: T[], n: number, f: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (next < items.length) await f(items[next++]);
  }));
}

async function cutChunks(region: Region, season: string, dir: string): Promise<Scale[]> {
  const ts = region.tileSize;
  const n = region.chunkTiles;
  const { x0, y0 } = region.tiles;

  // --- Zoom max : découpe des blocs -----------------------------------------
  const scales = new Set<Scale>([1]);
  let count = 0;
  for (let cy = 0; cy < region.chunks.ny; cy++) {
    for (let cx = 0; cx < region.chunks.nx; cx++) {
      const file = join(PATHS.output, 'renders', season, `chunk_${cx}_${cy}.png`);
      if (!(await exists(file))) {
        console.warn(`  bloc manquant : ${file}`);
        continue;
      }
      const { width = 0 } = await sharp(file).metadata();
      const s = width / (n * ts + 2 * region.chunkMarginPx);
      if (s !== 1 && s !== 2) throw new Error(`${file} : largeur ${width} px, densité ${s} non gérée`);
      scales.add(s);
      const tsS = ts * s;
      // Bloc recadré (marge retirée), gardé en mémoire brute pour les découpes
      const { data, info } = await sharp(file)
        .extract({ left: region.chunkMarginPx * s, top: region.chunkMarginPx * s, width: n * tsS, height: n * tsS })
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      const raw = { raw: { width: info.width, height: info.height, channels: info.channels } };
      for (let j = 0; j < n; j++) {
        for (let i = 0; i < n; i++) {
          const x = x0 + cx * n + i;
          const y = y0 + cy * n + j;
          const tile = () => sharp(data, raw).extract({ left: i * tsS, top: j * tsS, width: tsS, height: tsS });
          if (s === 2) {
            await writeTile(dir, region.maxZoom, x, y, 2, tile());
            await writeTile(dir, region.maxZoom, x, y, 1, tile().resize(ts, ts, { kernel: 'lanczos3' }));
          } else {
            await writeTile(dir, region.maxZoom, x, y, 1, tile());
          }
          count++;
        }
      }
    }
  }
  const list = [...scales].sort() as Scale[];
  console.log(`  z${region.maxZoom} : ${count} tuiles (densités ${list.map((s) => `${s}x`).join(', ')})`);
  return list;
}

async function makePyramid(region: Region, dir: string, list: Scale[]): Promise<void> {
  const ts = region.tileSize;
  const { x0, y0, x1, y1 } = region.tiles;
  let [bx0, by0, bx1, by1] = [x0, y0, x1, y1];
  for (let z = region.maxZoom - 1; z >= region.minZoom; z--) {
    [bx0, by0, bx1, by1] = [bx0 >> 1, by0 >> 1, bx1 >> 1, by1 >> 1];
    let made = 0;
    for (const s of list) {
      const tsS = ts * s;
      const cells: [number, number][] = [];
      for (let x = bx0; x <= bx1; x++) for (let y = by0; y <= by1; y++) cells.push([x, y]);
      await pool(cells, 8, async ([x, y]) => {
        const parts = [];
        for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
          const child = tilePath(dir, z + 1, 2 * x + dx, 2 * y + dy, s);
          if (await exists(child)) parts.push({ input: child, left: dx * tsS, top: dy * tsS });
        }
        if (!parts.length) {
          // Plus aucun enfant (blocs retirés, ex. pleine mer) : la parente d'un passage précédent est périmée
          await rm(tilePath(dir, z, x, y, s), { force: true });
          return;
        }
        // Enfants manquants (bords de la région) : transparents
        const mosaic = await sharp({
          create: { width: 2 * tsS, height: 2 * tsS, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
        })
          .composite(parts)
          .png()
          .toBuffer();
        await writeTile(dir, z, x, y, s, sharp(mosaic).resize(tsS, tsS, { kernel: 'lanczos3' }));
        made++;
      });
    }
    console.log(`  z${z} : ${made} tuiles`);
  }
}

async function makeSeason(region: Region, season: string): Promise<Scale[]> {
  const dir = join(PATHS.tiles, season);
  if (CUT_ONLY) return cutChunks(region, season, dir);
  let list: Scale[];
  if (PYRAMID_ONLY) {
    list = region.renderScale === 2 ? [1, 2] : [1];
  } else {
    await rm(dir, { recursive: true, force: true });
    list = await cutChunks(region, season, dir);
  }
  await makePyramid(region, dir, list);
  return list;
}

async function main(): Promise<void> {
  const region = JSON.parse(await readFile(join(PATHS.data, 'region.json'), 'utf8')) as Region & { description?: string };
  const cfg = JSON.parse(await readFile(PATHS.config, 'utf8'));
  const seasons = process.argv.slice(2).length ? process.argv.slice(2) : region.seasons;
  let scales: Scale[] = [1];
  for (const season of seasons) {
    console.log(`Saison ${season}`);
    scales = await makeSeason(region, season);
  }
  if (CUT_ONLY) return;
  // Métadonnées pour la visionneuse
  const meta = {
    name: region.name,
    description: cfg.description ?? region.name,
    climate: cfg.climate ?? 'alpine',
    // Légèrement rentrées : une borne pile sur une limite de tuile ferait demander
    // la rangée voisine, inexistante.
    bounds: region.lonLatBounds.map((v, i) => v + (i < 2 ? 1e-7 : -1e-7)),
    center: [(region.lonLatBounds[0] + region.lonLatBounds[2]) / 2, (region.lonLatBounds[1] + region.lonLatBounds[3]) / 2],
    // Grande région : la grille déborde largement sur la mer, on cadre sur l'emprise utile
    ...(cfg.bounds ? { fit: cfg.bounds } : {}),
    minzoom: region.minZoom,
    maxzoom: region.maxZoom,
    seasons: region.seasons,
    scales,
  };
  await writeFile(join(PATHS.tiles, 'region.json'), JSON.stringify(meta, null, 2));
  // Index des régions disponibles pour la visionneuse
  const index = [];
  for (const name of listRegions()) {
    try {
      const m = JSON.parse(await readFile(join(ROOT, 'public/tiles', name, 'region.json'), 'utf8'));
      index.push({ name, description: m.description ?? name });
    } catch {
      // région pas encore tuilée
    }
  }
  await writeFile(join(ROOT, 'public/tiles/regions.json'), JSON.stringify(index, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
