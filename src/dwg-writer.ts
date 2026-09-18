import type { Glb2DwgModule } from './wasm/glb2dwg.mjs';

/** LibreDWG refused an operation. Not caused by the input file. */
export class DwgWriteError extends Error {
  override name = 'DwgWriteError';
}

/**
 * Typed wrapper around native/glb2dwg.c.
 *
 * Owns one open drawing at a time. Always call end(), even after an error,
 * to release the drawing's WebAssembly memory.
 */
export class DwgWriter {
  readonly #mod: Glb2DwgModule;
  /** Reusable WASM allocations, so large meshes don't malloc per chunk. */
  readonly #scratch = [
    { ptr: 0, bytes: 0 },
    { ptr: 0, bytes: 0 },
  ];

  constructor(mod: Glb2DwgModule) {
    this.#mod = mod;
  }

  begin(): void {
    if (this.#mod._g2d_begin() !== 0) {
      throw new DwgWriteError('LibreDWG could not create a new drawing.');
    }
  }

  /** Adds a layer and returns its index. Names must be unique. */
  addLayer(name: string, color: number): number {
    const encoded = new TextEncoder().encode(name);
    const ptr = this.#mod._malloc(encoded.length + 1) >>> 0;
    if (ptr === 0) throw new DwgWriteError('Out of memory while adding a layer.');
    try {
      const heap = this.#mod.HEAPU8;
      heap.set(encoded, ptr);
      heap[ptr + encoded.length] = 0;
      const index = this.#mod._g2d_add_layer(ptr, color);
      if (index < 0) throw new DwgWriteError(`LibreDWG could not add the layer “${name}”.`);
      return index;
    } finally {
      this.#mod._free(ptr);
    }
  }

  /** Selects the layer for entities added next. -1 is layer "0". */
  useLayer(index: number): void {
    if (this.#mod._g2d_use_layer(index) !== 0) {
      throw new DwgWriteError(`Layer ${index} does not exist.`);
    }
  }

  /** Sets the drawing units, as a DWG $INSUNITS code. */
  setUnits(insunits: number): void {
    this.#mod._g2d_set_units(insunits);
  }

  /**
   * Adds one polyface mesh.
   * @param xyz vertex coordinates, 3 per vertex (at most 32,767 vertices)
   * @param faces 1-based vertex indices, 4 per face, 4th is 0 for triangles
   */
  addPolyface(xyz: Float64Array, faces: Int16Array): void {
    const xyzPtr = this.#write(0, xyz);
    const facesPtr = this.#write(1, faces);
    if (this.#mod._g2d_add_pface(xyzPtr, xyz.length / 3, facesPtr, faces.length / 4) !== 0) {
      throw new DwgWriteError('LibreDWG could not add a polyface mesh.');
    }
  }

  /** Adds one 3DFACE per triangle. xyz holds 9 numbers per triangle. */
  add3dFaces(xyz: Float64Array): void {
    const xyzPtr = this.#write(0, xyz);
    if (this.#mod._g2d_add_3dfaces(xyzPtr, xyz.length / 9) !== 0) {
      throw new DwgWriteError('LibreDWG could not add 3D faces.');
    }
  }

  setExtents(min: readonly number[], max: readonly number[]): void {
    const [minX = 0, minY = 0, minZ = 0] = min;
    const [maxX = 0, maxY = 0, maxZ = 0] = max;
    this.#mod._g2d_set_extents(minX, minY, minZ, maxX, maxY, maxZ);
  }

  /** Encodes the drawing and returns a copy of the DWG bytes. */
  finish(): Uint8Array {
    const code = this.#mod._g2d_finish();
    if (code !== 0) {
      throw new DwgWriteError(
        code > 0
          ? `LibreDWG could not encode the drawing (error code ${code}).`
          : 'Ran out of memory while writing the DWG file.',
      );
    }
    const ptr = this.#mod._g2d_output_ptr() >>> 0;
    const length = this.#mod._g2d_output_len() >>> 0;
    return this.#mod.HEAPU8.slice(ptr, ptr + length);
  }

  /** Frees the drawing and scratch memory. Safe to call more than once. */
  end(): void {
    this.#mod._g2d_end();
    for (const slot of this.#scratch) {
      if (slot.ptr !== 0) this.#mod._free(slot.ptr);
      slot.ptr = 0;
      slot.bytes = 0;
    }
  }

  /** Copies data into a reusable WASM allocation and returns its address. */
  #write(slotIndex: 0 | 1, data: Float64Array | Int16Array): number {
    const slot = this.#scratch[slotIndex] as { ptr: number; bytes: number };
    if (slot.bytes < data.byteLength) {
      if (slot.ptr !== 0) this.#mod._free(slot.ptr);
      slot.ptr = this.#mod._malloc(data.byteLength) >>> 0;
      slot.bytes = slot.ptr === 0 ? 0 : data.byteLength;
      if (slot.ptr === 0) throw new DwgWriteError('Ran out of memory while writing the DWG file.');
    }
    // Read HEAPU8 after malloc: growing memory replaces the underlying buffer.
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    this.#mod.HEAPU8.set(bytes, slot.ptr);
    return slot.ptr;
  }
}
