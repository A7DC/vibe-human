import * as THREE from 'three/webgpu'
import type { PatternDocument, PatternPanel, Vec2 } from '../clothing/document/types'
import type { RenderPanelRuntime } from '../clothing/simulation/types'
import { resolveSeamSamples } from '../clothing/geometry/seamUtils'

/** Freeze the original sewn edge correspondence into one rigged boundary.
 * UV duplicates remain separate so panel texture coordinates are preserved.
 */
export function bindSewnRenderSeams(geometry: THREE.BufferGeometry, document: PatternDocument, panels: RenderPanelRuntime[]) {
  const offsets = new Map<string, number>(); let count = 0
  for (const panel of panels) { offsets.set(panel.panelId, count); count += panel.panelUvs.length / 2 }
  const parents = Array.from({ length: count }, (_, i) => i)
  const find = (i: number): number => parents[i] === i ? i : (parents[i] = find(parents[i]))
  const edgeVertices = (panel: PatternPanel, samples: Vec2[]) => {
    const runtime = panels.find(entry => entry.panelId === panel.id)!
    const points = Object.values(panel.points), minX = Math.min(...points.map(p => p.x)), minY = Math.min(...points.map(p => p.y))
    const width = Math.max(...points.map(p => p.x)) - minX, height = Math.max(...points.map(p => p.y)) - minY
    const a = samples[0], b = samples[samples.length - 1], dx = b.x - a.x, dy = b.y - a.y, lengthSq = dx * dx + dy * dy
    const vertices = new Map<number, number>()
    for (let i = 0; i < runtime.panelUvs.length / 2; i++) {
      const x = minX + runtime.panelUvs[i * 2] * width, y = minY + runtime.panelUvs[i * 2 + 1] * height
      const t = ((x - a.x) * dx + (y - a.y) * dy) / lengthSq
      if (t >= -.00001 && t <= 1.00001 && Math.hypot(x - a.x - t * dx, y - a.y - t * dy) < .0001) vertices.set(Math.round(t * 10000), offsets.get(panel.id)! + i)
    }
    return vertices
  }
  let pairs = 0
  for (const seam of Object.values(document.seams)) {
    const a = document.panels[seam.a.panelId], b = document.panels[seam.b.panelId]
    if (a.edges.find(edge => edge.id === seam.a.edgeId)?.curve !== 'line' || b.edges.find(edge => edge.id === seam.b.edgeId)?.curve !== 'line') throw new Error('Rigged seam freezing currently requires straight authored seam edges')
    const resolved = resolveSeamSamples(document, seam, 1)
    if (!resolved) throw new Error(`Missing original seam ${seam.id}`)
    const va = edgeVertices(a, resolved.pointsA), vb = edgeVertices(b, resolved.pointsB)
    if (va.size !== vb.size || va.size < 2) throw new Error(`Nonconforming render seam ${seam.id}: ${va.size}/${vb.size}`)
    for (const [t, i] of va) {
      const j = vb.get(t)
      if (j === undefined) throw new Error(`Missing original render seam sample ${seam.id}/${t}`)
      parents[find(j)] = find(i); pairs++
    }
  }
  const groups = new Map<number, number[]>()
  for (let i = 0; i < count; i++) { const root = find(i); const group = groups.get(root) ?? []; group.push(i); groups.set(root, group) }
  const sewn = [...groups.values()].filter(group => group.length > 1)
  const position = geometry.getAttribute('position'), skinIndex = geometry.getAttribute('skinIndex'), skinWeight = geometry.getAttribute('skinWeight')
  let maxGap = 0
  for (const group of sewn) {
    const p = new THREE.Vector3(), first = new THREE.Vector3().fromBufferAttribute(position, group[0])
    for (const i of group) { p.fromBufferAttribute(position, i); maxGap = Math.max(maxGap, first.distanceTo(p)) }
    for (const attribute of [position, ...(geometry.morphAttributes.position ?? [])]) {
      const average = [0, 0, 0]
      for (const i of group) { average[0] += attribute.getX(i) / group.length; average[1] += attribute.getY(i) / group.length; average[2] += attribute.getZ(i) / group.length }
      for (const i of group) attribute.setXYZ(i, average[0], average[1], average[2])
    }
    const weights = new Map<number, number>()
    for (const i of group) for (let c = 0; c < 4; c++) { const bone = skinIndex.array[i * 4 + c]; weights.set(bone, (weights.get(bone) ?? 0) + skinWeight.array[i * 4 + c]) }
    const strongest = [...weights].sort((a,b) => b[1] - a[1]).slice(0,4), total = strongest.reduce((sum, pair) => sum + pair[1], 0)
    for (const i of group) for (let c = 0; c < 4; c++) { skinIndex.array[i * 4 + c] = strongest[c]?.[0] ?? 0; skinWeight.array[i * 4 + c] = (strongest[c]?.[1] ?? 0) / total }
  }
  geometry.computeVertexNormals()
  return { pairs, groups: sewn.length, maxOriginalBoundaryGapNative: maxGap }
}
