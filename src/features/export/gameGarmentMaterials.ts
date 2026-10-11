import * as THREE from 'three/webgpu'

type FabricVariant = 'tshirt' | 'hoodie' | 'jacket'
type PanelRange = { panelId: string; start: number; count: number }
type Boundary = { ax: number; ay: number; bx: number; by: number; kind: 'neck' | 'cuff' | 'hem' | 'seam' }

/** Follow the original compiled panel perimeter, including its curved neck.
 * UV duplicates stay separate; no positions, skin weights or targets change.
 */
function panelBoundary(geometry: THREE.BufferGeometry, range: PanelRange): Boundary[] {
  const index = geometry.index, uv = geometry.getAttribute('uv')
  if (!index) throw new Error('Authored fabric requires indexed upstream panels')
  const edges = new Map<string, { a: number; b: number; count: number }>()
  for (let i = 0; i < index.count; i += 3) {
    const triangle = [index.getX(i), index.getX(i + 1), index.getX(i + 2)]
    if (triangle.some(v => v < range.start || v >= range.start + range.count)) continue
    for (let j = 0; j < 3; j++) {
      const a = triangle[j], b = triangle[(j + 1) % 3], key = `${Math.min(a, b)}:${Math.max(a, b)}`
      const edge = edges.get(key)
      if (edge) edge.count++
      else edges.set(key, { a, b, count: 1 })
    }
  }
  return [...edges.values()].filter(edge => edge.count === 1).map(({ a, b }) => {
    const ax = uv.getX(a), ay = uv.getY(a), bx = uv.getX(b), by = uv.getY(b)
    const kind = Math.min(ay, by) > .98 ? 'hem'
      : Math.min(ax, bx) > .34 && Math.max(ax, bx) < .66 && Math.max(ay, by) < .18 ? 'neck'
      : Math.max(ax, bx) < .09 || Math.min(ax, bx) > .91 ? 'cuff' : 'seam'
    return { ax, ay, bx, by, kind }
  })
}

/** Tint-neutral low-resolution cotton and construction marks on original UVs.
 * Atlas packing distinguishes front closure/pockets from the plain back.
 */
export function createAuthoredGarmentFabric(geometry: THREE.BufferGeometry, variant: FabricVariant) {
  const ranges = geometry.userData.panelVertexRanges as PanelRange[] | undefined
  if (!ranges) throw new Error('Authored garment panel ranges are required for fabric detail')
  if (geometry.userData.fabricAtlas) throw new Error('Garment UV atlas was already packed')
  const boundaries = new Map(ranges.map(range => [range.panelId.includes('back'), panelBoundary(geometry, range)]))
  const uv = geometry.getAttribute('uv')
  for (const range of ranges) for (let i = range.start; i < range.start + range.count; i++) uv.setX(i, uv.getX(i) * .5 + (range.panelId.includes('back') ? .5 : 0))
  uv.needsUpdate = true
  geometry.userData.fabricAtlas = variant
  const width = 512, height = 256, values = new Uint8Array(width * height * 4)
  // Original flat panel width/height proportions keep trim widths consistent.
  const aspect = variant === 'tshirt' ? 1.57 / 1.18 : 2.86 / 1.18
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const u = (x % 256) / 255, v = y / 255, front = x < 256
    // Small woven variation, deliberately below the contrast of the stitching.
    const weave = Math.sin(x * Math.PI * .5) * Math.sin(y * Math.PI * .5)
    let shade = 246 + weave * 1.2 + Math.sin(u * 29 + v * 7) * .7
    let nearest = Infinity, kind: Boundary['kind'] = 'seam'
    for (const edge of boundaries.get(!front) ?? []) {
      const dx = (edge.bx - edge.ax) * aspect, dy = edge.by - edge.ay
      const px = (u - edge.ax) * aspect, py = v - edge.ay
      const t = Math.max(0, Math.min(1, (px * dx + py * dy) / Math.max(1e-12, dx * dx + dy * dy)))
      const distance = Math.hypot(px - dx * t, py - dy * t)
      if (distance < nearest) { nearest = distance; kind = edge.kind }
    }
    const ribWidth = kind === 'neck' ? .017 : kind === 'cuff' && variant !== 'tshirt' ? .026 : 0
    if (nearest < ribWidth) shade *= .84 + .035 * Math.cos((kind === 'cuff' ? v : u) * 920)
    // Turned cotton hems/cuffs and sewn panel joins, never heavy black outlines.
    if (kind === 'hem' || kind === 'cuff' && variant === 'tshirt') {
      if (nearest < .004) shade *= .92
      if (Math.abs(nearest - .012) < .002 || Math.abs(nearest - .019) < .0016) shade *= .88
    } else if (kind === 'seam' && nearest < .003) shade *= .94
    if (ribWidth && Math.abs(nearest - ribWidth) < .002) shade *= .92
    if (front && variant === 'jacket') {
      if (Math.abs(u - .5) < .005 && v > .025 && v < .982) shade *= y % 4 < 2 ? .55 : .70
      for (const sign of [-1, 1]) if (v > .73 && v < .88 && Math.abs(u - (.5 + sign * (.062 + (v - .73) * .08))) < .004) shade *= .70
    }
    if (front && variant === 'hoodie') {
      const side = .088 - Math.max(0, .83 - v) * .2
      if (v > .76 && v < .925 && Math.abs(u - .5) < side) shade *= .97
      if (v > .76 && v < .86 && Math.abs(Math.abs(u - .5) - side) < .0035) shade *= .76
      if (Math.abs(v - .925) < .002 && Math.abs(u - .5) < side) shade *= .92
    }
    const offset = (y * width + x) * 4
    values[offset] = values[offset + 1] = values[offset + 2] = Math.round(shade); values[offset + 3] = 255
  }
  const texture = new THREE.DataTexture(values, width, height, THREE.RGBAFormat)
  texture.name = `${variant}-authored-panel-cotton`; texture.colorSpace = THREE.SRGBColorSpace; texture.magFilter = THREE.LinearFilter; texture.minFilter = THREE.LinearMipmapLinearFilter; texture.generateMipmaps = true; texture.needsUpdate = true
  return texture
}
