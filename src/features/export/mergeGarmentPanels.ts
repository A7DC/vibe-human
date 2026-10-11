import * as THREE from 'three/webgpu'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'

/** Preserve the morph space: Three validates this flag but drops it on merge. */
export function mergeGarmentPanels(panels: THREE.BufferGeometry[]) {
  const merged = mergeGeometries(panels)
  if (!merged) throw new Error('Garment panels have incompatible vertex/morph attributes')
  merged.morphTargetsRelative = panels[0].morphTargetsRelative
  return merged
}
