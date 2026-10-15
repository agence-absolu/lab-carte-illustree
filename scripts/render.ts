// Lance Blender (sans interface) pour construire la scène et rendre les blocs,
// pour chaque saison demandée. Les options après « -- » sont transmises au script
// Blender (ex. --samples 64 --save-blend).
//
// Usage : node scripts/render.ts [--region nom] [saison…] [-- options build_scene.py]

import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ROOT, regionFromArgs } from '../lib/region.ts';

const PATHS = regionFromArgs();
const BLENDER = process.env.BLENDER ?? 'blender';

const args = process.argv.slice(2);
const sep = args.indexOf('--');
const seasonsArg = sep >= 0 ? args.slice(0, sep) : args;
const extra = sep >= 0 ? args.slice(sep + 1) : [];

const region = JSON.parse(await readFile(join(PATHS.data, 'region.json'), 'utf8'));
const seasons: string[] = seasonsArg.length ? seasonsArg : region.seasons;

for (const season of seasons) {
  console.log(`Rendu ${PATHS.name} / ${season}…`);
  const blenderArgs = ['--season', season, '--data', PATHS.data, '--out', PATHS.output, ...extra];
  const res = spawnSync(BLENDER, ['-b', '-P', join(ROOT, 'blender/build_scene.py'), '--', ...blenderArgs], {
    stdio: ['ignore', 'pipe', 'inherit'],
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024, // Blender écrit beaucoup sur stdout
  });
  // On ne garde que les messages du script (Blender est très bavard)
  for (const line of (res.stdout ?? '').split('\n')) {
    if (line.startsWith('[scene]') || /Error|Traceback/.test(line)) console.log(line);
  }
  if (res.status !== 0) {
    console.error(`Blender a échoué (code ${res.status})`);
    process.exit(1);
  }
}
