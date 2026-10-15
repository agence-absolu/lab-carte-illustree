// Libellés de la carte depuis OpenStreetMap (Overpass) : communes, lieux-dits et rues.
// Les textes ne sont pas « cuits » dans les tuiles : la visionneuse les affiche en
// couche vectorielle à part (GeoJSON), comme Grincat.
//
// Usage : node scripts/fetch-labels.ts --region nom
// Sortie : public/tiles/{nom}/labels.json (FeatureCollection, propriétés kind, rank, name)
//   kind = commune | lieu | rue ; rank = importance (1 = la plus forte)
// Données © contributeurs OpenStreetMap, licence ODbL.

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { regionFromArgs } from '../lib/region.ts';

const PATHS = regionFromArgs();
// Serveurs souvent saturés (504) : on alterne et on patiente entre les essais
const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter'];

// Lieux-dits : importance selon le type de lieu OSM
const PLACE_RANK: Record<string, number> = {
  city: 2,
  town: 2,
  village: 2,
  suburb: 2,
  quarter: 3,
  hamlet: 3,
  neighbourhood: 4,
  locality: 4,
  isolated_dwelling: 4,
};
// Rues : importance selon le type de voie
const ROAD_RANK: Record<string, number> = {
  motorway: 1,
  trunk: 1,
  primary: 1,
  secondary: 2,
  tertiary: 2,
  unclassified: 3,
  residential: 3,
  living_street: 3,
  pedestrian: 3,
  service: 4,
  track: 4,
  path: 4,
  footway: 4,
  steps: 4,
  cycleway: 4,
};

interface OsmElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  tags?: Record<string, string>;
  members?: { type: string; ref: number; role: string }[];
  geometry?: { lat: number; lon: number }[];
}

async function overpass(query: string): Promise<OsmElement[]> {
  let last: unknown;
  for (let attempt = 0; attempt < 8; attempt++) {
    const url = OVERPASS[attempt % OVERPASS.length];
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'carte-illustree (POC)' },
        body: new URLSearchParams({ data: query }),
      });
      if (!res.ok) throw new Error(`${url} : HTTP ${res.status}`);
      return ((await res.json()) as { elements: OsmElement[] }).elements;
    } catch (err) {
      last = err;
      console.warn(`  Overpass : ${(err as Error).message}, nouvel essai…`);
      await new Promise((r) => setTimeout(r, 10000 * (attempt + 1)));
    }
  }
  throw last;
}

const round = (v: number) => Math.round(v * 1e6) / 1e6;
const pt = (lon: number, lat: number) => [round(lon), round(lat)];

/** Assemble les tronçons d'une même rue qui se touchent par leurs extrémités. */
function mergeLines(lines: number[][][]): number[][][] {
  const key = (p: number[]) => `${p[0]},${p[1]}`;
  const pool = lines.map((l) => [...l]);
  const out: number[][][] = [];
  while (pool.length) {
    let line = pool.pop()!;
    let grew = true;
    while (grew) {
      grew = false;
      for (let i = 0; i < pool.length; i++) {
        const o = pool[i];
        const [a, b, c, d] = [key(line[0]), key(line[line.length - 1]), key(o[0]), key(o[o.length - 1])];
        if (b === c) line = [...line, ...o.slice(1)];
        else if (b === d) line = [...line, ...o.slice(0, -1).reverse()];
        else if (a === d) line = [...o, ...line.slice(1)];
        else if (a === c) line = [...o.slice(1).reverse(), ...line];
        else continue;
        pool.splice(i, 1);
        grew = true;
        break;
      }
    }
    out.push(line);
  }
  return out;
}

async function main(): Promise<void> {
  const region = JSON.parse(await readFile(join(PATHS.data, 'region.json'), 'utf8'));
  const [w, s, e, n] = region.lonLatBounds as number[];
  const bbox = `${s},${w},${n},${e}`;
  const features: object[] = [];

  // --- Communes : relations administratives de niveau 8, libellé au chef-lieu ---
  console.log('Communes…');
  const admin = await overpass(`[out:json][timeout:180];
    rel["boundary"="administrative"]["admin_level"="8"](${bbox})->.c;
    .c out body center;
    node(r.c:"admin_centre")->.a; .a out;
    node(r.c:"label")->.l; .l out;`);
  const nodes = new Map(admin.filter((el) => el.type === 'node').map((el) => [el.id, el]));
  const centres = new Set<number>();
  for (const rel of admin.filter((el) => el.type === 'relation')) {
    const name = rel.tags?.name;
    if (!name) continue;
    // Point du libellé : nœud « label », sinon chef-lieu, sinon centre de l'emprise
    const ref = rel.members?.find((m) => m.type === 'node' && m.role === 'label') ?? rel.members?.find((m) => m.type === 'node' && m.role === 'admin_centre');
    const node = ref ? nodes.get(ref.ref) : undefined;
    const c = node ?? (rel as unknown as { center?: { lat: number; lon: number } }).center;
    if (!c) continue;
    if (c.lon! < w || c.lon! > e || c.lat! < s || c.lat! > n) continue;
    for (const m of rel.members ?? []) if (m.type === 'node' && (m.role === 'admin_centre' || m.role === 'label')) centres.add(m.ref);
    features.push({
      type: 'Feature',
      properties: { kind: 'commune', rank: 1, name, population: Number(rel.tags?.population) || 0 },
      geometry: { type: 'Point', coordinates: pt(c.lon!, c.lat!) },
    });
  }
  const nCommunes = features.length;

  // --- Lieux-dits ---------------------------------------------------------------
  console.log('Lieux-dits…');
  const places = await overpass(`[out:json][timeout:180];
    node["place"~"^(${Object.keys(PLACE_RANK).join('|')})$"]["name"](${bbox});
    out;`);
  const communeNames = new Set(features.map((f) => (f as { properties: { name: string } }).properties.name));
  for (const p of places) {
    const name = p.tags!.name;
    // Le bourg porte le nom de la commune : déjà affiché
    if (centres.has(p.id) || communeNames.has(name)) continue;
    features.push({
      type: 'Feature',
      properties: { kind: 'lieu', rank: PLACE_RANK[p.tags!.place], name, place: p.tags!.place },
      geometry: { type: 'Point', coordinates: pt(p.lon!, p.lat!) },
    });
  }
  const nLieux = features.length - nCommunes;

  // --- Rues ---------------------------------------------------------------------
  console.log('Rues…');
  const ways = await overpass(`[out:json][timeout:300];
    way["highway"~"^(${Object.keys(ROAD_RANK).join('|')})$"]["name"]["area"!="yes"](${bbox});
    out tags geom;`);
  // Regroupées par nom et par rang : les tronçons d'une même rue sont assemblés
  const groups = new Map<string, { name: string; rank: number; lines: number[][][] }>();
  for (const wy of ways) {
    if (!wy.geometry || wy.geometry.length < 2) continue;
    const name = wy.tags!.name;
    const rank = ROAD_RANK[wy.tags!.highway];
    const k = `${rank}|${name}`;
    if (!groups.has(k)) groups.set(k, { name, rank, lines: [] });
    groups.get(k)!.lines.push(wy.geometry.map((g) => pt(g.lon, g.lat)));
  }
  let nRues = 0;
  for (const { name, rank, lines } of groups.values()) {
    const merged = mergeLines(lines);
    features.push({
      type: 'Feature',
      properties: { kind: 'rue', rank, name },
      geometry: merged.length === 1 ? { type: 'LineString', coordinates: merged[0] } : { type: 'MultiLineString', coordinates: merged },
    });
    nRues++;
  }

  const file = join(PATHS.tiles, 'labels.json');
  await writeFile(file, JSON.stringify({ type: 'FeatureCollection', features }));
  console.log(`${nCommunes} communes, ${nLieux} lieux-dits, ${nRues} rues (${ways.length} tronçons) → ${file}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
