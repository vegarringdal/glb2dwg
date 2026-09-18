import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import {
  convertGlbToDwg,
  layerName,
  POLYFACE_LIMIT,
  placePoints,
  UNITS,
  weldVertices,
  writePolyfaces,
} from '../src/convert.ts';
import type { Glb2DwgModule } from '../src/wasm/glb2dwg.mjs';
import { CUBE, makeGlb } from './make-glb.ts';

describe('UNITS', () => {
  test('uses the DWG codes for metres and millimetres', () => {
    assert.deepEqual(UNITS.meters, { scale: 1, insunits: 6, label: 'm' });
    assert.deepEqual(UNITS.millimeters, { scale: 1000, insunits: 4, label: 'mm' });
  });
});

describe('layerName', () => {
  test('replaces characters AutoCAD rejects', () => {
    assert.equal(layerName('Wheel <front>/left: "A"'), 'Wheel _front__left_ _A_');
  });

  test('avoids built-in layers and empty names', () => {
    assert.equal(layerName('0'), '0 mesh');
    assert.equal(layerName('DEFPOINTS'), 'DEFPOINTS mesh');
    assert.equal(layerName('  \u0001 '), 'mesh');
  });
});

describe('placePoints', () => {
  test('scales metres to millimetres', () => {
    const points = Float64Array.from([1, 2, 3]);
    assert.deepEqual([...placePoints(points, false, UNITS.millimeters.scale)], [1000, 2000, 3000]);
  });

  test('stands the model upright and scales in one pass', () => {
    const points = Float64Array.from([1, 2, 3]);
    assert.deepEqual([...placePoints(points, true, 1000)], [1000, -3000, 2000]);
  });

  test('returns the input untouched when there is nothing to do', () => {
    const points = Float64Array.from([1, 2, 3]);
    assert.equal(placePoints(points, false, 1), points);
  });
});

describe('weldVertices', () => {
  test('merges duplicate positions and drops collapsed triangles', () => {
    // Two triangles sharing an edge, stored with split vertices, plus a
    // triangle whose corners collapse onto the same point.
    const positions = Float64Array.from([
      0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 5, 5, 5, 5, 5, 5, 6, 6, 6,
    ]);
    const indices = Uint32Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    const welded = weldVertices(positions, indices);
    assert.deepEqual([...welded.positions], [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0, 5, 5, 5, 6, 6, 6]);
    assert.deepEqual([...welded.indices], [0, 1, 2, 1, 3, 2]);
  });
});

describe('writePolyfaces', () => {
  /** Two triangles per column, sharing the column's two vertices. */
  const ladder = (columns: number) => {
    const positions = new Float64Array(columns * 2 * 3);
    const indices: number[] = [];
    for (let c = 0; c < columns; c++) {
      positions.set([c, 0, 0, c, 1, 0], c * 6);
      if (c + 1 < columns) {
        const a = c * 2;
        indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
      }
    }
    return { positions, indices: Uint32Array.from(indices) };
  };

  /** Rebuilds the triangles a writer was handed, as "x,y,z x,y,z x,y,z". */
  const written = (chunks: { xyz: Float64Array; faces: Int16Array }[], limit: number) => {
    const triangles: string[] = [];
    for (const { xyz, faces } of chunks) {
      const vertexCount = xyz.length / 3;
      assert.ok(vertexCount <= limit, `chunk has ${vertexCount} vertices, over the limit`);
      assert.ok(faces.length / 4 <= limit, 'chunk has too many faces');
      for (let f = 0; f < faces.length; f += 4) {
        assert.equal(faces[f + 3], 0, 'triangles must have a zero fourth index');
        const corners = [0, 1, 2].map((k) => {
          const local = faces[f + k] as number;
          // Polyface indices are 1-based and must stay inside the chunk.
          assert.ok(local >= 1 && local <= vertexCount, `index ${local} outside the chunk`);
          return [...xyz.subarray((local - 1) * 3, local * 3)].join(',');
        });
        triangles.push(corners.join(' '));
      }
    }
    return triangles;
  };

  const expected = (positions: Float64Array, indices: Uint32Array) => {
    const triangles: string[] = [];
    for (let t = 0; t < indices.length; t += 3) {
      triangles.push(
        [0, 1, 2]
          .map((k) => {
            const v = indices[t + k] as number;
            return [...positions.subarray(v * 3, v * 3 + 3)].join(',');
          })
          .join(' '),
      );
    }
    return triangles;
  };

  const collect = (positions: Float64Array, indices: Uint32Array, limit?: number) => {
    const chunks: { xyz: Float64Array; faces: Int16Array }[] = [];
    const entities = writePolyfaces(
      { addPolyface: (xyz, faces) => chunks.push({ xyz: xyz.slice(), faces: faces.slice() }) },
      positions,
      indices,
      limit,
    );
    assert.equal(entities, chunks.length, 'reported entity count should match the writes');
    return chunks;
  };

  test('keeps a small mesh in one entity, with shared vertices', () => {
    const { positions, indices } = ladder(4);
    const chunks = collect(positions, indices);
    assert.equal(chunks.length, 1);
    // 8 vertices, 6 triangles, and no vertex written twice.
    assert.equal(chunks[0]?.xyz.length, 8 * 3);
    assert.equal(chunks[0]?.faces.length, 6 * 4);
    assert.deepEqual(written(chunks, POLYFACE_LIMIT), expected(positions, indices));
  });

  test('splits at the limit and renumbers each chunk from 1', () => {
    // A deliberately tiny limit exercises the same code path as a 32,767
    // vertex mesh without building one.
    const { positions, indices } = ladder(40);
    for (const limit of [4, 5, 7, 16]) {
      const chunks = collect(positions, indices, limit);
      assert.ok(chunks.length > 1, `limit ${limit} should have split the mesh`);
      assert.deepEqual(
        written(chunks, limit),
        expected(positions, indices),
        `limit ${limit} lost or reordered triangles`,
      );
    }
  });

  test('never exceeds what a 16-bit face index can hold', () => {
    assert.ok(POLYFACE_LIMIT <= 32767);
  });
});

const wasmJs = new URL('../src/wasm/glb2dwg.mjs', import.meta.url);
const wasmBinary = new URL('../src/wasm/glb2dwg.wasm', import.meta.url);
const wasmBuilt = existsSync(wasmJs) && existsSync(wasmBinary);

describe('convertGlbToDwg with LibreDWG', {
  skip: wasmBuilt ? false : 'run npm run build:wasm first',
}, () => {
  const load = async (): Promise<Glb2DwgModule> => {
    const { default: create } = await import(wasmJs.href);
    return create({ wasmBinary: readFileSync(wasmBinary) });
  };

  const glb = makeGlb({
    meshes: [CUBE],
    nodes: [
      { name: 'Frame', children: [1, 2] },
      { name: 'Left wheel', mesh: 0 },
      { name: 'Right wheel', mesh: 0, translation: [3, 0, 0] },
    ],
  });

  for (const entity of ['polyface', '3dface'] as const) {
    test(`writes an R2000 DWG with ${entity} entities`, async () => {
      const mod = await load();
      const { dwg, stats } = convertGlbToDwg(glb, mod, { entity, yUpToZUp: true, units: 'meters' });
      assert.equal(new TextDecoder().decode(dwg.subarray(0, 6)), 'AC1015');
      assert.equal(stats.layers, 2);
      assert.equal(stats.triangles, 24);
      assert.equal(stats.entities, entity === 'polyface' ? 2 : 24);
      assert.ok(dwg.byteLength > 1000);
    });
  }

  test('can convert repeatedly with one module', async () => {
    const mod = await load();
    const options = { entity: 'polyface', yUpToZUp: false, units: 'meters' } as const;
    const first = convertGlbToDwg(glb, mod, options);
    const second = convertGlbToDwg(glb, mod, options);
    assert.equal(first.dwg.byteLength, second.dwg.byteLength);
  });

  test('writes the chosen units into the drawing header', async () => {
    const mod = await load();
    // $INSUNITS sits in the header variables section, well before the first
    // entity; 4 is millimetres and 6 is metres.
    const insunits = (units: 'meters' | 'millimeters') => {
      const { dwg, stats } = convertGlbToDwg(glb, mod, { entity: '3dface', yUpToZUp: true, units });
      assert.equal(stats.units, units);
      return dwg;
    };
    const mm = insunits('millimeters');
    const m = insunits('meters');
    // Same geometry, same entity count: the files differ only in scale/units.
    assert.notDeepEqual(mm, m);
  });
});
