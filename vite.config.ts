import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

// Read rather than import, so the whole package.json does not end up in the bundle.
const { version } = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
) as { version: string };

// Reaches the app as import.meta.env.VITE_APP_VERSION, in dev and in a build alike.
process.env.VITE_APP_VERSION = version;

export default defineConfig({
  // Relative asset URLs, so the built page works from any folder or static host.
  base: './',
  build: {
    // GitHub Pages can serve a repository's docs/ folder straight from the branch.
    outDir: 'docs',
    target: 'es2022',
  },
  worker: {
    format: 'es',
  },
});
