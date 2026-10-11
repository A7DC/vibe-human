import * as THREE from 'three/webgpu'
import { bindSewnRenderSeams } from './exportSewnSeams'
import { mergeGarmentPanels } from './mergeGarmentPanels'
import { createDemoGarment, DEMO_GARMENT_PLACEMENTS } from '../clothing/demo/createDemoGarment'
import { toPatternDocument } from '../clothing/document/legacyAdapter'
import { compileGarmentRuntime } from '../clothing/compiler/compileGarmentRuntime'
import { SOLVER_PRESETS, applyDocumentPlacements, refreshSeamPlacementRest, createRenderPanelEntry, updateRenderPanels } from '../clothing/rendering/useGarmentSimulation'
import { XPBDClothSolver } from '../clothing/simulation/solver'
import { rebuildAvatarMeshCollider } from '../clothing/avatar-collision/AvatarCollisionRegistry'
import { solveCollisionConstraints } from '../clothing/simulation/collision/solveCollisionConstraints'
import { bindFittedGarment } from './exportGameGarments'

/** An offline invocation of the original interactive garment authoring pipeline. */
export async function authorUpstreamDemo(root: THREE.Object3D, body: THREE.SkinnedMesh, head: THREE.SkinnedMesh, options: { fitToTorso?: boolean; liftSleeves?: boolean; casualEase?: boolean; underLayers?: THREE.SkinnedMesh[]; renderSubdivisions?: number; variant?: 'tshirt' | 'hoodie' | 'jacket'; thinLayers?: boolean } = {}) {
  const started = performance.now()
  const saved = { scale: root.scale.clone(), quaternion: root.quaternion.clone(), position: root.position.clone(), modelPosition: root.children[0].position.clone() }
  const garment = createDemoGarment()
  const variant = options.variant ?? 'tshirt'
  const thinLayers = options.thinLayers ?? true
  const placements = structuredClone(DEMO_GARMENT_PLACEMENTS)
  if (options.fitToTorso) {
    // The same scale/placement operations exposed in the original pattern
    // editor, performed on its document BEFORE compiling/sewing. No mesh shell.
    const heightScale = .98 / (378 * .004)
    for (const panel of Object.values(garment.patterns)) for (const point of Object.values(panel.points)) {
      point.y *= heightScale
      if (point.in) point.in.y *= heightScale
      if (point.out) point.out.y *= heightScale
    }
    if (options.liftSleeves) for (const panel of Object.values(garment.patterns)) {
      panel.points[`${panel.id}-right-sleeve-top`].y = panel.points[`${panel.id}-right-shoulder`].y
      panel.points[`${panel.id}-left-sleeve-top`].y = panel.points[`${panel.id}-left-shoulder`].y
    }
    if (options.casualEase) for (const panel of Object.values(garment.patterns)) for (const [id, point] of Object.entries(panel.points)) {
      if (id.endsWith('-hem')) { point.y += .20 / .004; point.x *= 1.45 }
      else if (id.endsWith('-underarm')) point.x *= 1.40
      else if (id.endsWith('-shoulder')) point.x *= 1.10
    }
    if (variant !== 'tshirt') for (const panel of Object.values(garment.patterns)) {
      for (const sign of ['left', 'right']) {
        const direction = sign === 'left' ? -1 : 1
        const shoulder = panel.points[`${panel.id}-${sign}-shoulder`]
        const top = panel.points[`${panel.id}-${sign}-sleeve-top`]
        const bottom = panel.points[`${panel.id}-${sign}-sleeve-bottom`]
        top.x = bottom.x = direction * 1.43 / .004
        top.y = shoulder.y + .04 / .004
        bottom.y = top.y + (variant === 'hoodie' ? .34 : .31) / .004
      }
      // Editor-level ease on the original torso edges. Sleeve/neck edges and
      // all eight original sewing relationships remain in the document.
      for (const [id, point] of Object.entries(panel.points)) if (id.endsWith('-hem') || id.endsWith('-underarm')) point.x *= variant === 'hoodie' ? 1.12 : 1.08
    }
    for (const panel of Object.values(garment.patterns)) {
      const ys = Object.values(panel.points).map(point => point.y)
      // Keep the original highest neckline at native2.89 after editor resizing.
      // derive placement from the same bounds used by the upstream compiler.
      const nativeCentreY = 2.89 + (Math.min(...ys) - Math.max(...ys)) * .002
      placements[panel.id] = { position: { x: 0, y: nativeCentreY - 3.1, z: panel.id === 'torso-front' ? .34 : -.34 }, rotation: { x: 0, y: 0, z: 0 } }
    }
  }
  const document = toPatternDocument(garment, placements)
  const result = compileGarmentRuntime(document, { quality: 'high', seamSamples: 18, renderSubdivisions: options.renderSubdivisions ?? 30 })
  if (result.issues.some(issue => issue.severity === 'error')) throw new Error(JSON.stringify(result.issues))
  const runtime = result.value, mesh = runtime.simMesh
  const entries = runtime.renderPanels.map(createRenderPanelEntry)
  applyDocumentPlacements(mesh, document); refreshSeamPlacementRest(mesh)
  const panelDamping = Object.values(document.panels).map(panel => panel.damping).filter((value): value is number => Number.isFinite(value))
  const damping = panelDamping.length ? panelDamping.reduce((sum, value) => sum + value, 0) / panelDamping.length : SOLVER_PRESETS.high.damping
  const solver = new XPBDClothSolver(mesh, { ...SOLVER_PRESETS.high, damping, ...(variant !== 'tshirt' ? { gravityDelayTime: SOLVER_PRESETS.high.sewingTime } : {}) })
  const layerParents = (options.underLayers ?? []).map(mesh => ({ mesh, parent: mesh.parent }))
  for (const { mesh: layer } of layerParents) body.parent!.add(layer)
  let output: THREE.BufferGeometry | undefined
  let report: Record<string, unknown>
  try {
    // HumanModel's actual interactive scene places human5 at [0,-3.1,0].
    root.scale.setScalar(1); root.quaternion.identity(); root.position.set(0, -3.1, 0); root.children[0].position.set(0, 0, 0)
    root.updateMatrixWorld(true); body.skeleton.update()
    const collider = rebuildAvatarMeshCollider([body, head, ...(thinLayers ? [] : options.underLayers ?? [])], null, { id: 'avatar.mesh', skinOffset: .022, garmentThickness: .008, friction: .74, cellSize: .09, triangleStride: 1 })
    if (!collider) throw new Error('Original garment authoring body collider is unavailable')
    const layerCollider = thinLayers && options.underLayers?.length ? rebuildAvatarMeshCollider(options.underLayers, null, { id: 'garment.layer', skinOffset: .022, garmentThickness: .008, friction: .74, cellSize: .09, triangleStride: 1 }) : null
    const snapshot = { version: 1, proxies: [], meshColliders: [collider.snapshot], lowResMeshPatches: layerCollider ? [{ ...layerCollider.snapshot, region: 'pelvis' as const }] : [] }
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
    // A free shirt hem follows the pelvis, never an individual thigh. Nearest
    // body transfer can otherwise grab crotch/upper-leg vertices below the waist.
    const pelvis = body.skeleton.bones.findIndex(bone => bone.name === 'DEF-spine')
    if (pelvis < 0) throw new Error('Approved rig pelvis root is missing')
    let hemLegInfluencesReassigned = 0
    for (let i = 0; i < mesh.particleCount; i++) if (simPositions[i * 3 + 1] < 2.15) {
      for (let c = 0; c < 4; c++) {
        const offset = i * 4 + c, name = body.skeleton.bones[simJoints.array[offset]].name
        if (/thigh|shin|foot|toe/i.test(name) && simWeights.array[offset] > 0) {
          simJoints.array[offset] = pelvis; hemLegInfluencesReassigned++
        }
      }
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
    const summarizeHem = (indices: number[], position: { getY(i: number): number }) => ({ count: indices.length, minY: Math.min(...indices.map(i => position.getY(i))), maxY: Math.max(...indices.map(i => position.getY(i))), meanY: indices.reduce((sum, i) => sum + position.getY(i), 0) / indices.length })
    const simPositionAttribute = new THREE.BufferAttribute(simPositions, 3)
    const hemBoundaries = runtime.renderPanels.map((panel, index) => {
      const simIndices = runtime.panelInfo[panel.panelId].particleIndices.filter(i => mesh.panelUvs[i * 2 + 1] > .99999)
      const range = output!.userData.panelVertexRanges[index] as {start: number; count: number}
      const renderIndices = Array.from({length: range.count}, (_, i) => i + range.start).filter(i => output!.getAttribute('uv').getY(i) > .99999)
      return { panelId: panel.panelId, simulation: summarizeHem(simIndices, simPositionAttribute), rendered: summarizeHem(renderIndices, output!.getAttribute('position')) }
    })
    output.computeBoundingBox(); output.computeBoundingSphere()
    geometries.forEach(geometry => geometry.dispose()); simulationGeometry.dispose(); bound.geometry.dispose(); (bound.material as THREE.Material).dispose()
    report = { pipeline: 'Original createDemoGarment → toPatternDocument → compileGarmentRuntime → useGarmentSimulation initialization/embedding/smoothing helpers', quality: 'high', seamSamples: 18, variant, hemBoundaries, frozenSeams, hemLegInfluencesReassigned, renderSubdivisions: options.renderSubdivisions ?? 30, underLayers: (options.underLayers ?? []).map(mesh => mesh.name), layerCollision: thinLayers ? 'original two-sided lowResMeshPatches' : 'combined mesh surface',
      placements: document.panels, compilerIssues: result.issues, particles: mesh.particleCount, simTriangles: mesh.triangles.length / 3, renderVertices: output.getAttribute('position').count, renderTriangles: output.index!.count / 3,
      constraints: { stretch: mesh.stretchConstraints.length, shear: mesh.shearConstraints.length, bendDistance: mesh.bendDistanceConstraints.length, bend: mesh.bendConstraints.length, seam: mesh.seamConstraints.length, pin: mesh.pinConstraints.length },
      originalPatternUnedited: !options.fitToTorso, editorOperations: options.fitToTorso ? ['Scale both original panels vertically to .98 native units', 'Place both panels at x0,z±.34,rotation0; derive centreY from edited bounds to anchor the highest neckline at native2.89', ...(options.liftSleeves ? ['Lift original sleeve-top points to shoulder height so assembly surrounds T-pose arms'] : []), ...(options.casualEase ? ['Extend original hem .20 native units; widen hem45%, underarm40%, shoulder10%; derive placement from edited bounds to preserve neckline at2.89'] : []), ...(variant !== 'tshirt' ? [`Extend original sleeve edges to native wrist x±1.43; cuff depth ${variant === 'hoodie' ? '.34' : '.31'}; torso edge ease ${variant === 'hoodie' ? '12%' : '8%'}`] : [])] : [], authoringBodyTranslation: [0, -3.1, 0], colliderBounds: collider.snapshot.bounds, usesBvh: !!collider.snapshot.bvh, bodyTriangles: collider.snapshot.indices.length / 3,
      parameters: solver.params, steps, reason, maxMovement, seamGapMax: seamGapMax(), before, after: clearance(), history, elapsedMs: performance.now() - started,
      limitations: ['Drape is frozen on the neutral body; supported body extremes use transferred rig correctives, not separate per-body simulations', `Original compiler renderer embedding uses ${options.renderSubdivisions ?? 30} subdivisions; simulation topology is unchanged`, 'Every exported candidate requires actual animation and supported body-extreme visual review', 'The bounded step snapshot does not claim physical convergence; exceeding the 20-second wall budget rejects export', 'Empty compiler constraint arrays are preserved exactly, not filled with substitute constraints'] }
  } finally {
    for (const { mesh: layer, parent } of layerParents) { layer.removeFromParent(); parent?.add(layer) }
    root.scale.copy(saved.scale); root.quaternion.copy(saved.quaternion); root.position.copy(saved.position); root.children[0].position.copy(saved.modelPosition); root.updateMatrixWorld(true); body.skeleton.update()
  }
  return { geometry: output!, report }
}
