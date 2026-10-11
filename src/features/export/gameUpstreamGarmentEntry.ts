import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js'
import { prepareGameCharacter, exportGameCharacter } from './exportGameCharacter'
import { buildGameCatalogGarments } from './exportGameGarments'
import { createAuthoredGarmentFabric } from './gameGarmentMaterials'
import { authorUpstreamHood } from './gameUpstreamHood'
import { authorUpstreamDemo } from './gameUpstreamGarment'
import { buildGameGroom } from './gameGroom'
import { createGameAnimations } from './gameAnimations'

async function build() {
  const base = import.meta.env.BASE_URL
  const decoder = new DRACOLoader().setDecoderPath(`${base}node_modules/three/examples/jsm/libs/draco/gltf/`)
  const source = await new GLTFLoader().setDRACOLoader(decoder).loadAsync(`${base}human5.glb`)
  const prepared = await prepareGameCharacter(source.scene, { textureBaseUrl: base })
  const clothing = buildGameCatalogGarments(prepared.body, prepared.head)
  const variant = new URLSearchParams(location.search).get('variant') as 'tshirt' | 'hoodie' | 'jacket' | null
  const candidate = await authorUpstreamDemo(prepared.root, prepared.body, prepared.head, { fitToTorso: !!new URLSearchParams(location.search).get('fit'), liftSleeves: Number(new URLSearchParams(location.search).get('fit')) >= 2, casualEase: Number(new URLSearchParams(location.search).get('fit')) >= 3, underLayers: new URLSearchParams(location.search).get('bodyOnly') === '1' ? [] : clothing.garments.filter(mesh => mesh.name === 'starter-trousers'), renderSubdivisions: Number(new URLSearchParams(location.search).get('density')) || 30, variant: variant ?? 'tshirt', thinLayers: new URLSearchParams(location.search).get('solidLayers') !== '1' })
  if (variant === 'jacket' || variant === 'hoodie') {
    for (const colour of ['navy', 'cream', 'wine']) {
      const id = `${variant}-${colour}`
      clothing.manifestGarments[id].meshes = variant === 'jacket' ? [id] : [id, `${id}-folded-hood`]
    }
    clothing.garments = clothing.garments.filter(mesh => !mesh.name.startsWith(`${variant}-`) || clothing.manifestGarments[mesh.name.split('-').slice(0,2).join('-')]?.meshes.includes(mesh.name))
  }
  const cottonMap = (clothing.garments.find(mesh => mesh.name === 'starter-tee')!.material as import('three/webgpu').MeshStandardMaterial).map
  const authoredMap = variant === 'jacket' || variant === 'hoodie' ? createAuthoredGarmentFabric(candidate.geometry, variant) : cottonMap
  for (const mesh of clothing.garments) if (variant === 'jacket' || variant === 'hoodie' ? new RegExp(`^${variant}-(navy|cream|wine)$`).test(mesh.name) : mesh.name === 'starter-tee' || mesh.name.startsWith('tshirt-')) {
    mesh.geometry = candidate.geometry
    const material = mesh.material as import('three/webgpu').MeshStandardMaterial
    material.map = authoredMap
    material.vertexColors = false // Keep neutral cotton map; upstream panel UVs remain intact.
  }
  if (variant === 'hoodie' && new URLSearchParams(location.search).get('sewnHood') === '1') {
    const hood = await authorUpstreamHood(prepared.root, prepared.body, prepared.head, clothing.garments.find(mesh => mesh.name === 'hoodie-navy')!)
    for (const mesh of clothing.garments) if (/^hoodie-(navy|cream|wine)-folded-hood$/.test(mesh.name)) mesh.geometry = hood.geometry
    Object.assign(candidate.report, { hood: hood.report })
  }
  prepared.body.parent!.add(...clothing.bodyRegions, ...clothing.garments)
  prepared.body.removeFromParent()
  prepared.controls.build.mesh = 'body-exposed'
  const groom = buildGameGroom(prepared.head)
  prepared.head.parent!.add(...groom.meshes)
  for (const [id, binding] of Object.entries(clothing.manifestGarments)) {
    if (id.startsWith('cap-')) binding.hides.push(...Object.values(groom.controls.hair.choices).flat())
  }
  const animations = createGameAnimations(prepared.root)
  const binary = await exportGameCharacter(prepared.root, { animations })
  decoder.dispose()
  const manifest = {
    url: '/assets/character/upstream-garment.glb',
    permissionRecord: 'User-relayed owner permission: “yes it is open source and you can use it for your app”; fork github.com/A7DC/vibe-human; see docs/character-integration.md',
    controls: { ...prepared.controls, ...groom.controls },
    garments: clothing.manifestGarments,
    animations: Object.fromEntries(animations.map(clip => [clip.name, clip.name])),
  }
  const result = { authoringReport: candidate.report, binary: Array.from(new Uint8Array(binary)), manifest, metrics: { ...prepared.metrics, ...clothing.stats, groom: groom.stats, bytes: binary.byteLength } }
  Object.assign(window, { gameUpstreamGarment: result })
  document.querySelector('#status')!.textContent = JSON.stringify(result.metrics)
  for (const [label, filename, blob] of [
    ['Download character', 'upstream-garment.glb', new Blob([binary], {type:'model/gltf-binary'})],
    ['Download manifest', 'upstream-garment-manifest.json', new Blob([JSON.stringify(manifest,null,2)], {type:'application/json'})],
  ] as const) {
    const link = document.createElement('a'); link.textContent = label; link.download = filename
    link.href = URL.createObjectURL(blob); link.style.margin = '16px'; document.body.appendChild(link)
  }
}
build().catch(error => { Object.assign(window, { gameUpstreamGarmentError: String(error.stack ?? error) }); document.querySelector('#status')!.textContent = String(error) })
