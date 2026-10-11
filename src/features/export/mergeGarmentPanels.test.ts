import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three/webgpu'
import { mergeGarmentPanels } from './mergeGarmentPanels'

test('merging rigged drape panels preserves relative build deltas and zero unrelated jaw deltas', () => {
  const panel = (x: number) => {
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([x, 2.4, .2, x + .1, 2.4, .2, x, 2.5, .2], 3)); geometry.setIndex([0, 1, 2])
    geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Uint16Array(12), 4))
    geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute([1,0,0,0, 1,0,0,0, 1,0,0,0], 4))
    geometry.morphTargetsRelative = true
    geometry.morphAttributes.position = [new THREE.Float32BufferAttribute(new Float32Array(9), 3), new THREE.Float32BufferAttribute([.02,0,.04, .02,0,.04, .02,0,.04], 3)]
    return geometry
  }
  const inputs = [panel(-.2), panel(.1)], merged = mergeGarmentPanels(inputs)
  assert.equal(merged.morphTargetsRelative, true, 'GLTF must not subtract the ~2.5-high base from relative deltas')
  const p = merged.getAttribute('position'), jaw = merged.morphAttributes.position![0], build = merged.morphAttributes.position![1]
  for (let i = 0; i < p.count; i++) {
    assert.equal(jaw.getY(i), 0)
    assert.equal(p.getY(i) + build.getY(i), p.getY(i))
    assert.ok(Math.abs(build.getZ(i) - .04) < 1e-6)
    assert.equal(merged.getAttribute('skinWeight').getX(i), 1)
  }
  inputs.forEach(geometry => geometry.dispose()); merged.dispose()
})
