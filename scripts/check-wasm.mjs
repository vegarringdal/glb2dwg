// Stops `npm run dev` / `npm run build` early with a clear message when the
// WebAssembly module hasn't been built yet.
import { existsSync } from 'node:fs';

const required = ['src/wasm/glb2dwg.mjs', 'src/wasm/glb2dwg.wasm'];
const missing = required.filter((file) => !existsSync(new URL(`../${file}`, import.meta.url)));

if (missing.length > 0) {
  console.error(
    [
      '',
      `The WebAssembly module hasn't been built yet (missing ${missing.join(', ')}).`,
      'Build it first with one of:',
      '  npm run build:wasm          (needs the Emscripten SDK)',
      '  npm run build:wasm:docker   (needs Docker)',
      '',
    ].join('\n'),
  );
  process.exit(1);
}
