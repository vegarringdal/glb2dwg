/**
 * Reads DWG files back, for tests.
 *
 * Wraps the reader half of native/glb2dwg.c, which is compiled only into
 * test/wasm/glb2dwg-test.mjs. Nothing here ships with the app; it exists so
 * tests can check what really landed in the file rather than trusting the
 * writer's own report.
 */
import { existsSync, readFileSync } from 'node:fs';
import type { Glb2DwgModule } from '../src/wasm/glb2dwg.mjs';

export interface ReaderModule extends Glb2DwgModule {
  _g2d_read_open(ptr: number, len: number): number;
  _g2d_read_close(): void;
  _g2d_read_chain_errors(): number;
  _g2d_read_version(): number;
  _g2d_read_insunits(): number;
  _g2d_read_extents(ptr: number): void;
  _g2d_read_num_triangles(): number;
  _g2d_read_triangles(xyzPtr: number, layerPtr: number, maxTris: number): number;
  _g2d_read_num_layers(): number;
  _g2d_read_layer_name(index: number, bufPtr: number, bufLen: number): number;
}

/** A triangle as read back out of a DWG file. */
export interface ReadTriangle {
  /** Nine numbers: three corners, in the order stored. */
  corners: number[];
  /** Layer name, or undefined if the entity had none. */
  layer: string | undefined;
}

export interface ReadDrawing {
  /**
   * Model space entities whose prev/next links are missing or point at the
   * wrong neighbour. Files with any of these are refused by AutoCAD-compatible
   * readers, so this must be zero.
   */
  chainErrors: number;
  /** LibreDWG's version enum; compare against R_2000. */
  version: number;
  insunits: number;
  extents: { min: number[]; max: number[] };
  layers: string[];
  triangles: ReadTriangle[];
}

/** LibreDWG's Dwg_Version_Type enum value for R2000 (AC1015). */
export const R_2000 = 25;

const moduleUrl = new URL('./wasm/glb2dwg-test.mjs', import.meta.url);
const wasmUrl = new URL('./wasm/glb2dwg-test.wasm', import.meta.url);

/** False when the test module hasn't been built; tests skip themselves. */
export const readerBuilt = existsSync(moduleUrl) && existsSync(wasmUrl);

let cached: Promise<ReaderModule> | undefined;

export function loadReader(): Promise<ReaderModule> {
  cached ??= (async () => {
    const { default: create } = (await import(moduleUrl.href)) as {
      default: (options: { wasmBinary: Buffer }) => Promise<ReaderModule>;
    };
    return create({ wasmBinary: readFileSync(wasmUrl) });
  })();
  return cached;
}

/** Decodes DWG bytes and returns everything the tests care about. */
export function readDwg(mod: ReaderModule, dwg: Uint8Array): ReadDrawing {
  const dwgPtr = mod._malloc(dwg.byteLength);
  if (dwgPtr === 0) throw new Error('out of memory');
  try {
    mod.HEAPU8.set(dwg, dwgPtr);
    const code = mod._g2d_read_open(dwgPtr, dwg.byteLength);
    if (code !== 0) throw new Error(`LibreDWG could not read the drawing back (code ${code})`);
  } finally {
    mod._free(dwgPtr);
  }

  try {
    return {
      chainErrors: mod._g2d_read_chain_errors(),
      version: mod._g2d_read_version(),
      insunits: mod._g2d_read_insunits(),
      extents: readExtents(mod),
      layers: readLayers(mod),
      triangles: readTriangles(mod),
    };
  } finally {
    mod._g2d_read_close();
  }
}

function readExtents(mod: ReaderModule): { min: number[]; max: number[] } {
  const ptr = mod._malloc(6 * 8);
  if (ptr === 0) throw new Error('out of memory');
  try {
    mod._g2d_read_extents(ptr);
    const values = [...new Float64Array(mod.HEAPU8.buffer, ptr, 6)];
    return { min: values.slice(0, 3), max: values.slice(3) };
  } finally {
    mod._free(ptr);
  }
}

function readLayers(mod: ReaderModule): string[] {
  const size = 512;
  const ptr = mod._malloc(size);
  if (ptr === 0) throw new Error('out of memory');
  try {
    const names: string[] = [];
    for (let i = 0; i < mod._g2d_read_num_layers(); i++) {
      const length = mod._g2d_read_layer_name(i, ptr, size);
      names.push(new TextDecoder().decode(mod.HEAPU8.slice(ptr, ptr + length)));
    }
    return names;
  } finally {
    mod._free(ptr);
  }
}

function readTriangles(mod: ReaderModule): ReadTriangle[] {
  const count = mod._g2d_read_num_triangles();
  if (count === 0) return [];

  const xyzPtr = mod._malloc(count * 9 * 8);
  const layerPtr = mod._malloc(count * 4);
  if (xyzPtr === 0 || layerPtr === 0) throw new Error('out of memory');
  try {
    const copied = mod._g2d_read_triangles(xyzPtr, layerPtr, count);
    // Copy out before any later allocation can move the heap.
    const xyz = new Float64Array(mod.HEAPU8.buffer, xyzPtr, copied * 9).slice();
    const layerIndex = new Int32Array(mod.HEAPU8.buffer, layerPtr, copied).slice();
    const layers = readLayers(mod);

    const triangles: ReadTriangle[] = [];
    for (let i = 0; i < copied; i++) {
      triangles.push({
        corners: [...xyz.subarray(i * 9, i * 9 + 9)],
        layer: layers[layerIndex[i] as number],
      });
    }
    return triangles;
  } finally {
    mod._free(xyzPtr);
    mod._free(layerPtr);
  }
}

/**
 * A comparable key for one triangle. Rotation is normalized, so the same
 * triangle starting at a different corner matches, but reversal is not:
 * winding still has to agree.
 */
export function triangleKey(corners: readonly number[], decimals = 6): string {
  const points = [0, 1, 2].map((i) =>
    corners
      .slice(i * 3, i * 3 + 3)
      .map((value) => {
        const rounded = value.toFixed(decimals);
        return rounded === `-${(0).toFixed(decimals)}` ? (0).toFixed(decimals) : rounded;
      })
      .join(','),
  );
  const rotations = [0, 1, 2].map((i) =>
    [points[i], points[(i + 1) % 3], points[(i + 2) % 3]].join(' '),
  );
  rotations.sort();
  return rotations[0] as string;
}

/** Triangle keys for a mesh held as positions plus indices. */
export function expectedKeys(positions: Float64Array, indices: Uint32Array): string[] {
  const keys: string[] = [];
  for (let t = 0; t < indices.length; t += 3) {
    const corners: number[] = [];
    for (let k = 0; k < 3; k++) {
      const v = indices[t + k] as number;
      corners.push(...positions.subarray(v * 3, v * 3 + 3));
    }
    keys.push(triangleKey(corners));
  }
  return keys;
}
