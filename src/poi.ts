// Points remarquables (essai) : au clic, vol de caméra incliné vers le lieu, lent travelling
// circulaire, puis fondu vers une vraie photo du paysage (Wikimedia Commons).
//
// Photos choisies à la main sur Commons, avec auteur et licence : pour une version publiée,
// les remplacer par des photos ou vidéos dont on a les droits (office de tourisme…).

import { Popup, type Map as MaplibreMap } from 'maplibre-gl';
import fredUrl from './assets/fred.png';

interface Poi {
  name: string;
  text: string;
  lngLat: [number, number];
  // Caméra d'arrivée : bearing = direction regardée (° depuis le nord)
  // offset : position du lieu à l'écran, en px depuis le centre (y négatif = vers le haut)
  camera: { zoom: number; pitch: number; bearing: number; offset?: [number, number] };
  // Sans photo : la séquence s'arrête sur le travelling, avec une bulle au nom du lieu
  photo?: { file: string; author: string; license: string };
  // Médaillon rond (PNG 96 px, cerclé de blanc) à la place du point
  icon?: string;
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
  {
    name: 'Chez Fred !',
    text: 'Vue sur l\'Anse Mitan et la baie de Fort-de-France.',
    lngLat: [-61.053087813662195, 14.547598730078395],
    camera: { zoom: 17, pitch: 60, bearing: 180, offset: [0, -220] },
    // L'Anse Mitan, en contrebas, vers la baie de Fort-de-France (pas encore de photo prise de chez lui)
    photo: { file: 'Les_Trois-Îlets,_Martinique_2019-11-04.jpg', author: 'Alexey Komarov', license: 'CC BY-SA 4.0' },
    icon: fredUrl,
  },
];

const commonsImage = (file: string, width: number) =>
  `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(file)}?width=${width}`;
const commonsPage = (file: string) => `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(file)}`;

const FLIGHT_MS = 5000; // vol vers le lieu
const ORBIT_MS = 9000; // travelling circulaire à l'arrivée
const ORBIT_DEG = 35;
const PHOTO_AFTER_MS = 400; // délai entre l'arrivée et le fondu vers la photo (presque aussitôt)

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
        properties: { name: p.name, ...(p.icon ? { icon: `poi-${i}` } : {}) },
        geometry: { type: 'Point', coordinates: p.lngLat },
      })),
    },
  });
  map.addLayer({
    id: 'poi-cercle',
    type: 'circle',
    source: 'poi',
    filter: ['!', ['has', 'icon']],
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
    // Lieux à médaillon : la photo suffit, pas de nom
    filter: ['!', ['has', 'icon']],
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

  // Médaillons : images chargées puis couche de symboles, sous les noms
  Promise.all(
    POIS.map(async (p, i) => {
      if (!p.icon) return;
      const img = await map.loadImage(p.icon);
      map.addImage(`poi-${i}`, img.data, { pixelRatio: 2 });
    }),
  ).then(() => {
    map.addLayer(
      {
        id: 'poi-icone',
        type: 'symbol',
        source: 'poi',
        filter: ['has', 'icon'],
        layout: {
          'icon-image': ['get', 'icon'],
          'icon-allow-overlap': true,
          'icon-pitch-alignment': 'viewport',
        },
      },
      'poi-nom',
    );
    listen('poi-icone');
  });

  const canvas = map.getCanvas();
  listen('poi-cercle');
  function listen(layer: string) {
    map.on('mouseenter', layer, () => (canvas.style.cursor = 'pointer'));
    map.on('mouseleave', layer, () => (canvas.style.cursor = ''));
    map.on('click', layer, (e) => {
      const id = e.features?.[0]?.id;
      if (typeof id === 'number') visit(POIS[id]);
    });
  }

  // Vue photo : modale plein écran, fondu et lent zoom (effet Ken Burns) en CSS
  const view = document.getElementById('poi-view') as HTMLDialogElement;
  const img = view.querySelector('img')!;
  const title = view.querySelector('h2')!;
  const text = view.querySelector('p.poi-text')!;
  const credit = view.querySelector<HTMLAnchorElement>('a.poi-credit')!;
  const popup = new Popup({ closeButton: false, offset: 26, className: 'poi-popup' });
  let run = 0; // jeton : un nouveau clic ou une fermeture annule la séquence en cours

  function visit(poi: Poi) {
    const token = ++run;
    popup.remove();
    enableTilt();
    const photo = poi.photo;
    if (photo) {
      // Photo préchargée pendant le vol
      img.src = commonsImage(photo.file, Math.min(2560, Math.round(innerWidth * devicePixelRatio)));
      img.alt = `Photo : ${poi.name}`;
      title.textContent = poi.name;
      text.textContent = poi.text;
      credit.textContent = `Photo : ${photo.author}, ${photo.license}, via Wikimedia Commons`;
      credit.href = commonsPage(photo.file);
    }

    const { zoom, pitch, bearing, offset = [0, 0] } = poi.camera;
    map.flyTo({ center: poi.lngLat, offset, zoom, pitch, bearing: bearing - ORBIT_DEG / 2, duration: FLIGHT_MS, curve: 1.6, essential: true });
    map.once('moveend', () => {
      if (token !== run) return;
      // Travelling autour du lieu lui-même (qui reste à sa place à l'écran), pas du centre
      map.easeTo({ bearing: bearing + ORBIT_DEG / 2, around: poi.lngLat, duration: ORBIT_MS, easing: (t) => t, essential: true });
      if (!photo) {
        popup.setLngLat(poi.lngLat).setText(poi.text ? `${poi.name} — ${poi.text}` : poi.name).addTo(map);
        return;
      }
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
