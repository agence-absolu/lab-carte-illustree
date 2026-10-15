// Choix de la région traitée et chemins associés.
// Chaque région a sa config (config/regions/{nom}.json) et ses dossiers data/{nom},
// output/{nom} et public/tiles/{nom}.

import { readdirSync } from 'node:fs';
import { join } from 'node:path';

export const ROOT = new URL('..', import.meta.url).pathname;

export interface RegionPaths {
  name: string;
  section?: string; // section d'une grande région (scripts/run-tiled.ts)
  config: string;
  data: string;
  output: string;
  tiles: string;
}

export function listRegions(): string[] {
  return readdirSync(join(ROOT, 'config/regions'))
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -5))
    .sort();
}

/**
 * Région demandée par `--region nom` (ou la variable REGION). Retire l'option de
 * argv pour que le reste des arguments puisse être lu normalement.
 *
 * `--section id` vise une section d'une grande région : config générée dans
 * data/{nom}/sections/{id}/config.json, données et rendus dans les sous-dossiers
 * sections/{id}, tuiles dans le dossier commun de la région.
 */
export function regionFromArgs(argv: string[] = process.argv): RegionPaths {
  let name = process.env.REGION;
  const i = argv.indexOf('--region');
  if (i >= 0) {
    name = argv[i + 1];
    argv.splice(i, 2);
  }
  const regions = listRegions();
  if (!name) {
    if (regions.length !== 1) {
      throw new Error(`Préciser la région avec --region (disponibles : ${regions.join(', ')})`);
    }
    name = regions[0];
  }
  if (!regions.includes(name)) throw new Error(`Région inconnue « ${name} » (disponibles : ${regions.join(', ')})`);
  const s = argv.indexOf('--section');
  if (s >= 0) {
    const section = argv[s + 1];
    argv.splice(s, 2);
    const data = join(ROOT, 'data', name, 'sections', section);
    return {
      name,
      section,
      config: join(data, 'config.json'),
      data,
      output: join(ROOT, 'output', name, 'sections', section),
      tiles: join(ROOT, 'public/tiles', name),
    };
  }
  return {
    name,
    config: join(ROOT, 'config/regions', `${name}.json`),
    data: join(ROOT, 'data', name),
    output: join(ROOT, 'output', name),
    tiles: join(ROOT, 'public/tiles', name),
  };
}
