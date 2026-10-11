import assert from 'node:assert/strict'
import { test } from 'node:test'
import { solveCollisionConstraints } from './solveCollisionConstraints'
import { buildTriangleBVH } from './triangleBVH'
import type { ClothSimMesh, MeshSurfaceColliderSnapshot } from '../types'

function collider(bvh: boolean): MeshSurfaceColliderSnapshot {
  // The triangle occupies only half its large AABB. A point in the other half
  // must not be treated as penetrating merely because it is behind the plane.
  const vertices = new Float32Array([0, 0, 0, 0, 0, 2, 2, 0, 0])
  const indices = new Uint32Array([0, 1, 2])
  return {
    kind: 'mesh', id: 'large-triangle', vertices, indices,
    triangleNormals: new Float32Array([0, 1, 0]),
    cellSize: 4, cellKeys: new Int32Array([0]), cellStarts: new Uint32Array([0]),
    cellCounts: new Uint32Array([1]), cellTriangleIndices: new Uint32Array([0]),
    cellIndexLookup: new Map([[0, 0]]), triangleVisitMarks: new Uint32Array(1), triangleVisitStamp: 0,
    bounds: { minX: 0, minY: 0, minZ: 0, maxX: 2, maxY: 0, maxZ: 2 },
    skin: .02, thickness: .01, friction: 0,
    ...(bvh ? { bvh: buildTriangleBVH(vertices, indices) } : {}),
  } as MeshSurfaceColliderSnapshot
}
function resolve(bvh: boolean, point: number[], previous = point) {
  const mesh = {
    particleCount: 1, positions: new Float32Array(point), prevPositions: new Float32Array(previous),
    invMass: new Float32Array([1]), triangles: new Uint32Array(),
  } as ClothSimMesh
  solveCollisionConstraints(mesh, { version: 1, proxies: [], meshColliders: [collider(bvh)] })
  return [...mesh.positions]
}
for (const bvh of [false, true]) {
  const name = bvh ? 'BVH' : 'grid'
  test(`${name}: rejects a distant backside triangle inside its broad-phase AABB`, () => {
    const point = [1.8, -.01, 1.8]
    assert.deepEqual(resolve(bvh, point), [...new Float32Array(point)])
  })
  test(`${name}: resolves genuine near-surface contact from either side`, () => {
    for (const y of [-.01, 0, .01]) {
      const point = resolve(bvh, [.2, y, .2])
      assert.ok(Math.abs(point[1] - .03) < 1e-6, `${y}: ${point}`)
      assert.ok(Math.abs(point[0] - .2) < 1e-6 && Math.abs(point[2] - .2) < 1e-6)
    }
  })
  test(`${name}: preserves swept recovery far beyond the discrete contact band`, () => {
    const point = resolve(bvh, [.2, -.3, .2], [.2, .3, .2])
    assert.ok(Math.abs(point[1] - .03) < 1e-6)
  })
  test(`${name}: does not clamp an outside near-miss sweep to the triangle plane`, () => {
    const point = [1.8, -.3, 1.8]
    assert.deepEqual(resolve(bvh, point, [1.8, .3, 1.8]), [...new Float32Array(point)])
  })
}
