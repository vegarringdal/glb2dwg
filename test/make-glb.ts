/** Builds small GLB files in memory for tests. */

export interface TestMesh {
  positions: number[];
  indices?: number[];
  /** 5121 UNSIGNED_BYTE, 5123 UNSIGNED_SHORT (default) or 5125 UNSIGNED_INT. */
  indexType?: 5121 | 5123 | 5125;
  mode?: number;
  /** Store positions with a 16-byte stride (4 filler bytes per vertex). */
  interleaved?: boolean;
}

export interface TestNode {
  name?: string;
  mesh?: number;
  children?: number[];
  translation?: number[];
  rotation?: number[];
  scale?: number[];
  matrix?: number[];
}

export interface TestGltf {
  meshes: TestMesh[];
  nodes: TestNode[];
  /** Root nodes of the default scene. Defaults to [0]. */
  roots?: number[];
  extensionsRequired?: string[];
}

export function makeGlb(gltf: TestGltf): ArrayBuffer {
  const bin: number[] = [];
  const bufferViews: object[] = [];
  const accessors: object[] = [];
  const meshes: object[] = [];

  const pad4 = () => {
    while (bin.length % 4 !== 0) bin.push(0);
  };
  const pushBytes = (bytes: Uint8Array) => {
    for (const byte of bytes) bin.push(byte);
  };

  for (const mesh of gltf.meshes) {
    pad4();
    const count = mesh.positions.length / 3;
    const stride = mesh.interleaved ? 16 : 12;
    const positionBytes = new Uint8Array(count * stride);
    const view = new DataView(positionBytes.buffer);
    for (let i = 0; i < count; i++) {
      for (let c = 0; c < 3; c++) {
        view.setFloat32(i * stride + c * 4, mesh.positions[i * 3 + c] as number, true);
      }
      if (mesh.interleaved) view.setUint32(i * stride + 12, 0xdeadbeef, true);
    }
    bufferViews.push({
      buffer: 0,
      byteOffset: bin.length,
      byteLength: positionBytes.length,
      ...(mesh.interleaved ? { byteStride: stride } : {}),
    });
    pushBytes(positionBytes);
    const attributes = { POSITION: accessors.length };
    accessors.push({
      bufferView: bufferViews.length - 1,
      componentType: 5126,
      count,
      type: 'VEC3',
    });

    const primitive: Record<string, unknown> = { attributes };
    if (mesh.mode !== undefined) primitive.mode = mesh.mode;

    if (mesh.indices) {
      pad4();
      const type = mesh.indexType ?? 5123;
      const size = type === 5121 ? 1 : type === 5123 ? 2 : 4;
      const indexBytes = new Uint8Array(mesh.indices.length * size);
      const indexView = new DataView(indexBytes.buffer);
      mesh.indices.forEach((value, i) => {
        if (size === 1) indexView.setUint8(i, value);
        else if (size === 2) indexView.setUint16(i * 2, value, true);
        else indexView.setUint32(i * 4, value, true);
      });
      bufferViews.push({ buffer: 0, byteOffset: bin.length, byteLength: indexBytes.length });
      pushBytes(indexBytes);
      primitive.indices = accessors.length;
      accessors.push({
        bufferView: bufferViews.length - 1,
        componentType: type,
        count: mesh.indices.length,
        type: 'SCALAR',
      });
    }

    meshes.push({ primitives: [primitive] });
  }
  pad4();

  const json = {
    asset: { version: '2.0' },
    ...(gltf.extensionsRequired ? { extensionsRequired: gltf.extensionsRequired } : {}),
    scene: 0,
    scenes: [{ nodes: gltf.roots ?? [0] }],
    nodes: gltf.nodes,
    meshes,
    accessors,
    bufferViews,
    buffers: [{ byteLength: bin.length }],
  };

  let jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonPadding = (4 - (jsonBytes.length % 4)) % 4;
  if (jsonPadding) {
    const padded = new Uint8Array(jsonBytes.length + jsonPadding).fill(0x20);
    padded.set(jsonBytes);
    jsonBytes = padded;
  }

  const total = 12 + 8 + jsonBytes.length + 8 + bin.length;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonBytes.length, true);
  view.setUint32(16, 0x4e4f534a, true);
  out.set(jsonBytes, 20);
  const binStart = 20 + jsonBytes.length;
  view.setUint32(binStart, bin.length, true);
  view.setUint32(binStart + 4, 0x004e4942, true);
  out.set(bin, binStart + 8);
  return out.buffer;
}

/**
 * Rounds coordinates the way a GLB does: positions are stored as 32-bit
 * floats, so expected values have to pass through the same narrowing before
 * they can be compared with what comes back out of a converted file.
 */
export function asStoredInGlb(positions: ArrayLike<number>): Float64Array {
  return Float64Array.from(positions, Math.fround);
}

/** A unit cube: 8 vertices, 12 triangles. */
export const CUBE: TestMesh = {
  positions: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1],
  indices: [
    0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0,
    4, 3, 4, 7,
  ],
};
