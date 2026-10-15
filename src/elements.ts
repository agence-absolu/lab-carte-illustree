// Essai « éléments repositionnés » (sections listées dans elements/index.json) : au lieu des arbres et des
// bâtiments peints dans les tuiles, la carte les place elle-même sur un sol rendu sans eux.
// - Arbres : images des modèles Blender vus de biais (sprites), debout face à la caméra,
//   à leur hauteur réelle, avec une ombre ronde au sol.
// - Bâtiments : extrusions MapLibre (murs clairs + fine dalle de toit à la couleur de l'ortho).
// Données : scripts/export-elements.ts ; sprites : build_scene.py --sprites ; sol : variante « sol ».

import type { ExpressionSpecification, GeoJSONSourceSpecification, Map as MaplibreMap } from 'maplibre-gl';

const SPRITE_CSS_PX = 128; // côté des sprites en px CSS avant mise à l'échelle (icon-size)
// Les éléments remplacent les tuiles peintes en vue inclinée et de près ; sinon (vue à plat,
// vue d'ensemble), les tuiles peintes restent : des arbres debout, vus de dessus, sembleraient couchés.
const MIN_ZOOM = 15.5; // zoom carte
const MIN_PITCH = 20; // °
// Les couches sont construites dès les tuiles de zoom 12 : en vue inclinée, le lointain prend des
// tuiles de zoom faible, qui doivent aussi porter leurs arbres.
const LAYER_MIN_ZOOM = 12;
// Une tuile GeoJSON de MapLibre ne tient pas plus de ~16 000 icônes (sommets indexés sur 16 bits),
// et une tuile de zoom 12 à 14 couvre toute une section boisée (~80 000 arbres) : arbres répartis
// entre plusieurs sources.
const TREE_SHARDS = 6;
// Sprites posés à la main, en plus des arbres (clins d'œil) : hauteur en mètres
const EXTRAS = [
  // Chez Fred : une caipirinha géante (blender/caipirinha.py), comme posée chez le voisin : ~15 m à
  // l'est de sa pastille (à sa gauche dans le point de vue du lieu, tourné vers le sud)
  { sprite: 'caipirinha', lngLat: [-61.05295, 14.54755], height: 20 },
];
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

  const ids: string[] = [];

  // Métadonnées et données revalidées à chaque visite (ETag : 304 sans renvoi si inchangées) : elles
  // changent à chaque export, et un cache de 24 h servait par exemple un sprites.json sans la caipirinha
  const getJson = (url: string) => fetch(url, { cache: 'no-cache' }).then((r) => r.json());

  async function load() {
    // v : jetons de version (export, rendu) ajoutés aux URL des images, que MapLibre charge sans
    // revalidation : une image refaite change d'URL et n'est pas resservie depuis le cache
    const index: { id: string; bounds: [number, number, number, number]; v?: string }[] =
      await getJson(`${base}/elements/index.json`);
    const sections: Elements[] = await Promise.all(index.map((e) => getJson(`${base}/elements/${e.id}.json`)));
    const sprites: Record<string, { side: number; footY: number; v?: number }> = await getJson(`${base}/elements/sprites/sprites.json`);
    await Promise.all(
      Object.entries(sprites).map(async ([name, sp]) => {
        const img = await map.loadImage(`${base}/elements/sprites/${name}.png?v=${sp.v ?? 0}`);
        // Toutes les images à SPRITE_CSS_PX de côté, quelle que soit leur définition (256 ou 512 px)
        if (!map.hasImage(name)) map.addImage(name, img.data, { pixelRatio: img.data.width / SPRITE_CSS_PX });
      }),
    );
    // Taille des sprites calculée à une seule latitude (l'île entière tient en 0,6° : < 0,3 % d'écart)
    const lat = (index[0].bounds[1] + index[0].bounds[3]) / 2;
    const data: Elements = {
      bounds: index[0].bounds,
      trees: { type: 'FeatureCollection', features: sections.flatMap((d) => d.trees.features) },
      buildings: { type: 'FeatureCollection', features: sections.flatMap((d) => d.buildings.features) },
    };
    // Clins d'œil : source à part, pour un calque au-dessus des arbres
    const extras: Collection = { type: 'FeatureCollection', features: [] };
    for (const x of EXTRAS) {
      const sp = sprites[x.sprite];
      if (!sp) continue;
      extras.features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: x.lngLat },
        properties: { i: x.sprite, s: x.height * sp.side, f: sp.footY, o: [0, (1 - sp.footY) * SPRITE_CSS_PX] },
      });
    }
    map.addSource('extras', { type: 'geojson', data: extras as GeoJSONSourceSpecification['data'] });
    // f : position du pied dans l'image (fraction depuis le haut) → décalage depuis le bas
    for (const t of data.trees.features) {
      const p = t.properties;
      p.o = [0, (1 - p.f) * SPRITE_CSS_PX];
    }

    // Sol rendu sans arbres ni bâtiments, au-dessus des tuiles habituelles : une source par
    // section, bornée à son emprise (pas de requêtes pour des tuiles qui n'existent pas)
    for (const e of index) {
      const id = `sol-${e.id}`;
      map.addSource(id, {
        type: 'raster',
        tiles: [`${base}/sol/{z}/{x}/{y}.webp?v=${e.v ?? 0}`],
        tileSize: 256,
        bounds: e.bounds.map((v, i) => v + (i < 2 ? 1e-7 : -1e-7)) as [number, number, number, number],
        minzoom: 10,
        maxzoom: 18,
      });
      map.addLayer({ id, type: 'raster', source: id, minzoom: LAYER_MIN_ZOOM, paint: { 'raster-resampling': 'linear' } }, 'ortho');
      ids.push(id);
    }

    map.addSource('arbres', { type: 'geojson', data: data.trees as GeoJSONSourceSpecification['data'] });
    for (let k = 0; k < TREE_SHARDS; k++) {
      const features = data.trees.features.filter((_, i) => i % TREE_SHARDS === k);
      map.addSource(`arbres-${k}`, { type: 'geojson', data: { ...data.trees, features } as GeoJSONSourceSpecification['data'] });
    }
    map.addSource('batiments', { type: 'geojson', data: data.buildings as GeoJSONSourceSpecification['data'] });

    // Ombres : disque flou décalé vers le sud-est (soleil au nord-ouest), à plat sur le sol
    map.addLayer(
      {
        id: 'arbres-ombres',
        type: 'circle',
        source: 'arbres',
        minzoom: LAYER_MIN_ZOOM,
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
        minzoom: LAYER_MIN_ZOOM,
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
        minzoom: LAYER_MIN_ZOOM,
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
    const treeIds = [];
    for (let k = 0; k < TREE_SHARDS; k++) {
      treeIds.push(`arbres-${k}`);
      map.addLayer(
        {
          id: `arbres-${k}`,
          type: 'symbol',
          source: `arbres-${k}`,
          minzoom: LAYER_MIN_ZOOM,
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
    // Au-dessus de tous les arbres (ajouté après eux), sous les libellés et les points remarquables
    map.addLayer(
      {
        id: 'extras',
        type: 'symbol',
        source: 'extras',
        minzoom: LAYER_MIN_ZOOM,
        layout: {
          'icon-image': ['get', 'i'],
          'icon-size': perMeter(lat, ['get', 's'], 1 / SPRITE_CSS_PX),
          'icon-offset': ['get', 'o'],
          'icon-anchor': 'bottom',
          'icon-pitch-alignment': 'viewport',
          'icon-rotation-alignment': 'viewport',
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
        },
      },
      beforeId,
    );
    ids.push('arbres-ombres', 'batiments-murs', 'batiments-toits', ...treeIds, 'extras');
    map.on('zoom', update);
    map.on('pitch', update);
  }

  let enabled = false;
  let shown: boolean | null = null;
  function update() {
    const show = enabled && map.getZoom() >= MIN_ZOOM && map.getPitch() >= MIN_PITCH;
    if (show === shown) return;
    shown = show;
    for (const id of ids) map.setLayoutProperty(id, 'visibility', show ? 'visible' : 'none');
  }

  return (on: boolean) => {
    enabled = on;
    if (on && !loaded) loaded = load();
    loaded?.then(() => {
      shown = null;
      update();
    });
  };
}
