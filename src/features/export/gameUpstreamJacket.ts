import * as THREE from 'three/webgpu'
import type { PatternDocument, PatternPanel, PatternPoint } from '../clothing/document/types'
import { authorUpstreamDemo } from './gameUpstreamGarment'
import { authorUpstreamHood } from './gameUpstreamHood'
import type { buildGameCatalogGarments } from './exportGameGarments'

/** Cut the original front into two real open panels. Original shoulder, arm,
 * underarm and side sewing edges remain attached to the original back panel. */
export function splitOpenJacketPattern(input: PatternDocument): PatternDocument {
  const document = structuredClone(input), front = document.panels['torso-front']
  if (!front || !document.panels['torso-back']) throw Error('Open jacket needs original torso panels')
  // Outerwear ease is an editor pattern operation, before simulation, not a
  // displacement of the finished mesh. It must fit around the real hoodie.
  for (const panel of Object.values(document.panels)) {
    for (const point of Object.values(panel.points)) {
      point.x *= 1.10
      if (point.in) point.in.x *= 1.10
      if (point.out) point.out.x *= 1.10
      if (point.id.endsWith('-hem')) point.y += .06 / .004
    }
    panel.placement.position.z = panel.id === 'torso-front' ? .52 : -.48
    const ys = Object.values(panel.points).map(point => point.y)
    panel.placement.position.y = 2.89 + (Math.min(...ys) - Math.max(...ys)) * .002 - 3.1
  }
  // The shallow demo back neck traps an inner hood beneath outerwear. Lower
  // only the original free cubic edge's handles; its shoulder seam endpoints
  // stay exactly paired. Equal control offsets lower the curve centre by .16.
  const backNeck=document.panels['torso-back']
  backNeck.points['torso-back-neck-left'].out!.y += .16 / (.004 * .75)
  backNeck.points['torso-back-neck-right'].in!.y += .16 / (.004 * .75)
  const makeHalf = (side: 'left' | 'right'): PatternPanel => {
    const sign = side === 'left' ? -1 : 1, id = `jacket-front-${side}`
    const suffixes = ['neck', 'shoulder', 'sleeve-top', 'sleeve-bottom', 'underarm', 'hem']
    const sourceId = (suffix: string) => suffix === 'neck' ? `torso-front-neck-${side}` : `torso-front-${side}-${suffix}`
    const ordered: PatternPoint[] = suffixes.map(suffix => ({...front.points[sourceId(suffix)], id:`${id}-${suffix}`}))
    ordered.push({id:`${id}-opening-hem`,x:sign*25,y:ordered[5].y,kind:'corner'}, {id:`${id}-opening-neck`,x:sign*25,y:ordered[0].y+20,kind:'corner'})
    const ids = [`${side}-shoulder`,`${side}-sleeve-top`,`${side}-sleeve-opening`,`${side}-sleeve-underarm`,`${side}-side`,'hem','opening','neck']
    // Each original panel is consistently wound; keep left seam direction as
    // authored so the compiler can establish matching edge correspondence.
    const edges = ordered.map((point,i)=>({id:ids[i],from:point.id,to:ordered[(i+1)%ordered.length].id,curve:'line' as const}))
    const points=Object.fromEntries(ordered.map(point=>[point.id,point]))
    const xs=ordered.map(point=>point.x),ys=ordered.map(point=>point.y),shoulder=ordered[1]
    const pins=[{id:`${id}-shoulder-pin`,u:(shoulder.x-Math.min(...xs))/(Math.max(...xs)-Math.min(...xs)),v:(shoulder.y-Math.min(...ys))/(Math.max(...ys)-Math.min(...ys)),weight:1}]
    return {...front,id,name:`Open jacket ${side} front`,points,edges,pins,placement:{position:{...front.placement.position,x:(Math.min(...xs)+Math.max(...xs))*.002},rotation:{...front.placement.rotation}}}
  }
  const back=document.panels['torso-back'],points=Object.values(back.points),xs=points.map(p=>p.x),ys=points.map(p=>p.y)
  back.pins=['left','right'].map(side=>{const shoulder=back.points[`torso-back-${side}-shoulder`];return{id:`back-${side}-shoulder-pin`,u:(shoulder.x-Math.min(...xs))/(Math.max(...xs)-Math.min(...xs)),v:(shoulder.y-Math.min(...ys))/(Math.max(...ys)-Math.min(...ys)),weight:1}})
  const left=makeHalf('left'),right=makeHalf('right')
  delete document.panels['torso-front'];document.panels[left.id]=left;document.panels[right.id]=right
  for(const seam of Object.values(document.seams))for(const endpoint of [seam.a,seam.b])if(endpoint.panelId==='torso-front')endpoint.panelId=endpoint.edgeId.startsWith('left-')?left.id:right.id
  document.id='game-open-layered-jacket';document.name='Original jacket panels, split open over hoodie'
  document.metadata={...document.metadata,construction:'Three cut panels; open centre front; original sleeve/side/shoulder seams; real hoodie collision underlayer'}
  return document
}

export async function authorUpstreamJacket(root: THREE.Object3D,body:THREE.SkinnedMesh,head:THREE.SkinnedMesh,underLayers:THREE.SkinnedMesh[]) {
  const hoodie=underLayers.find(mesh=>/^hoodie-(navy|cream|wine)$/.test(mesh.name))
  if(!hoodie)throw Error('Open jacket needs its authored hoodie body')
  const ranges=hoodie.geometry.userData.panelVertexRanges as {panelId:string;start:number;count:number}[],uv=hoodie.geometry.getAttribute('uv')
  const shoulderTarget=(back:boolean,sign:number)=>{
    const range=ranges.find(r=>r.panelId.includes(back?'back':'front'))!
    // Original hoodie shoulder: x±105.6, panel bounds±357.5; vertical
    // shoulder-to-neck14*heightScale, full edited panel height295.
    const targetU=.5+sign*105.6/715,targetV=(14*(.98/(378*.004)))/295
    let nearest=range.start,distance=Infinity
    for(let i=range.start;i<range.start+range.count;i++){
      const u=hoodie.geometry.userData.fabricAtlas?uv.getX(i)*2-(back?1:0):uv.getX(i),d=(u-targetU)**2+(uv.getY(i)-targetV)**2
      if(d<distance){distance=d;nearest=i}
    }
    const position=new THREE.Vector3().fromBufferAttribute(hoodie.geometry.getAttribute('position'),nearest)
    const normal=new THREE.Vector3().fromBufferAttribute(hoodie.geometry.getAttribute('normal'),nearest)
    if (normal.z * (back ? -1 : 1) < 0) normal.negate()
    normal.y = Math.max(normal.y, .35); normal.normalize()
    return position.addScaledVector(normal,.035).add(new THREE.Vector3(0,-3.1,0))
  }
  return authorUpstreamDemo(root,body,head,{fitToTorso:true,liftSleeves:true,casualEase:true,variant:'jacket',renderSubdivisions:12,maxAuthoringMs:60000,underLayers,editPattern:splitOpenJacketPattern,placeAuthoringPins:mesh=>{
    for(const pin of mesh.pinConstraints){const back=mesh.panelIds[pin.particle]==='torso-back',sign=back?(mesh.panelUvs[pin.particle*2]<.5?-1:1):mesh.panelIds[pin.particle].endsWith('left')?-1:1,target=shoulderTarget(back,sign);pin.x=target.x;pin.y=target.y;pin.z=target.z;target.toArray(mesh.positions,pin.particle*3);target.toArray(mesh.prevPositions,pin.particle*3)}
  }})
}

/** Independent UV atlas: subtle sewn opening edges, no painted fake gap. */
export function createOpenJacketFabric(geometry:THREE.BufferGeometry) {
  const ranges=geometry.userData.panelVertexRanges as {panelId:string;start:number;count:number}[]
  const uv=geometry.getAttribute('uv'),size=128,width=size*ranges.length,values=new Uint8Array(width*size*4)
  for(const[panel,range]of ranges.entries())for(let i=range.start;i<range.start+range.count;i++)uv.setX(i,(uv.getX(i)+panel)/ranges.length)
  for(let y=0;y<size;y++)for(let x=0;x<width;x++){
    const panel=Math.floor(x/size),u=(x%size)/(size-1),v=y/(size-1),id=ranges[panel].panelId
    let shade=246+Math.sin(x*1.5)*Math.sin(y*1.5)
    if(v>.975)shade*=.9
    if(id.includes('front')){
      const distance=id.endsWith('left')?1-u:u
      if(distance<.009&&v>.09)shade*=.72
      else if(distance<.021&&v>.09)shade*=.91
      if(v>.67&&v<.80&&Math.abs(distance-(.15+(v-.67)*.18))<.006)shade*=.72
    }
    const i=(y*width+x)*4;values[i]=values[i+1]=values[i+2]=Math.round(shade);values[i+3]=255
  }
  const map=new THREE.DataTexture(values,width,size,THREE.RGBAFormat);map.colorSpace=THREE.SRGBColorSpace;map.magFilter=THREE.LinearFilter;map.minFilter=THREE.LinearMipmapLinearFilter;map.generateMipmaps=true;map.needsUpdate=true;map.name='open-jacket-panel-cotton';uv.needsUpdate=true
  return map
}

/** Assemble the reviewed layered outfit while retaining standalone hoodie data. */
export async function authorLayeredJacketOutfit(root: THREE.Object3D, body: THREE.SkinnedMesh, head: THREE.SkinnedMesh, clothing: ReturnType<typeof buildGameCatalogGarments>, replaced: Set<THREE.BufferGeometry>) {
  const jacket = await authorUpstreamJacket(root, body, head, clothing.garments.filter(mesh => ['starter-trousers','hoodie-cream'].includes(mesh.name)))
  const jacketBounds = jacket.geometry.boundingBox!, jacketPositions = jacket.geometry.getAttribute('position'), jacketIndex = jacket.geometry.index!
  let longestEdge = 0
  for(let i=0;i<jacketIndex.count;i+=3)for(let c=0;c<3;c++){
    const a=jacketIndex.getX(i+c),b=jacketIndex.getX(i+(c+1)%3)
    longestEdge=Math.max(longestEdge,Math.hypot(jacketPositions.getX(a)-jacketPositions.getX(b),jacketPositions.getY(a)-jacketPositions.getY(b),jacketPositions.getZ(a)-jacketPositions.getZ(b)))
  }
  console.info('JACKET_STAGE',JSON.stringify({elapsedMs:jacket.report.elapsedMs,particles:jacket.report.particles,maxMovement:jacket.report.maxMovement,bounds:jacketBounds,longestEdge}))
  if (jacketBounds.min.y<1.4 || jacketBounds.max.y>3.2 || jacketBounds.min.x < -1.9 || jacketBounds.max.x>1.9 || jacketBounds.min.z<-.85 || jacketBounds.max.z>.85 || longestEdge>.35) throw new Error('Layered jacket exceeds sane torso bounds or has stretched triangles; hood stage skipped')

  const jacketFabric = createOpenJacketFabric(jacket.geometry)
  for (const colour of ['navy','cream','wine']) clothing.manifestGarments[`jacket-${colour}`].meshes = [`jacket-${colour}`, 'hoodie-cream', 'hoodie-cream-folded-hood']
  clothing.garments = clothing.garments.filter(mesh => {
    const keep=!mesh.name.startsWith('jacket-') || /^jacket-(navy|cream|wine)$/.test(mesh.name)
    if(!keep)replaced.add(mesh.geometry)
    return keep
  })
  for (const mesh of clothing.garments) if (/^jacket-(navy|cream|wine)$/.test(mesh.name)) {
    replaced.add(mesh.geometry); mesh.geometry = jacket.geometry
    const material = mesh.material as import('three/webgpu').MeshStandardMaterial
    material.map = jacketFabric; material.vertexColors = false
  }
  const outsideHood = await authorUpstreamHood(root, body, head, clothing.garments.find(mesh=>mesh.name==='hoodie-cream')!, [clothing.garments.find(mesh=>mesh.name==='jacket-navy')!], {maxAuthoringMs:60000})
  console.info('HOOD_STAGE',JSON.stringify({elapsedMs:outsideHood.report.elapsedMs,particles:outsideHood.report.particles,bounds:outsideHood.geometry.boundingBox,neckContinuity:outsideHood.report.neckContinuity}))
  // Jacket-specific hood shape keeps the separately equipped hoodie untouched.
  const baseHood = clothing.garments.find(mesh=>mesh.name==='hoodie-cream-folded-hood')!
  const jacketHood = baseHood.clone(); jacketHood.name='jacket-layered-hood'; jacketHood.geometry=outsideHood.geometry
  clothing.garments.push(jacketHood)
  // Fully covered inner sleeves need not render through independently skinned
  // outer sleeves. Keep the real open-front torso and collar; the standalone
  // hoodie retains its complete original geometry and garment binding.
  const innerHoodie=clothing.garments.find(mesh=>mesh.name==='hoodie-cream')!
  const jacketInner=innerHoodie.clone();jacketInner.name='jacket-inner-hoodie'
  jacketInner.geometry=innerHoodie.geometry.clone()
  const innerPositions=jacketInner.geometry.getAttribute('position'),innerIndex=jacketInner.geometry.index!,kept:number[]=[]
  for(let i=0;i<innerIndex.count;i+=3){
    const triangle=[innerIndex.getX(i),innerIndex.getX(i+1),innerIndex.getX(i+2)]
    const x=triangle.reduce((sum,v)=>sum+innerPositions.getX(v),0)/3,y=triangle.reduce((sum,v)=>sum+innerPositions.getY(v),0)/3
    if(!(Math.abs(x)>.32&&y>2.25))kept.push(...triangle)
  }
  jacketInner.geometry.setIndex(kept)
  clothing.garments.push(jacketInner)
  for(const colour of ['navy','cream','wine'])clothing.manifestGarments[`jacket-${colour}`].meshes=[`jacket-${colour}`,jacketInner.name,jacketHood.name]
  return { jacket: jacket.report, jacketHood: outsideHood.report }
}
