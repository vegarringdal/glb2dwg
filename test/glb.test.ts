import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { GlbError, parseGlb } from '../src/glb.ts';
import { CUBE, makeGlb } from './make-glb.ts';

const close = (actual: ArrayLike<number>, expected: number[]) => {
  assert.equal(actual.length, expected.length);
  expected.forEach((value, i) => {
    assert.ok(
      Math.abs((actual[i] as number) - value) < 1e-9,
      `index ${i}: ${actual[i]} != ${value}`,
    );
  });
};

describe('parseGlb', () => {
  test('rejects files that are not GLB', () => {
    const bytes = new TextEncoder().encode('{"asset":{"version":"2.0"}} not binary at all').buffer;
    assert.throws(() => parseGlb(bytes as ArrayBuffer), GlbError);
  });

  test('reads indexed triangles and applies node translation', () => {
    const glb = makeGlb({
      meshes: [CUBE],
      nodes: [{ name: 'Box', mesh: 0, translation: [10, 0, 0] }],
    });
    const { parts, skippedPrimitives } = parseGlb(glb);
    assert.equal(skippedPrimitives, 0);
    assert.equal(parts.length, 1);
    const [part] = parts;
    assert.equal(part?.name, 'Box');
    assert.equal(part?.indices.length, 36);
    close(part?.positions.subarray(3, 6) ?? [], [11, 0, 0]);
  });

  test('composes parent rotation with child translation', () => {
    const s = Math.SQRT1_2; // 90° about Z
    const glb = makeGlb({
      meshes: [{ positions: [1, 0, 0, 0, 1, 0, 0, 0, 1], indices: [0, 1, 2] }],
      nodes: [
        { name: 'parent', rotation: [0, 0, s, s], children: [1] },
        { mesh: 0, translation: [5, 0, 0] },
      ],
    });
    const [part] = parseGlb(glb).parts;
    // Child point (1,0,0) + (5,0,0) = (6,0,0), rotated 90° about Z = (0,6,0).
    close(part?.positions.subarray(0, 3) ?? [], [0, 6, 0]);
    assert.equal(part?.name, 'mesh 0');
  });

  test('converts triangle strips and drops degenerate triangles', () => {
    const glb = makeGlb({
      meshes: [
        {
          positions: [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0],
          indices: [0, 1, 2, 3, 3],
          mode: 5,
        },
      ],
      nodes: [{ mesh: 0 }],
    });
    const [part] = parseGlb(glb).parts;
    assert.deepEqual([...(part?.indices ?? [])], [0, 1, 2, 2, 1, 3]);
  });

  test('reads interleaved positions and byte indices', () => {
    const glb = makeGlb({
      meshes: [{ ...CUBE, interleaved: true, indexType: 5121 }],
      nodes: [{ mesh: 0 }],
    });
    const [part] = parseGlb(glb).parts;
    close(part?.positions ?? [], CUBE.positions);
    assert.deepEqual([...(part?.indices ?? [])], CUBE.indices);
  });

  test('flips winding under a mirroring transform', () => {
    const glb = makeGlb({
      meshes: [{ positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2] }],
      nodes: [{ mesh: 0, scale: [-1, 1, 1] }],
    });
    const [part] = parseGlb(glb).parts;
    assert.deepEqual([...(part?.indices ?? [])], [0, 2, 1]);
  });

  test('skips point and line primitives', () => {
    const glb = makeGlb({
      meshes: [CUBE, { positions: [0, 0, 0, 1, 1, 1], mode: 1 }],
      nodes: [{ children: [1, 2] }, { mesh: 0 }, { mesh: 1 }],
    });
    const { parts, skippedPrimitives } = parseGlb(glb);
    assert.equal(parts.length, 1);
    assert.equal(skippedPrimitives, 1);
  });

  test('explains unsupported mesh compression', () => {
    const glb = makeGlb({
      meshes: [CUBE],
      nodes: [{ mesh: 0 }],
      extensionsRequired: ['KHR_draco_mesh_compression'],
    });
    assert.throws(() => parseGlb(glb), /Draco/);
  });

  test('rejects indices that point past the vertex list', () => {
    const glb = makeGlb({
      meshes: [{ positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 7] }],
      nodes: [{ mesh: 0 }],
    });
    assert.throws(() => parseGlb(glb), GlbError);
  });
});
