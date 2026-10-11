import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js'
import { prepareGameCharacter, exportGameCharacter } from './exportGameCharacter'
import { buildGameCatalogGarments } from './exportGameGarments'
import { buildGameGroom } from './gameGroom'
import { createGameAnimations } from './gameAnimations'
import { authorUpstreamDemo } from './gameUpstreamGarment'
import { createAuthoredGarmentFabric } from './gameGarmentMaterials'
import { authorUpstreamTrousers, createGameTrouserDocument } from './gameUpstreamTrousers'
import { createAuthoredTrouserFabric } from './gameTrouserMaterials'
import { authorUpstreamHood } from './gameUpstreamHood'

async function build() {
  const base = import.meta.env.BASE_URL
  const decoder = new DRACOLoader().setDecoderPath(`${base}node_modules/three/examples/jsm/libs/draco/gltf/`)
  const source = await new GLTFLoader().setDRACOLoader(decoder).loadAsync(`${base}human5.glb`)
  const prepared = await prepareGameCharacter(source.scene, { textureBaseUrl: base })
  const clothing = buildGameCatalogGarments(prepared.body, prepared.head)
  // Author with the original pattern compiler, sewing solver and renderer.
  // Only the resulting rigged mesh is exported; simulation stays offline.
  const reports: Record<string, Record<string, unknown>> = {}
  const replaced = new Set<import('three/webgpu').BufferGeometry>()
  const trousers = await authorUpstreamTrousers(prepared.root, prepared.body, prepared.head, { renderSubdivisions: 12 })
  reports.trousers = trousers.report
  const trouserFabric = createAuthoredTrouserFabric(trousers.geometry, createGameTrouserDocument())
  for (const colour of ['navy', 'cream', 'wine']) clothing.manifestGarments[`trousers-${colour}`].meshes = [`trousers-${colour}`]
  clothing.garments = clothing.garments.filter(mesh => {
    if (mesh.name.startsWith('trousers-') && !/^trousers-(navy|cream|wine)$/.test(mesh.name)) { replaced.add(mesh.geometry); return false }
    return true
  })
  for (const mesh of clothing.garments) if (mesh.name === 'starter-trousers' || /^trousers-(navy|cream|wine)$/.test(mesh.name)) {
    replaced.add(mesh.geometry); mesh.geometry = trousers.geometry
    mesh.userData.garmentAuthoring = { source: 'New four-panel PatternDocument through upstream compiler, sewing solver and render embedding', runtimeCloth: false }
    const material = mesh.material as import('three/webgpu').MeshStandardMaterial
    material.map = trouserFabric; material.vertexColors = false
  }
  for (const variant of ['tshirt', 'hoodie', 'jacket'] as const) {
    const authored = await authorUpstreamDemo(prepared.root, prepared.body, prepared.head, {
      fitToTorso: true, liftSleeves: true, casualEase: true, variant,
      underLayers: clothing.garments.filter(mesh => mesh.name === 'starter-trousers'),
      renderSubdivisions: 12,
    })
    reports[variant] = authored.report
    const fabric = createAuthoredGarmentFabric(authored.geometry, variant)
    if (variant !== 'tshirt') {
      for (const colour of ['navy', 'cream', 'wine']) {
        const id = `${variant}-${colour}`
        // Closed jackets have no intersecting inner tee or floating lapels.
        // The hood is authored against this final torso below.
        clothing.manifestGarments[id].meshes = variant === 'hoodie' ? [id, `${id}-folded-hood`] : [id]
      }
      clothing.garments = clothing.garments.filter(mesh => {
        const id = mesh.name.split('-').slice(0, 2).join('-')
        const keep = !mesh.name.startsWith(`${variant}-`) || clothing.manifestGarments[id]?.meshes.includes(mesh.name)
        if (!keep) replaced.add(mesh.geometry)
        return keep
      })
    }
    for (const mesh of clothing.garments) if ((variant === 'tshirt' && mesh.name === 'starter-tee') || new RegExp(`^${variant}-(navy|cream|wine)$`).test(mesh.name)) {
      replaced.add(mesh.geometry)
      mesh.geometry = authored.geometry
      mesh.userData.garmentAuthoring = { source: 'Upstream demo pattern with authored fit and sleeve changes, original sewing solver and render embedding', runtimeCloth: false }
      const material = mesh.material as import('three/webgpu').MeshStandardMaterial
      material.vertexColors = false
      if (fabric) material.map = fabric
    }
  }
  const hood = await authorUpstreamHood(prepared.root, prepared.body, prepared.head, clothing.garments.find(mesh => mesh.name === 'hoodie-navy')!)
  reports.hood = hood.report
  for (const mesh of clothing.garments) if (/^hoodie-(navy|cream|wine)-folded-hood$/.test(mesh.name)) {
    replaced.add(mesh.geometry); mesh.geometry = hood.geometry
    mesh.userData.garmentAuthoring = { source: 'New two-panel PatternDocument through upstream sewing solver, attached to authored torso collar', runtimeCloth: false }
  }
  for (const geometry of replaced) geometry.dispose()
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
    url: '/assets/character/vibe-human.glb',
    permissionRecord: 'User-relayed owner permission: “yes it is open source and you can use it for your app”; fork github.com/A7DC/vibe-human; see docs/character-integration.md',
    controls: { ...prepared.controls, ...groom.controls },
    garments: clothing.manifestGarments,
    animations: Object.fromEntries(animations.map(clip => [clip.name, clip.name])),
  }
  const garmentTriangles = clothing.garments.reduce((sum, mesh) => sum + (mesh.geometry.index?.count ?? mesh.geometry.getAttribute('position').count) / 3, 0)
  const result = { binary: Array.from(new Uint8Array(binary)), manifest, authoringReport: { ...reports.tshirt, additionalGarments: { hoodie: reports.hoodie, jacket: reports.jacket, trousers: reports.trousers, hood: reports.hood } }, metrics: { ...prepared.metrics, ...clothing.stats, garmentTriangles, groom: groom.stats, bytes: binary.byteLength } }
  Object.assign(window, { gameExport: result })
  document.querySelector('#status')!.textContent = JSON.stringify(result.metrics)
  for (const [label, filename, blob] of [
    ['Download character', 'vibe-human.glb', new Blob([binary], {type:'model/gltf-binary'})],
    ['Download manifest', 'manifest.json', new Blob([JSON.stringify(manifest,null,2)], {type:'application/json'})],
  ] as const) {
    const link = document.createElement('a'); link.textContent = label; link.download = filename
    link.href = URL.createObjectURL(blob); link.style.margin = '16px'; document.body.appendChild(link)
  }
}
build().catch(error => { Object.assign(window, { gameExportError: String(error.stack ?? error) }); document.querySelector('#status')!.textContent = String(error) })
