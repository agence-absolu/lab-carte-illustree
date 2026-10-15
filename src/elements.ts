// Essai « éléments repositionnés » (section de Saint-Pierre) : au lieu des arbres et des
// bâtiments peints dans les tuiles, la carte les place elle-même sur un sol rendu sans eux.
// - Arbres : images des modèles Blender vus de biais (sprites), debout face à la caméra,
//   à leur hauteur réelle, avec une ombre ronde au sol.
// - Bâtiments : extrusions MapLibre (murs clairs + fine dalle de toit à la couleur de l'ortho).
// Données : scripts/export-elements.ts ; sprites : build_scene.py --sprites ; sol : variante « sol ».

import type { ExpressionSpecification, GeoJSONSourceSpecification, Map as MaplibreMap } from 'maplibre-gl';

const SECTION = '15_9';
const SPRITE_CSS_PX = 128; // sprites de 256 px affichés en pixelRatio 2
const MIN_ZOOM = 14; // zoom carte (tuiles z15) : en dessous, tuiles illustrées habituelles
const WALL = '#ece3d3'; // façades, comme dans build_scene.py
const ROOF_SLAB = 0.6; // épaisseur de la dalle de toit (m)

interface Collection {
  type: 'FeatureCollection';
  features: { type: 'Feature'; geometry: { type: string; coordinates: unknown }; properties: Record<string, any> }[];
}

interface Elements {
  bounds: [number, number, number, number];
  trees: Collection;
  buildings: Collection;
}

/**
 * Pixels écran par mètre au sol, à la latitude donnée, en fonction du zoom carte
 * (monde de 512 px au zoom 0). Expression : valeur(zoom) × propriété.
 */
function perMeter(lat: number, prop: ExpressionSpecification | number, scale = 1): ExpressionSpecification {
  const k = (z: number) => ((512 * 2 ** z) / (40075016.686 * Math.cos((lat * Math.PI) / 180))) * scale;
  return ['interpolate', ['exponential', 2], ['zoom'], 10, ['*', prop, k(10)], 22, ['*', prop, k(22)]];
}

export async function setupElements(map: MaplibreMap, tiles: string, beforeId: string | undefined): Promise<(on: boolean) => void> {
  const base = `${tiles}/martinique`;
  let loaded: Promise<void> | null = null;

  async function load() {
    const data: Elements = await fetch(`${base}/elements/${SECTION}.json`).then((r) => r.json());
    const sprites: Record<string, unknown> = await fetch(`${base}/elements/sprites/sprites.json`).then((r) => r.json());
    await Promise.all(
      Object.keys(sprites).map(async (name) => {
        const img = await map.loadImage(`${base}/elements/sprites/${name}.png`);
        if (!map.hasImage(name)) map.addImage(name, img.data, { pixelRatio: 256 / SPRITE_CSS_PX });
      }),
    );
    const lat = (data.bounds[1] + data.bounds[3]) / 2;
    // f : position du pied dans l'image (fraction depuis le haut) → décalage depuis le bas
    for (const t of data.trees.features) {
      const p = t.properties;
      p.o = [0, (1 - p.f) * SPRITE_CSS_PX];
    }

    // Sol rendu sans arbres ni bâtiments, au-dessus des tuiles habituelles
    map.addSource('sol', {
      type: 'raster',
      tiles: [`${base}/sol/{z}/{x}/{y}.webp`],
      tileSize: 256,
      bounds: data.bounds.map((v, i) => v + (i < 2 ? 1e-7 : -1e-7)) as [number, number, number, number],
      minzoom: 10,
      maxzoom: 18,
    });
    map.addLayer({ id: 'sol', type: 'raster', source: 'sol', minzoom: MIN_ZOOM, paint: { 'raster-resampling': 'linear' } }, 'ortho');

    map.addSource('arbres', { type: 'geojson', data: data.trees as GeoJSONSourceSpecification['data'] });
    map.addSource('batiments', { type: 'geojson', data: data.buildings as GeoJSONSourceSpecification['data'] });

    // Ombres : disque flou décalé vers le sud-est (soleil au nord-ouest), à plat sur le sol
    map.addLayer(
      {
        id: 'arbres-ombres',
        type: 'circle',
        source: 'arbres',
        minzoom: MIN_ZOOM,
        paint: {
          'circle-radius': perMeter(lat, ['get', 'r'], 0.95),
          'circle-color': '#0e2a14',
          'circle-opacity': 0.32,
          'circle-blur': 0.6,
          'circle-pitch-alignment': 'map',
          'circle-pitch-scale': 'map',
          'circle-translate': ['interpolate', ['exponential', 2], ['zoom'],
            14, ['literal', [0.6, 0.6]], 18, ['literal', [9.6, 9.6]], 22, ['literal', [153.6, 153.6]]],
          'circle-translate-anchor': 'map',
        },
      },
      beforeId,
    );
    map.addLayer(
      {
        id: 'batiments-murs',
        type: 'fill-extrusion',
        source: 'batiments',
        minzoom: MIN_ZOOM,
        paint: {
          'fill-extrusion-color': WALL,
          'fill-extrusion-height': ['-', ['get', 'h'], ROOF_SLAB],
          'fill-extrusion-base': 0,
          'fill-extrusion-vertical-gradient': true,
        },
      },
      beforeId,
    );
    map.addLayer(
      {
        id: 'batiments-toits',
        type: 'fill-extrusion',
        source: 'batiments',
        minzoom: MIN_ZOOM,
        paint: {
          'fill-extrusion-color': ['get', 'c'],
          'fill-extrusion-height': ['get', 'h'],
          'fill-extrusion-base': ['-', ['get', 'h'], ROOF_SLAB],
          'fill-extrusion-vertical-gradient': false,
        },
      },
      beforeId,
    );
    // Arbres debout, du fond vers l'avant ; le pied de l'arbre sur son point
    map.addLayer(
      {
        id: 'arbres',
        type: 'symbol',
        source: 'arbres',
        minzoom: MIN_ZOOM,
        layout: {
          'icon-image': ['get', 'i'],
          'icon-size': perMeter(lat, ['get', 's'], 1 / SPRITE_CSS_PX),
          // Pied de l'arbre sur son point : décalage propre à chaque sprite (o, pixels de l'image)
          'icon-offset': ['get', 'o'],
          'icon-anchor': 'bottom',
          'icon-pitch-alignment': 'viewport',
          'icon-rotation-alignment': 'viewport',
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
          'symbol-z-order': 'viewport-y',
        },
      },
      beforeId,
    );
  }

  const ids = ['sol', 'arbres-ombres', 'batiments-murs', 'batiments-toits', 'arbres'];
  return (on: boolean) => {
    if (on && !loaded) loaded = load();
    loaded?.then(() => {
      for (const id of ids) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
    });
  };
}
