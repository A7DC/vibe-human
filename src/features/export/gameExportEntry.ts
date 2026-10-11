import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js'
import { prepareGameCharacter, exportGameCharacter } from './exportGameCharacter'
import { buildGameCatalogGarments } from './exportGameGarments'
import { buildGameGroom } from './gameGroom'
import { createGameAnimations } from './gameAnimations'

async function build() {
  const base = import.meta.env.BASE_URL
  const decoder = new DRACOLoader().setDecoderPath(`${base}node_modules/three/examples/jsm/libs/draco/gltf/`)
  const source = await new GLTFLoader().setDRACOLoader(decoder).loadAsync(`${base}human5.glb`)
  const prepared = await prepareGameCharacter(source.scene, { textureBaseUrl: base })
  const clothing = buildGameCatalogGarments(prepared.body, prepared.head)
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
  const result = { binary: Array.from(new Uint8Array(binary)), manifest, metrics: { ...prepared.metrics, ...clothing.stats, groom: groom.stats, bytes: binary.byteLength } }
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
