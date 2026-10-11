import * as THREE from 'three/webgpu'
import { bindSewnRenderSeams } from './exportSewnSeams'
import { mergeGarmentPanels } from './mergeGarmentPanels'
import type { ClothSimMesh, MeshSurfaceColliderSnapshot } from '../clothing/simulation/types'
import type { PatternDocument, PatternPanel, PatternSeam } from '../clothing/document/types'
import { compileGarmentRuntime } from '../clothing/compiler/compileGarmentRuntime'
import { SOLVER_PRESETS, applyDocumentPlacements, refreshSeamPlacementRest, createRenderPanelEntry, updateRenderPanels } from '../clothing/rendering/useGarmentSimulation'
import { XPBDClothSolver } from '../clothing/simulation/solver'
import { rebuildAvatarMeshCollider } from '../clothing/avatar-collision/AvatarCollisionRegistry'
import { solveCollisionConstraints } from '../clothing/simulation/collision/solveCollisionConstraints'
import { bindFittedGarment } from './exportGameGarments'

/** A newly authored trouser pattern, using the original document/compiler/solver. */
export function createGameTrouserDocument(): PatternDocument {
  const panels: Record<string, PatternPanel> = {}, seams: Record<string, PatternSeam> = {}
  // Native rest coordinates, converted to the existing pattern editor's units.
  const outline: [string, number, number][] = [
    ['waist-inner', 0, 2.02], ['waist-outer', .40, 2.02],
    ['hip', .53, 1.67], ['outer-knee', .48, .97], ['hem-outer', .43, .20],
    ['hem-inner', -.025, .20], ['inner-knee', -.05, .97],
    ['crotch', -.07, 1.48], ['rise', -.025, 1.70],
  ]
  const edges = ['waist', 'outer-rise', 'outer-thigh', 'outer-calf', 'hem', 'inner-calf', 'inner-thigh', 'rise-lower', 'rise-upper']
  for (const sign of [-1, 1]) for (const face of ['front', 'back']) {
    const id = `${sign < 0 ? 'negative' : 'positive'}-${face}`
    const points = Object.fromEntries(outline.map(([key, x, y]) => [key, { id: key, x: sign * x / .004, y: -y / .004, kind: 'corner' as const }]))
    const xs = Object.values(points).map(p => p.x), ys = Object.values(points).map(p => p.y)
    const minX = Math.min(...xs), maxX = Math.max(...xs)
    const pinX = sign * .20 / .004
    panels[id] = { id, name: id, points, edges: edges.map((edge, i) => ({ id: edge, from: outline[i][0], to: outline[(i + 1) % outline.length][0], curve: 'line' })), closed: true,
      particleDistance: 18, stretchCompliance: .0001, shearCompliance: .00016, bendCompliance: .12, damping: .045,
      placement: { position: { x: (minX + maxX) * .002, y: -(Math.min(...ys) + Math.max(...ys)) * .002 - 3.1, z: face === 'front' ? .30 : -.30 }, rotation: { x: 0, y: 0, z: 0 } },
      pins: [{ id: `${id}-waist-pin`, u: (pinX - minX) / (maxX - minX), v: 0, weight: 1 }],
    }
  }
  const stitch = (a: string, b: string, edge: string) => {
    const id = `${a}-${b}-${edge}`
    seams[id] = { id, name: id, a: { panelId: a, edgeId: edge }, b: { panelId: b, edgeId: edge }, strength: 1 }
  }
  for (const side of ['negative', 'positive']) for (const edge of ['outer-rise', 'outer-thigh', 'outer-calf', 'inner-calf', 'inner-thigh']) stitch(`${side}-front`, `${side}-back`, edge)
  for (const face of ['front', 'back']) for (const edge of ['rise-lower', 'rise-upper']) stitch(`negative-${face}`, `positive-${face}`, edge)
  return { id: 'game-four-panel-trousers', name: 'Four-panel casual trousers', panels, seams }
}

/** Place the original waist attachments on the body rather than the flat
 * front/back assembly planes. Keep pin height and panel identity unchanged. */
export function fitTrouserWaistPins(mesh: ClothSimMesh, collider: MeshSurfaceColliderSnapshot) {
  const records: { particle: number; before: number[]; after: number[]; surfaceZ: number }[] = []
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), hit = new THREE.Vector3()
  const ray = new THREE.Ray(), normal = new THREE.Vector3(), edge = new THREE.Vector3()
  for (const pin of mesh.pinConstraints) {
    const front = mesh.panelIds[pin.particle].endsWith('-front'), direction = front ? 1 : -1
    ray.origin.set(pin.x, pin.y, front ? collider.bounds.maxZ + 1 : collider.bounds.minZ - 1)
    ray.direction.set(0, 0, -direction)
    let distance = Infinity, surfaceZ = NaN, normalZ = 0
    for (let i = 0; i < collider.indices.length; i += 3) {
      a.fromArray(collider.vertices, collider.indices[i] * 3); b.fromArray(collider.vertices, collider.indices[i + 1] * 3); c.fromArray(collider.vertices, collider.indices[i + 2] * 3)
      if (!ray.intersectTriangle(a, b, c, false, hit)) continue
      const d = ray.origin.distanceToSquared(hit)
      if (d >= distance) continue
      distance = d; surfaceZ = hit.z
      normal.subVectors(b, a).cross(edge.subVectors(c, a)).normalize(); normalZ = Math.abs(normal.z)
    }
    if (!Number.isFinite(surfaceZ) || normalZ < .2) throw new Error(`Waist attachment ${pin.particle} has no usable torso surface`)
    const before = [pin.x, pin.y, pin.z]
    // Offset along the ray enough to provide the collider's normal clearance.
    pin.z = surfaceZ + direction * (collider.skin + collider.thickness) / normalZ
    records.push({ particle: pin.particle, before, after: [pin.x, pin.y, pin.z], surfaceZ })
  }
  return records
}

export async function authorUpstreamTrousers(root: THREE.Object3D, body: THREE.SkinnedMesh, head: THREE.SkinnedMesh, options: { renderSubdivisions?: number } = {}) {
  const started = performance.now()
  const saved = { scale: root.scale.clone(), quaternion: root.quaternion.clone(), position: root.position.clone(), modelPosition: root.children[0].position.clone() }
  const document = createGameTrouserDocument()
  const result = compileGarmentRuntime(document, { quality: 'high', seamSamples: 18, renderSubdivisions: options.renderSubdivisions ?? 12 })
  if (result.issues.some(issue => issue.severity === 'error')) throw new Error(JSON.stringify(result.issues))
  const runtime = result.value, mesh = runtime.simMesh
  const entries = runtime.renderPanels.map(createRenderPanelEntry)
  applyDocumentPlacements(mesh, document); refreshSeamPlacementRest(mesh)
  const panelDamping = Object.values(document.panels).map(panel => panel.damping).filter((value): value is number => Number.isFinite(value))
  const damping = panelDamping.length ? panelDamping.reduce((sum, value) => sum + value, 0) / panelDamping.length : SOLVER_PRESETS.high.damping
  const solver = new XPBDClothSolver(mesh, { ...SOLVER_PRESETS.high, damping, gravityDelayTime: SOLVER_PRESETS.high.sewingTime })
  let output: THREE.BufferGeometry | undefined
  let report: Record<string, unknown>
  try {
    // HumanModel's actual interactive scene places human5 at [0,-3.1,0].
    root.scale.setScalar(1); root.quaternion.identity(); root.position.set(0, -3.1, 0); root.children[0].position.set(0, 0, 0)
    root.updateMatrixWorld(true); body.skeleton.update()
    const collider = rebuildAvatarMeshCollider([body, head], null, { id: 'avatar.mesh', skinOffset: .022, garmentThickness: .008, friction: .74, cellSize: .09, triangleStride: 1 })
    if (!collider) throw new Error('Original garment authoring body collider is unavailable')
    const waistAttachments = fitTrouserWaistPins(mesh, collider.snapshot)
    const snapshot = { version: 1, proxies: [], meshColliders: [collider.snapshot] }
    const clearance = () => {
      const positions = new Float32Array(mesh.positions)
      solveCollisionConstraints({ ...mesh, positions, prevPositions: new Float32Array(positions) }, snapshot)
      let changed = 0, maximum = 0, worst = -1
      for (let i = 0; i < mesh.particleCount; i++) {
        const distance = Math.hypot(...[0, 1, 2].map(c => positions[i * 3 + c] - mesh.positions[i * 3 + c]))
        if (distance > .0001) changed++
        if (distance > maximum) { maximum = distance; worst = i }
      }
      let nearest: unknown = null
      if (worst >= 0) {
        const p = new THREE.Vector3().fromArray(mesh.positions, worst * 3), q = new THREE.Vector3(), triangle = new THREE.Triangle(), snapshot = collider.snapshot
        let distance = Infinity
        for (let face = 0; face < snapshot.indices.length / 3; face++) {
          triangle.a.fromArray(snapshot.vertices, snapshot.indices[face * 3] * 3); triangle.b.fromArray(snapshot.vertices, snapshot.indices[face * 3 + 1] * 3); triangle.c.fromArray(snapshot.vertices, snapshot.indices[face * 3 + 2] * 3)
          triangle.closestPointToPoint(p, q)
          const d = p.distanceTo(q)
          if (d < distance) { distance = d; nearest = { face, distance, point: q.toArray(), normal: triangle.getNormal(new THREE.Vector3()).toArray(), triangle: [triangle.a.toArray(), triangle.b.toArray(), triangle.c.toArray()] } }
        }
      }
      return { changed, maxProjectionNative: maximum, worst, position: worst < 0 ? null : Array.from(mesh.positions.slice(worst * 3, worst * 3 + 3)), projected: worst < 0 ? null : Array.from(positions.slice(worst * 3, worst * 3 + 3)), nearest }
    }
    const before = clearance(), simulationStarted = performance.now(), history: { step: number; maxMovement: number; seamGapMax: number }[] = []
    const seamGapMax = () => mesh.seamConstraints.reduce((maximum, seam) => Math.max(maximum, Math.hypot(...[0, 1, 2].map(c => mesh.positions[seam.a * 3 + c] - mesh.positions[seam.b * 3 + c]))), 0)
    let steps = 0, maxMovement = Infinity, stable = 0, reason = 'step-cap'
    for (; steps < 240; steps++) {
      if (performance.now() - simulationStarted > 20000) throw new Error('Upstream authoring exceeded its 20-second budget before completing the fixed 240 steps')
      const previous = new Float32Array(mesh.positions)
      solver.step(snapshot); maxMovement = 0
      for (let i = 0; i < mesh.particleCount; i++) {
        const movement = Math.hypot(...[0, 1, 2].map(c => mesh.positions[i * 3 + c] - previous[i * 3 + c]))
        if (!Number.isFinite(movement)) throw new Error('Upstream original garment simulation diverged')
        maxMovement = Math.max(maxMovement, movement)
      }
      if (steps % 20 === 0) history.push({ step: steps + 1, maxMovement, seamGapMax: seamGapMax() })
      stable = maxMovement < .0005 ? stable + 1 : 0
      if (steps > 90 && stable >= 12) { steps++; reason = 'movement-threshold'; break }
      if (steps % 3 === 0) await new Promise(resolve => setTimeout(resolve, 0))
    }
    updateRenderPanels(runtime, entries, mesh.positions)
    const inverse = body.matrixWorld.clone().invert(), point = new THREE.Vector3()
    const simPositions = new Float32Array(mesh.positions.length)
    for (let i = 0; i < mesh.particleCount; i++) point.fromArray(mesh.positions, i * 3).applyMatrix4(inverse).toArray(simPositions, i * 3)
    const simulationGeometry = new THREE.BufferGeometry()
    simulationGeometry.setAttribute('position', new THREE.BufferAttribute(simPositions, 3)); simulationGeometry.setIndex(new THREE.BufferAttribute(mesh.triangles, 1))
    // Bind a finite simulation mesh once. The exact original renderer embedding
    // transfers that same rig to its dense visual mesh without a second solver.
    const bound = bindFittedGarment(body, simulationGeometry, 'upstream-demo-simulation-binding', new THREE.MeshStandardMaterial(), 8)
    const simJoints = bound.geometry.getAttribute('skinIndex'), simWeights = bound.geometry.getAttribute('skinWeight')
    // Preserve panel leg identity; nearby opposite inner-thigh samples cannot
    // drive this leg. Waist transitions to pelvis, while knees retain native rig.
    const pelvis = body.skeleton.bones.findIndex(bone => bone.name === 'DEF-spine')
    if (pelvis < 0) throw new Error('Approved rig pelvis root is missing')
    const boneX = body.skeleton.bones.map(bone => bone.getWorldPosition(new THREE.Vector3()).x)
    let oppositeLegWeightsRemoved = 0
    for (let i = 0; i < mesh.particleCount; i++) {
      const sign = mesh.panelIds[i].startsWith('negative') ? -1 : 1
      const y = simPositions[i * 3 + 1]
      const pelvisBlend = THREE.MathUtils.smoothstep(y, 1.65, 1.94)
      const combined = new Map<number, number>()
      for (let c = 0; c < 4; c++) {
        const index = simJoints.array[i * 4 + c], weight = simWeights.array[i * 4 + c]
        if (/thigh|shin|foot|toe/i.test(body.skeleton.bones[index].name) && boneX[index] * sign < -.001) { oppositeLegWeightsRemoved++; continue }
        combined.set(index, (combined.get(index) ?? 0) + weight * (1 - pelvisBlend))
      }
      combined.set(pelvis, (combined.get(pelvis) ?? 0) + pelvisBlend)
      const weights = [...combined].filter(pair => pair[1] > 0).sort((a,b) => b[1] - a[1]).slice(0,4)
      const sum = weights.reduce((total, pair) => total + pair[1], 0)
      if (!(sum > 0)) throw new Error(`No ipsilateral rig weights for trouser particle ${i}`)
      for (let c = 0; c < 4; c++) { simJoints.array[i * 4 + c] = weights[c]?.[0] ?? 0; simWeights.array[i * 4 + c] = (weights[c]?.[1] ?? 0) / sum }
    }
    const geometries = entries.map(entry => {
      const geometry = entry.geometry, p = geometry.getAttribute('position'), joints = new Uint16Array(p.count * 4), weights = new Float32Array(p.count * 4)
      const embedding = entry.panel.embedding
      const morphs = (bound.geometry.morphAttributes.position ?? []).map(() => new Float32Array(p.count * 3))
      for (let i = 0; i < p.count; i++) {
        point.fromBufferAttribute(p, i).applyMatrix4(inverse); p.setXYZ(i, point.x, point.y, point.z)
        const combined = new Map<number, number>()
        for (let corner = 0; corner < 3; corner++) {
          const sim = embedding.simTriangles[i * 3 + corner], amount = Math.max(0, embedding.barycentrics[i * 3 + corner])
          for (let c = 0; c < 4; c++) {
            const bone = simJoints.array[sim * 4 + c]
            combined.set(bone, (combined.get(bone) ?? 0) + simWeights.array[sim * 4 + c] * amount)
          }
          for (let m = 0; m < morphs.length; m++) for (let c = 0; c < 3; c++) morphs[m][i * 3 + c] += bound.geometry.morphAttributes.position![m].array[sim * 3 + c] * embedding.barycentrics[i * 3 + corner]
        }
        const strongest = [...combined].sort((a, b) => b[1] - a[1]).slice(0, 4), total = strongest.reduce((sum, entry) => sum + entry[1], 0)
        strongest.forEach(([bone, amount], c) => { joints[i * 4 + c] = bone; weights[i * 4 + c] = amount / total })
      }
      geometry.setAttribute('skinIndex', new THREE.BufferAttribute(joints, 4)); geometry.setAttribute('skinWeight', new THREE.BufferAttribute(weights, 4))
      geometry.morphTargetsRelative = true; geometry.morphAttributes.position = morphs.map(values => new THREE.BufferAttribute(values, 3)); geometry.computeVertexNormals()
      return geometry
    })
    output = mergeGarmentPanels(geometries)
    const frozenSeams = bindSewnRenderSeams(output, document, runtime.renderPanels)
    // Derived morph normals must match the final draped base, not the old tee.
    const baseNormal = output.getAttribute('normal'), basePosition = output.getAttribute('position')
    output.morphAttributes.normal = (output.morphAttributes.position ?? []).map(morph => {
      const target = new THREE.BufferGeometry(), targetPositions = new Float32Array(basePosition.count * 3)
      for (let i = 0; i < basePosition.count; i++) { targetPositions[i * 3] = basePosition.getX(i) + morph.getX(i); targetPositions[i * 3 + 1] = basePosition.getY(i) + morph.getY(i); targetPositions[i * 3 + 2] = basePosition.getZ(i) + morph.getZ(i) }
      target.setAttribute('position', new THREE.BufferAttribute(targetPositions, 3)); target.setIndex(output!.index!.clone()); target.computeVertexNormals()
      const normal = target.getAttribute('normal'), deltas = new Float32Array(basePosition.count * 3)
      for (let i = 0; i < basePosition.count; i++) { deltas[i * 3] = normal.getX(i) - baseNormal.getX(i); deltas[i * 3 + 1] = normal.getY(i) - baseNormal.getY(i); deltas[i * 3 + 2] = normal.getZ(i) - baseNormal.getZ(i) }
      target.dispose(); return new THREE.BufferAttribute(deltas, 3)
    })
    let panelOffset = 0
    output.userData.panelVertexRanges = runtime.renderPanels.map(panel => { const range = { panelId: panel.panelId, start: panelOffset, count: panel.panelUvs.length / 2 }; panelOffset += range.count; return range })
    output.computeBoundingBox(); output.computeBoundingSphere()
    geometries.forEach(geometry => geometry.dispose()); simulationGeometry.dispose(); bound.geometry.dispose(); (bound.material as THREE.Material).dispose()
    report = { pipeline: 'New four-panel PatternDocument → original compileGarmentRuntime/XPBD/renderer embedding/smoothing → rig transfer and sewn seam freezing',
      document, compilerIssues: result.issues, particles: mesh.particleCount, simulationTriangles: mesh.triangles.length / 3,
      renderVertices: output.getAttribute('position').count, renderTriangles: output.index!.count / 3,
      pins: mesh.pinConstraints.length, waistAttachments, seams: mesh.seamConstraints.length, frozenSeams, oppositeLegWeightsRemoved,
      parameters: solver.params, steps, reason, maxMovement, seamGapMax: seamGapMax(), before, after: clearance(), history, elapsedMs: performance.now() - started,
      limitations: ['New game-authored trouser pattern, not an upstream bundled template', 'Frozen neutral drape with transferred morphs; actual body extremes and gait require visual validation', 'No runtime cloth simulation', 'Bounded authoring snapshot is not a physical convergence claim'] }
  } finally {
    root.scale.copy(saved.scale); root.quaternion.copy(saved.quaternion); root.position.copy(saved.position); root.children[0].position.copy(saved.modelPosition); root.updateMatrixWorld(true); body.skeleton.update()
  }
  return { geometry: output!, report }
}
