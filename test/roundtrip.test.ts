/**
 * End-to-end checks: build a GLB, convert it, then hand the bytes back to
 * LibreDWG's decoder and compare what comes out against the source geometry.
 *
 * These are the tests that answer "is it really writing correct 3D DWG
 * files?", because nothing here trusts the writer's own account of its work.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  type ConvertOptions,
  convertGlbToDwg,
  type EntityKind,
  placePoints,
  UNITS,
} from '../src/convert.ts';
import {
  expectedKeys,
  loadReader,
  R_2000,
  readDwg,
  readerBuilt,
  triangleKey,
} from './dwg-reader.ts';
import { asStoredInGlb, CUBE, makeGlb, type TestGltf } from './make-glb.ts';

const skip = readerBuilt ? false : 'run npm run build:wasm first';

const ENTITY_KINDS: EntityKind[] = ['polyface', '3dface'];

const convert = async (gltf: TestGltf, options: Partial<ConvertOptions> = {}) => {
  const mod = await loadReader();
  const full: ConvertOptions = {
    entity: '3dface',
    yUpToZUp: true,
    units: 'millimeters',
    ...options,
  };
  const { dwg, stats } = convertGlbToDwg(makeGlb(gltf), mod, full);
  return { drawing: readDwg(mod, dwg), stats, bytes: dwg.byteLength };
};

/** The cube's triangles, as the converter should have placed them. */
const placedCube = (options: Partial<ConvertOptions> = {}) => {
  const scale = UNITS[options.units ?? 'millimeters'].scale;
  const positions = placePoints(asStoredInGlb(CUBE.positions), options.yUpToZUp ?? true, scale);
  return expectedKeys(positions, Uint32Array.from(CUBE.indices ?? []));
};

// Serial: the module holds one drawing at a time, and each conversion needs
// room for the geometry twice over (written, then read back).
describe('DWG round trip', { skip, concurrency: 1 }, () => {
  for (const entity of ENTITY_KINDS) {
    test(`${entity}: every triangle survives with its coordinates and winding`, async () => {
      const { drawing, stats } = await convert(
        { meshes: [CUBE], nodes: [{ name: 'Cube', mesh: 0 }] },
        { entity },
      );

      assert.equal(drawing.version, R_2000, 'not an R2000 drawing');
      assert.equal(drawing.triangles.length, 12);
      assert.equal(stats.triangles, 12);
      assert.deepEqual(
        drawing.triangles.map((t) => triangleKey(t.corners)).sort(),
        placedCube({ entity }).sort(),
      );
    });

    test(`${entity}: geometry is three-dimensional, not flattened`, async () => {
      const { drawing } = await convert({ meshes: [CUBE], nodes: [{ mesh: 0 }] }, { entity });
      const zs = drawing.triangles.flatMap((t) => [t.corners[2], t.corners[5], t.corners[8]]);
      assert.ok(Math.max(...(zs as number[])) - Math.min(...(zs as number[])) > 0, 'all Z equal');
      // The cube is 1 m on each side, so in millimetres it spans 1000.
      for (const axis of [0, 1, 2]) {
        const values = drawing.triangles.flatMap((t) => [
          t.corners[axis],
          t.corners[axis + 3],
          t.corners[axis + 6],
        ]) as number[];
        assert.equal(Math.max(...values) - Math.min(...values), 1000, `axis ${axis} span`);
      }
    });

    test(`${entity}: each mesh lands on its own layer`, async () => {
      const { drawing, stats } = await convert(
        {
          meshes: [CUBE],
          nodes: [
            { name: 'Frame', children: [1, 2] },
            { name: 'Left wheel', mesh: 0 },
            { name: 'Right wheel', mesh: 0, translation: [3, 0, 0] },
          ],
        },
        { entity },
      );

      assert.equal(stats.layers, 2);
      // Layer "0" always exists in a DWG, alongside the two we added.
      assert.deepEqual(drawing.layers, ['0', 'Left wheel', 'Right wheel']);
      assert.equal(drawing.triangles.length, 24);

      const perLayer = new Map<string, number>();
      for (const triangle of drawing.triangles) {
        const name = triangle.layer ?? '(none)';
        perLayer.set(name, (perLayer.get(name) ?? 0) + 1);
      }
      assert.deepEqual([...perLayer.entries()].sort(), [
        ['Left wheel', 12],
        ['Right wheel', 12],
      ]);

      // The right wheel is translated 3 m along X, which is 3000 mm.
      const xOf = (layer: string) =>
        Math.min(
          ...drawing.triangles
            .filter((t) => t.layer === layer)
            .flatMap((t) => [t.corners[0], t.corners[3], t.corners[6]] as number[]),
        );
      assert.equal(xOf('Right wheel') - xOf('Left wheel'), 3000);
    });
  }

  for (const entity of ENTITY_KINDS) {
    test(`${entity}: entities are linked the way AutoCAD writes them`, async () => {
      // Without these links a reader desynchronises and refuses the file, and
      // whether it does so depends on the bitstream, so small test models can
      // pass while real ones fail. Check every scene size.
      const scenes: [string, TestGltf][] = [
        ['one mesh', { meshes: [CUBE], nodes: [{ name: 'Cube', mesh: 0 }] }],
        [
          'three meshes',
          {
            meshes: [CUBE],
            nodes: [
              { name: 'A', mesh: 0 },
              { name: 'B', mesh: 0, translation: [2, 0, 0] },
              { name: 'C', mesh: 0, translation: [4, 0, 0] },
            ],
            roots: [0, 1, 2],
          },
        ],
        [
          'one triangle',
          {
            meshes: [{ positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2] }],
            nodes: [{ name: 'T', mesh: 0 }],
          },
        ],
      ];

      for (const [label, scene] of scenes) {
        const { drawing } = await convert(scene, { entity });
        assert.equal(drawing.chainErrors, 0, `${label} has broken entity links`);
      }
    });
  }

  test('both entity kinds describe exactly the same triangles', async () => {
    const scene: TestGltf = { meshes: [CUBE], nodes: [{ name: 'Cube', mesh: 0 }] };
    const asPolyface = await convert(scene, { entity: 'polyface' });
    const asFaces = await convert(scene, { entity: '3dface' });
    assert.deepEqual(
      asPolyface.drawing.triangles.map((t) => triangleKey(t.corners)).sort(),
      asFaces.drawing.triangles.map((t) => triangleKey(t.corners)).sort(),
    );
  });

  test('units set $INSUNITS and scale the geometry', async () => {
    const scene: TestGltf = { meshes: [CUBE], nodes: [{ mesh: 0 }] };

    const mm = await convert(scene, { units: 'millimeters' });
    assert.equal(mm.drawing.insunits, 4);
    assert.deepEqual(
      mm.drawing.triangles.map((t) => triangleKey(t.corners)).sort(),
      placedCube().sort(),
    );

    const m = await convert(scene, { units: 'meters' });
    assert.equal(m.drawing.insunits, 6);
    assert.deepEqual(
      m.drawing.triangles.map((t) => triangleKey(t.corners)).sort(),
      placedCube({ units: 'meters' }).sort(),
    );

    // Same shape, 1000x apart.
    const span = (drawing: typeof m.drawing) =>
      Math.max(
        ...drawing.triangles.flatMap((t) => [t.corners[0], t.corners[3], t.corners[6]] as number[]),
      );
    assert.equal(span(mm.drawing), span(m.drawing) * 1000);
  });

  test('standing the model upright maps glTF Y-up onto CAD Z-up', async () => {
    // A marker 2 m up glTF's Y axis should end up 2 m up the drawing's Z.
    const scene: TestGltf = {
      meshes: [{ positions: [0, 0, 0, 1, 0, 0, 0, 2, 0], indices: [0, 1, 2] }],
      nodes: [{ mesh: 0 }],
    };

    // Negating a zero gives -0, which is the same coordinate but not deep-equal.
    const corners = (drawing: { triangles: { corners: number[] }[] }) =>
      (drawing.triangles[0]?.corners ?? []).map((value) => value + 0 || 0);

    const upright = await convert(scene, { yUpToZUp: true, units: 'meters' });
    assert.deepEqual(corners(upright.drawing), [0, 0, 0, 1, 0, 0, 0, 0, 2]);

    const asIs = await convert(scene, { yUpToZUp: false, units: 'meters' });
    assert.deepEqual(corners(asIs.drawing), [0, 0, 0, 1, 0, 0, 0, 2, 0]);
  });

  test('drawing extents cover the geometry, ignoring unused vertices', async () => {
    // The fourth vertex is far away and referenced by no triangle.
    const scene: TestGltf = {
      meshes: [{ positions: [0, 0, 0, 1, 0, 0, 0, 0, 3, 99, 99, 99], indices: [0, 1, 2] }],
      nodes: [{ mesh: 0 }],
    };
    const { drawing } = await convert(scene, { yUpToZUp: false, units: 'meters' });
    assert.deepEqual(drawing.extents.min, [0, 0, 0]);
    assert.deepEqual(drawing.extents.max, [1, 0, 3]);
  });

  test('a mesh too big for one polyface is split without losing a triangle', async () => {
    // A ladder of quads with more vertices than a polyface can hold, so the
    // writer has to split it and renumber vertices per chunk.
    // Just over 32,767 vertices, the smallest mesh that has to be split.
    const columns = 17_000;
    const positions: number[] = [];
    const indices: number[] = [];
    for (let c = 0; c < columns; c++) {
      positions.push(c, 0, 0, c, 1, c / 1000);
      if (c + 1 < columns) {
        const a = c * 2;
        indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
      }
    }
    const scene: TestGltf = {
      meshes: [{ positions, indices }],
      nodes: [{ name: 'Ladder', mesh: 0 }],
    };

    const { drawing, stats } = await convert(scene, {
      entity: 'polyface',
      yUpToZUp: false,
      units: 'meters',
    });

    const triangleCount = indices.length / 3;
    assert.ok(stats.entities > 1, 'expected the mesh to be split');
    assert.equal(stats.triangles, triangleCount);
    assert.equal(drawing.triangles.length, triangleCount);
    assert.deepEqual(
      drawing.triangles.map((t) => triangleKey(t.corners)).sort(),
      expectedKeys(asStoredInGlb(positions), Uint32Array.from(indices)).sort(),
    );
    assert.ok(drawing.triangles.every((t) => t.layer === 'Ladder'));
  });

  test('a model with no usable geometry is refused rather than written empty', async () => {
    const mod = await loadReader();
    const glb = makeGlb({
      meshes: [{ positions: [0, 0, 0, 1, 1, 1], mode: 1 }],
      nodes: [{ mesh: 0 }],
    });
    assert.throws(
      () => convertGlbToDwg(glb, mod, { entity: '3dface', yUpToZUp: true, units: 'millimeters' }),
      /points or lines/,
    );
  });
});
