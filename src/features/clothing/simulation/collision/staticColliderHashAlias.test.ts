import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three/webgpu'
import { buildAvatarMeshColliderSnapshotFromSkinnedMeshes } from '../../avatar-collision/buildAvatarMeshCollider'
import { solveCollisionConstraints } from './solveCollisionConstraints'
import type { ClothSimMesh } from '../types'

/** Actual mirrored-cell collision seen at a fitted tee cuff, reduced to triangles. */
test('static avatar collider rejects distant aliased cells and still resolves local penetration', () => {
  const hash = (x: number, y: number, z: number) => ((x * 73856093) ^ (y * 19349663) ^ (z * 83492791)) | 0
  assert.equal(hash(-9, 29, 1), hash(9, 29, -1))
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([
    // Opposite-arm triangle, normal +X, occupies aliased cell [9,29,-1].
    .82, 2.62, -.03, .82, 2.69, -.03, .82, 2.65, -.005,
    // True nearby arm surface, outward normal +Z.
    -.83, 2.60, -.02, -.75, 2.60, -.02, -.79, 2.70, -.02,
    // Body extent keeps the outside cuff point within the global AABB.
    -1, 2.4, .4, -1.1, 2.4, .4, -1, 2.8, .4,
  ], 3))
  geometry.setIndex([0, 1, 2, 3, 4, 5, 6, 7, 8])
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Uint16Array(36), 4))
  const weights = new Float32Array(36); for (let i = 0; i < 9; i++) weights[i * 4] = 1
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(weights, 4))
  const bone = new THREE.Bone(), avatar = new THREE.SkinnedMesh(geometry, new THREE.MeshBasicMaterial())
  avatar.add(bone); avatar.bind(new THREE.Skeleton([bone])); avatar.updateMatrixWorld(true); avatar.skeleton.update()
  const collider = buildAvatarMeshColliderSnapshotFromSkinnedMeshes([avatar], { skinOffset: .006, garmentThickness: .004 })!
  const particle = (x: number, y: number, z: number): ClothSimMesh => ({
    particleCount: 1, positions: new Float32Array([x, y, z]), prevPositions: new Float32Array([x, y, z]), velocities: new Float32Array(3), invMass: new Float32Array([1]),
    panelIds: ['test'], particleFrictions: new Float32Array([0]), panelUvs: new Float32Array(2), panelLocalPositions: new Float32Array(2), triangles: new Uint32Array(),
    stretchConstraints: [], shearConstraints: [], bendDistanceConstraints: [], bendConstraints: [], seamConstraints: [], pinConstraints: [],
  })
  const snapshot = { version: 1, proxies: [], meshColliders: [collider] }
  const exterior = particle(-.78987998, 2.62404084, .18196939), before = Array.from(exterior.positions)
  solveCollisionConstraints(exterior, snapshot)
  assert.deepEqual(Array.from(exterior.positions), before, 'outside cuff must not be projected by the opposite arm')
  const interior = particle(-.79, 2.64, -.025)
  solveCollisionConstraints(interior, snapshot)
  assert.ok(Math.abs(interior.positions[2] - -.01) < 1e-5, 'nearby penetration reaches the .01 clearance surface')
  geometry.dispose(); (avatar.material as THREE.Material).dispose()
})
