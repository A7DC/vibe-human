import * as THREE from 'three'
import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'

/** Separate game path: session exports remain posed/static; this retains the live rig. */
export const GAME_MORPHS = [
  'id.body.global.mass.neg', 'id.body.global.mass.pos',
  'id.skull.lowerJaw.width.neg', 'id.skull.lowerJaw.width.pos',
] as const

export type GameCharacterOptions = {
  textureBaseUrl?: string
  height?: number
  morphTargets?: readonly string[]
}

export type PreparedGameCharacter = {
  root: THREE.Group
  body: THREE.SkinnedMesh
  head: THREE.SkinnedMesh
  controls: {
    build: { mesh: string; positive: string; negative: string }
    faceWidth: { mesh: string; positive: string; negative: string }
    skinTone: { material: string; materials: string[] }
    eyeColour: { material: string }
  }
  metrics: { vertices: number; triangles: number; joints: number; height: number; morphTargets: number }
}

async function smallAlbedo(url: string, limit: number): Promise<THREE.CanvasTexture> {
  const texture = await new THREE.TextureLoader().loadAsync(url)
  const source = texture.image as HTMLImageElement
  const ratio = Math.min(1, limit / Math.max(source.width, source.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(source.width * ratio))
  canvas.height = Math.max(1, Math.round(source.height * ratio))
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas texture conversion is unavailable')
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height)
  texture.dispose()
  const result = new THREE.CanvasTexture(canvas)
  result.colorSpace = THREE.SRGBColorSpace
  result.flipY = false
  result.magFilter = THREE.NearestFilter
  result.minFilter = THREE.NearestMipmapNearestFilter
  return result
}

/** The selected skin tint supplies hue; source maps supply restrained surface detail. */
function neutralizeSkinAlbedo(texture: THREE.CanvasTexture): void {
  const canvas = texture.image as HTMLCanvasElement
  const ctx = canvas.getContext('2d')!
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const luminances: number[] = []
  for (let i = 0; i < pixels.data.length; i += 4) {
    const l = (.2126 * pixels.data[i] + .7152 * pixels.data[i + 1] + .0722 * pixels.data[i + 2]) / 255
    if (l > .025 && pixels.data[i + 3] > 0) luminances.push(l)
  }
  luminances.sort((a, b) => a - b)
  const median = luminances[Math.floor(luminances.length / 2)] ?? .5
  for (let i = 0; i < pixels.data.length; i += 4) {
    const l = (.2126 * pixels.data[i] + .7152 * pixels.data[i + 1] + .0722 * pixels.data[i + 2]) / 255
    const ratio = l / Math.max(.025, median)
    // Keep painted cavities dark; compress the remaining baked lighting into detail.
    const neutral = ratio < .15 ? ratio * .7 : .88 * Math.pow(ratio, .55)
    const grey = Math.round(255 * Math.min(.99, Math.max(0, neutral)))
    pixels.data[i] = pixels.data[i + 1] = pixels.data[i + 2] = grey
  }
  ctx.putImageData(pixels, 0, 0)
  texture.needsUpdate = true
}

/** Eye atlas fronts occupy two discs; tint only their iris pixels, never sclera. */
function irisAlbedo(source: THREE.CanvasTexture): THREE.CanvasTexture {
  const image = source.image as HTMLCanvasElement
  const canvas = document.createElement('canvas')
  canvas.width = image.width; canvas.height = image.height
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(image, 0, 0)
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height)
  // Coordinates measured on upstream eyes.png, expressed independently of downsampling.
  const centres = [[.251, .399], [.728, .399]]
  const radius = .111
  for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
    const u = (x + .5) / canvas.width, v = (y + .5) / canvas.height
    const distance = Math.min(...centres.map(([cx, cy]) => Math.hypot(u - cx, v - cy)))
    const i = (y * canvas.width + x) * 4
    if (distance >= radius) { pixels.data[i + 3] = 0; continue }
    const luminance = (.2126 * pixels.data[i] + .7152 * pixels.data[i + 1] + .0722 * pixels.data[i + 2]) / 255
    // Keep the pupil black and lift iris fibres so the selected tint reads visibly.
    const grey = luminance < .035 ? 0 : Math.round(255 * Math.min(1, Math.sqrt(luminance) * 1.65))
    pixels.data[i] = pixels.data[i + 1] = pixels.data[i + 2] = grey
    pixels.data[i + 3] = 255
  }
  ctx.putImageData(pixels, 0, 0)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.flipY = false
  texture.magFilter = THREE.NearestFilter
  texture.minFilter = THREE.NearestMipmapNearestFilter
  return texture
}

/** Pass the raw loaded human5 GLTF scene, before authoring view offsets or simulation. */
export async function prepareGameCharacter(source: THREE.Object3D, options: GameCharacterOptions = {}): Promise<PreparedGameCharacter> {
  const height = options.height ?? 1.78
  if (!Number.isFinite(height) || height <= 0) throw new Error('Invalid character height')
  source.updateMatrixWorld(true)
  const model = cloneSkeleton(source)
  model.name = 'VibeHumanGameRig'
  // The source argument is a GLTF scene; presentation transforms are not exported.
  model.position.set(0, 0, 0)
  model.quaternion.identity()
  model.scale.set(1, 1, 1)
  const skins: THREE.SkinnedMesh[] = []
  const meshes: THREE.Mesh[] = []
  const skeletons = new Set<THREE.Skeleton>()
  const retained = new Set(options.morphTargets ?? GAME_MORPHS)
  model.traverse(object => {
    const mesh = object as THREE.Mesh
    if (!mesh.isMesh) return
    meshes.push(mesh)
    // Clone all geometry: morph pruning must never mutate the authoring scene.
    mesh.geometry = mesh.geometry.clone()
    const names = Object.entries(mesh.morphTargetDictionary ?? {}).filter(([name]) => retained.has(name))
    const indices = names.map(([, index]) => index)
    const attributes = mesh.geometry.morphAttributes as Record<string, THREE.BufferAttribute[]>
    for (const key of Object.keys(attributes)) attributes[key] = indices.map(index => attributes[key][index])
    mesh.morphTargetDictionary = Object.fromEntries(names.map(([name], i) => [name, i]))
    mesh.morphTargetInfluences = names.map(() => 0)
    if ((mesh as THREE.SkinnedMesh).isSkinnedMesh) {
      skins.push(mesh as THREE.SkinnedMesh)
      skeletons.add((mesh as THREE.SkinnedMesh).skeleton)
    }
  })
  if (skins.length !== 2) throw new Error(`Expected human5 body/head primitives; found ${skins.length}`)
  for (const skeleton of skeletons) skeleton.pose()
  model.updateMatrixWorld(true)
  const sorted = skins.sort((a, b) => {
    a.geometry.computeBoundingBox(); b.geometry.computeBoundingBox()
    return a.geometry.boundingBox!.min.y - b.geometry.boundingBox!.min.y
  })
  const [body, head] = sorted
  body.name = 'GameBody'; head.name = 'GameHead'
  for (const target of ['id.body.global.mass.neg', 'id.body.global.mass.pos']) if (body.morphTargetDictionary?.[target] === undefined) throw new Error(`Missing body morph: ${target}`)
  for (const target of ['id.skull.lowerJaw.width.neg', 'id.skull.lowerJaw.width.pos']) if (head.morphTargetDictionary?.[target] === undefined) throw new Error(`Missing face morph: ${target}`)
  const base = (options.textureBaseUrl ?? '/').replace(/\/?$/, '/')
  const maps = await Promise.all([
    smallAlbedo(`${base}textures/colorfinal4k.jpg`, 512),
    smallAlbedo(`${base}textures/body/albedo.png`, 512),
    smallAlbedo(`${base}textures/eyes.png`, 256),
  ])
  neutralizeSkinAlbedo(maps[0])
  neutralizeSkinAlbedo(maps[1])
  head.material = new THREE.MeshStandardMaterial({ name: 'GameSkinHead', map: maps[0], roughness: .94, metalness: 0 })
  body.material = new THREE.MeshStandardMaterial({ name: 'GameSkinBody', map: maps[1], roughness: .94, metalness: 0 })
  const eyeMaterial = new THREE.MeshStandardMaterial({ name: 'GameSclera', map: maps[2], roughness: .64, metalness: 0 })
  const irisMaterial = new THREE.MeshStandardMaterial({
    name: 'GameEyes', map: irisAlbedo(maps[2]), roughness: .64, metalness: 0,
    alphaTest: .5,
  })
  const irises: THREE.Mesh[] = []
  let eyeCount = 0
  for (const mesh of meshes) {
    if (mesh === body || mesh === head) continue
    if (!/^Eye_[LR]$/.test(mesh.name)) throw new Error(`Unexpected mesh in raw human5 export: ${mesh.name}`)
    mesh.name = mesh.name.endsWith('L') ? 'GameEyeL' : 'GameEyeR'
    mesh.material = eyeMaterial
    const iris = new THREE.Mesh(mesh.geometry, irisMaterial)
    iris.name = `${mesh.name}Iris`
    iris.scale.setScalar(1.006) // Actual clearance survives GLTF; renderOrder/polygonOffset do not.
    // Same eye node, UVs and rig attachment; alpha clips the overlay to iris only.
    mesh.add(iris)
    irises.push(iris)
    eyeCount++
  }
  meshes.push(...irises)
  if (eyeCount !== 2) throw new Error('Both eye meshes must remain attached to their original rig nodes')
  const bounds = new THREE.Box3().setFromObject(model, true)
  const nativeHeight = bounds.max.y - bounds.min.y
  if (!(nativeHeight > 0)) throw new Error('Character has no measurable height')
  const scale = height / nativeHeight
  const root = new THREE.Group()
  root.name = 'GameCharacter'
  root.rotation.y = Math.PI // human5 faces +Z; game locomotion faces -Z.
  root.scale.setScalar(scale)
  model.position.y -= bounds.min.y
  root.add(model)
  root.updateMatrixWorld(true)
  let vertices = 0, triangles = 0
  for (const mesh of meshes) {
    vertices += mesh.geometry.getAttribute('position').count
    triangles += (mesh.geometry.index?.count ?? mesh.geometry.getAttribute('position').count) / 3
  }
  return {
    root, body, head,
    controls: {
      build: { mesh: body.name, negative: GAME_MORPHS[0], positive: GAME_MORPHS[1] },
      faceWidth: { mesh: head.name, negative: GAME_MORPHS[2], positive: GAME_MORPHS[3] },
      skinTone: { material: 'GameSkinHead', materials: ['GameSkinBody'] },
      eyeColour: { material: 'GameEyes' },
    },
    metrics: { vertices, triangles, joints: body.skeleton.bones.length, height, morphTargets: retained.size },
  }
}

/** Add fitted rigged garments and in-place clips before serializing. No flattening. */
export async function exportGameCharacter(root: THREE.Object3D, options: { animations: THREE.AnimationClip[] }): Promise<ArrayBuffer> {
  const names = new Set(options.animations.filter(clip => clip.tracks.length).map(clip => clip.name))
  for (const required of ['idle', 'walk', 'run', 'crouch', 'jump']) if (!names.has(required)) throw new Error(`Missing in-place game animation: ${required}`)
  root.updateMatrixWorld(true)
  const result = await new GLTFExporter().parseAsync(root, {
    binary: true, onlyVisible: false, trs: true, animations: options.animations,
    maxTextureSize: 512,
  })
  if (!(result instanceof ArrayBuffer)) throw new Error('Expected binary game GLB')
  return result
}
