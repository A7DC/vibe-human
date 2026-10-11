import * as THREE from 'three/webgpu'

/** Restrained fabric construction marks in the original draped panel UVs.
 * Atlas packing distinguishes the front closure from the unmarked back.
 */
export function createAuthoredGarmentFabric(geometry: THREE.BufferGeometry, variant: 'hoodie' | 'jacket') {
  const ranges = geometry.userData.panelVertexRanges as { panelId: string; start: number; count: number }[] | undefined
  if (!ranges) throw new Error('Authored garment panel ranges are required for fabric detail')
  if (geometry.userData.fabricAtlas) throw new Error('Garment UV atlas was already packed')
  const uv = geometry.getAttribute('uv')
  for (const range of ranges) for (let i = range.start; i < range.start + range.count; i++) uv.setX(i, uv.getX(i) * .5 + (range.panelId.includes('back') ? .5 : 0))
  geometry.userData.fabricAtlas = variant
  const width = 512, height = 256, values = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const u = (x % 256) / 255, v = y / 255, front = x < 256
    let shade = 244 + ((x * 17 + y * 31) % 5 - 2)
    // Narrow knit cuffs and turned hem; no dark silhouette outlines.
    if (u < .012 || u > .988 || v > .974) shade *= .82
    if (v < .042 && Math.abs(u - .5) < .058) shade *= .72
    if (front && variant === 'jacket') {
      if (Math.abs(u - .5) < .006 && v > .025 && v < .982) shade *= (y % 4 < 2 ? .50 : .67)
      // Two slanted welt-pocket openings, carried by the draped surface.
      for (const sign of [-1, 1]) if (v > .73 && v < .88 && Math.abs(u - (.5 + sign * (.062 + (v - .73) * .08))) < .006) shade *= .68
    }
    if (front && variant === 'hoodie') {
      const side = .088 - Math.max(0, .83 - v) * .2
      if (v > .76 && v < .925 && Math.abs(u - .5) < side) shade *= .95
      if (v > .76 && v < .86 && Math.abs(Math.abs(u - .5) - side) < .005) shade *= .72
    }
    const offset = (y * width + x) * 4
    values[offset] = values[offset + 1] = values[offset + 2] = Math.round(shade); values[offset + 3] = 255
  }
  const texture = new THREE.DataTexture(values, width, height, THREE.RGBAFormat)
  texture.name = `${variant}-authored-panel-cotton`; texture.colorSpace = THREE.SRGBColorSpace; texture.magFilter = THREE.LinearFilter; texture.minFilter = THREE.LinearMipmapLinearFilter; texture.generateMipmaps = true; texture.needsUpdate = true
  return texture
}
