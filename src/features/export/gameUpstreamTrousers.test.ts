import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createGameTrouserDocument, fitTrouserWaistPins } from './gameUpstreamTrousers'
import { compileGarmentRuntime } from '../clothing/compiler/compileGarmentRuntime'
import { resolveSeamSamples } from '../clothing/geometry/seamUtils'

test('four-panel trousers compile with waist pins and no sewn waist/ankle openings', () => {
  const document = createGameTrouserDocument()
  assert.equal(Object.keys(document.panels).length, 4)
  assert.equal(Object.keys(document.seams).length, 14)
  const result = compileGarmentRuntime(document, { quality: 'high', seamSamples: 18, renderSubdivisions: 12 })
  assert.deepEqual(result.issues.filter(issue => issue.severity === 'error'), [])
  assert.equal(result.value.simMesh.pinConstraints.length, 4)
  assert.ok(result.value.simMesh.seamConstraints.length > 0)
  assert.ok(result.value.simMesh.positions.every(Number.isFinite))
  for (const seam of Object.values(document.seams)) {
    assert.ok(!['waist', 'hem'].includes(seam.a.edgeId))
    const samples = resolveSeamSamples(document, seam, 18)!
    assert.ok(samples && samples.pointsA.length === samples.pointsB.length)
    // All paired points correspond along the leg, never ankle-to-waist.
    samples.pointsA.forEach((a, i) => assert.ok(Math.abs(a.y - samples.pointsB[i].y) < 1e-6))
  }
})


test('waist pins follow measured front/back surfaces plus contact clearance', () => {
  const document = createGameTrouserDocument()
  const mesh = compileGarmentRuntime(document, { quality: 'high', seamSamples: 18, renderSubdivisions: 12 }).value.simMesh
  const collider = {
    vertices: new Float32Array([-1,-2,.2, 1,-2,.2, 0,0,.2, -1,-2,-.1, 1,-2,-.1, 0,0,-.1]),
    indices: new Uint32Array([0,1,2,3,5,4]), bounds: {minX:-1,maxX:1,minY:-2,maxY:0,minZ:-.1,maxZ:.2}, skin:.022, thickness:.008,
  } as import('../clothing/simulation/types').MeshSurfaceColliderSnapshot
  const positions = mesh.positions.slice()
  const records = fitTrouserWaistPins(mesh, collider)
  assert.equal(records.length, 4)
  for (const record of records) {
    assert.equal(record.before[0], record.after[0])
    assert.equal(record.before[1], record.after[1])
    const expected = mesh.panelIds[record.particle].endsWith('-front') ? .23 : -.13
    assert.ok(Math.abs(record.after[2] - expected) < 1e-6)
  }
  assert.deepEqual(mesh.positions, positions, 'Attachment setup must not rewrite simulated geometry')
})
