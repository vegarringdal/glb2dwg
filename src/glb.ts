/**
 * Minimal GLB (binary glTF 2.0) reader.
 *
 * Reads only what a DWG needs: triangle geometry in world space, grouped by
 * node. Materials, textures, normals, skins and animation are ignored.
 */

/** A triangle mesh in world space (glTF axes, meters). */
export interface MeshPart {
  /** Node name, else mesh name, else "mesh N". Used for the layer name. */
  name: string;
  /** xyz triples. */
  positions: Float64Array;
  /** Three vertex indices per triangle. Degenerate triangles are removed. */
  indices: Uint32Array;
}

export interface GlbScene {
  parts: MeshPart[];
  /** Primitives skipped because they are points or lines, or have no positions. */
  skippedPrimitives: number;
}

/** A problem with the input file, worded for the person who chose it. */
export class GlbError extends Error {
  override name = 'GlbError';
}

interface GltfNode {
  name?: string;
  mesh?: number;
  children?: number[];
  matrix?: number[];
  translation?: number[];
  rotation?: number[];
  scale?: number[];
}

interface GltfPrimitive {
  attributes: Record<string, number | undefined>;
  indices?: number;
  mode?: number;
}

interface GltfAccessor {
  bufferView?: number;
  byteOffset?: number;
  componentType: number;
  normalized?: boolean;
  count: number;
  type: string;
  sparse?: {
    count: number;
    indices: { bufferView: number; byteOffset?: number; componentType: number };
    values: { bufferView: number; byteOffset?: number };
  };
}

interface GltfJson {
  extensionsRequired?: string[];
  scene?: number;
  scenes?: { nodes?: number[] }[];
  nodes?: GltfNode[];
  meshes?: { name?: string; primitives?: GltfPrimitive[] }[];
  accessors?: GltfAccessor[];
  bufferViews?: { buffer: number; byteOffset?: number; byteLength: number; byteStride?: number }[];
  buffers?: { byteLength: number; uri?: string }[];
}

const GLB_MAGIC = 0x46546c67; // "glTF"
const CHUNK_JSON = 0x4e4f534a; // "JSON"
const CHUNK_BIN = 0x004e4942; // "BIN\0"

const MODE_TRIANGLES = 4;
const MODE_TRIANGLE_STRIP = 5;
const MODE_TRIANGLE_FAN = 6;

const COMPONENT_BYTES: Record<number, number> = {
  5120: 1, // BYTE
  5121: 1, // UNSIGNED_BYTE
  5122: 2, // SHORT
  5123: 2, // UNSIGNED_SHORT
  5125: 4, // UNSIGNED_INT
  5126: 4, // FLOAT
};

const TYPE_COMPONENTS: Record<string, number> = {
  SCALAR: 1,
  VEC2: 2,
  VEC3: 3,
  VEC4: 4,
  MAT2: 4,
  MAT3: 9,
  MAT4: 16,
};

/** Geometry compression we can't decode without extra libraries. */
const UNSUPPORTED_EXTENSIONS: Record<string, string> = {
  KHR_draco_mesh_compression: 'Draco mesh compression',
  EXT_meshopt_compression: 'meshopt compression',
};

export function parseGlb(data: ArrayBuffer): GlbScene {
  const { json, bin } = readContainer(data);

  for (const extension of json.extensionsRequired ?? []) {
    const label = UNSUPPORTED_EXTENSIONS[extension];
    if (label) {
      throw new GlbError(
        `This model uses ${label}, which isn't supported. Export it again without mesh compression.`,
      );
    }
  }

  const reader = new AccessorReader(json, bin);
  const nodes = json.nodes ?? [];
  const parts: MeshPart[] = [];
  let skippedPrimitives = 0;

  const stack = rootNodes(json).map((index) => ({ index, parent: IDENTITY }));
  const visited = new Set<number>();

  while (stack.length > 0) {
    const item = stack.pop();
    if (!item) break;
    const node = nodes[item.index];
    if (!node) throw new GlbError(`The model refers to node ${item.index}, which doesn't exist.`);
    if (visited.has(item.index)) {
      throw new GlbError('The model’s node hierarchy contains a loop.');
    }
    visited.add(item.index);

    const world = multiply(item.parent, localMatrix(node));

    if (node.mesh !== undefined) {
      const mesh = json.meshes?.[node.mesh];
      if (!mesh) throw new GlbError(`The model refers to mesh ${node.mesh}, which doesn't exist.`);
      const name = node.name || mesh.name || `mesh ${node.mesh}`;

      for (const primitive of mesh.primitives ?? []) {
        const part = readPrimitive(reader, primitive, world, name);
        if (part) parts.push(part);
        else skippedPrimitives++;
      }
    }

    // Push children in reverse so they are visited in file order.
    const children = node.children ?? [];
    for (let i = children.length - 1; i >= 0; i--) {
      stack.push({ index: children[i] as number, parent: world });
    }
  }

  return { parts, skippedPrimitives };
}

function readContainer(data: ArrayBuffer): { json: GltfJson; bin: Uint8Array | undefined } {
  if (data.byteLength < 20) {
    throw new GlbError('This file is too small to be a GLB model.');
  }
  const view = new DataView(data);
  if (view.getUint32(0, true) !== GLB_MAGIC) {
    throw new GlbError(
      "This isn't a GLB file. Export the model as binary glTF (.glb) and try again.",
    );
  }
  const version = view.getUint32(4, true);
  if (version !== 2) {
    throw new GlbError(`This file uses glTF ${version}. Only glTF 2.0 is supported.`);
  }

  const length = Math.min(view.getUint32(8, true), data.byteLength);
  let offset = 12;
  let jsonText: string | undefined;
  let bin: Uint8Array | undefined;

  while (offset + 8 <= length) {
    const chunkLength = view.getUint32(offset, true);
    const chunkType = view.getUint32(offset + 4, true);
    const start = offset + 8;
    if (start + chunkLength > length) {
      throw new GlbError('The GLB file is cut off. Download or export it again.');
    }
    if (chunkType === CHUNK_JSON && jsonText === undefined) {
      jsonText = new TextDecoder().decode(new Uint8Array(data, start, chunkLength));
    } else if (chunkType === CHUNK_BIN && bin === undefined) {
      bin = new Uint8Array(data, start, chunkLength);
    }
    // Chunks are padded to 4 bytes; align in case a writer forgot.
    offset = start + Math.ceil(chunkLength / 4) * 4;
  }

  if (jsonText === undefined) {
    throw new GlbError('The GLB file has no scene description (JSON chunk).');
  }
  try {
    return { json: JSON.parse(jsonText) as GltfJson, bin };
  } catch {
    throw new GlbError('The GLB file’s scene description is not valid JSON.');
  }
}

function rootNodes(json: GltfJson): number[] {
  // Returned in reverse, because the traversal pops from the end.
  const scene = json.scenes?.[json.scene ?? 0];
  if (scene) return [...(scene.nodes ?? [])].reverse();

  // No scenes: treat every node that isn't someone's child as a root.
  const nodes = json.nodes ?? [];
  const children = new Set(nodes.flatMap((node) => node.children ?? []));
  const roots: number[] = [];
  for (let i = nodes.length - 1; i >= 0; i--) {
    if (!children.has(i)) roots.push(i);
  }
  return roots;
}

function readPrimitive(
  reader: AccessorReader,
  primitive: GltfPrimitive,
  world: Mat4,
  name: string,
): MeshPart | undefined {
  const mode = primitive.mode ?? MODE_TRIANGLES;
  const positionAccessor = primitive.attributes.POSITION;
  if (
    positionAccessor === undefined ||
    (mode !== MODE_TRIANGLES && mode !== MODE_TRIANGLE_STRIP && mode !== MODE_TRIANGLE_FAN)
  ) {
    return undefined;
  }

  const local = reader.read(positionAccessor, 'VEC3');
  const vertexCount = local.length / 3;
  const positions = transformPoints(local, world);

  let sequence: ArrayLike<number>;
  if (primitive.indices !== undefined) {
    sequence = reader.read(primitive.indices, 'SCALAR');
  } else {
    const implicit = new Uint32Array(vertexCount);
    for (let i = 0; i < vertexCount; i++) implicit[i] = i;
    sequence = implicit;
  }

  const flip = determinant3(world) < 0;
  const indices = triangulate(sequence, mode, vertexCount, flip);
  return { name, positions, indices };
}

/** Converts list/strip/fan index sequences to a triangle list. */
function triangulate(
  sequence: ArrayLike<number>,
  mode: number,
  vertexCount: number,
  flipWinding: boolean,
): Uint32Array {
  const n = sequence.length;
  const maxTriangles = mode === MODE_TRIANGLES ? Math.floor(n / 3) : Math.max(0, n - 2);
  const out = new Uint32Array(maxTriangles * 3);
  let count = 0;

  const emit = (a: number, b: number, c: number) => {
    if (a >= vertexCount || b >= vertexCount || c >= vertexCount) {
      throw new GlbError('A mesh in this model refers to a vertex that doesn’t exist.');
    }
    if (a === b || b === c || a === c) return;
    out[count++] = a;
    out[count++] = flipWinding ? c : b;
    out[count++] = flipWinding ? b : c;
  };

  const at = (i: number) => sequence[i] as number;

  if (mode === MODE_TRIANGLES) {
    for (let i = 0; i + 2 < n; i += 3) emit(at(i), at(i + 1), at(i + 2));
  } else if (mode === MODE_TRIANGLE_STRIP) {
    for (let i = 0; i + 2 < n; i++) {
      if (i % 2 === 0) emit(at(i), at(i + 1), at(i + 2));
      else emit(at(i + 1), at(i), at(i + 2));
    }
  } else {
    for (let i = 1; i + 1 < n; i++) emit(at(i), at(i + 1), at(0));
  }

  return out.slice(0, count);
}

class AccessorReader {
  readonly #json: GltfJson;
  readonly #bin: Uint8Array | undefined;
  readonly #buffers = new Map<number, Uint8Array>();

  constructor(json: GltfJson, bin: Uint8Array | undefined) {
    this.#json = json;
    this.#bin = bin;
  }

  /** Reads an accessor as doubles, applying sparse data and normalization. */
  read(index: number, expectedType: 'SCALAR' | 'VEC3'): Float64Array {
    const accessor = this.#json.accessors?.[index];
    if (!accessor)
      throw new GlbError(`The model refers to accessor ${index}, which doesn't exist.`);
    if (accessor.type !== expectedType) {
      throw new GlbError(`Accessor ${index} is ${accessor.type}, expected ${expectedType}.`);
    }

    const components = TYPE_COMPONENTS[accessor.type] ?? 0;
    const componentBytes = COMPONENT_BYTES[accessor.componentType];
    if (!componentBytes || !Number.isInteger(accessor.count) || accessor.count < 0) {
      throw new GlbError(`Accessor ${index} has an unsupported layout.`);
    }

    const out = new Float64Array(accessor.count * components);

    if (accessor.bufferView !== undefined) {
      const { bytes, byteStride } = this.#bufferView(accessor.bufferView);
      const elementBytes = components * componentBytes;
      const step = byteStride || elementBytes;
      const base = accessor.byteOffset ?? 0;
      readComponents(
        bytes,
        base,
        step,
        accessor.count,
        components,
        accessor.componentType,
        out,
        `Accessor ${index}`,
      );
    }

    if (accessor.sparse && accessor.sparse.count > 0) {
      this.#applySparse(accessor, components, out, index);
    }

    if (accessor.normalized) normalize(out, accessor.componentType);
    return out;
  }

  #applySparse(accessor: GltfAccessor, components: number, out: Float64Array, index: number) {
    const sparse = accessor.sparse;
    if (!sparse) return;
    const label = `Sparse data in accessor ${index}`;

    const targets = new Float64Array(sparse.count);
    const indexView = this.#bufferView(sparse.indices.bufferView);
    const indexBytes = COMPONENT_BYTES[sparse.indices.componentType] ?? 0;
    readComponents(
      indexView.bytes,
      sparse.indices.byteOffset ?? 0,
      indexBytes,
      sparse.count,
      1,
      sparse.indices.componentType,
      targets,
      label,
    );

    const values = new Float64Array(sparse.count * components);
    const valueView = this.#bufferView(sparse.values.bufferView);
    const valueBytes = components * (COMPONENT_BYTES[accessor.componentType] ?? 0);
    readComponents(
      valueView.bytes,
      sparse.values.byteOffset ?? 0,
      valueBytes,
      sparse.count,
      components,
      accessor.componentType,
      values,
      label,
    );

    for (let i = 0; i < sparse.count; i++) {
      const target = targets[i] as number;
      if (target >= accessor.count) throw new GlbError(`${label} points past the end.`);
      out.set(values.subarray(i * components, (i + 1) * components), target * components);
    }
  }

  #bufferView(index: number): { bytes: Uint8Array; byteStride: number } {
    const view = this.#json.bufferViews?.[index];
    if (!view) throw new GlbError(`The model refers to buffer view ${index}, which doesn't exist.`);
    const buffer = this.#buffer(view.buffer);
    const start = view.byteOffset ?? 0;
    if (start + view.byteLength > buffer.byteLength) {
      throw new GlbError(`Buffer view ${index} reads past the end of its buffer.`);
    }
    return {
      bytes: buffer.subarray(start, start + view.byteLength),
      byteStride: view.byteStride ?? 0,
    };
  }

  #buffer(index: number): Uint8Array {
    const cached = this.#buffers.get(index);
    if (cached) return cached;

    const buffer = this.#json.buffers?.[index];
    if (!buffer) throw new GlbError(`The model refers to buffer ${index}, which doesn't exist.`);

    let bytes: Uint8Array;
    if (buffer.uri === undefined) {
      if (index !== 0 || !this.#bin) {
        throw new GlbError('The GLB file is missing its binary data chunk.');
      }
      bytes = this.#bin;
    } else if (buffer.uri.startsWith('data:')) {
      bytes = decodeDataUri(buffer.uri);
    } else {
      throw new GlbError(
        `This model loads geometry from a separate file (${buffer.uri}). Export a self-contained .glb instead.`,
      );
    }

    this.#buffers.set(index, bytes);
    return bytes;
  }
}

function readComponents(
  bytes: Uint8Array,
  base: number,
  step: number,
  count: number,
  components: number,
  componentType: number,
  out: Float64Array,
  label: string,
): void {
  if (count === 0) return;
  const componentBytes = COMPONENT_BYTES[componentType];
  if (!componentBytes) throw new GlbError(`${label} has an unsupported component type.`);
  const end = base + (count - 1) * step + components * componentBytes;
  if (end > bytes.byteLength) throw new GlbError(`${label} reads past the end of its data.`);

  // Fast path: tightly packed floats at a 4-byte aligned offset.
  const absolute = bytes.byteOffset + base;
  if (componentType === 5126 && step === components * 4 && absolute % 4 === 0) {
    out.set(new Float32Array(bytes.buffer, absolute, count * components));
    return;
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = 0;
  for (let i = 0; i < count; i++) {
    let at = base + i * step;
    for (let c = 0; c < components; c++) {
      out[o++] = readComponent(view, at, componentType);
      at += componentBytes;
    }
  }
}

function readComponent(view: DataView, offset: number, componentType: number): number {
  switch (componentType) {
    case 5120:
      return view.getInt8(offset);
    case 5121:
      return view.getUint8(offset);
    case 5122:
      return view.getInt16(offset, true);
    case 5123:
      return view.getUint16(offset, true);
    case 5125:
      return view.getUint32(offset, true);
    default:
      return view.getFloat32(offset, true);
  }
}

function normalize(values: Float64Array, componentType: number): void {
  const divisor = { 5120: 127, 5121: 255, 5122: 32767, 5123: 65535 }[componentType];
  if (!divisor) return;
  for (let i = 0; i < values.length; i++) {
    values[i] = Math.max((values[i] as number) / divisor, -1);
  }
}

function decodeDataUri(uri: string): Uint8Array {
  const comma = uri.indexOf(',');
  if (comma < 0 || !uri.slice(0, comma).endsWith(';base64')) {
    throw new GlbError('The model embeds data in a format that isn’t supported.');
  }
  const binary = atob(uri.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// --- 4x4 column-major matrices -------------------------------------------

type Mat4 = Float64Array;

const IDENTITY: Mat4 = new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

function localMatrix(node: GltfNode): Mat4 {
  if (node.matrix?.length === 16) return new Float64Array(node.matrix);

  const [tx = 0, ty = 0, tz = 0] = node.translation ?? [];
  const [x = 0, y = 0, z = 0, w = 1] = node.rotation ?? [];
  const [sx = 1, sy = 1, sz = 1] = node.scale ?? [];

  const xx = x * x;
  const yy = y * y;
  const zz = z * z;
  const xy = x * y;
  const xz = x * z;
  const yz = y * z;
  const wx = w * x;
  const wy = w * y;
  const wz = w * z;

  return new Float64Array([
    (1 - 2 * (yy + zz)) * sx,
    2 * (xy + wz) * sx,
    2 * (xz - wy) * sx,
    0,
    2 * (xy - wz) * sy,
    (1 - 2 * (xx + zz)) * sy,
    2 * (yz + wx) * sy,
    0,
    2 * (xz + wy) * sz,
    2 * (yz - wx) * sz,
    (1 - 2 * (xx + yy)) * sz,
    0,
    tx,
    ty,
    tz,
    1,
  ]);
}

function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Float64Array(16);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) {
        sum += (a[k * 4 + row] as number) * (b[col * 4 + k] as number);
      }
      out[col * 4 + row] = sum;
    }
  }
  return out;
}

function determinant3(m: Mat4): number {
  const [a = 0, b = 0, c = 0, , d = 0, e = 0, f = 0, , g = 0, h = 0, i = 0] = m;
  return a * (e * i - f * h) - d * (b * i - c * h) + g * (b * f - c * e);
}

function transformPoints(points: Float64Array, m: Mat4): Float64Array {
  const [
    m0 = 0,
    m1 = 0,
    m2 = 0,
    ,
    m4 = 0,
    m5 = 0,
    m6 = 0,
    ,
    m8 = 0,
    m9 = 0,
    m10 = 0,
    ,
    m12 = 0,
    m13 = 0,
    m14 = 0,
  ] = m;
  const out = new Float64Array(points.length);
  for (let i = 0; i < points.length; i += 3) {
    const x = points[i] as number;
    const y = points[i + 1] as number;
    const z = points[i + 2] as number;
    const wx = m0 * x + m4 * y + m8 * z + m12;
    const wy = m1 * x + m5 * y + m9 * z + m13;
    const wz = m2 * x + m6 * y + m10 * z + m14;
    if (!Number.isFinite(wx) || !Number.isFinite(wy) || !Number.isFinite(wz)) {
      throw new GlbError('The model contains invalid coordinates (NaN or infinity).');
    }
    out[i] = wx;
    out[i + 1] = wy;
    out[i + 2] = wz;
  }
  return out;
}
