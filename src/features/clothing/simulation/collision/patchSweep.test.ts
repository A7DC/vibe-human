import assert from 'node:assert/strict'
import { test } from 'node:test'
import { solveCollisionConstraints } from './solveCollisionConstraints'
import { buildTriangleBVH } from './triangleBVH'
import type { ClothSimMesh, CollisionMeshPatchSnapshot } from '../types'

function patch(bvh: boolean, reverse: boolean): CollisionMeshPatchSnapshot {
  const vertices = new Float32Array([0, 0, 0, 0, 0, 2, 2, 0, 0])
  const indices = new Uint32Array(reverse ? [0, 2, 1] : [0, 1, 2])
  return {
    id: 'thin-layer', region: 'torso', vertices, indices,
    triangleNormals: new Float32Array([0, reverse ? -1 : 1, 0]),
    cellSize: 4, cellKeys: new Int32Array([0]), cellStarts: new Uint32Array([0]),
    cellCounts: new Uint32Array([1]), cellTriangleIndices: new Uint32Array([0]),
    cellIndexLookup: new Map([[0, 0]]), triangleVisitMarks: new Uint32Array(1), triangleVisitStamp: 0,
    bounds: { minX: 0, minY: 0, minZ: 0, maxX: 2, maxY: 0, maxZ: 2 },
    skin: .02, thickness: .01, friction: 0,
    ...(bvh ? { bvh: buildTriangleBVH(vertices, indices) } : {}),
  } as CollisionMeshPatchSnapshot
}
function resolve(bvh: boolean, reverse: boolean, point: number[], previous = point, pinned = false) {
  const mesh = {
    particleCount: 1, positions: new Float32Array(point), prevPositions: new Float32Array(previous),
    invMass: new Float32Array([pinned ? 0 : 1]), triangles: new Uint32Array(),
  } as ClothSimMesh
  solveCollisionConstraints(mesh, { version: 1, proxies: [], lowResMeshPatches: [patch(bvh, reverse)] })
  return [...mesh.positions]
}
for (const bvh of [false, true]) for (const reverse of [false, true]) {
  const label = `${bvh ? 'BVH' : 'grid'} ${reverse ? 'reversed' : 'normal'} winding`
  test(`${label}: crossing stays on its starting side, even outside the contact band`, () => {
    for (const side of [-1, 1]) for (const endDistance of [.01, .3]) {
      const point = resolve(bvh, reverse, [.2, -side * endDistance, .2], [.2, side * .3, .2])
      assert.ok(Math.abs(point[1] - side * .03) < 1e-6, `side ${side}, end ${endDistance}: ${point}`)
    }
  })
  test(`${label}: stationary contacts retain their own side`, () => {
    for (const side of [-1, 1]) {
      assert.ok(Math.abs(resolve(bvh, reverse, [.2, side * .01, .2])[1] - side * .03) < 1e-6)
    }
    assert.ok(resolve(bvh, reverse, [.2, 0, .2]).every(Number.isFinite))
  })
  test(`${label}: near misses and pinned particles remain unchanged`, () => {
    const point = [1.8, -.3, 1.8]
    assert.deepEqual(resolve(bvh, reverse, point, [1.8, .3, 1.8]), [...new Float32Array(point)])
    const pinned = [.2, -.3, .2]
    assert.deepEqual(resolve(bvh, reverse, pinned, [.2, .3, .2], true), [...new Float32Array(pinned)])
  })
  test(`${label}: triangle centroid sweeps even when all vertices miss`, () => {
    const positions = new Float32Array([-1, -.3, -1, 3, -.3, -1, -1, -.3, 3])
    const prevPositions = positions.slice()
    for (let i = 1; i < prevPositions.length; i += 3) prevPositions[i] = .3
    const mesh = { particleCount: 3, positions, prevPositions, invMass: new Float32Array([1, 1, 1]), triangles: new Uint32Array([0, 1, 2]) } as ClothSimMesh
    solveCollisionConstraints(mesh, { version: 1, proxies: [], lowResMeshPatches: [patch(bvh, reverse)] })
    for (let i = 1; i < positions.length; i += 3) assert.ok(Math.abs(positions[i] - .03) < 1e-6)
  })
}
