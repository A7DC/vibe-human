import * as THREE from 'three'
import { bindFittedGarment } from './exportGameGarments'
import { createDefaultGroomSettings, createDefaultHairMaterialSettings } from '../groom/core/groomAsset'
import { generateGuidesFromScalpSelection } from '../groom/core/guideCurves'
import { generateStrandsFromGuides } from '../groom/core/strandGeneration'
import { buildHairCardMesh } from '../groom/core/hairCardBuilder'
import type { GroomAsset, Vec3Tuple } from '../groom/core/types'

export type GameGroomExport = {
  meshes: THREE.SkinnedMesh[]
  controls: {
    hair: { choices: Record<'crop' | 'shaved' | 'sidepart', string[]> }
    facialHair: { choices: Record<'none' | 'stubble' | 'beard', string[]> }
    hairColour: { material: string; materials: string[] }
  }
  stats: { source: string; meshes: number; triangles: number; guides: number; strands: number; cards: number }
}

type Style = 'shaved' | 'crop' | 'sidepart' | 'stubble' | 'beard'
type Face = { id: number; vertices: number[]; center: THREE.Vector3; normal: THREE.Vector3 }

/** Position clustering is offline authoring: all resulting vertices are rebound
 * to the native head afterwards. The scalp shell carries the haircut silhouette. */
function simplifySurface(source: THREE.BufferGeometry, triangleLimit: number) {
  const sourcePositions=source.getAttribute('position'), sourceIndex=source.index!
  let cell=.012, result=source
  for(let attempt=0;attempt<18;attempt++,cell*=1.22) {
    const groups=new Map<string,{id:number;sum:THREE.Vector3;count:number}>(), remap:number[]=[]
    for(let i=0;i<sourcePositions.count;i++) {
      const p=new THREE.Vector3().fromBufferAttribute(sourcePositions,i)
      const key=`${Math.round(p.x/cell)},${Math.round(p.y/cell)},${Math.round(p.z/cell)}`
      let group=groups.get(key)
      if(!group){group={id:groups.size,sum:new THREE.Vector3(),count:0};groups.set(key,group)}
      group.sum.add(p);group.count++;remap.push(group.id)
    }
    const indices:number[]=[], used=new Set<string>()
    for(let i=0;i<sourceIndex.count;i+=3) {
      const triangle=[remap[sourceIndex.getX(i)],remap[sourceIndex.getX(i+1)],remap[sourceIndex.getX(i+2)]]
      if(new Set(triangle).size<3)continue
      const key=triangle.slice().sort((a,b)=>a-b).join(',')
      if(used.has(key))continue
      used.add(key);indices.push(...triangle)
    }
    if(indices.length/3>triangleLimit&&attempt<17)continue
    const positions=[...groups.values()].flatMap(group=>group.sum.multiplyScalar(1/group.count).toArray())
    result=new THREE.BufferGeometry();result.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));result.setIndex(indices)
    result.computeVertexNormals();source.dispose();break
  }
  return result
}

/** Retain only two representative cards per region, each two curved quads.
 * Upstream cards have duplicated back faces and six length segments; a two-sided
 * material supplies their backs and the short game hair needs only two segments. */
function compactCards(source: THREE.BufferGeometry, count: number) {
  const kept=Math.min(2,count), verticesPerCard=source.getAttribute('position').count/count
  const result=new THREE.BufferGeometry(), indices:number[]=[]
  for(const attributeName of ['position','normal','uv']) {
    const attribute=source.getAttribute(attributeName), values:number[]=[]
    for(let card=0;card<kept;card++) {
      const base=Math.floor((card+.5)*count/kept)*verticesPerCard
      for(const row of [0,3,6])for(const column of [0,2]) {
        const v=base+row*3+column
        values.push(attribute.getX(v),attribute.getY(v))
        if(attribute.itemSize===3)values.push(attribute.getZ(v))
      }
    }
    result.setAttribute(attributeName,new THREE.Float32BufferAttribute(values,attribute.itemSize))
  }
  for(let card=0;card<kept;card++)for(let row=0;row<2;row++) {
    const a=card*6+row*2;indices.push(a,a+1,a+2,a+1,a+3,a+2)
  }
  // Region fitting can make a card as wide as a whole temple. Keep only a
  // narrow ribbon around its guide; the continuous shell supplies coverage.
  const points=result.getAttribute('position')
  for(let i=0;i<points.count;i+=2) {
    const a=new THREE.Vector3().fromBufferAttribute(points,i), b=new THREE.Vector3().fromBufferAttribute(points,i+1)
    const midpoint=a.clone().add(b).multiplyScalar(.5), half=b.clone().sub(a).multiplyScalar(.5)
    half.clampLength(0,.014)
    points.setXYZ(i,...midpoint.clone().sub(half).toArray() as [number,number,number])
    points.setXYZ(i+1,...midpoint.clone().add(half).toArray() as [number,number,number])
  }
  result.setIndex(indices);source.dispose()
  return {geometry:result,cardCount:kept}
}

/** Offline-only authored grooms. Source head, guides and all card vertices stay
 * in native human5 coordinates until the exporter wraps the complete rig. */
export function buildGameGroom(head: THREE.SkinnedMesh): GameGroomExport {
  const source = head.geometry, position = source.getAttribute('position'), index = source.index
  if (!head.skeleton || !source.getAttribute('skinWeight')) throw new Error('Game groom requires the native skinned head')
  source.computeBoundingBox()
  if (source.boundingBox!.max.y < 3.35 || source.boundingBox!.max.y > 3.65) throw new Error('Game groom expects unscaled native human5 head geometry')
  if (!source.getAttribute('normal')) source.computeVertexNormals()
  const normal = source.getAttribute('normal')
  const faces: Face[] = []
  for (let i = 0; i < (index?.count ?? position.count); i += 3) {
    const vertices = [0, 1, 2].map(k => index ? index.getX(i + k) : i + k)
    const center = new THREE.Vector3(), outward = new THREE.Vector3()
    for (const v of vertices) { center.add(new THREE.Vector3().fromBufferAttribute(position, v)); outward.add(new THREE.Vector3().fromBufferAttribute(normal, v)) }
    faces.push({ id: i / 3, vertices, center: center.multiplyScalar(1 / 3), normal: outward.normalize() })
  }
  // Native +Z faces forward. The lower hairline wraps around the back while
  // the forehead and ears remain clear; sideburns end above the cheekbones.
  const scalp = faces.filter(({center:p,normal:n}) => {
    const line = p.z > .075 ? 3.34 : p.z > -.035 ? 3.245 : 3.16
    return p.y > line && !(Math.abs(p.x) > .145 && p.y < 3.285 && p.z > -.025) && n.y > -.48
  })
  const beard = faces.filter(({center:p,normal:n}) => p.y > 2.995 + .15 * Math.abs(p.x) && p.y < 3.195 && p.z > .07
    && Math.abs(p.x) < .158 && n.z > .12
    && p.y < 3.035 + .85 * Math.abs(p.x)
    && !(p.y > 3.075 && p.y < 3.135 && Math.abs(p.x) < .072)
    && !(p.y > 3.145 && Math.abs(p.x) < .048))
  if (scalp.length < 20 || beard.length < 10) throw new Error('Native head scalp/beard masks are empty')
  const shellMaterial = new THREE.MeshStandardMaterial({name:'GameHair',color:0x30251e,roughness:1,side:THREE.DoubleSide})
  // A low-resolution neutral comb map stays tintable by the hair-colour
  // control. The part is drawn on the closed scalp shell, never cut from it.
  const combCanvas=document.createElement('canvas');combCanvas.width=256;combCanvas.height=256
  const comb=combCanvas.getContext('2d')!
  comb.fillStyle='#eeeeee';comb.fillRect(0,0,256,256)
  comb.lineCap='round'
  for(let i=0;i<24;i++) {
    const row=30+i*8, part=98+(row-128)*.12
    comb.strokeStyle=i%3===0?'#b8b8b8':'#d0d0d0';comb.lineWidth=1.5
    comb.beginPath();comb.moveTo(part+4,row)
    comb.quadraticCurveTo(157,row-19,251,row+18);comb.stroke()
    comb.beginPath();comb.moveTo(part-4,row)
    comb.quadraticCurveTo(52,row+6,4,row+34);comb.stroke()
  }
  comb.strokeStyle='#888888';comb.lineWidth=4
  comb.beginPath();comb.moveTo(86,30);comb.quadraticCurveTo(98,126,111,230);comb.stroke()
  const combTexture=new THREE.CanvasTexture(combCanvas);combTexture.colorSpace=THREE.SRGBColorSpace
  const sidepartMaterial=new THREE.MeshStandardMaterial({name:'GameSidepart',color:0x30251e,roughness:1,side:THREE.DoubleSide,map:combTexture})
  const stubbleMaterial = new THREE.MeshStandardMaterial({name:'GameStubble',color:0x30251e,roughness:1,side:THREE.DoubleSide,transparent:true,opacity:.24,depthWrite:false})
  const beardMaterial = new THREE.MeshStandardMaterial({name:'GameBeard',color:0x30251e,roughness:1,side:THREE.DoubleSide,transparent:true,opacity:.82,depthWrite:false})
  const cardMaterial = new THREE.MeshStandardMaterial({name:'GameHairCards',color:0x30251e,roughness:1,side:THREE.DoubleSide,alphaTest:.38})
  const meshes: THREE.SkinnedMesh[] = []
  const choices: Record<Style,string[]> = {shaved:[],crop:[],sidepart:[],stubble:[],beard:[]}
  const stats = {source:'upstream scalp guides → strandGeneration → hairCardBuilder; native-head skin/morph binding',meshes:0,triangles:0,guides:0,strands:0,cards:0}
  const add = (geometry: THREE.BufferGeometry, name: string, style: Style, material: THREE.Material, sourceVertices?: number[]) => {
    let mesh: THREE.SkinnedMesh
    if(sourceVertices) {
      // Facial hair is a source-surface overlay: preserve exact vertex identity.
      // Decimation followed by nearest-point rebinding can switch jaw vertices
      // to the neck, producing hanging tabs when the head/body morphs shrink.
      const exact=geometry.clone()
      const copy=(attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute) => {
        const values:number[]=[]
        for(const v of sourceVertices)for(let c=0;c<attribute.itemSize;c++)values.push(attribute.getComponent(v,c))
        return new THREE.Float32BufferAttribute(values,attribute.itemSize)
      }
      const joints=copy(source.getAttribute('skinIndex'))
      exact.setAttribute('skinIndex',new THREE.Uint16BufferAttribute(joints.array,4))
      exact.setAttribute('skinWeight',copy(source.getAttribute('skinWeight')))
      exact.morphTargetsRelative=source.morphTargetsRelative
      for(const [attribute,targets] of Object.entries(source.morphAttributes)) {
        exact.morphAttributes[attribute as keyof typeof exact.morphAttributes]=targets.map(target=>{
          const result=copy(target)
          if(attribute==='position'&&!source.morphTargetsRelative)for(let i=0;i<sourceVertices.length;i++) {
            const v=sourceVertices[i]
            result.setXYZ(i,result.getX(i)+geometry.attributes.position.getX(i)-position.getX(v),result.getY(i)+geometry.attributes.position.getY(i)-position.getY(v),result.getZ(i)+geometry.attributes.position.getZ(i)-position.getZ(v))
          }
          return result
        })
      }
      mesh=new THREE.SkinnedMesh(exact,material);mesh.name=name
      mesh.position.copy(head.position);mesh.quaternion.copy(head.quaternion);mesh.scale.copy(head.scale)
      mesh.bindMode=head.bindMode;mesh.bind(head.skeleton,head.bindMatrix.clone());mesh.bindMatrixInverse.copy(head.bindMatrixInverse)
      mesh.morphTargetDictionary={...head.morphTargetDictionary};mesh.morphTargetInfluences=head.morphTargetInfluences?.slice()
      mesh.castShadow=true;mesh.receiveShadow=true
    }else mesh = bindFittedGarment(head,geometry,name,material)
    mesh.visible = style === 'crop'
    mesh.userData.groomAuthoring = {source:'vibe-human groom pipeline',style,runtimeSimulation:false}
    meshes.push(mesh);choices[style].push(name)
    stats.triangles += (geometry.index?.count ?? geometry.getAttribute('position').count) / 3
    geometry.dispose()
  }
  const shell = (selected: Face[], style: Style) => {
    const vertices: number[] = [], mapped = new Map<number,number>(), indices: number[] = []
    for (const face of selected) for (const v of face.vertices) {
      if (!mapped.has(v)) {mapped.set(v,vertices.length);vertices.push(v)}
      indices.push(mapped.get(v)!)
    }
    const points: number[] = [], normals: number[] = []
    for (const v of vertices) {
      const p = new THREE.Vector3().fromBufferAttribute(position,v), n = new THREE.Vector3().fromBufferAttribute(normal,v)
      const crown = THREE.MathUtils.smoothstep(p.y,3.31,3.47)
      const offset = style === 'shaved' ? .004 : style === 'crop' ? .024 + .019 * crown
        : style === 'sidepart' ? .024 + .044 * crown : style === 'stubble' ? .0025 : .0045
      p.addScaledVector(n,offset)
      if(style==='sidepart') {
        // Lift and sweep the long side away from the left-hand part. Preserve
        // the shell clearance so the asymmetric silhouette cannot expose skin.
        const swept=THREE.MathUtils.smoothstep(p.x,-.08,.08)
        p.x+=.038*crown
        p.y+=.044*crown*swept
      }
      points.push(...p.toArray());normals.push(...n.toArray())
    }
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position',new THREE.Float32BufferAttribute(points,3))
    geometry.setAttribute('normal',new THREE.Float32BufferAttribute(normals,3));geometry.setIndex(indices)
    const facial=style==='beard'||style==='stubble'
    const simplified=facial?geometry:simplifySurface(geometry,800)
    if(style==='sidepart') {
      const vertices=simplified.getAttribute('position'),uv:number[]=[]
      for(let i=0;i<vertices.count;i++)uv.push((vertices.getX(i)+.24)/.48,(vertices.getZ(i)+.24)/.48)
      simplified.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2))
    }
    add(simplified,`groom-${style}-base`,style,style==='stubble'?stubbleMaterial:style==='beard'?beardMaterial:style==='sidepart'?sidepartMaterial:shellMaterial,facial?vertices:undefined)
  }
  for (const style of ['crop','sidepart','stubble','beard'] as Style[]) {
    const selected = style === 'stubble' || style === 'beard' ? beard : scalp
    shell(selected,style)
    if (style === 'stubble' || style === 'beard') continue
    const settings = {...createDefaultGroomSettings(),guideLength:style==='sidepart'?.038:.025,
      guideSegments:4,strandDensity:.12,clumpStrength:.35,noiseAmplitude:.0008,curlStrength:0,frizzStrength:0,cutRandomness:.08}
    const materialSettings = {...createDefaultHairMaterialSettings(),melanin:0,melaninRedness:0,melaninRandomize:.03,rootDarken:.18}
    const triangleIds = selected.map(face=>face.id)
    const allGuides = generateGuidesFromScalpSelection(head,head.name,triangleIds,settings)
    const guides = allGuides.filter((_,i)=>i%Math.max(1,Math.ceil(allGuides.length/64))===0)
    // Comb the source guides before the existing strand interpolator runs.
    // Five small directional scalp regions stop the card fitter spanning
    // opposite sides of the head with a single sheet.
    for (const guide of guides) {
      const start = new THREE.Vector3(...guide.points[0])
      const face = faces[guide.root.triangleIndex]
      const direction = style === 'sidepart' ? face.normal.clone().multiplyScalar(.48).add(new THREE.Vector3(start.x < -.04 ? -.45 : .8, .13, -.30)).normalize()
        : face.normal.clone().multiplyScalar(.9).add(new THREE.Vector3(.08,.16,-.12)).normalize()
      const length = style === 'sidepart' ? settings.guideLength * (.38 + .62 * THREE.MathUtils.smoothstep(start.y,3.26,3.45)) : settings.guideLength
      guide.points = guide.points.map((_,i) => start.clone().addScaledVector(face.normal,.006)
        .addScaledVector(direction,length*i/(guide.points.length-1)).toArray() as Vec3Tuple)
      guide.length=length
    }
    const asset: GroomAsset = {id:`game-${style}`,name:`Game ${style}`,targetMeshId:head.name,
      scalpMask:{selectedTriangleIndices:triangleIds},guides,settings,material:materialSettings,version:1}
    const strands = generateStrandsFromGuides(asset,head)
    stats.guides += guides.length;stats.strands += strands.length
    const groups = new Map<string,typeof strands>()
    for (const strand of strands) {
      const [x,y,z] = strand.points[0]
      const region = y>3.39 ? 'crown' : Math.abs(x)>.105 ? (x>0?'left':'right') : z<.015?'back':'front'
      const group=groups.get(region)??[];group.push(strand);groups.set(region,group)
    }
    for (const [region,group] of groups) {
      if(region !== 'crown' && region !== 'front')continue
      const cards=buildHairCardMesh(group,0,materialSettings)
      if (!cards.cardCount) {cards.geometry.dispose();cards.atlas.dispose();continue}
      const compact=compactCards(cards.geometry,cards.cardCount)
      stats.cards+=compact.cardCount
      if (!cardMaterial.map) {
        const canvas=document.createElement('canvas');canvas.width=512;canvas.height=256
        canvas.getContext('2d')!.drawImage(cards.atlasCanvas,0,0,512,256)
        const atlas=new THREE.CanvasTexture(canvas);atlas.colorSpace=THREE.SRGBColorSpace
        atlas.magFilter=THREE.NearestFilter;atlas.minFilter=THREE.LinearMipmapLinearFilter
        cardMaterial.map=atlas
      }
      cards.atlas.dispose()
      add(compact.geometry,`groom-${style}-${region}-cards`,style,cardMaterial)
    }
  }
  stats.meshes=meshes.length
  return {meshes,controls:{hair:{choices:{crop:choices.crop,shaved:choices.shaved,sidepart:choices.sidepart}},
    facialHair:{choices:{none:[],stubble:choices.stubble,beard:choices.beard}},
    hairColour:{material:'GameHair',materials:['GameHairCards','GameStubble','GameBeard','GameSidepart']}},stats}
}
