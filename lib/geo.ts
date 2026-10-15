// Outils Web Mercator (EPSG:3857) et grille de tuiles XYZ.

export const R = 6378137;
export const ORIGIN = Math.PI * R; // 20037508.342789244

/** Résolution en mètres Mercator par pixel au zoom z (tuiles de tileSize px). */
export function resolution(z: number, tileSize = 256): number {
  return (2 * Math.PI * R) / (tileSize * 2 ** z);
}

/** Lon/lat (degrés) → mètres Mercator. */
export function lonLatToMercator(lon: number, lat: number): [number, number] {
  const x = (R * lon * Math.PI) / 180;
  const y = R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
  return [x, y];
}

/** Mètres Mercator → lon/lat (degrés). */
export function mercatorToLonLat(x: number, y: number): [number, number] {
  const lon = (x / R) * (180 / Math.PI);
  const lat = (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * (180 / Math.PI);
  return [lon, lat];
}

/** Coin nord-ouest de la tuile (x, y) au zoom z, en mètres Mercator. */
export function tileOrigin(x: number, y: number, z: number, tileSize = 256): [number, number] {
  const span = tileSize * resolution(z, tileSize);
  return [x * span - ORIGIN, ORIGIN - y * span];
}

/** Indice (fractionnaire) de tuile contenant le point Mercator. */
export function mercatorToTile(mx: number, my: number, z: number, tileSize = 256): [number, number] {
  const span = tileSize * resolution(z, tileSize);
  return [(mx + ORIGIN) / span, (ORIGIN - my) / span];
}

/** Facteur de dilatation Mercator à la latitude donnée (à appliquer aux altitudes). */
export function mercatorScale(lat: number): number {
  return 1 / Math.cos((lat * Math.PI) / 180);
}

export interface RegionConfig {
  name: string;
  center: [number, number];
  sizeMeters: number;
  minZoom: number;
  maxZoom: number;
  tileSize: number;
  chunkTiles: number;
  chunkMarginPx: number;
  renderScale?: number; // densité de rendu : 2 = tuiles HD @2x (512 px)
  seasons: string[];
  // Plage de tuiles imposée au zoom max (bornes incluses) : remplace center/sizeMeters.
  // Sert aux sections d'une grande région (scripts/run-tiled.ts).
  tiles?: { x0: number; y0: number; x1: number; y1: number };
}

/** Région calculée, calée sur la grille des tuiles au zoom max. */
export interface Region {
  name: string;
  maxZoom: number;
  minZoom: number;
  tileSize: number;
  res: number; // m Mercator / px au zoom max
  tiles: { x0: number; y0: number; x1: number; y1: number }; // bornes incluses
  chunkTiles: number;
  chunkMarginPx: number; // en px 1x
  renderScale: number;
  chunks: { nx: number; ny: number };
  bbox: [number, number, number, number]; // minx, miny, maxx, maxy (EPSG:3857)
  widthM: number;
  heightM: number;
  lonLatBounds: [number, number, number, number]; // ouest, sud, est, nord
  centerLat: number;
  k: number; // facteur d'exagération des altitudes = 1/cos(lat)
  seasons: string[];
}

export function computeRegion(cfg: RegionConfig): Region {
  const z = cfg.maxZoom;
  const ts = cfg.tileSize;
  const res = resolution(z, ts);
  const span = ts * res;
  const [cx, cy] = cfg.center ? lonLatToMercator(cfg.center[0], cfg.center[1]) : [0, 0];

  let x0: number, y0: number, x1: number, y1: number;
  if (cfg.tiles) {
    ({ x0, y0, x1, y1 } = cfg.tiles);
    if ((x1 - x0 + 1) % cfg.chunkTiles || (y1 - y0 + 1) % cfg.chunkTiles) {
      throw new Error('tiles : la plage doit être un multiple de chunkTiles');
    }
  } else {
    // Nombre de tuiles nécessaire, arrondi au multiple de chunkTiles supérieur.
    const n = Math.ceil(Math.ceil(cfg.sizeMeters / span) / cfg.chunkTiles) * cfg.chunkTiles;
    const [tx, ty] = mercatorToTile(cx, cy, z, ts);
    x0 = Math.round(tx - n / 2);
    y0 = Math.round(ty - n / 2);
    x1 = x0 + n - 1;
    y1 = y0 + n - 1;
  }

  const [minx, maxy] = tileOrigin(x0, y0, z, ts);
  const [maxx, miny] = tileOrigin(x1 + 1, y1 + 1, z, ts);
  const [west, south] = mercatorToLonLat(minx, miny);
  const [east, north] = mercatorToLonLat(maxx, maxy);
  const centerLat = mercatorToLonLat(0, (miny + maxy) / 2)[1];

  return {
    name: cfg.name,
    maxZoom: z,
    minZoom: cfg.minZoom,
    tileSize: ts,
    res,
    tiles: { x0, y0, x1, y1 },
    chunkTiles: cfg.chunkTiles,
    chunkMarginPx: cfg.chunkMarginPx,
    renderScale: cfg.renderScale ?? 1,
    chunks: { nx: (x1 - x0 + 1) / cfg.chunkTiles, ny: (y1 - y0 + 1) / cfg.chunkTiles },
    bbox: [minx, miny, maxx, maxy],
    widthM: maxx - minx,
    heightM: maxy - miny,
    lonLatBounds: [west, south, east, north],
    centerLat,
    k: mercatorScale(centerLat),
    seasons: cfg.seasons,
  };
}
