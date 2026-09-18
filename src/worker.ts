/// <reference lib="webworker" />
/**
 * Runs the conversion off the main thread so the page stays responsive
 * while LibreDWG encodes large models.
 */
import { type ConvertOptions, type ConvertStats, convertGlbToDwg } from './convert.ts';
import { GlbError } from './glb.ts';
import createGlb2DwgModule, { type Glb2DwgModule } from './wasm/glb2dwg.mjs';
import wasmUrl from './wasm/glb2dwg.wasm?url';

export interface ConvertRequest {
  id: number;
  glb: ArrayBuffer;
  options: ConvertOptions;
}

export type ConvertResponse =
  | { id: number; ok: true; dwg: Uint8Array; stats: ConvertStats }
  | { id: number; ok: false; message: string; fileProblem: boolean };

let modulePromise: Promise<Glb2DwgModule> | undefined;

function loadModule(): Promise<Glb2DwgModule> {
  modulePromise ??= createGlb2DwgModule({
    locateFile: (path) => (path.endsWith('.wasm') ? wasmUrl : path),
    printErr: (text) => console.warn('[LibreDWG]', text),
  });
  return modulePromise;
}

const scope = self as unknown as DedicatedWorkerGlobalScope;

scope.addEventListener('message', async (event: MessageEvent<ConvertRequest>) => {
  const { id, glb, options } = event.data;
  let response: ConvertResponse;

  try {
    const mod = await loadModule();
    const { dwg, stats } = convertGlbToDwg(glb, mod, options);
    response = { id, ok: true, dwg, stats };
  } catch (error) {
    // A WebAssembly trap leaves the module unusable; load a fresh one next time.
    if (error instanceof WebAssembly.RuntimeError) modulePromise = undefined;
    const fileProblem = error instanceof GlbError;
    const message =
      error instanceof Error ? error.message : 'The conversion failed for an unknown reason.';
    if (!fileProblem) console.error(error);
    response = { id, ok: false, message, fileProblem };
  }

  const transfer = response.ok ? [response.dwg.buffer as ArrayBuffer] : [];
  scope.postMessage(response, transfer);
});
