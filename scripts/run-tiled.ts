// Grande région (île entière…) : ni les données ni la scène Blender ne tiennent en un
// morceau. La grille des blocs est découpée en sections de N×N blocs ; chaque section
// est traitée comme une petite région (fetch-data → render → découpe des tuiles au
// zoom max), puis ses données et rendus sont effacés. La pyramide des zooms inférieurs
// est construite à la fin sur l'ensemble des tuiles.
//
// Seuls les blocs utiles sont rendus : ceux qui contiennent de la terre ou des
// hauts-fonds (relief grossier RGE ALTI), plus une couronne de mer autour des côtes.
// Le reste (large) est laissé vide : la visionneuse affiche sa couleur de fond.
//
// Reprise : une section terminée est notée dans data/{nom}/done/ et sautée ensuite.
//
// Usage : node scripts/run-tiled.ts --region nom [--plan] [--jobs n] [--limit n] [--only sx_sy…]
//         [--no-pyramid] [--keep] [-- options build_scene.py]
//   --keep : garder données et rendus des sections (examen)

import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, access, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { computeRegion, type Region, type RegionConfig } from '../lib/geo.ts';
import { ROOT, regionFromArgs } from '../lib/region.ts';
import { boxBlur, distanceTo, inpaint } from '../lib/raster.ts';

const PATHS = regionFromArgs();
const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
const opts = sep >= 0 ? argv.slice(0, sep) : argv;
const extra = sep >= 0 ? argv.slice(sep + 1) : [];
const optValue = (name: string) => (opts.includes(name) ? opts[opts.indexOf(name) + 1] : undefined);
const PLAN = opts.includes('--plan');
const LIMIT = Number(optValue('--limit') ?? Infinity);
const JOBS = Number(optValue('--jobs') ?? 1);
const ONLY = opts.includes('--only') ? opts.slice(opts.indexOf('--only') + 1).filter((o) => /^\d+_\d+$/.test(o)) : null;

// Version du rendu : une section notée faite avec une autre version est refaite
// (à incrémenter quand données ou scène changent).
const PIPELINE = '4';
// Versions encore valables pour une section sans eau profonde : la v4 n'a changé que la
// mer au-delà de 25 m (couleur unie du large).
const SHALLOW_OK = ['3'];
// Profondeurs (m, négatives) du dégradé vers la couleur unie du large (build_scene.py,
// smooth(depth, 25, 55)), avec un peu de marge pour le relief grossier.
const DEEP_FROM = -24;
const OPEN_SEA_BELOW = -56;
const COARSE_PX = 25; // m Mercator par pixel du relief grossier
const SEA_FALLOFF = 800; // m : distance aux données où la mer comblée atteint seaDepth

interface TiledConfig extends RegionConfig {
  bounds: [number, number, number, number]; // ouest, sud, est, nord (degrés)
  tiled: { sectionChunks: number; keepDepth: number; coastChunks: number };
  climate?: string;
  sea?: boolean;
  seaDepth?: number;
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

function run(script: string, args: string[], log: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(ROOT, 'scripts', script), ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    const out: string[] = [];
    child.stdout.on('data', (d) => out.push(String(d)));
    child.stderr.on('data', (d) => out.push(String(d)));
    child.on('close', async (code) => {
      await writeFile(log, out.join(''), { flag: 'a' });
      if (code === 0) resolve();
      else reject(new Error(`${script} ${args.join(' ')} : code ${code}\n${out.join('').split('\n').slice(-15).join('\n')}`));
    });
  });
}

/** Relief grossier RGE ALTI de toute l'emprise (lignes du nord vers le sud), en cache. */
async function coarseDem(bbox: [number, number, number, number]): Promise<{ v: Float32Array; w: number; h: number }> {
  const w = Math.ceil((bbox[2] - bbox[0]) / COARSE_PX);
  const h = Math.ceil((bbox[3] - bbox[1]) / COARSE_PX);
  const file = join(PATHS.data, 'coarse.f32');
  const key = join(PATHS.data, 'coarse.json');
  const k = JSON.stringify([bbox, COARSE_PX]);
  if ((await exists(file)) && (await readFile(key, 'utf8').catch(() => '')) === k) {
    const buf = await readFile(file);
    return { v: new Float32Array(buf.buffer, buf.byteOffset, w * h), w, h };
  }
  console.log(`Relief grossier ${w}×${h} (${COARSE_PX} m/px)…`);
  const v = new Float32Array(w * h);
  const B = 1024;
  for (let y = 0; y < h; y += B) {
    for (let x = 0; x < w; x += B) {
      const bw = Math.min(B, w - x);
      const bh = Math.min(B, h - y);
      const bb = [bbox[0] + x * COARSE_PX, bbox[3] - (y + bh) * COARSE_PX, bbox[0] + (x + bw) * COARSE_PX, bbox[3] - y * COARSE_PX];
      const p = new URLSearchParams({
        SERVICE: 'WMS', VERSION: '1.3.0', REQUEST: 'GetMap', STYLES: '', CRS: 'EPSG:3857',
        BBOX: bb.join(','), WIDTH: String(bw), HEIGHT: String(bh),
        LAYERS: 'ELEVATION.ELEVATIONGRIDCOVERAGE.HIGHRES', FORMAT: 'image/x-bil;bits=32',
      });
      const res = await fetch(`https://data.geopf.fr/wms-r?${p}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (!res.ok || buf.length !== bw * bh * 4) throw new Error(`relief grossier : HTTP ${res.status}, ${buf.toString("utf8", 0, 400)}`);
      const src = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length));
      for (let j = 0; j < bh; j++) v.set(src.subarray(j * bw, (j + 1) * bw), (y + j) * w + x);
    }
  }
  await writeFile(file, v);
  await writeFile(key, k);
  return { v, w, h };
}

async function main(): Promise<void> {
  const cfg = JSON.parse(await readFile(PATHS.config, 'utf8')) as TiledConfig;
  const { sectionChunks: S, keepDepth, coastChunks } = cfg.tiled;
  const N = cfg.chunkTiles;
  const z = cfg.maxZoom;

  // --- Grille globale -------------------------------------------------------
  // Calée sur un multiple de 2^(zmax − zmin) tuiles : pyramide alignée jusqu'au
  // zoom min, et sur les sections.
  const align = Math.max(S * N, 2 ** (z - cfg.minZoom));
  const n = 2 ** z;
  const tx = (lon: number) => ((lon + 180) / 360) * n;
  const ty = (lat: number) => {
    const r = (lat * Math.PI) / 180;
    return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n;
  };
  const [west, south, east, north] = cfg.bounds;
  const x0 = Math.floor(tx(west) / align) * align;
  const y0 = Math.floor(ty(north) / align) * align;
  const x1 = Math.ceil(tx(east) / align) * align - 1;
  const y1 = Math.ceil(ty(south) / align) * align - 1;
  const region: Region = computeRegion({ ...cfg, tiles: { x0, y0, x1, y1 } });
  await mkdir(join(PATHS.data, 'done'), { recursive: true });
  await writeFile(join(PATHS.data, 'region.json'), JSON.stringify({ ...region, climate: cfg.climate ?? 'alpine', tiled: true }, null, 2));
  const { nx, ny } = region.chunks;
  console.log(`Grille z${z} : tuiles x ${x0}–${x1}, y ${y0}–${y1} → ${nx}×${ny} blocs de ${N}×${N} tuiles`);

  // --- Blocs utiles ---------------------------------------------------------
  const dem = await coarseDem(region.bbox);
  const blockM = N * region.tileSize * region.res;
  const land = new Uint8Array(nx * ny);
  const shallow = new Uint8Array(nx * ny);
  for (let j = 0; j < dem.h; j++) {
    for (let i = 0; i < dem.w; i++) {
      const v = dem.v[j * dem.w + i];
      const cx = Math.floor(((i + 0.5) * COARSE_PX) / blockM);
      const cy = Math.floor(((j + 0.5) * COARSE_PX) / blockM);
      if (cx >= nx || cy >= ny) continue;
      if (v > 0.5) land[cy * nx + cx] = 1;
      else if (v > keepDepth) shallow[cy * nx + cx] = 1;
    }
  }
  const keep = new Uint8Array(nx * ny);
  for (let cy = 0; cy < ny; cy++) {
    for (let cx = 0; cx < nx; cx++) {
      if (shallow[cy * nx + cx]) keep[cy * nx + cx] = 1;
      if (!land[cy * nx + cx]) continue;
      for (let dy = -coastChunks; dy <= coastChunks; dy++) {
        for (let dx = -coastChunks; dx <= coastChunks; dx++) {
          const a = cx + dx;
          const b = cy + dy;
          if (a >= 0 && b >= 0 && a < nx && b < ny) keep[b * nx + a] = 1;
        }
      }
    }
  }
  // --- Bathymétrie de comblement, commune à toutes les sections ---------------
  // Au large, le RGE ALTI n'a plus de bathymétrie. Comblée section par section, la
  // profondeur inventée changerait d'une section à l'autre (carrés de bleus différents) :
  // on la calcule une fois sur toute l'emprise, en prolongeant les fonds connus puis en
  // plongeant vers seaDepth en s'éloignant des données.
  const seaFillFile = join(PATHS.data, 'seafill.f32');
  // Relief et fonds de chaque bloc (bord compris, ±1 pixel grossier) : plus haut et plus
  // bas point. Blocs de pleine mer = uniformément de la couleur du fond de la visionneuse,
  // inutile de les rendre : leurs tuiles sont supprimées, la visionneuse montre son fond.
  const blockMax = new Float32Array(nx * ny).fill(-Infinity);
  const blockMin = new Float32Array(nx * ny).fill(Infinity);
  const openSea: number[] = [];
  if (cfg.sea) {
    const depth = cfg.seaDepth ?? -60;
    const valid = new Uint8Array(dem.v.length);
    for (let i = 0; i < valid.length; i++) valid[i] = dem.v[i] > depth ? 1 : 0;
    const filled = inpaint(dem.v, valid, dem.w, dem.h);
    const dist = distanceTo(valid, dem.w, dem.h);
    for (let i = 0; i < filled.length; i++) {
      if (valid[i]) continue;
      const t = Math.min(1, (dist[i] * COARSE_PX) / SEA_FALLOFF);
      filled[i] = Math.min(-0.5, filled[i] * (1 - t * t * (3 - 2 * t)) + depth * (t * t * (3 - 2 * t)));
    }
    // Lissage du comblement seul (~200 m) : le bord des levés suit des dalles carrées
    const soft = boxBlur(filled, dem.w, dem.h, 8);
    for (let i = 0; i < filled.length; i++) if (!valid[i]) filled[i] = Math.min(-0.5, soft[i]);
    await writeFile(seaFillFile, filled);

    for (let j = 0; j < dem.h; j++) {
      for (let i = 0; i < dem.w; i++) {
        const v = filled[j * dem.w + i];
        for (let dj = -1; dj <= 1; dj++) {
          for (let di = -1; di <= 1; di++) {
            const cx = Math.floor(((i + di + 0.5) * COARSE_PX) / blockM);
            const cy = Math.floor(((j + dj + 0.5) * COARSE_PX) / blockM);
            if (cx < 0 || cy < 0 || cx >= nx || cy >= ny) continue;
            const b = cy * nx + cx;
            if (v > blockMax[b]) blockMax[b] = v;
            if (v < blockMin[b]) blockMin[b] = v;
          }
        }
      }
    }
    for (let b = 0; b < nx * ny; b++) {
      if (keep[b] && blockMax[b] < OPEN_SEA_BELOW) {
        keep[b] = 0;
        openSea.push(b);
      }
    }
  }
  // Blocs gardés avant extension : la reprise compare le nombre de blocs d'une section
  // faite avec une version qui ne le notait pas
  const baseKeep = keep.slice();
  // Extension jusqu'à la pleine mer : un bloc gardé dont le voisin n'est pas entièrement
  // profond s'arrêterait net sur de l'eau claire. Le choix des blocs se fait sur le relief
  // brut (valeurs aberrantes du large ignorées), la mer comblée dit où elle est vraiment profonde.
  let grown = 0;
  if (cfg.sea) {
    for (let grew = true; grew; ) {
      grew = false;
      for (let cy = 0; cy < ny; cy++) {
        for (let cx = 0; cx < nx; cx++) {
          const b = cy * nx + cx;
          if (keep[b] || blockMax[b] < OPEN_SEA_BELOW) continue;
          let near = false;
          for (let dy = -1; dy <= 1 && !near; dy++) {
            for (let dx = -1; dx <= 1 && !near; dx++) {
              const a = cx + dx;
              const c = cy + dy;
              near = a >= 0 && c >= 0 && a < nx && c < ny && keep[c * nx + a] === 1;
            }
          }
          if (near) {
            keep[b] = 1;
            grown++;
            grew = true;
          }
        }
      }
    }
  }

  // Aperçu du plan : terre, hauts-fonds, blocs gardés
  const prev = Buffer.alloc(nx * ny * 3);
  for (let i = 0; i < nx * ny; i++) {
    prev[i * 3] = land[i] ? 60 : 0;
    prev[i * 3 + 1] = land[i] ? 160 : shallow[i] ? 120 : 0;
    prev[i * 3 + 2] = keep[i] ? 200 : 40;
  }
  await sharp(prev, { raw: { width: nx, height: ny, channels: 3 } }).resize(nx * 4, ny * 4, { kernel: 'nearest' }).png().toFile(join(PATHS.data, 'plan.png'));

  const sections = new Map<string, { sx: number; sy: number; chunks: [number, number][] }>();
  for (let cy = 0; cy < ny; cy++) {
    for (let cx = 0; cx < nx; cx++) {
      if (!keep[cy * nx + cx]) continue;
      const sx = Math.floor(cx / S);
      const sy = Math.floor(cy / S);
      const id = `${sx}_${sy}`;
      if (!sections.has(id)) sections.set(id, { sx, sy, chunks: [] });
      sections.get(id)!.chunks.push([cx - sx * S, cy - sy * S]);
    }
  }
  const nKeep = keep.reduce((a, b) => a + b, 0);
  const done = new Set<string>();
  for (const f of await readdir(join(PATHS.data, 'done'))) {
    if (f.startsWith('.')) continue;
    const [ver, , count] = (await readFile(join(PATHS.data, 'done', f), 'utf8')).split(' ');
    const v = ver.slice(1);
    const sec = sections.get(f);
    const deep = sec?.chunks.some(([a, b]) => blockMin[(sec.sy * S + b) * nx + sec.sx * S + a] < DEEP_FROM);
    // Nombre de blocs rendus : noté depuis l'extension vers la pleine mer, sinon ceux d'avant
    let base = 0;
    if (sec) for (let b = 0; b < S; b++) for (let a = 0; a < S; a++) base += baseKeep[(sec.sy * S + b) * nx + sec.sx * S + a];
    const sameChunks = sec && sec.chunks.length === (count ? Number(count) : base);
    if (sameChunks && (v === PIPELINE || (SHALLOW_OK.includes(v) && !deep))) done.add(f);
    // Section devenue entièrement pleine mer : plus rien à rendre
    if (!sec) await rm(join(PATHS.data, 'done', f), { force: true });
  }
  // Tuiles des blocs de pleine mer (rendus par une version précédente)
  let removed = 0;
  if (!PLAN) {
    for (const b of openSea) {
      const tx0 = x0 + (b % nx) * N;
      const ty0 = y0 + Math.floor(b / nx) * N;
      for (const season of cfg.seasons) {
        for (let x = tx0; x < tx0 + N; x++) {
          for (let y = ty0; y < ty0 + N; y++) {
            const f = join(PATHS.tiles, season, String(z), String(x), `${y}.webp`);
            if (await exists(f)) {
              await rm(f);
              removed++;
            }
          }
        }
      }
    }
  }
  console.log(`${openSea.length} blocs de pleine mer non rendus (fond de la visionneuse)${removed ? `, ${removed} tuiles supprimées` : ''} ; ${grown} blocs ajoutés jusqu'à la pleine mer`);
  let todo = [...sections.entries()].filter(([id]) => (ONLY ? ONLY.includes(id) : !done.has(id))); // --only : refait même si déjà faite
  console.log(`${nKeep} blocs à rendre (${nKeep * N * N} tuiles z${z}) sur ${nx * ny}, en ${sections.size} sections de ${S}×${S} blocs ; ${done.size} déjà faites, ${todo.length} à faire`);
  todo = todo.slice(0, LIMIT);
  if (PLAN) return;

  // --- Traitement des sections ----------------------------------------------
  // JOBS sections à la fois, chacune enchaînant téléchargement, rendu et découpe :
  // les sections se décalent d'elles-mêmes, réseau et Blender travaillent en même temps.
  const logDir = join(ROOT, 'output', PATHS.name, 'logs');
  await mkdir(logDir, { recursive: true });
  const t0 = Date.now();
  let finished = 0;
  let failed = 0;
  const processSection = async (id: string, sec: { sx: number; sy: number; chunks: [number, number][] }) => {
    const ts = Date.now();
    const log = join(logDir, `${id}.log`);
    const dir = join(PATHS.data, 'sections', id);
    await mkdir(dir, { recursive: true });
    const { sx, sy } = sec;
    const tiles = { x0: x0 + sx * S * N, y0: y0 + sy * S * N, x1: x0 + (sx + 1) * S * N - 1, y1: y0 + (sy + 1) * S * N - 1 };
    const { bounds, tiled, ...rest } = cfg;
    const seaFill = cfg.sea ? { file: seaFillFile, bbox: region.bbox, px: COARSE_PX, width: dem.w, height: dem.h } : undefined;
    await writeFile(join(dir, 'config.json'), JSON.stringify({ ...rest, name: `${cfg.name}/${id}`, tiles, seaFill }, null, 2));
    try {
      await run('fetch-data.ts', ['--region', PATHS.name, '--section', id], log);
      const chunks = sec.chunks.map(([a, b]) => `${a},${b}`);
      await run('render.ts', ['--region', PATHS.name, '--section', id, ...cfg.seasons, '--', '--chunks', ...chunks, ...extra], log);
      await run('make-tiles.ts', ['--region', PATHS.name, '--section', id, '--cut-only'], log);
      await writeFile(join(PATHS.data, 'done', id), `v${PIPELINE} ${new Date().toISOString()} ${sec.chunks.length}`);
      if (!opts.includes('--keep')) {
        await rm(dir, { recursive: true, force: true });
        await rm(join(ROOT, 'output', PATHS.name, 'sections', id), { recursive: true, force: true });
      }
    } catch (err) {
      failed++;
      console.error(`Section ${id} : échec (journal ${log})\n${(err as Error).message}`);
      return;
    }
    finished++;
    const left = todo.length - finished - failed;
    const eta = ((Date.now() - t0) / 1000 / (finished + failed)) * left;
    console.log(
      `[${finished + failed}/${todo.length}] section ${id} (${sec.chunks.length} blocs) en ${((Date.now() - ts) / 1000).toFixed(0)} s` +
        ` — reste ~${(eta / 3600).toFixed(1)} h`,
    );
  };
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(JOBS, todo.length) }, async () => {
      while (next < todo.length) {
        const [id, sec] = todo[next++];
        await processSection(id, sec);
      }
    }),
  );
  if (failed) console.error(`${failed} section(s) en échec : relancer la commande pour les reprendre.`);

  if (!opts.includes('--no-pyramid')) {
    console.log('Pyramide des zooms inférieurs…');
    await run('make-tiles.ts', ['--region', PATHS.name, '--pyramid-only'], join(logDir, 'pyramid.log'));
    console.log('Terminé.');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
