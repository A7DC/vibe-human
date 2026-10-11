import * as THREE from 'three/webgpu'
import { createDemoGarment } from '../clothing/demo/createDemoGarment'
import { evaluateEdgeAt } from '../clothing/geometry/patternSampling'
import { triangulatePanel } from '../clothing/geometry/triangulate'

/** Offline authoring helpers. No cloth solver or simulation enters the game export. */
export type GameGarmentBinding = { meshes: string[]; hides: string[] }
export type StarterGarmentExport = {
  garments: THREE.SkinnedMesh[]
  bodyRegions: THREE.SkinnedMesh[]
  manifestGarments: Record<string, GameGarmentBinding>
  stats: { sourceVertices: number; sourceTriangles: number; garmentTriangles: number; bodyTriangles: number; template: string }
}

type Attribute = THREE.BufferAttribute | THREE.InterleavedBufferAttribute
const component = (a: Attribute, i: number, c: number) => c === 0 ? a.getX(i) : c === 1 ? a.getY(i) : c === 2 ? a.getZ(i) : a.getW(i)
const copyAttribute = (attribute: Attribute, vertices: number[]): THREE.BufferAttribute => {
  const ArrayType = attribute.array.constructor as { new(length: number): THREE.TypedArray }
  const values = new ArrayType(vertices.length * attribute.itemSize)
  vertices.forEach((index, output) => {
    for (let c = 0; c < attribute.itemSize; c++) values[output * attribute.itemSize + c] = component(attribute, index, c)
  })
  // getX/Y/Z/W already decode normalized values, so re-encode integer storage.
  if (attribute.normalized) {
    const maximum = attribute.array instanceof Uint8Array ? 255 : attribute.array instanceof Uint16Array ? 65535 : attribute.array instanceof Int8Array ? 127 : 32767
    vertices.forEach((index, output) => {
      for (let c = 0; c < attribute.itemSize; c++) values[output * attribute.itemSize + c] = Math.round(component(attribute, index, c) * maximum)
    })
  }
  return new THREE.BufferAttribute(values, attribute.itemSize, attribute.normalized)
}

function triangles(geometry: THREE.BufferGeometry) {
  const index = geometry.getIndex(), count = index?.count ?? geometry.getAttribute('position').count
  const result: [number, number, number][] = []
  for (let i = 0; i < count; i += 3) result.push([index ? index.getX(i) : i, index ? index.getX(i + 1) : i + 1, index ? index.getX(i + 2) : i + 2])
  return result
}

/** Retains source vertex identity: skin indices, weights, UVs and every supplied morph remain aligned. */
function sliceGeometry(source: THREE.BufferGeometry, selected: [number, number, number][], offset: number, cuffThickness = 0): THREE.BufferGeometry {
  const vertices: number[] = [], mapped = new Map<number, number>(), indices: number[] = []
  const edges = new Map<string, { a: number; b: number; count: number }>()
  const sourcePosition = source.getAttribute('position')
  const pointKey = (i: number) => [sourcePosition.getX(i), sourcePosition.getY(i), sourcePosition.getZ(i)].map(n => n.toFixed(5)).join(',')
  for (const triangle of selected) {
    for (const index of triangle) {
      if (!mapped.has(index)) { mapped.set(index, vertices.length); vertices.push(index) }
      indices.push(mapped.get(index)!)
    }
    if (cuffThickness) for (let j = 0; j < 3; j++) {
      const a = triangle[j], b = triangle[(j + 1) % 3], key = [pointKey(a), pointKey(b)].sort().join(':')
      const existing = edges.get(key)
      if (existing) existing.count++
      else edges.set(key, { a, b, count: 1 })
    }
  }
  const exteriorCount = vertices.length
  const boundaryVertices: number[] = []
  if (cuffThickness) for (const edge of edges.values()) if (edge.count === 1) {
    const a = mapped.get(edge.a)!, b = mapped.get(edge.b)!, innerA = vertices.length, innerB = innerA + 1
    vertices.push(edge.a, edge.b)
    boundaryVertices.push(a, b, innerA, innerB)
    indices.push(a, innerA, b, b, innerA, innerB)
  }
  const result = new THREE.BufferGeometry()
  for (const [name, attribute] of Object.entries(source.attributes)) result.setAttribute(name, copyAttribute(attribute, vertices))
  result.setIndex(indices)
  result.morphTargetsRelative = source.morphTargetsRelative
  for (const [name, attributes] of Object.entries(source.morphAttributes)) {
    result.morphAttributes[name as keyof typeof result.morphAttributes] = attributes.map(attribute => copyAttribute(attribute, vertices))
  }
  const position = result.getAttribute('position'), normal = result.getAttribute('normal')
  if (offset && normal) for (let i = 0; i < position.count; i++) {
    const amount = offset - (i >= exteriorCount ? cuffThickness : 0)
    const dx = normal.getX(i) * amount, dy = normal.getY(i) * amount, dz = normal.getZ(i) * amount
    position.setXYZ(i, position.getX(i) + dx, Math.max(.003, position.getY(i) + dy), position.getZ(i) + dz)
    if (!result.morphTargetsRelative) for (const morph of result.morphAttributes.position ?? []) morph.setXYZ(i, morph.getX(i) + dx, Math.max(.003, morph.getY(i) + dy), morph.getZ(i) + dz)
  }
  result.userData.boundaryVertices = [...new Set(boundaryVertices)]
  result.userData.interiorStart = exteriorCount
  result.userData.cuffThickness = cuffThickness
  // Pure body partitions retain the full body smoothing and matching morph
  // normals across mask borders. Only displaced or thickened pieces need new normals.
  if (offset || cuffThickness || !normal) result.computeVertexNormals()
  result.computeBoundingBox(); result.computeBoundingSphere()
  return result
}

function skinnedPart(body: THREE.SkinnedMesh, name: string, geometry: THREE.BufferGeometry, material: THREE.Material | THREE.Material[]) {
  const mesh = new THREE.SkinnedMesh(geometry, material)
  mesh.name = name
  mesh.position.copy(body.position); mesh.quaternion.copy(body.quaternion); mesh.scale.copy(body.scale)
  mesh.bindMode = body.bindMode
  mesh.bind(body.skeleton, body.bindMatrix.clone())
  mesh.bindMatrixInverse.copy(body.bindMatrixInverse)
  mesh.morphTargetDictionary = { ...body.morphTargetDictionary }
  mesh.morphTargetInfluences = body.morphTargetInfluences?.slice()
  mesh.castShadow = true; mesh.receiveShadow = true
  return mesh
}

/** Sew the actual upstream front/back T-shirt patterns into a clean low-poly volume. */
function buildPatternTop(body: THREE.SkinnedMesh, name: string, material: THREE.Material, kind: 'tshirt' | 'hoodie' | 'jacket' = 'tshirt'): THREE.SkinnedMesh {
  const document = createDemoGarment()
  // A straight sleeve opening avoids the demo flat-pattern's diagonal tips
  // becoming hanging flaps when the native T-pose arms rotate down.
  for (const panel of Object.values(document.patterns)) {
    if (kind === 'tshirt') {
      panel.points[`${panel.id}-right-sleeve-bottom`].x = 196
      panel.points[`${panel.id}-left-sleeve-bottom`].x = -196
      continue
    }
    for (const [id, point] of Object.entries(panel.points)) {
      if (id.endsWith('right-sleeve-top') || id.endsWith('right-sleeve-bottom')) point.x = 347
      if (id.endsWith('left-sleeve-top') || id.endsWith('left-sleeve-bottom')) point.x = -347
    }
  }
  const positions: number[] = [], uv: number[] = [], indices: number[] = [], colours: number[] = []
  const panelData: { start: number; edges: Record<string, number[]>; boundaryCount: number }[] = []
  const panels = [document.patterns['torso-front'], document.patterns['torso-back']]
  const inside = (x: number, y: number, polygon: { x: number; y: number }[]) => {
    let result = false
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const a = polygon[i], b = polygon[j]
      if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) result = !result
    }
    return result
  }
  panels.forEach((panel, side) => {
    const boundary: { x: number; y: number }[] = [], edges: Record<string, number[]> = {}
    for (const edge of panel.edges) {
      const from = panel.points[edge.from], to = panel.points[edge.to]
      const count = kind === 'jacket' && side === 0 && edge.id === 'hem' ? 32 : edge.curve === 'cubic' ? 16 : Math.max(2, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / 18))
      edges[edge.id] = []
      for (let i = 0; i < count; i++) { edges[edge.id].push(boundary.length); boundary.push(evaluateEdgeAt(panel, edge, i / count)) }
    }
    for (let e = 0; e < panel.edges.length; e++) edges[panel.edges[e].id].push(edges[panel.edges[(e + 1) % panel.edges.length].id][0])
    const interior: { x: number; y: number }[] = []
    for (let y = -174; y < 192; y += 18) {
      const samples: number[] = []
      if (kind === 'jacket' && side === 0) { for (let x = 30; x < 347; x += 18) samples.push(x, -x) }
      else for (let x = kind === 'tshirt' ? -186 : -336; x < (kind === 'tshirt' ? 192 : 342); x += 18) samples.push(x)
      for (const x of samples) if (inside(x, y, boundary)) interior.push({ x, y })
    }
    const surface = triangulatePanel(boundary, interior)
    const start = positions.length / 3
    for (const point of surface.points) {
      const x = point.x * .00403, ax = Math.abs(x)
      let y = 2.90 - (point.y + 182) * ((kind === 'tshirt' ? .96 : .99) / 378)
      // A modest lifted shoulder seam clears the native shoulder without copying the deltoid bulge.
      const shoulderLift = 1 - THREE.MathUtils.smoothstep(point.y, -150, -96)
      y += .025 * shoulderLift * Math.sin(THREE.MathUtils.clamp((ax - .19) / .60, 0, 1) * Math.PI)
      const torsoDepth = .275 * Math.sqrt(Math.max(.25, 1 - (ax / .46) ** 2))
      let depth = torsoDepth
      if (ax > .35) {
        // Round the sewn sleeve around its sampled top/bottom bounds; a
        // constant-depth pair of panels produces an unwanted rectangular tube.
        const crossing: number[] = []
        for (let i = 0; i < boundary.length; i++) {
          const a = boundary[i], b = boundary[(i + 1) % boundary.length]
          if (point.x < Math.min(a.x, b.x) - .001 || point.x > Math.max(a.x, b.x) + .001) continue
          if (Math.abs(a.x - b.x) < .001) { crossing.push(a.y, b.y); continue }
          crossing.push(a.y + (b.y - a.y) * (point.x - a.x) / (b.x - a.x))
        }
        if (crossing.length > 1) {
          const top = Math.min(...crossing), bottom = Math.max(...crossing), t = (point.y - (top + bottom) / 2) / Math.max(1, (bottom - top) / 2)
          const taper = kind === 'tshirt' ? .15 : THREE.MathUtils.lerp(.18, .12, THREE.MathUtils.clamp((ax - .43) / .97, 0, 1))
          const sleeveDepth = Math.max(.012, taper * Math.sqrt(Math.max(0, 1 - t * t)))
          // Spread the armhole transition across several rows instead of folding
          // the entire chest panel at one x coordinate.
          depth = THREE.MathUtils.lerp(torsoDepth, sleeveDepth, THREE.MathUtils.smoothstep(ax, .35, .55))
        }
      }
      // The neckline narrows over several pattern rows in both directions. A
      // hard rectangular switch here creates a shelf across the posed chest.
      const collarBlend = THREE.MathUtils.smoothstep(-point.y, 112, 164) * (1 - THREE.MathUtils.smoothstep(ax, .16, .31))
      const collarDepth = Math.sqrt(Math.max(.0064, .19 ** 2 - x ** 2))
      depth = THREE.MathUtils.lerp(depth, collarDepth, collarBlend)
      positions.push(x, y, .035 + (side === 0 ? depth : -depth))
      uv.push((point.x + 196) / 392, (196 - point.y) / 378)
      if (kind === 'tshirt') {
        // Use the actual sewn pattern edges for restrained rib/turned-hem tint.
        // Vertex shading adds no extra surface, so the tested fit stays exact.
        let edgeShade = 1
        for (const edgeId of ['neck', 'hem', 'left-sleeve-opening', 'right-sleeve-opening']) {
          const edge = edges[edgeId]
          let distance = Infinity
          for (let j = 1; j < edge.length; j++) {
            const a = boundary[edge[j - 1]], b = boundary[edge[j]]
            const dx = b.x - a.x, dy = b.y - a.y
            const t = THREE.MathUtils.clamp(((point.x - a.x) * dx + (point.y - a.y) * dy) / (dx * dx + dy * dy || 1), 0, 1)
            distance = Math.min(distance, Math.hypot(point.x - a.x - t * dx, point.y - a.y - t * dy))
          }
          const width = edgeId === 'neck' ? 7 : 5
          const strength = edgeId === 'neck' ? .13 : .08
          edgeShade = Math.min(edgeShade, 1 - strength * (1 - THREE.MathUtils.smoothstep(distance, 0, width)))
        }
        colours.push(edgeShade, edgeShade, edgeShade)
      }
    }
    for (let i = 0; i < surface.triangles.length; i += 3) {
      const [a, b, c] = surface.triangles.slice(i, i + 3).map(index => index + start)
      if (kind === 'jacket' && side === 0) {
        const xs = [a, b, c].map(index => positions[index * 3])
        if (!xs.every(x => x >= .1208) && !xs.every(x => x <= -.1208)) continue
      }
      indices.push(...(side === 0 ? [a, c, b] : [a, b, c]))
    }
    panelData.push({ start, edges, boundaryCount: boundary.length })
  })
  // Close only the eight seams declared by upstream: neck, hem and sleeve openings stay open.
  for (const seam of Object.values(document.seams)) {
    const front = panelData[0].edges[seam.a.edgeId], back = panelData[1].edges[seam.b.edgeId]
    const sideSeam = seam.a.edgeId === 'right-side' || seam.a.edgeId === 'left-side'
    const middle: number[] = []
    if (sideSeam) for (let i = 0; i < front.length; i++) {
      const a = panelData[0].start + front[i], b = panelData[1].start + back[i]
      const x = (positions[a * 3] + positions[b * 3]) / 2
      middle.push(positions.length / 3)
      // Wrap around the flank instead of connecting two panels with a chord
      // through the trouser waistband. This keeps the entire side outside it.
      positions.push(x + Math.sign(x) * .06, (positions[a * 3 + 1] + positions[b * 3 + 1]) / 2, .035)
      uv.push((uv[a * 2] + uv[b * 2]) / 2, (uv[a * 2 + 1] + uv[b * 2 + 1]) / 2)
      if (kind === 'tshirt') for (let c = 0; c < 3; c++) colours.push((colours[a * 3 + c] + colours[b * 3 + c]) / 2)
    }
    for (let i = 0; i < front.length - 1; i++) {
      const a = panelData[0].start + front[i], b = panelData[0].start + front[i + 1]
      const c = panelData[1].start + back[i], d = panelData[1].start + back[i + 1]
      if (sideSeam) { const m = middle[i], n = middle[i + 1]; indices.push(a, b, m, b, n, m, m, n, c, n, d, c) }
      else indices.push(a, b, c, b, d, c)
    }
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3)); geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); geometry.setIndex(indices); geometry.computeVertexNormals()
  if (kind === 'tshirt') {
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colours, 3))
    const cotton = material as THREE.MeshStandardMaterial
    cotton.vertexColors = true
    const pixels = new Uint8Array(64 * 64 * 4)
    for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
      const i = (y * 64 + x) * 4
      // Deterministic, low-contrast cotton weave; neutral RGB preserves variants.
      const tone = 251 + ((x + (y % 2)) % 3 === 0 ? 2 : 0) - (y % 4 === 0 ? 2 : 0)
      pixels[i] = pixels[i + 1] = pixels[i + 2] = tone; pixels[i + 3] = 255
    }
    const weave = new THREE.DataTexture(pixels, 64, 64, THREE.RGBAFormat)
    weave.name = 'tee-cotton-weave'; weave.colorSpace = THREE.SRGBColorSpace
    weave.magFilter = THREE.LinearFilter; weave.minFilter = THREE.LinearMipmapLinearFilter
    weave.generateMipmaps = true; weave.needsUpdate = true
    cotton.map = weave
  }
  const mesh = bindFittedGarment(body, geometry, name, material, 8)
  // A sewn sleeve is one cross-section. Front chest skin can be almost entirely
  // breast-weighted while its matching rear vertex follows the upper-arm bone;
  // independently transferring those weights folds the connecting seam at idle.
  // Share the source-derived blend across matching outer panel vertices, fading
  // inward so the centre chest still retains its original source weighting.
  const garmentPosition = mesh.geometry.getAttribute('position')
  const skinIndex = mesh.geometry.getAttribute('skinIndex'), skinWeight = mesh.geometry.getAttribute('skinWeight')
  const sections = new Map<string, number[]>()
  for (let i = 0; i < garmentPosition.count; i++) {
    if (Math.abs(garmentPosition.getX(i)) < .28 || garmentPosition.getY(i) < 2.54) continue
    const key = `${garmentPosition.getX(i).toFixed(5)}:${garmentPosition.getY(i).toFixed(5)}`
    const vertices = sections.get(key) ?? []; vertices.push(i); sections.set(key, vertices)
  }
  for (const vertices of sections.values()) {
    if (vertices.length < 2) continue
    const average = new Map<number, number>()
    for (const i of vertices) for (let c = 0; c < 4; c++) {
      const bone = component(skinIndex, i, c)
      average.set(bone, (average.get(bone) ?? 0) + component(skinWeight, i, c) / vertices.length)
    }
    for (const i of vertices) {
      const blend = THREE.MathUtils.smoothstep(Math.abs(garmentPosition.getX(i)), .28, .40)
      const combined = new Map([...average].map(([bone, weight]) => [bone, weight * blend]))
      for (let c = 0; c < 4; c++) {
        const bone = component(skinIndex, i, c)
        combined.set(bone, (combined.get(bone) ?? 0) + component(skinWeight, i, c) * (1 - blend))
      }
      const strongest = [...combined].sort((a, b) => b[1] - a[1]).slice(0, 4)
      const total = strongest.reduce((sum, entry) => sum + entry[1], 0)
      skinIndex.setXYZW(i, ...[0, 1, 2, 3].map(c => strongest[c]?.[0] ?? 0) as [number, number, number, number])
      skinWeight.setXYZW(i, ...[0, 1, 2, 3].map(c => (strongest[c]?.[1] ?? 0) / total) as [number, number, number, number])
    }
    for (const morph of mesh.geometry.morphAttributes.position ?? []) {
      const meanX = vertices.reduce((sum, i) => sum + morph.getX(i), 0) / vertices.length
      const meanY = vertices.reduce((sum, i) => sum + morph.getY(i), 0) / vertices.length
      for (const i of vertices) {
        const blend = THREE.MathUtils.smoothstep(Math.abs(garmentPosition.getX(i)), .28, .40)
        morph.setX(i, THREE.MathUtils.lerp(morph.getX(i), meanX, blend))
        morph.setY(i, THREE.MathUtils.lerp(morph.getY(i), meanY, blend))
      }
      // Keep the authored front/back thickness positive at either build target.
      const sorted = [...vertices].sort((a, b) => garmentPosition.getZ(a) - garmentPosition.getZ(b))
      const back = sorted[0], front = sorted[sorted.length - 1]
      const baseDepth = garmentPosition.getZ(front) - garmentPosition.getZ(back)
      const targetDepth = baseDepth + morph.getZ(front) - morph.getZ(back)
      if (targetDepth < baseDepth * .25) {
        const correction = (baseDepth * .25 - targetDepth) / 2
        morph.setZ(front, morph.getZ(front) + correction); morph.setZ(back, morph.getZ(back) - correction)
      }
    }
  }
  geometry.dispose()
  mesh.userData.garmentAuthoring = { source: 'upstream createDemoGarment two-panel sewing pattern', seams: Object.keys(document.seams), runtimeCloth: false }
  return mesh
}

let trainerPanelTexture: THREE.DataTexture | undefined
function getTrainerPanelTexture() {
  if (trainerPanelTexture) return trainerPanelTexture
  const width = 64, height = 128, pixels = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const u = (x + .5) / width, v = (y + .5) / height, side = Math.abs(u - .5)
    let tone = 252
    // Projected textile tongue, three crossed lace rows and a curved toe seam.
    // Paint directly on the proven clean upper: separate lace boxes were buried
    // beneath it, and added foot topology previously caused animation spikes.
    if (side < .18 && v > .65 && v < .91) tone = 220
    if (side > .155 && side < .185 && v > .67 && v < .90) tone = 184
    for (const row of [.74, .81, .875]) {
      if (side < .16 && (Math.abs(v - row - (u - .5) * .19) < .009 || Math.abs(v - row + (u - .5) * .19) < .009)) tone = 137
    }
    if (Math.abs(v - (.94 - side * side * .34)) < .009) tone = 184
    if (v < .17) tone = 211
    const i = (y * width + x) * 4
    pixels[i] = pixels[i + 1] = pixels[i + 2] = tone; pixels[i + 3] = 255
  }
  const map = new THREE.DataTexture(pixels, width, height, THREE.RGBAFormat)
  map.name = 'trainer-tongue-laces-toe-panels'; map.colorSpace = THREE.SRGBColorSpace
  map.magFilter = THREE.LinearFilter; map.minFilter = THREE.LinearMipmapLinearFilter
  map.generateMipmaps = true; map.needsUpdate = true
  trainerPanelTexture = map
  return map
}

/** Clean authored trainer volumes; raw toe triangles/rims never enter footwear. */
function buildCleanTrainers(body: THREE.SkinnedMesh, upperName: string, soleName: string, upperColour: THREE.ColorRepresentation, soleColour: THREE.ColorRepresentation): THREE.SkinnedMesh[] {
  const source = body.geometry.getAttribute('position')
  const feet = [-1, 1].map(sign => {
    const indices: number[] = [], bounds = new THREE.Box3()
    for (let i = 0; i < source.count; i++) if (source.getY(i) < .23 && Math.sign(source.getX(i)) === sign) { indices.push(i); bounds.expandByPoint(new THREE.Vector3(source.getX(i), source.getY(i), source.getZ(i))) }
    const bone = body.skeleton.bones.findIndex(bone => bone.name === THREE.PropertyBinding.sanitizeNodeName(`DEF-foot.${sign > 0 ? 'L' : 'R'}`) || bone.name === `DEF-foot.${sign > 0 ? 'L' : 'R'}`)
    if (bone < 0 || !indices.length) throw new Error('Approved foot bones/vertices missing')
    return { sign, indices, bounds, bone }
  })
  return [false, true].map(sole => {
    const positions: number[] = [], indices: number[] = [], weights: number[] = [], joints: number[] = [], owner: number[] = [], uv: number[] = []
    const sides = 16
    feet.forEach((foot, f) => {
      const centre = foot.bounds.getCenter(new THREE.Vector3()), size = foot.bounds.getSize(new THREE.Vector3())
      const halfX = size.x / 2 + .022, halfZ = size.z / 2 + .038, centreZ = centre.z + .014
      const start = positions.length / 3
      const rings = sole ? [{ y: .008, x: 1, z: 1, cz: centreZ }, { y: .067, x: .975, z: .985, cz: centreZ }]
        // Native +Z is the toe. The trouser hem hides v<~.7, so put the
        // visible tongue/laces forward and raise the instep just behind the toe.
        : [{ y: .062, x: .96, z: .97, cz: centreZ }, { y: .126, x: .88, z: .91, cz: centreZ - .01 }, { y: .195, x: .80, z: .61, cz: centreZ - .025 }, { y: .245, x: .69, z: .31, cz: foot.bounds.min.z + size.z * .31 }]
      for (const ring of rings) for (let j = 0; j < sides; j++) {
        const angle = j / sides * Math.PI * 2, x = Math.cos(angle), z = Math.sin(angle)
        positions.push(centre.x + Math.sign(x) * Math.sqrt(Math.abs(x)) * halfX * ring.x, ring.y, ring.cz + Math.sign(z) * Math.sqrt(Math.abs(z)) * halfZ * ring.z)
        uv.push(.5 + Math.sign(x) * Math.sqrt(Math.abs(x)) * ring.x / 2, .5 + (ring.cz + Math.sign(z) * Math.sqrt(Math.abs(z)) * halfZ * ring.z - centreZ) / (2 * halfZ))
        joints.push(foot.bone, 0, 0, 0); weights.push(1, 0, 0, 0); owner.push(f)
      }
      for (let ring = 0; ring < rings.length - 1; ring++) for (let j = 0; j < sides; j++) {
        const a = start + ring * sides + j, b = start + ring * sides + (j + 1) % sides, c = a + sides, d = b + sides
        indices.push(a, c, b, b, c, d)
      }
      if (sole) for (let j = 1; j < sides - 1; j++) { indices.push(start, start + j, start + j + 1); indices.push(start + sides, start + sides + j + 1, start + sides + j) }
    })
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3)); geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(joints, 4)); geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(weights, 4)); geometry.setIndex(indices)
    geometry.morphTargetsRelative = true
    geometry.morphAttributes.position = (body.geometry.morphAttributes.position ?? []).map(morph => {
      const targetBounds = feet.map(foot => {
        const bounds = new THREE.Box3()
        for (const i of foot.indices) bounds.expandByPoint(new THREE.Vector3(morph.getX(i) + (body.geometry.morphTargetsRelative ? source.getX(i) : 0), morph.getY(i) + (body.geometry.morphTargetsRelative ? source.getY(i) : 0), morph.getZ(i) + (body.geometry.morphTargetsRelative ? source.getZ(i) : 0)))
        return bounds
      })
      const delta = new Float32Array(positions.length)
      owner.forEach((footIndex, i) => {
        const foot = feet[footIndex], baseSize = foot.bounds.getSize(new THREE.Vector3()), targetSize = targetBounds[footIndex].getSize(new THREE.Vector3())
        const baseCentre = foot.bounds.getCenter(new THREE.Vector3()), targetCentre = targetBounds[footIndex].getCenter(new THREE.Vector3())
        for (let c = 0; c < 3; c++) {
          const ratio = targetSize.getComponent(c) / Math.max(.001, baseSize.getComponent(c))
          delta[i * 3 + c] = targetCentre.getComponent(c) + (positions[i * 3 + c] - baseCentre.getComponent(c)) * ratio - positions[i * 3 + c]
        }
      })
      return new THREE.BufferAttribute(delta, 3)
    })
    geometry.computeVertexNormals(); geometry.computeBoundingBox(); geometry.computeBoundingSphere()
    const name = sole ? soleName : upperName, mat = new THREE.MeshStandardMaterial({ color: sole ? soleColour : upperColour, roughness: .98, side: THREE.DoubleSide }); mat.name = name
    if (!sole) mat.map = getTrainerPanelTexture()
    const mesh = skinnedPart(body, name, geometry, mat); mesh.userData.garmentAuthoring = { source: 'clean foot-bound trainer volume', weightedTo: 'approved DEF-foot.L/R', runtimeCloth: false }; return mesh
  })
}

/**
 * First proof outfit authored on the approved human5 body, not downloaded finished clothes.
 * Tee cut proportions come from the existing two-panel upstream T-shirt template.
 * Trousers/trainers are newly authored fitted shell regions. They reuse the real avatar's
 * exact topology and rig, including corrective deltas, rather than a stand-in character.
 * Call after selecting/aliasing export morphs and BEFORE normalizing the native-size rig.
 */
export function buildGameStarterGarments(body: THREE.SkinnedMesh): StarterGarmentExport {
  const geometry = body.geometry, position = geometry.getAttribute('position')
  if (!body.skeleton?.bones.length || !geometry.getAttribute('skinIndex') || !geometry.getAttribute('skinWeight')) throw new Error('Starter garments require the approved skinned body')
  geometry.computeBoundingBox()
  const bounds = geometry.boundingBox!
  if (bounds.max.y < 2.8 || bounds.max.y > 3.05 || bounds.min.x > -1.5 || bounds.max.x < 1.5) throw new Error('Starter garment authoring expects native human5 T-pose body coordinates')
  const template = createDemoGarment(), panel = template.patterns['torso-front']
  // Preserve the upstream shoulder:sleeve proportion; fit it to this body's torso width.
  const sleeveRatio = Math.abs(panel.points['torso-front-right-sleeve-top'].x / panel.points['torso-front-right-shoulder'].x)
  // Leave a real arm underlap below the cloth cuff. Coverage must end
  // before the sewn opening, especially when upper-arm twist bones move.
  const sleeveHalfWidth = .31 * sleeveRatio
  const all = triangles(geometry)
  const centroid = (triangle: [number, number, number]) => ({
    x: triangle.reduce((n, i) => n + position.getX(i), 0) / 3,
    y: triangle.reduce((n, i) => n + position.getY(i), 0) / 3,
    z: triangle.reduce((n, i) => n + position.getZ(i), 0) / 3,
  })
  // Sewn neckline is higher at the back: do not leave broad old shell cutouts
  // visible through the new collar. The true neck above the opening stays visible.
  const top = (p: { x: number; y: number; z: number }) => p.y >= 1.94 && p.y <= 2.93 && Math.abs(p.x) <= sleeveHalfWidth && !(p.y > (p.z > .035 ? 2.87 : 2.89) && Math.abs(p.x) < .145)
  const bottom = (p: { x: number; y: number }) => p.y >= .19 && p.y <= 2.02 && Math.abs(p.x) < .7
  const shoes = (p: { x: number; y: number }) => p.y < .25
  const masks: Record<string, [number, number, number][]> = { exposed: [], top: [], bottom: [], shoes: [], sleeves: [] }
  const garmentFaces: Record<string, [number, number, number][]> = { top: [], bottom: [], shoes: [], soles: [] }
  for (const triangle of all) {
    const p = centroid(triangle)
    // At the arm boundary keep every straddling triangle visible. Hiding a
    // triangle for only one covered vertex amputates the visible arm edge.
    // The cuff overlaps this conservative cut by ~0.15 native units.
    // Keep actual skin under both openings. Centroid-only masks cut away
    // waist triangles that extend beyond a garment's animated hem/rim.
    const coveredTop = top(p) && triangle.every(i => position.getY(i) >= 2.08) && (Math.abs(p.x) < .46 || triangle.every(i => Math.abs(position.getX(i)) < sleeveHalfWidth))
    const coveredBottom = bottom(p) && triangle.every(i => position.getY(i) <= 1.96)
    // Corrected sewn long sleeves continuously cover the old 1.36 skin cut:
    // posed crouch rays hit exposed skin at |x|1.363–1.380 through intact cloth.
    // Residual triangle centroids reach 1.407; end coverage at 1.41, retaining
    // skin under the measured cuff at 1.418+.
    // This region remains visible with short sleeves; hands are not removed.
    const region = coveredTop ? 'top' : shoes(p) ? 'shoes' : coveredBottom ? 'bottom' : p.y > 2.2 && p.y < 2.95 && Math.abs(p.x) < 1.41 ? 'sleeves' : 'exposed'
    masks[region].push(triangle)
    if (top(p)) garmentFaces.top.push(triangle)
    if (bottom(p)) garmentFaces.bottom.push(triangle)
    if (shoes(p)) garmentFaces.shoes.push(triangle)
    if (p.y < .085) garmentFaces.soles.push(triangle)
  }
  const material = (name: string, colour: number) => {
    const result = new THREE.MeshStandardMaterial({ color: colour, roughness: .98, side: THREE.DoubleSide }); result.name = name; return result
  }
  const bodyRegions = Object.entries(masks).filter(([, faces]) => faces.length).map(([name, faces]) => skinnedPart(body,
    name === 'exposed' ? 'body-exposed' : `body-covered-${name}`, sliceGeometry(geometry, faces, 0), body.material))
  const specs = [
    { name: 'starter-tee', region: 'top', offset: .055, colour: 0x8b8d88 },
    { name: 'starter-trousers', region: 'bottom', offset: .045, colour: 0x343b44 },
  ]
  const garments = specs.map(spec => {
    if (!garmentFaces[spec.region].length) throw new Error(`Empty authored garment region: ${spec.region}`)
    const mesh = spec.region === 'top' ? buildPatternTop(body, spec.name, material(spec.name, spec.colour))
      : skinnedPart(body, spec.name, sliceGeometry(geometry, garmentFaces[spec.region], spec.offset, .018), material(spec.name, spec.colour))
    if (spec.region === 'top' || spec.region === 'bottom') relaxGarmentSilhouette(mesh, spec.region === 'top' ? 'tshirt' : 'trousers')
    mesh.userData.garmentAuthoring = { source: 'approved human5 body topology', template: spec.region === 'top' ? `${template.name}: sampled panels, triangulation and eight seams` : 'new fitted body-region shell', runtimeCloth: false }
    return mesh
  })
  garments.push(...buildCleanTrainers(body, 'starter-trainers', 'starter-trainer-soles', 0xb6b5a9, 0x343633))
  return {
    garments, bodyRegions,
    manifestGarments: {
      'starter-tee': { meshes: ['starter-tee'], hides: ['body-covered-top'] },
      'starter-trousers': { meshes: ['starter-trousers'], hides: ['body-covered-bottom'] },
      'starter-trainers': { meshes: ['starter-trainers', 'starter-trainer-soles'], hides: ['body-covered-shoes'] },
    },
    stats: { sourceVertices: position.count, sourceTriangles: all.length, garmentTriangles: garments.reduce((n, mesh) => n + mesh.geometry.index!.count / 3, 0), bodyTriangles: bodyRegions.reduce((n, mesh) => n + mesh.geometry.index!.count / 3, 0), template: template.name },
  }
}

/**
 * For authored/settled upstream pattern meshes: transfer native-body weights and
 * corrective deltas offline. Caller supplies an already fitted garment geometry.
 * Nearest-vertex transfer is a first bind, requiring visual pose/extreme review.
 */
export function bindFittedGarment(body: THREE.SkinnedMesh, fittedGeometry: THREE.BufferGeometry, name: string, material: THREE.Material, sampleCount = 1): THREE.SkinnedMesh {
  const source = body.geometry.getAttribute('position'), fitted = fittedGeometry.getAttribute('position')
  if (!source || !fitted || !body.geometry.getAttribute('skinWeight')) throw new Error('Weight transfer requires fitted geometry and a skinned source')
  const nearest: number[] = [], neighbourhoods: { index: number; weight: number }[][] = []
  for (let i = 0; i < fitted.count; i++) {
    let winner = 0, distance = Infinity
    const samples: { index: number; distance: number }[] = []
    for (let j = 0; j < source.count; j++) {
      const d = (fitted.getX(i) - source.getX(j)) ** 2 + (fitted.getY(i) - source.getY(j)) ** 2 + (fitted.getZ(i) - source.getZ(j)) ** 2
      if (d < distance) { winner = j; distance = d }
      if (sampleCount > 1 && (samples.length < sampleCount || d < samples[samples.length - 1].distance)) {
        samples.push({ index: j, distance: d }); samples.sort((a, b) => a.distance - b.distance)
        if (samples.length > sampleCount) samples.pop()
      }
    }
    nearest.push(winner)
    const sum = samples.reduce((total, sample) => total + 1 / (.0025 + sample.distance), 0)
    neighbourhoods.push(sampleCount === 1 ? [{ index: winner, weight: 1 }] : samples.map(sample => ({ index: sample.index, weight: 1 / (.0025 + sample.distance) / sum })))
  }
  const geometry = fittedGeometry.clone()
  for (const attribute of ['skinIndex', 'skinWeight']) geometry.setAttribute(attribute, copyAttribute(body.geometry.getAttribute(attribute), nearest))
  if (sampleCount > 1) {
    // Smooth actual source weights across the cuff; nearest-vertex switching
    // can attach adjacent cloth vertices to different arm/twist bones.
    const sourceJoints = body.geometry.getAttribute('skinIndex'), sourceWeights = body.geometry.getAttribute('skinWeight')
    const joints = new Uint16Array(fitted.count * 4), weights = new Float32Array(fitted.count * 4)
    neighbourhoods.forEach((samples, i) => {
      const combined = new Map<number, number>()
      for (const sample of samples) for (let c = 0; c < 4; c++) {
        const joint = component(sourceJoints, sample.index, c)
        combined.set(joint, (combined.get(joint) ?? 0) + component(sourceWeights, sample.index, c) * sample.weight)
      }
      const strongest = [...combined].sort((a, b) => b[1] - a[1]).slice(0, 4), total = strongest.reduce((sum, entry) => sum + entry[1], 0)
      strongest.forEach(([joint, weight], c) => { joints[i * 4 + c] = joint; weights[i * 4 + c] = weight / total })
    })
    geometry.setAttribute('skinIndex', new THREE.BufferAttribute(joints, 4)); geometry.setAttribute('skinWeight', new THREE.BufferAttribute(weights, 4))
  }
  geometry.morphTargetsRelative = true
  geometry.morphAttributes.position = (body.geometry.morphAttributes.position ?? []).map(morph => {
    const values = new Float32Array(fitted.count * 3)
    neighbourhoods.forEach((samples, i) => {
      for (const sample of samples) for (let c = 0; c < 3; c++) values[i * 3 + c] += sample.weight * (component(morph, sample.index, c) - (body.geometry.morphTargetsRelative ? 0 : component(source, sample.index, c)))
    })
    return new THREE.BufferAttribute(values, 3)
  })
  return skinnedPart(body, name, geometry, material)
}

/** Ease source anatomy into cloth; preserve every authored corrective delta and skin weight. */
function relaxGarmentSilhouette(mesh: THREE.SkinnedMesh, kind: 'tshirt' | 'coat' | 'trousers') {
  const geometry = mesh.geometry, p = geometry.getAttribute('position')
  const boundaries = new Set<number>(geometry.userData.boundaryVertices ?? [])
  const mix = THREE.MathUtils.lerp
  const original = new Float32Array(p.array)
  for (let i = 0; i < p.count; i++) {
    const oldX = p.getX(i), oldY = p.getY(i), oldZ = p.getZ(i)
    let x = oldX, y = oldY, z = oldZ
    if (kind === 'trousers') {
      if (y > 1.60) {
        // Follow the native hip-to-waist taper instead of extruding the hip
        // ellipse into a tall, rigid waistband above a fitted shirt. Native
        // neutral waist is about .294 wide; retain .025 cloth clearance.
        const waist = THREE.MathUtils.smoothstep(y, 1.72, 1.985)
        const rx = mix(.365, .32, waist), rz = mix(.255, .235, waist), cy = .025
        const radius = Math.hypot(x / rx, (z - cy) / rz)
        if (radius > .01) { const blend = THREE.MathUtils.smoothstep(y, 1.58, 1.72); x = mix(x, x / radius, blend); z = mix(z, cy + (z - cy) / radius, blend) }
      } else {
        const centreX = Math.sign(x || 1) * .205, rx = mix(.125, .18, THREE.MathUtils.smoothstep(y, .3, 1.5)), rz = mix(.135, .20, THREE.MathUtils.smoothstep(y, .3, 1.5))
        const radius = Math.hypot((x - centreX) / rx, (z - .025) / rz)
        if (radius > .01) { x = centreX + (x - centreX) / radius; z = .025 + (z - .025) / radius }
      }
      if (boundaries.has(i) && oldY > 1.93) y = 1.985
      if (boundaries.has(i) && oldY < .3) y = .22
      // Ellipse fitting otherwise places the duplicated inner rim on the
      // exterior, producing collapsed/inverted collision faces at the waist.
      // Restore the authored inward thickness after fitting both surfaces.
      if (i >= (geometry.userData.interiorStart ?? Infinity)) {
        const centreX = y > 1.60 ? 0 : Math.sign(x || 1) * .205
        const dx = x - centreX, dz = z - .025, radius = Math.hypot(dx, dz)
        const thickness = Number(geometry.userData.cuffThickness ?? 0)
        if (radius > thickness && thickness > 0) { x -= dx / radius * thickness; z -= dz / radius * thickness }
      }
    } else {
      const hem = kind === 'tshirt' ? 1.94 : 1.91
      if (Math.abs(x) < .50 && y < 2.65) {
        const rx = mix(kind === 'coat' ? .435 : .40, kind === 'coat' ? .455 : .42, THREE.MathUtils.smoothstep(y, hem, 2.55))
        const rz = kind === 'coat' ? .32 : .285, cz = .035
        const radius = Math.hypot(x / rx, (z - cz) / rz)
        if (radius > .01) { const blend = (1 - THREE.MathUtils.smoothstep(y, 2.50, 2.65)) * (1 - THREE.MathUtils.smoothstep(Math.abs(x), .36, .50)); x = mix(x, x / radius, blend); z = mix(z, cz + (z - cz) / radius, blend) }
      }
      if (boundaries.has(i) && oldY < hem + .11) y = hem
      const sleeve = kind === 'tshirt' ? .755 : 1.43
      if (boundaries.has(i) && Math.abs(oldX) > sleeve - .09) x = Math.sign(oldX) * sleeve
      if (boundaries.has(i) && oldY > 2.63 && Math.abs(oldX) < .28) {
        const radius = Math.hypot(x / .185, (z - .035) / .16)
        if (radius > .01) { x /= radius; z = .035 + (z - .035) / radius; y = 2.78 }
      }
    }
    p.setXYZ(i, x, y, z)
    if (!geometry.morphTargetsRelative) for (const morph of geometry.morphAttributes.position ?? []) morph.setXYZ(i, morph.getX(i) + x - oldX, morph.getY(i) + y - oldY, morph.getZ(i) + z - oldZ)
  }
  // Apply body-build changes as smooth girth changes, rather than adding the
  // source skin's muscle/buttock grooves back onto the newly eased cloth.
  // Keep the original average outward displacement for each native-height band.
  const section = (i: number) => {
    const x = original[i * 3], y = original[i * 3 + 1], z = original[i * 3 + 2]
    if (kind !== 'trousers' && (Math.abs(x) >= .50 || y >= 2.60)) return null
    const centreX = kind === 'trousers' && y < 1.60 ? Math.sign(x || 1) * .205 : 0
    const dx = x - centreX, dz = z - .025, length = Math.hypot(dx, dz)
    if (length < .025) return null
    return { key: `${centreX}:${Math.floor(y / .12)}`, centreX, y, nx: dx / length, nz: dz / length }
  }
  for (const morph of geometry.morphAttributes.position ?? []) {
    const means = new Map<string, { sum: number; sumY: number; height: number; count: number }>()
    for (let i = 0; i < p.count; i++) {
      const region = section(i); if (!region) continue
      const dx = morph.getX(i) - (geometry.morphTargetsRelative ? 0 : p.getX(i))
      const dz = morph.getZ(i) - (geometry.morphTargetsRelative ? 0 : p.getZ(i))
      const entry = means.get(region.key) ?? { sum: 0, sumY: 0, height: 0, count: 0 }
      entry.sum += dx * region.nx + dz * region.nz
      entry.sumY += morph.getY(i) - (geometry.morphTargetsRelative ? 0 : p.getY(i))
      entry.height += region.y; entry.count++; means.set(region.key, entry)
    }
    for (let i = 0; i < p.count; i++) {
      const region = section(i); if (!region) continue
      const entry = means.get(region.key)!
      let amount = entry.sum / entry.count, vertical = entry.sumY / entry.count, blend = 1
      if (kind !== 'trousers') {
        // Continuous height filtering removes the old floor(y/.12) corrective
        // steps, whose normal discontinuities lit up as horizontal chest bands.
        // Each sampled band contributes equally, independent of panel density.
        let radialSum = 0, verticalSum = 0, total = 0
        for (const sample of means.values()) {
          const weight = Math.exp(-.5 * ((region.y - sample.height / sample.count) / .15) ** 2)
          radialSum += weight * sample.sum / sample.count
          verticalSum += weight * sample.sumY / sample.count; total += weight
        }
        amount = radialSum / total; vertical = verticalSum / total
        // Preserve the corrected shoulder seams and arm fit with a continuous
        // fade into their original morphs, rather than another hard cutoff.
        blend = (1 - THREE.MathUtils.smoothstep(Math.abs(original[i * 3]), .36, .50)) * (1 - THREE.MathUtils.smoothstep(region.y, 2.42, 2.60))
      }
      const x = p.getX(i) - region.centreX, z = p.getZ(i) - .025, length = Math.hypot(x, z) || 1
      morph.setX(i, mix(morph.getX(i), x / length * amount + (geometry.morphTargetsRelative ? 0 : p.getX(i)), blend))
      morph.setZ(i, mix(morph.getZ(i), z / length * amount + (geometry.morphTargetsRelative ? 0 : p.getZ(i)), blend))
      if (kind !== 'trousers') morph.setY(i, mix(morph.getY(i), vertical + (geometry.morphTargetsRelative ? 0 : p.getY(i)), blend))
    }
  }
  refreshGarmentNormals(geometry)
}

/** Rebuild base and corrective normals only after the final garment shape edit. */
function refreshGarmentNormals(geometry: THREE.BufferGeometry) {
  const p = geometry.getAttribute('position')
  geometry.computeVertexNormals()
  const baseNormal = geometry.getAttribute('normal')
  geometry.morphAttributes.normal = (geometry.morphAttributes.position ?? []).map(morph => {
    const target = new THREE.BufferGeometry(), positions = new Float32Array(p.count * 3)
    for (let i = 0; i < p.count; i++) for (let c = 0; c < 3; c++) positions[i * 3 + c] = component(morph, i, c) + (geometry.morphTargetsRelative ? component(p, i, c) : 0)
    target.setAttribute('position', new THREE.BufferAttribute(positions, 3)); target.setIndex(geometry.index!.clone()); target.computeVertexNormals()
    const normal = target.getAttribute('normal'), values = new Float32Array(p.count * 3)
    for (let i = 0; i < p.count; i++) for (let c = 0; c < 3; c++) values[i * 3 + c] = component(normal, i, c) - (geometry.morphTargetsRelative ? component(baseNormal, i, c) : 0)
    target.dispose(); return new THREE.BufferAttribute(values, 3)
  })
  geometry.computeBoundingBox(); geometry.computeBoundingSphere()
}

/** All shop variants are authored derivatives of the approved rig, with distinct garment silhouettes. */
export function buildGameCatalogGarments(body: THREE.SkinnedMesh, head: THREE.SkinnedMesh): StarterGarmentExport {
  const result = buildGameStarterGarments(body)
  const centre = (source: THREE.BufferGeometry, triangle: [number, number, number]) => {
    const p = source.getAttribute('position')
    return new THREE.Vector3(...([0, 1, 2].map(c => triangle.reduce((sum, i) => sum + component(p, i, c), 0) / 3) as [number, number, number]))
  }
  const select = (source: THREE.BufferGeometry, predicate: (p: THREE.Vector3) => boolean) => triangles(source).filter(triangle => predicate(centre(source, triangle)))
  const trouserFaces = select(body.geometry, p => p.y >= .19 && p.y < 2.02 && Math.abs(p.x) < .7)
  const capFaces = select(head.geometry, p => p.y > 3.27)
  const capBandFaces = select(head.geometry, p => p.y > 3.27 && p.y < 3.32)
  const template = (id: string) => result.garments.find(mesh => mesh.name === id)!
  const variants = [{ id: 'navy', colour: 0x26384d }, { id: 'cream', colour: 0xcdc4ac }, { id: 'wine', colour: 0x733e47 }]
  const material = (name: string, colour: THREE.ColorRepresentation) => {
    const mat = new THREE.MeshStandardMaterial({ color: colour, roughness: .98, side: THREE.DoubleSide }); mat.name = name; return mat
  }
  const add = (mesh: THREE.SkinnedMesh) => { mesh.userData.garmentAuthoring = { source: 'approved human5 rig', authoredFor: 'Darts World', runtimeCloth: false }; result.garments.push(mesh); return mesh.name }
  const shell = (source: THREE.SkinnedMesh, name: string, faces: [number, number, number][], offset: number, colour: THREE.ColorRepresentation) => {
    if (!faces.length) throw new Error(`Empty catalog garment: ${name}`)
    const mesh = skinnedPart(source, name, sliceGeometry(source.geometry, faces, offset, .022), material(name, colour))
    if (/^(hoodie|jacket|trousers)-/.test(name)) relaxGarmentSilhouette(mesh, name.startsWith('trousers-') ? 'trousers' : 'coat')
    if (name.endsWith('-waistband')) {
      const p = mesh.geometry.getAttribute('position'), n = mesh.geometry.getAttribute('normal')
      for (let i = 0; i < p.count; i++) p.setXYZ(i, p.getX(i) + n.getX(i) * .012, p.getY(i), p.getZ(i) + n.getZ(i) * .012)
    }
    return mesh
  }
  const prop = (source: THREE.SkinnedMesh, name: string, geometry: THREE.BufferGeometry, colour: THREE.ColorRepresentation) => {
    const mesh = bindFittedGarment(source, geometry, name, material(name, colour)); geometry.dispose(); return mesh
  }
  const box = (size: [number, number, number], at: [number, number, number]) => new THREE.BoxGeometry(...size).translate(...at)
  for (const variant of variants) {
    const shade = new THREE.Color(variant.colour), dark = shade.clone().multiplyScalar(.6), light = shade.clone().lerp(new THREE.Color(0xe5dfce), .24)
    const tshirt = `tshirt-${variant.id}`
    const teeMaterial = (template('starter-tee').material as THREE.MeshStandardMaterial).clone()
    teeMaterial.name = tshirt; teeMaterial.color.copy(shade)
    add(skinnedPart(body, tshirt, template('starter-tee').geometry.clone(), teeMaterial))
    result.manifestGarments[tshirt] = { meshes: [tshirt], hides: ['body-covered-top'] }

    const hoodie = `hoodie-${variant.id}`
    const hoodGeometry = new THREE.TorusGeometry(.235, .075, 6, 12, Math.PI * 1.55)
    hoodGeometry.rotateZ(Math.PI * .225); hoodGeometry.rotateX(Math.PI / 2); hoodGeometry.translate(0, 2.68, -.11)
    const hoodieMesh = buildPatternTop(body, hoodie, material(hoodie, shade), 'hoodie'); relaxGarmentSilhouette(hoodieMesh, 'coat')
    const hoodMeshes = [add(hoodieMesh),
      add(prop(body, `${hoodie}-folded-hood`, hoodGeometry, shade)),
      add(prop(body, `${hoodie}-pouch`, box([.34, .18, .018], [0, 2.14, .365]), shade.clone().multiplyScalar(.9)))]
    // A dark ribbed waistband is a separate surface, not merely a colour on the body.
    const ribFaces = select(body.geometry, p => p.y > 1.91 && p.y < 2.03 && Math.abs(p.x) < .7)
    hoodMeshes.push(add(shell(body, `${hoodie}-waistband`, ribFaces, .10, dark)))
    result.manifestGarments[hoodie] = { meshes: hoodMeshes, hides: ['body-covered-top', 'body-covered-sleeves'] }

    const jacket = `jacket-${variant.id}`
    const collar = new THREE.CylinderGeometry(.185, .24, .15, 12, 1, true).translate(0, 2.765, .025)
    const jacketMesh = buildPatternTop(body, jacket, material(jacket, shade), 'jacket'); relaxGarmentSilhouette(jacketMesh, 'coat')
    const jacketMeshes = [add(jacketMesh), add(prop(body, `${jacket}-collar`, collar, dark)), tshirt]
    for (const sign of [-1, 1]) {
      const lapel = new THREE.BoxGeometry(.075, .37, .035).rotateZ(-sign * .08).translate(sign * .165, 2.41, .365)
      jacketMeshes.push(add(prop(body, `${jacket}-lapel-${sign}`, lapel, light)))
    }
    result.manifestGarments[jacket] = { meshes: jacketMeshes, hides: ['body-covered-top', 'body-covered-sleeves'] }

    const trousers = `trousers-${variant.id}`
    const trouserMesh = shell(body, trousers, trouserFaces, .075, shade)
    // Ease the front rise: prevent the skin's anatomical contours reading through cloth.
    const tp = trouserMesh.geometry.getAttribute('position')
    for (let i = 0; i < tp.count; i++) if (tp.getY(i) > 1.62 && tp.getY(i) < 1.96 && Math.abs(tp.getX(i)) < .2 && tp.getZ(i) > .045) tp.setZ(i, Math.max(tp.getZ(i), .245))
    refreshGarmentNormals(trouserMesh.geometry)
    const trouserMeshes = [add(trouserMesh)]
    for (const sign of [-1, 1]) trouserMeshes.push(add(prop(body, `${trousers}-cargo-pocket-${sign}`, box([.028, .24, .19], [sign * .38, 1.40, .035]), shade.clone().multiplyScalar(.9))))
    result.manifestGarments[trousers] = { meshes: trouserMeshes, hides: ['body-covered-bottom'] }

    const trainers = `trainers-${variant.id}`
    const trainerMeshes = buildCleanTrainers(body, trainers, `${trainers}-soles`, shade, 0xc9c7b9).map(add)
    result.manifestGarments[trainers] = { meshes: trainerMeshes, hides: ['body-covered-shoes'] }

    const cap = `cap-${variant.id}`
    const brimShape = new THREE.Shape()
    brimShape.moveTo(-.235, 0); brimShape.quadraticCurveTo(-.30, .22, 0, .30); brimShape.quadraticCurveTo(.30, .22, .235, 0); brimShape.lineTo(-.235, 0)
    const brim = new THREE.ExtrudeGeometry(brimShape, { depth: .016, bevelEnabled: false, curveSegments: 6 }).rotateX(Math.PI / 2).translate(0, 3.29, .13)
    const capMeshes = [add(shell(head, cap, capFaces, .045, shade)), add(prop(head, `${cap}-brim`, brim, shade))]
    if (capBandFaces.length) capMeshes.push(add(shell(head, `${cap}-band`, capBandFaces, .055, dark)))
    // Export composition adds actual grooming mesh names here, so a cap hides intersecting hair.
    result.manifestGarments[cap] = { meshes: capMeshes, hides: [] }
  }
  // Variant colours change materials only. Share final immutable geometry so
  // GLTFExporter writes one accessor/buffer set per silhouette and detail.
  const geometries = new Map<string, THREE.BufferGeometry>([['tshirt', template('starter-tee').geometry]])
  for (const mesh of result.garments) {
    const key = mesh.name.replace(/-(navy|cream|wine)(?=-|$)/, '')
    const shared = geometries.get(key)
    if (shared && shared !== mesh.geometry) { mesh.geometry.dispose(); mesh.geometry = shared }
    else geometries.set(key, mesh.geometry)
  }
  result.stats.garmentTriangles = result.garments.reduce((sum, mesh) => sum + (mesh.geometry.index?.count ?? mesh.geometry.getAttribute('position').count) / 3, 0)
  return result
}
