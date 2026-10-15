import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

// Démo du lab Absolu, servie depuis un sous-répertoire (lab.agence-absolu.com/<slug>/).
// Le slug est le nom npm du projet : la démo se déploie dans le dossier qui porte son nom.
// BASE_PATH surcharge au besoin (racine de domaine : BASE_PATH=/).
const { name } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const base = process.env.BASE_PATH || `/${name}/`;

export default defineConfig(({ command }) => ({
  base,
  // Pas de repli sur index.html : une tuile absente (large d'une grande région) doit
  // répondre 404, que MapLibre ignore, et non une page HTML qu'il tente de décoder.
  appType: 'mpa',
  // public/ ne contient que les tuiles (plusieurs Go) : la version déployée lit toujours
  // celles de R2 (VITE_TILES_URL), le build ne les embarque pas. Le serveur de
  // développement les sert pour la bascule vers les tuiles locales.
  publicDir: command === 'build' ? false : 'public',
  build: {
    rolldownOptions: {
      output: {
        // Worker MapLibre (maplibre-gl-worker.mjs?url) émis en .js : le serveur du lab ne
        // connaît pas .mjs et l'envoie en application/octet-stream, refusé pour un module.
        assetFileNames: ({ names }) =>
          names.some((n) => n.endsWith('.mjs')) ? 'assets/[name]-[hash].js' : 'assets/[name]-[hash][extname]',
      },
    },
  },
}));
