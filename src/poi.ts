// Points remarquables (essai) : au clic, vol de caméra incliné vers le lieu, lent travelling
// circulaire, puis fondu vers une vraie photo du paysage (Wikimedia Commons).
//
// Photos choisies à la main sur Commons, avec auteur et licence : pour une version publiée,
// les remplacer par des photos ou vidéos dont on a les droits (office de tourisme…).

import type { Map as MaplibreMap } from 'maplibre-gl';

interface Poi {
  name: string;
  text: string;
  lngLat: [number, number];
  // Caméra d'arrivée : bearing = direction regardée (° depuis le nord)
  camera: { zoom: number; pitch: number; bearing: number };
  photo: { file: string; author: string; license: string };
}

const POIS: Poi[] = [
  {
    name: 'Montagne Pelée',
    text: 'Volcan actif de 1 397 m, dont l\'éruption de 1902 a détruit Saint-Pierre.',
    lngLat: [-61.1654, 14.8092],
    camera: { zoom: 12.6, pitch: 68, bearing: 40 },
    photo: { file: 'Saint-Pierre_(Martinique)_avec_Montage_Pelée.JPG', author: 'Zinneke', license: 'CC BY-SA 4.0' },
  },
  {
    name: 'Saint-Pierre',
    text: 'Ancienne capitale, au pied de la Pelée, face à la mer Caraïbe.',
    lngLat: [-61.1758, 14.7417],
    camera: { zoom: 15, pitch: 62, bearing: 60 },
    photo: { file: 'Ville_de_Saint-Pierre.jpg', author: 'Rehcral', license: 'CC BY-SA 4.0' },
  },
  {
    name: 'Anse Couleuvre',
    text: 'Plage de sable noir au bout de la route du nord-caraïbe.',
    lngLat: [-61.2192, 14.842],
    camera: { zoom: 15.6, pitch: 62, bearing: 90 },
    photo: { file: 'Anse_Couleuvre_-_vue_coté_nord.jpg', author: 'Patrice78500', license: 'CC BY-SA 4.0' },
  },
  {
    name: 'Pitons du Carbet',
    text: 'Cinq sommets volcaniques couverts de forêt tropicale humide.',
    lngLat: [-61.1138, 14.6982],
    camera: { zoom: 13.2, pitch: 68, bearing: -20 },
    photo: { file: 'Pitons.jpeg', author: 'Ze Moudong', license: 'CC BY-SA 4.0' },
  },
  {
    name: 'Jardin de Balata',
    text: 'Jardin botanique sur les hauteurs de Fort-de-France.',
    lngLat: [-61.0159, 14.6904],
    camera: { zoom: 16, pitch: 60, bearing: -30 },
    photo: { file: 'Vue_du_Jardin_de_Balata.jpg', author: 'IngridDb', license: 'CC BY-SA 4.0' },
  },
  {
    name: 'Fort Saint-Louis',
    text: 'Fort du XVIIᵉ siècle qui garde la baie de Fort-de-France.',
    lngLat: [-61.0664, 14.5997],
    camera: { zoom: 16.4, pitch: 60, bearing: 20 },
    photo: { file: 'Fort_Saint-Louis_vu_du_Carénage_02.jpg', author: 'UHF', license: 'CC BY-SA 3.0' },
  },
  {
    name: 'Presqu\'île de la Caravelle',
    text: 'Réserve naturelle avancée dans l\'Atlantique : mangrove, savanes et falaises.',
    lngLat: [-60.909, 14.753],
    camera: { zoom: 13.8, pitch: 65, bearing: 70 },
    photo: { file: 'TiFoX-réserve_protégée-9.jpg', author: 'Bruno Tifox Celica', license: 'CC BY-SA 4.0' },
  },
  {
    name: 'Rocher du Diamant',
    text: 'Îlot volcanique de 175 m, fortifié par les Anglais en 1804.',
    lngLat: [-61.0389, 14.4431],
    camera: { zoom: 14.8, pitch: 65, bearing: 230 },
    photo: { file: 'Diamond_Rock.jpg', author: 'Apmarles', license: 'CC BY 3.0' },
  },
];

const commonsImage = (file: string, width: number) =>
  `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(file)}?width=${width}`;
const commonsPage = (file: string) => `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(file)}`;

const FLIGHT_MS = 5000; // vol vers le lieu
const ORBIT_MS = 9000; // travelling circulaire à l'arrivée
const ORBIT_DEG = 35;
const PHOTO_AFTER_MS = 2500; // délai entre l'arrivée et le fondu vers la photo

/**
 * Ajoute les points remarquables à la carte (après le chargement du style).
 * `enableTilt` passe la carte en vue inclinée (relief 3D) avant le vol.
 */
export function setupPois(map: MaplibreMap, enableTilt: () => void): void {
  map.addSource('poi', {
    type: 'geojson',
    data: {
      type: 'FeatureCollection',
      features: POIS.map((p, i) => ({
        type: 'Feature',
        id: i,
        properties: { name: p.name },
        geometry: { type: 'Point', coordinates: p.lngLat },
      })),
    },
  });
  map.addLayer({
    id: 'poi-cercle',
    type: 'circle',
    source: 'poi',
    paint: {
      'circle-radius': 7,
      'circle-color': '#f2a33a',
      'circle-stroke-color': '#ffffff',
      'circle-stroke-width': 2.5,
      'circle-pitch-alignment': 'viewport',
    },
  });
  map.addLayer({
    id: 'poi-nom',
    type: 'symbol',
    source: 'poi',
    layout: {
      'text-field': ['get', 'name'],
      'text-font': ['Metropolis Bold'],
      'text-size': 13,
      'text-offset': [0, 1.1],
      'text-anchor': 'top',
      'text-allow-overlap': true,
    },
    paint: { 'text-color': '#7a3d00', 'text-halo-color': '#ffffff', 'text-halo-width': 2 },
  });

  const canvas = map.getCanvas();
  map.on('mouseenter', 'poi-cercle', () => (canvas.style.cursor = 'pointer'));
  map.on('mouseleave', 'poi-cercle', () => (canvas.style.cursor = ''));
  map.on('click', 'poi-cercle', (e) => {
    const id = e.features?.[0]?.id;
    if (typeof id === 'number') visit(POIS[id]);
  });

  // Vue photo : modale plein écran, fondu et lent zoom (effet Ken Burns) en CSS
  const view = document.getElementById('poi-view') as HTMLDialogElement;
  const img = view.querySelector('img')!;
  const title = view.querySelector('h2')!;
  const text = view.querySelector('p.poi-text')!;
  const credit = view.querySelector<HTMLAnchorElement>('a.poi-credit')!;
  let run = 0; // jeton : un nouveau clic ou une fermeture annule la séquence en cours

  function visit(poi: Poi) {
    const token = ++run;
    enableTilt();
    // Photo préchargée pendant le vol
    img.src = commonsImage(poi.photo.file, Math.min(2560, Math.round(innerWidth * devicePixelRatio)));
    img.alt = `Photo : ${poi.name}`;
    title.textContent = poi.name;
    text.textContent = poi.text;
    credit.textContent = `Photo : ${poi.photo.author}, ${poi.photo.license}, via Wikimedia Commons`;
    credit.href = commonsPage(poi.photo.file);

    const { zoom, pitch, bearing } = poi.camera;
    map.flyTo({ center: poi.lngLat, zoom, pitch, bearing: bearing - ORBIT_DEG / 2, duration: FLIGHT_MS, curve: 1.6, essential: true });
    map.once('moveend', () => {
      if (token !== run) return;
      map.easeTo({ bearing: bearing + ORBIT_DEG / 2, duration: ORBIT_MS, easing: (t) => t, essential: true });
      setTimeout(() => {
        if (token !== run) return;
        view.showModal();
        requestAnimationFrame(() => view.classList.add('visible'));
      }, PHOTO_AFTER_MS);
    });
  }

  function close() {
    run++;
    view.classList.remove('visible');
    setTimeout(() => view.close(), 600);
  }
  view.querySelector('button')!.addEventListener('click', close);
  view.addEventListener('cancel', (e) => {
    e.preventDefault(); // Échap : même fondu de sortie
    close();
  });
}
