import * as maplibregl from 'maplibre-gl';
import type { ExpressionSpecification, FilterSpecification, LayerSpecification, RasterTileSource, StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { setupPois } from './poi.ts';
import { setupElements } from './elements.ts';
// MapLibre 6 charge son worker via import.meta.url, ce que le pré-bundling de Vite
// casse : on lui donne l'URL du worker servie par Vite.
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';

maplibregl.setWorkerUrl(workerUrl);

interface TilesMeta {
  name: string;
  description?: string;
  climate?: string;
  bounds: [number, number, number, number];
  center: [number, number];
  fit?: [number, number, number, number]; // emprise à cadrer au départ (grandes régions)
  minzoom: number;
  maxzoom: number;
  seasons: string[];
  scales?: number[];
}

// Racine des tuiles : stockage distant (R2…) si VITE_TILES_URL est défini (.env) ; en
// développement seulement, ?tiles=local revient aux tuiles locales (public/tiles)
const REMOTE_TILES = import.meta.env.VITE_TILES_URL?.replace(/\/$/, '');
const params = new URLSearchParams(location.search);
const useRemote = !!REMOTE_TILES && !(import.meta.env.DEV && params.get('tiles') === 'local');
// Tuiles locales sous la base de la démo (/carte-illustree/tiles en développement)
const TILES = useRemote ? REMOTE_TILES : `${import.meta.env.BASE_URL}tiles`;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// Région : ?region=nom dans l'URL, sinon la première tuilée
const regions: { name: string; description: string }[] = await fetch(`${TILES}/regions.json`).then((r) => r.json());
const regionName = params.get('region') ?? regions[0]?.name;
const meta: TilesMeta = await fetch(`${TILES}/${regionName}/region.json`).then((r) => r.json());
document.title = `Carte illustrée — ${meta.description ?? meta.name}`;
// Notice de fabrication : elle décrit le pipeline de la Martinique
const about = $<HTMLDialogElement>('about');
const aboutOpen = $<HTMLButtonElement>('about-open');
aboutOpen.hidden = meta.name !== 'martinique';
aboutOpen.addEventListener('click', () => about.showModal());
$('about-close').addEventListener('click', () => about.close());
// Clic sur le fond assombri (hors de la boîte) : fermeture
about.addEventListener('click', (e) => {
  if (e.target === about) about.close();
});
// Une seule étape ouverte à la fois : l'attribut name des <details> le fait déjà dans les
// navigateurs récents, ceci couvre les autres
const steps = document.querySelectorAll<HTMLDetailsElement>('#about details[name="about-step"]');
for (const d of steps) {
  d.addEventListener('toggle', () => {
    if (d.open) for (const o of steps) if (o !== d) o.open = false;
  });
}

const regionSelect = $<HTMLSelectElement>('region');
for (const r of regions) regionSelect.add(new Option(r.description, r.name, false, r.name === regionName));
regionSelect.addEventListener('change', () => {
  params.set('region', regionSelect.value);
  location.search = params.toString();
});

// Tuiles locales ou hébergées (développement seulement) : régions et métadonnées sont lues
// au démarrage, on recharge
const remoteInput = $<HTMLInputElement>('remote');
remoteInput.checked = useRemote;
remoteInput.closest('label')!.hidden = !(import.meta.env.DEV && REMOTE_TILES);
remoteInput.addEventListener('change', () => {
  if (remoteInput.checked) params.delete('tiles');
  else params.set('tiles', 'local');
  location.search = params.toString();
});

// Variantes de la région (boutons radio construits d'après les métadonnées)
const SEASON_LABELS: Record<string, string> = { summer: 'Été', winter: 'Hiver', jour: 'Jour' };
const seasonsBox = $<HTMLFieldSetElement>('seasons');
meta.seasons.forEach((s, i) => {
  const label = document.createElement('label');
  label.innerHTML = `<input type="radio" name="season" value="${s}"${i === 0 ? ' checked' : ''} /> ${SEASON_LABELS[s] ?? s}`;
  seasonsBox.append(label);
});
seasonsBox.hidden = meta.seasons.length < 2;

// Tuiles HD (@2x, 512 px pour une tuile de 256) par défaut sur les écrans haute densité
const hasHd = meta.scales?.includes(2) ?? false;
let hd = hasHd && window.devicePixelRatio >= 1.5;
const tileUrl = (season: string) => `${TILES}/${meta.name}/${season}/{z}/{x}/{y}${hd ? '@2x' : ''}.webp`;

// Le zoom MapLibre suit un monde de 512 px au zoom 0, la grille XYZ un monde de
// 256 px : une tuile 256 px du niveau z s'affiche à l'échelle 1:1 au zoom carte z − 1.
const TILE_ZOOM_OFFSET = 1;

// Libellés OSM (scripts/fetch-labels.ts), affichés par-dessus les tuiles : rien n'est
// « cuit » dans l'image. Absents si le script n'a pas été lancé pour la région.
const labelsUrl = `${TILES}/${meta.name}/labels.json`;
const hasLabels = (await fetch(labelsUrl, { method: 'HEAD' })).ok;

// Typographie à la Grincat (Outfit) : Metropolis, géométrique voisine, servie en glyphes SDF
const PLACE_COLOR = '#002b56';
const STREET_HALO = '#302757';
const labelLayers: LayerSpecification[] = [
  // Rues : plus le rang est faible (voie importante), plus tôt elles apparaissent
  ...[
    { rank: [1, 2], minzoom: 13.5 },
    { rank: [3], minzoom: 15 },
    { rank: [4], minzoom: 16 },
  ].map(({ rank, minzoom }) => ({
    id: `rues-${rank.join('')}`,
    type: 'symbol' as const,
    source: 'labels',
    minzoom,
    filter: ['all', ['==', ['get', 'kind'], 'rue'], ['in', ['get', 'rank'], ['literal', rank]]] as FilterSpecification,
    layout: {
      'symbol-placement': 'line' as const,
      'symbol-spacing': 350,
      'text-field': ['get', 'name'] as ExpressionSpecification,
      'text-font': ['Metropolis Medium'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 14, 11, 17, 13] as ExpressionSpecification,
      'text-max-angle': 30,
    },
    paint: { 'text-color': '#ffffff', 'text-halo-color': STREET_HALO, 'text-halo-width': 1.4 },
  })),
  // Lieux-dits : rang 2 (villages, quartiers) puis 3 (hameaux) puis 4 (lieux-dits isolés)
  ...[
    { rank: 2, minzoom: 11 },
    { rank: 3, minzoom: 12.5 },
    { rank: 4, minzoom: 13.5 },
  ].map(({ rank, minzoom }) => ({
    id: `lieux-${rank}`,
    type: 'symbol' as const,
    source: 'labels',
    minzoom,
    filter: ['all', ['==', ['get', 'kind'], 'lieu'], ['==', ['get', 'rank'], rank]] as FilterSpecification,
    layout: {
      'text-field': ['get', 'name'] as ExpressionSpecification,
      'text-font': ['Metropolis Semi Bold'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 11, 12 - (rank - 2), 16, 15 - (rank - 2)] as ExpressionSpecification,
      'text-max-width': 8,
      'symbol-sort-key': rank,
    },
    paint: { 'text-color': PLACE_COLOR, 'text-halo-color': '#ffffff', 'text-halo-width': 1.6 },
  })),
  {
    id: 'communes',
    type: 'symbol',
    source: 'labels',
    filter: ['==', ['get', 'kind'], 'commune'],
    layout: {
      'text-field': ['get', 'name'],
      'text-font': ['Metropolis Bold'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 9, 12, 12, 16, 16, 22],
      'text-max-width': 8,
      // Les plus peuplées d'abord quand la place manque
      'symbol-sort-key': ['-', ['get', 'population']],
      'text-allow-overlap': false,
    },
    paint: { 'text-color': PLACE_COLOR, 'text-halo-color': '#ffffff', 'text-halo-width': 2 },
  },
];

const style: StyleSpecification = {
  version: 8,
  glyphs: 'https://fonts.openmaptiles.org/{fontstack}/{range}.pbf',
  sources: {
    ...Object.fromEntries(
      meta.seasons.map((s) => [
        s,
        {
          type: 'raster',
          tiles: [tileUrl(s)],
          tileSize: 256,
          bounds: meta.bounds,
          minzoom: meta.minzoom,
          maxzoom: meta.maxzoom,
        },
      ]),
    ),
    // Orthophoto IGN (WMTS Géoplateforme, grille PM = Web Mercator), pour comparaison
    ortho: {
      type: 'raster',
      tiles: [
        'https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=ORTHOIMAGERY.ORTHOPHOTOS' +
          '&STYLE=normal&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&FORMAT=image/jpeg',
      ],
      tileSize: 256,
      maxzoom: 19,
      attribution: 'Orthophoto © IGN',
    },
    // Relief pour la vue inclinée (essai) : tuiles Terrarium d'AWS Open Data (SRTM / ETOPO,
    // ~30 m), libres et sans clé. À remplacer par des tuiles tirées du RGE ALTI si l'essai plaît.
    dem: {
      type: 'raster-dem',
      tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
      encoding: 'terrarium',
      tileSize: 256,
      maxzoom: 14,
      attribution: 'Relief : Mapzen Terrain Tiles (AWS Open Data)',
    },
    osm: {
      type: 'raster',
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      maxzoom: 19,
      attribution: '© contributeurs OpenStreetMap',
    },
    ...(hasLabels
      ? { labels: { type: 'geojson' as const, data: labelsUrl, attribution: 'Libellés © contributeurs OpenStreetMap (ODbL)' } }
      : {}),
  },
  layers: [
    // Fond hors emprise : mer profonde sous les tropiques, vert pâle en montagne
    { id: 'fond', type: 'background', paint: { 'background-color': meta.climate === 'tropical' ? '#0b3f78' /* = OPEN_SEA de build_scene.py */ : '#dfe6dc' } },
    ...meta.seasons.map((s, i) => ({
      id: s,
      type: 'raster' as const,
      source: s,
      layout: { visibility: (i === 0 ? 'visible' : 'none') as 'visible' | 'none' },
      // Au-delà du zoom max, MapLibre agrandit les tuiles du zoom max
      paint: { 'raster-resampling': 'linear' as const },
    })),
    { id: 'ortho', type: 'raster', source: 'ortho', layout: { visibility: 'none' } },
    { id: 'osm', type: 'raster', source: 'osm', layout: { visibility: 'none' } },
    ...(hasLabels ? labelLayers : []),
  ],
};

const map = new maplibregl.Map({
  container: 'map',
  style,
  ...(meta.fit
    ? { bounds: meta.fit, fitBoundsOptions: { padding: 20 } }
    : { center: meta.center, zoom: meta.maxzoom - TILE_ZOOM_OFFSET - 1.5 }),
  minZoom: meta.minzoom - TILE_ZOOM_OFFSET,
  // Un demi-niveau d'agrandissement au-delà du 1:1 des tuiles du zoom max, pas plus
  maxZoom: meta.maxzoom - TILE_ZOOM_OFFSET + 0.5,
  maxBounds: [
    [meta.bounds[0] - 0.02, meta.bounds[1] - 0.015],
    [meta.bounds[2] + 0.02, meta.bounds[3] + 0.015],
  ],
  // Vue à plat, nord en haut ; la case « Vue inclinée » débloque rotation et inclinaison
  dragRotate: false,
  touchPitch: false,
  maxPitch: 0,
  attributionControl: { compact: true, customAttribution: 'Données IGN (licence Etalab 2.0)' },
});
map.touchZoomRotate.disableRotation();
map.keyboard.disableRotation();
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-right');

// Accès depuis la console pour le débogage
if (import.meta.env.DEV) Object.assign(window, { map });

// Bascule de saison
for (const input of document.querySelectorAll<HTMLInputElement>('input[name="season"]')) {
  input.addEventListener('change', () => {
    for (const s of meta.seasons) map.setLayoutProperty(s, 'visibility', s === input.value ? 'visible' : 'none');
  });
}

// Vue inclinée (essai) : relief 3D sous les tuiles illustrées, inclinaison et rotation permises
const tilt = $<HTMLInputElement>('tilt');
const TILT_PITCH = 60;
function applyTilt() {
  if (tilt.checked) {
    map.setTerrain({ source: 'dem', exaggeration: 1.2 });
    map.setSky({ 'sky-color': '#7fb2e5', 'horizon-color': '#d8e8f5', 'sky-horizon-blend': 0.6, 'fog-color': '#d8e8f5', 'fog-ground-blend': 0.2 });
    map.setMaxPitch(80);
    map.dragRotate.enable();
    map.touchPitch.enable();
    map.touchZoomRotate.enableRotation();
    map.keyboard.enableRotation();
    map.easeTo({ pitch: TILT_PITCH, duration: 1200 });
  } else {
    map.dragRotate.disable();
    map.touchPitch.disable();
    map.touchZoomRotate.disableRotation();
    map.keyboard.disableRotation();
    map.easeTo({ pitch: 0, bearing: 0, duration: 800 });
    map.once('moveend', () => {
      if (tilt.checked) return;
      map.setTerrain(null);
      map.setMaxPitch(0);
    });
  }
}
tilt.addEventListener('change', applyTilt);

// Éléments repositionnés (essai, Saint-Pierre et chez Fred) : sol sans arbres, arbres en sprites, bâtiments extrudés
const elementsInput = $<HTMLInputElement>('elements');
elementsInput.closest('label')!.hidden = meta.name !== 'martinique';
let showElements: ((on: boolean) => void) | null = null;
// Éléments sous les libellés, ou à défaut sous les points remarquables (pastille de Fred au-dessus)
const elementsBefore = () => (hasLabels ? labelLayers[0].id : map.getLayer('poi-cercle') ? 'poi-cercle' : undefined);
// Cochée par défaut : les éléments prennent le relais en vue inclinée, de près
if (meta.name === 'martinique') {
  map.once('load', async () => {
    showElements ??= await setupElements(map, TILES, elementsBefore());
    showElements(elementsInput.checked);
  });
}
elementsInput.addEventListener('change', async () => {
  showElements ??= await setupElements(map, TILES, elementsBefore());
  showElements(elementsInput.checked);
  if (!elementsInput.checked) return;
  if (!tilt.checked) {
    tilt.checked = true;
    applyTilt();
    map.stop();
  }
  // Déjà au-dessus d'une zone équipée (Saint-Pierre, Anse Mitan) et assez près : on reste ; sinon, Saint-Pierre
  const { lng, lat } = map.getCenter();
  const near = map.getZoom() >= 15.5 && ((lng > -61.194 && lng < -61.171 && lat > 14.732 && lat < 14.754) ||
    (lng > -61.063 && lng < -61.039 && lat > 14.541 && lat < 14.563));
  if (!near) map.flyTo({ center: [-61.1775, 14.7425], zoom: 16.2, pitch: 62, bearing: 70, duration: 3500, essential: true });
});

// Superposition de l'ortho IGN pour comparaison
const ortho = $<HTMLInputElement>('ortho');
ortho.addEventListener('change', () => map.setLayoutProperty('ortho', 'visibility', ortho.checked ? 'visible' : 'none'));

// Superposition OSM pour comparaison
const osm = $<HTMLInputElement>('osm');
osm.addEventListener('change', () => map.setLayoutProperty('osm', 'visibility', osm.checked ? 'visible' : 'none'));

// Bascule HD / standard (tileSize reste 256 : MapLibre affiche les 512 px en 256 px CSS)
const hdInput = $<HTMLInputElement>('hd');
hdInput.checked = hd;
hdInput.closest('label')!.hidden = !hasHd;
hdInput.addEventListener('change', () => {
  hd = hdInput.checked;
  for (const s of meta.seasons) map.getSource<RasterTileSource>(s)?.setTiles([tileUrl(s)]);
});

const zoom = $<HTMLParagraphElement>('zoom');
const showZoom = () => {
  const z = map.getZoom();
  const tileZ = Math.min(meta.maxzoom, Math.round(z + TILE_ZOOM_OFFSET));
  const scale = 2 ** (z + TILE_ZOOM_OFFSET - meta.maxzoom);
  const over = scale > 1.01 ? ` (agrandies ×${scale.toFixed(2)})` : '';
  zoom.textContent = `Zoom carte ${z.toFixed(2)} · tuiles z${tileZ}${over}`;
};
map.on('zoom', showZoom);
showZoom();

// Affichage des libellés
const labelsInput = $<HTMLInputElement>('labels');
labelsInput.closest('label')!.hidden = !hasLabels;
labelsInput.addEventListener('change', () => {
  for (const l of labelLayers) map.setLayoutProperty(l.id, 'visibility', labelsInput.checked ? 'visible' : 'none');
});

// Contour des tuiles chargées (débogage) : filet rouge autour de chaque tuile reçue de la
// saison affichée ; les tuiles absentes (404, pleine mer) restent sans cadre.
const tileLon = (x: number, z: number) => (x / 2 ** z) * 360 - 180;
const tileLat = (y: number, z: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** z))) * 180) / Math.PI;
const gridInput = $<HTMLInputElement>('grid');
const gridIdsInput = $<HTMLInputElement>('grid-ids');
const drawGrid = () => {
  if (!gridInput.checked && !gridIdsInput.checked) return;
  const season = document.querySelector<HTMLInputElement>('input[name="season"]:checked')?.value ?? meta.seasons[0];
  // API interne de MapLibre 6 (style.tileManagers), suffisante pour un outil de débogage
  const tm = (map.style as unknown as { tileManagers: Record<string, any> }).tileManagers[season];
  if (!tm) return;
  const seen = new Set<string>();
  const features: { type: 'Feature'; properties: object; geometry: { type: 'LineString'; coordinates: number[][] } }[] = [];
  const labels: { type: 'Feature'; properties: { id: string }; geometry: { type: 'Point'; coordinates: number[] } }[] = [];
  // MapLibre garde des tuiles parentes en secours (enfant absent ou en cours de chargement) :
  // on ne montre que le niveau demandé, le plus fin des tuiles visibles
  const ids = tm.getVisibleCoordinates();
  const zoomLevel = Math.max(...ids.map((id: { canonical: { z: number } }) => id.canonical.z));
  for (const id of ids) {
    if (id.canonical.z !== zoomLevel || tm.getTile(id)?.state !== 'loaded') continue;
    const { z, x, y } = id.canonical;
    const key = `${z}/${x}/${y}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const [w, e, n, s] = [tileLon(x, z), tileLon(x + 1, z), tileLat(y, z), tileLat(y + 1, z)];
    features.push({
      type: 'Feature',
      properties: {},
      geometry: { type: 'LineString', coordinates: [[w, n], [e, n], [e, s], [w, s], [w, n]] },
    });
    // Libellé z/x/y au centre de la tuile (milieu en Mercator, pas en latitude)
    labels.push({
      type: 'Feature',
      properties: { id: key },
      geometry: { type: 'Point', coordinates: [(w + e) / 2, tileLat(y + 0.5, z)] },
    });
  }
  map.getSource<maplibregl.GeoJSONSource>('grille')?.setData({ type: 'FeatureCollection', features });
  map.getSource<maplibregl.GeoJSONSource>('grille-ids')?.setData({ type: 'FeatureCollection', features: labels });
};
map.on('load', () => {
  // Points remarquables (essai) : vol incliné puis photo du lieu
  if (meta.name === 'martinique') {
    setupPois(map, () => {
      if (tilt.checked) return;
      tilt.checked = true;
      // Relief et inclinaison permis, sans l'animation de la case : le vol prend le relais
      applyTilt();
      map.stop();
    });
  }
  map.addSource('grille', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({
    id: 'grille',
    type: 'line',
    source: 'grille',
    layout: { visibility: 'none' },
    paint: { 'line-color': '#ff0000', 'line-width': 0.5 },
  });
  map.addSource('grille-ids', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({
    id: 'grille-ids',
    type: 'symbol',
    source: 'grille-ids',
    layout: {
      visibility: 'none',
      'text-field': ['get', 'id'],
      'text-font': ['Metropolis Medium'],
      'text-size': 12,
      'text-allow-overlap': true,
      'text-ignore-placement': true,
    },
    paint: { 'text-color': '#ff0000', 'text-halo-color': '#ffffff', 'text-halo-width': 1.5 },
  });
});
map.on('idle', drawGrid);
for (const [input, layer] of [[gridInput, 'grille'], [gridIdsInput, 'grille-ids']] as const) {
  input.addEventListener('change', () => {
    map.setLayoutProperty(layer, 'visibility', input.checked ? 'visible' : 'none');
    drawGrid();
  });
}
