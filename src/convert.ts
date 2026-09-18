import { DwgWriter } from './dwg-writer.ts';
import { GlbError, parseGlb } from './glb.ts';
import type { Glb2DwgModule } from './wasm/glb2dwg.mjs';

export type EntityKind = 'polyface' | '3dface';

export type UnitName = 'meters' | 'millimeters';

/**
 * glTF coordinates are always meters, so each unit needs a scale factor and
 * the matching DWG $INSUNITS code. Add a row to offer more units.
 */
export const UNITS: Record<UnitName, { scale: number; insunits: number; label: string }> = {
  meters: { scale: 1, insunits: 6, label: 'm' },
  millimeters: { scale: 1000, insunits: 4, label: 'mm' },
};

export interface ConvertOptions {
  /** Polyface meshes share vertices; 3D faces are one entity per triangle. */
  entity: EntityKind;
  /** glTF is Y-up, AutoCAD is Z-up. */
  yUpToZUp: boolean;
  /** Drawing units. glTF models are in meters. */
  units: UnitName;
}

export interface ConvertStats {
  units: UnitName;
  layers: number;
  triangles: number;
  entities: number;
  skippedPrimitives: number;
}

export interface ConvertResult {
  dwg: Uint8Array;
  stats: ConvertStats;
}

/** Max vertices and faces in one polyface mesh (16-bit signed indices). */
export const POLYFACE_LIMIT = 32767;

/** Triangles sent to WASM per call when writing 3D faces. */
const FACE_BATCH = 50_000;

/** AutoCAD Color Index values, cycled so neighboring layers are distinguishable. */
const LAYER_COLORS = [1, 2, 3, 4, 5, 6, 30, 140, 210, 50, 90, 170];

export function convertGlbToDwg(
  glb: ArrayBuffer,
  mod: Glb2DwgModule,
  options: ConvertOptions,
): ConvertResult {
  const scene = parseGlb(glb);
  const parts = scene.parts.filter((part) => part.indices.length > 0);

  if (parts.length === 0) {
    throw new GlbError(
      scene.skippedPrimitives > 0
        ? 'This model only contains points or lines. DWG export needs triangle meshes.'
        : 'This model contains no triangle meshes to convert.',
    );
  }

  const unit = UNITS[options.units] ?? UNITS.meters;
  const writer = new DwgWriter(mod);
  try {
    writer.begin();
    writer.setUnits(unit.insunits);

    const layers = new LayerTable(writer);
    const min = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
    const max = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
    let triangles = 0;
    let entities = 0;

    for (const part of parts) {
      const positions = placePoints(part.positions, options.yUpToZUp, unit.scale);
      expandBounds(positions, part.indices, min, max);
      writer.useLayer(layers.indexFor(part.name));

      if (options.entity === 'polyface') {
        const mesh = weldVertices(positions, part.indices);
        entities += writePolyfaces(writer, mesh.positions, mesh.indices);
        triangles += mesh.indices.length / 3;
      } else {
        entities += write3dFaces(writer, positions, part.indices);
        triangles += part.indices.length / 3;
      }
    }

    writer.setExtents(min, max);
    const dwg = writer.finish();

    return {
      dwg,
      stats: {
        units: options.units,
        layers: layers.size,
        triangles,
        entities,
        skippedPrimitives: scene.skippedPrimitives,
      },
    };
  } finally {
    writer.end();
  }
}

/**
 * Scales metres to the drawing units and, if asked, rotates +90° about X so
 * glTF's (x, y, z) becomes CAD's (x, -z, y).
 */
export function placePoints(
  positions: Float64Array,
  yUpToZUp: boolean,
  scale: number,
): Float64Array {
  if (!yUpToZUp && scale === 1) return positions;
  const out = new Float64Array(positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i] as number;
    const y = positions[i + 1] as number;
    const z = positions[i + 2] as number;
    out[i] = x * scale;
    out[i + 1] = (yUpToZUp ? -z : y) * scale;
    out[i + 2] = (yUpToZUp ? y : z) * scale;
  }
  return out;
}

/**
 * Grows the drawing extents to cover a mesh. Only vertices a triangle
 * actually uses count: glTF files often carry vertices nothing refers to, and
 * those would push the extents out past the visible geometry.
 */
function expandBounds(
  positions: Float64Array,
  indices: Uint32Array,
  min: number[],
  max: number[],
): void {
  for (const index of indices) {
    for (let axis = 0; axis < 3; axis++) {
      const value = positions[index * 3 + axis] as number;
      if (value < (min[axis] as number)) min[axis] = value;
      if (value > (max[axis] as number)) max[axis] = value;
    }
  }
}

/**
 * Merges vertices with identical coordinates. glTF splits vertices wherever
 * normals or texture coordinates change; CAD meshes only need positions, and
 * shared vertices make polyfaces smaller and connected. Triangles that
 * collapse after merging are dropped.
 */
export function weldVertices(
  positions: Float64Array,
  indices: Uint32Array,
): { positions: Float64Array; indices: Uint32Array } {
  const vertexCount = positions.length / 3;
  const firstIndex = new Map<string, number>();
  const remap = new Uint32Array(vertexCount);
  const welded = new Float64Array(positions.length);
  let unique = 0;

  for (let v = 0; v < vertexCount; v++) {
    const x = positions[v * 3] as number;
    const y = positions[v * 3 + 1] as number;
    const z = positions[v * 3 + 2] as number;
    const key = `${x} ${y} ${z}`;
    const existing = firstIndex.get(key);
    if (existing === undefined) {
      firstIndex.set(key, unique);
      welded[unique * 3] = x;
      welded[unique * 3 + 1] = y;
      welded[unique * 3 + 2] = z;
      remap[v] = unique++;
    } else {
      remap[v] = existing;
    }
  }

  const out = new Uint32Array(indices.length);
  let count = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const a = remap[indices[t] as number] as number;
    const b = remap[indices[t + 1] as number] as number;
    const c = remap[indices[t + 2] as number] as number;
    if (a === b || b === c || a === c) continue;
    out[count++] = a;
    out[count++] = b;
    out[count++] = c;
  }

  return { positions: welded.slice(0, unique * 3), indices: out.slice(0, count) };
}

/**
 * Writes a triangle mesh as polyface meshes, splitting it whenever a chunk
 * would exceed `limit` vertices or faces. Each chunk only carries the vertices
 * its faces use, renumbered from 1. Returns the number of entities written.
 * The limit is a parameter so tests can force splitting on small meshes.
 */
export function writePolyfaces(
  writer: Pick<DwgWriter, 'addPolyface'>,
  positions: Float64Array,
  indices: Uint32Array,
  limit: number = POLYFACE_LIMIT,
): number {
  const vertexCount = positions.length / 3;
  // stamp[v] === chunk means vertex v already has local index local[v].
  const stamp = new Uint32Array(vertexCount);
  const local = new Uint16Array(vertexCount);
  const triangleCount = indices.length / 3;
  const xyz = new Float64Array(Math.min(limit, vertexCount) * 3);
  const faces = new Int16Array(Math.min(limit, triangleCount) * 4);

  let chunk = 1;
  let vertices = 0;
  let faceCount = 0;
  let entities = 0;

  const flush = () => {
    if (faceCount === 0) return;
    writer.addPolyface(xyz.subarray(0, vertices * 3), faces.subarray(0, faceCount * 4));
    entities++;
    chunk++;
    vertices = 0;
    faceCount = 0;
  };

  for (let t = 0; t < indices.length; t += 3) {
    let newVertices = 0;
    for (let k = 0; k < 3; k++) {
      if (stamp[indices[t + k] as number] !== chunk) newVertices++;
    }
    if (vertices + newVertices > limit || faceCount === limit) flush();

    const face = faceCount * 4;
    for (let k = 0; k < 3; k++) {
      const v = indices[t + k] as number;
      if (stamp[v] !== chunk) {
        stamp[v] = chunk;
        local[v] = vertices;
        xyz[vertices * 3] = positions[v * 3] as number;
        xyz[vertices * 3 + 1] = positions[v * 3 + 1] as number;
        xyz[vertices * 3 + 2] = positions[v * 3 + 2] as number;
        vertices++;
      }
      faces[face + k] = (local[v] as number) + 1;
    }
    faces[face + 3] = 0;
    faceCount++;
  }

  flush();
  return entities;
}

function write3dFaces(writer: DwgWriter, positions: Float64Array, indices: Uint32Array): number {
  const triangleCount = indices.length / 3;
  const batch = new Float64Array(Math.min(FACE_BATCH, triangleCount) * 9);

  for (let first = 0; first < triangleCount; first += FACE_BATCH) {
    const count = Math.min(FACE_BATCH, triangleCount - first);
    for (let t = 0; t < count; t++) {
      for (let k = 0; k < 3; k++) {
        const v = indices[(first + t) * 3 + k] as number;
        const o = (t * 3 + k) * 3;
        batch[o] = positions[v * 3] as number;
        batch[o + 1] = positions[v * 3 + 1] as number;
        batch[o + 2] = positions[v * 3 + 2] as number;
      }
    }
    writer.add3dFaces(batch.subarray(0, count * 9));
  }
  return triangleCount;
}

/** Maps mesh names to unique, valid DWG layer names. */
class LayerTable {
  readonly #writer: DwgWriter;
  /** Keyed by lowercase name: DWG layer names are case-insensitive. */
  readonly #byName = new Map<string, number>();

  constructor(writer: DwgWriter) {
    this.#writer = writer;
  }

  get size(): number {
    return this.#byName.size;
  }

  indexFor(rawName: string): number {
    const name = layerName(rawName);
    const key = name.toLowerCase();
    const existing = this.#byName.get(key);
    if (existing !== undefined) return existing;

    const color = LAYER_COLORS[this.#byName.size % LAYER_COLORS.length] as number;
    const index = this.#writer.addLayer(name, color);
    this.#byName.set(key, index);
    return index;
  }
}

/**
 * Makes a string safe as an AutoCAD layer name: replaces reserved characters,
 * avoids the built-in "0" and "Defpoints" layers, and caps the length.
 */
export function layerName(raw: string): string {
  let name = raw
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>/\\":;?*|=`',]/g, '_')
    .trim();
  if (name === '') name = 'mesh';
  const lower = name.toLowerCase();
  if (lower === '0' || lower === 'defpoints') name = `${name} mesh`;
  return name.slice(0, 255);
}
