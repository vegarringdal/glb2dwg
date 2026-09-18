// Types for glb2dwg.mjs, which Emscripten generates from native/glb2dwg.c.
// Keep in sync with the exported functions in native/build.sh.

export interface Glb2DwgModule {
  HEAPU8: Uint8Array;
  _malloc(size: number): number;
  _free(ptr: number): void;
  _g2d_begin(): number;
  _g2d_end(): void;
  _g2d_add_layer(namePtr: number, color: number): number;
  _g2d_use_layer(index: number): number;
  _g2d_set_units(insunits: number): void;
  _g2d_add_pface(xyzPtr: number, numVerts: number, facesPtr: number, numFaces: number): number;
  _g2d_add_3dfaces(xyzPtr: number, numTriangles: number): number;
  _g2d_set_extents(
    minX: number,
    minY: number,
    minZ: number,
    maxX: number,
    maxY: number,
    maxZ: number,
  ): void;
  _g2d_finish(): number;
  _g2d_output_ptr(): number;
  _g2d_output_len(): number;
}

export interface Glb2DwgModuleOptions {
  locateFile?: (path: string, scriptDirectory: string) => string;
  wasmBinary?: ArrayBuffer | Uint8Array;
  print?: (text: string) => void;
  printErr?: (text: string) => void;
}

declare function createGlb2DwgModule(options?: Glb2DwgModuleOptions): Promise<Glb2DwgModule>;
export default createGlb2DwgModule;
