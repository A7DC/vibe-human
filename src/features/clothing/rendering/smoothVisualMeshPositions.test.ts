import assert from 'node:assert/strict'
import { test } from 'node:test'
import { smoothVisualMeshPositions } from './useGarmentSimulation'

// Two linked vertices and an isolated vertex exercise synchronous updates and
// the zero-neighbor case without relying on renderer or simulation state.
const original = new Float32Array([-1, -2, -3, 1, 2, 3, 7, 8, 9])
const offsets = new Uint32Array([0, 1, 2, 2])
const neighbors = new Uint32Array([1, 0])
function run(positions: Float32Array, alpha: number, passes = 1) {
  smoothVisualMeshPositions(positions, new Float32Array(positions.length), offsets, neighbors, passes, alpha)
}
function near(actual: Float32Array, expected: number[]) {
  actual.forEach((value, i) => assert.ok(Number.isFinite(value) && Math.abs(value - expected[i]) < 1e-6, `${i}: ${value} != ${expected[i]}`))
}
test('positive smoothing moves both vertices toward their previous-pass neighbor mean', () => {
  const positions = original.slice()
  run(positions, .25)
  near(positions, [-.5, -1, -1.5, .5, 1, 1.5, 7, 8, 9])
})
test('negative smoothing expands around the mean and preserves isolated vertices', () => {
  const positions = original.slice()
  run(positions, -.08)
  near(positions, [-1.16, -2.32, -3.48, 1.16, 2.32, 3.48, 7, 8, 9])
})
test('the production positive/negative sequence partially restores lost extent', () => {
  const positions = original.slice()
  run(positions, .28, 3)
  const smoothedExtent = positions[3] - positions[0]
  run(positions, -.08)
  assert.ok(positions[3] - positions[0] > smoothedExtent)
  near(positions, [-.09881344, -.19762688, -.29644032, .09881344, .19762688, .29644032, 7, 8, 9])
})
test('zero and nonfinite controls are no-ops rather than introducing NaNs', () => {
  for (const [alpha, passes] of [[0, 3], [.28, 0], [.28, -1], [NaN, 1], [Infinity, 1], [-Infinity, 1], [.28, Infinity], [.28, NaN]]) {
    const positions = original.slice()
    run(positions, alpha, passes)
    assert.deepEqual(positions, original)
  }
})
