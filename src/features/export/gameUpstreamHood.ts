import * as THREE from 'three/webgpu'
import type { PatternDocument, PatternPanel } from '../clothing/document/types'
import { compileGarmentRuntime } from '../clothing/compiler/compileGarmentRuntime'
import { SOLVER_PRESETS, applyDocumentPlacements, refreshSeamPlacementRest, createRenderPanelEntry, updateRenderPanels } from '../clothing/rendering/useGarmentSimulation'
import { XPBDClothSolver } from '../clothing/simulation/solver'
import { rebuildAvatarMeshCollider } from '../clothing/avatar-collision/AvatarCollisionRegistry'
import { bindFittedGarment } from './exportGameGarments'
import { mergeGarmentPanels } from './mergeGarmentPanels'
import { bindSewnRenderSeams } from './exportSewnSeams'

type CollarPoint = { position: THREE.Vector3; vertex: number; distance: number; order?: number }
function collarArc(geometry: THREE.BufferGeometry, sign: number): CollarPoint[] {
  const uv = geometry.getAttribute('uv'), position = geometry.getAttribute('position'), index = geometry.index!
  const ranges = geometry.userData.panelVertexRanges as {panelId:string;start:number;count:number}[]
  const points: CollarPoint[] = []
  for (const range of ranges) {
    const edges = new Map<string,{a:number;b:number;count:number}>()
    for(let i=0;i<index.count;i+=3){const t=[index.getX(i),index.getX(i+1),index.getX(i+2)];if(t.some(v=>v<range.start||v>=range.start+range.count))continue
      for(let c=0;c<3;c++){const a=t[c],b=t[(c+1)%3],key=`${Math.min(a,b)}:${Math.max(a,b)}`,edge=edges.get(key);if(edge)edge.count++;else edges.set(key,{a,b,count:1})}}
    const unpack = (i:number) => geometry.userData.fabricAtlas ? uv.getX(i)*2-(range.panelId.includes('back')?1:0) : uv.getX(i)
    for(const edge of edges.values())if(edge.count===1 && [edge.a,edge.b].every(i=>Math.abs(unpack(i)-.5)<.0616 && uv.getY(i)<.12))for(const vertex of [edge.a,edge.b]){
      const p=new THREE.Vector3().fromBufferAttribute(position,vertex)
      const u=unpack(vertex)
      if((u-.5)*sign<-.00001 || points.some(q=>q.position.distanceTo(p)<.0001))continue
      points.push({position:p,vertex,distance:0,order:range.panelId.includes('back')?.124-Math.abs(u-.5):Math.abs(u-.5)})
    }
  }
  if(points.length<5)throw Error(`Hood needs the authored collar arc (${points.length} samples)`)
  points.sort((a,b)=>a.order!-b.order!)
  for(let i=1;i<points.length;i++)points[i].distance=points[i-1].distance+points[i].position.distanceTo(points[i-1].position)
  return points
}
function sampleCollar(arc:CollarPoint[],t:number){
  const distance=Math.max(0,Math.min(1,t))*arc.at(-1)!.distance
  const b=Math.max(1,arc.findIndex(point=>point.distance>=distance)),a=b-1
  const amount=(distance-arc[a].distance)/Math.max(1e-9,arc[b].distance-arc[a].distance)
  return {position:arc[a].position.clone().lerp(arc[b].position,amount),a:arc[a].vertex,b:arc[b].vertex,amount}
}

function assertNeckContinuity(value: { positionMax: number; correctiveMax: number; influenceMax: number; vertices: number }) {
  const errors = [value.positionMax, value.correctiveMax, value.influenceMax]
  if (value.vertices < 2 || errors.some(error => !Number.isFinite(error) || error > 1e-4)) {
    throw new Error(`Hood collar continuity failed: ${JSON.stringify(value)}`)
  }
}

/** Two mirrored cut panels, sewn by the original compiler/solver. Neckline pins
 * are offline authoring attachments; exported cloth follows the existing rig. */
export async function authorUpstreamHood(root: THREE.Object3D, body: THREE.SkinnedMesh, head: THREE.SkinnedMesh, hoodie: THREE.SkinnedMesh) {
  const arcs = {'hood-left':collarArc(hoodie.geometry,-1),'hood-right':collarArc(hoodie.geometry,1)}
  const panel = (id: keyof typeof arcs, sign: number): PatternPanel => {
    const base = arcs[id].at(-1)!.distance / .004
    if(base>=162.5)throw Error('Measured hood collar arc exceeds authored side-panel width')
    const outline = [[0, 0], [base, 0], [162.5, 70], [130, 150], [0, 130]]
    return { id, name: id, points: Object.fromEntries(outline.map(([x,y],i)=>[`${id}-${i}`, {id:`${id}-${i}`,x,y,kind:'corner' as const}])), edges: outline.map((_,i)=>({id:`edge-${i}`,from:`${id}-${i}`,to:`${id}-${(i+1)%outline.length}`,curve:'line' as const})), closed:true, particleDistance:12, stretchCompliance:.0001, shearCompliance:.00016, bendCompliance:.12, damping:.08,
      placement:{position:{x:sign*.22,y:2.59-3.1,z:-.35},rotation:{x:0,y:Math.PI/2,z:0}},
      pins:Array.from({length:9},(_,i)=>({id:`${id}-neck-${i}`,u:i/8*base/162.5,v:0,weight:1})) }
  }
  const panels = { 'hood-left':panel('hood-left',-1), 'hood-right':panel('hood-right',1) }
  const document: PatternDocument = {id:'game-sewn-hood',name:'Two-panel folded hood',panels,seams:Object.fromEntries([1,2].map(i=>[`hood-centre-${i}`,{id:`hood-centre-${i}`,name:'Hood centre seam',a:{panelId:'hood-left',edgeId:`edge-${i}`},b:{panelId:'hood-right',edgeId:`edge-${i}`},strength:1}]))}
  const compiled = compileGarmentRuntime(document,{quality:'high',seamSamples:18,renderSubdivisions:12})
  if(compiled.issues.some(issue=>issue.severity==='error'))throw Error(JSON.stringify(compiled.issues))
  const runtime=compiled.value, mesh=runtime.simMesh, entries=runtime.renderPanels.map(createRenderPanelEntry)
  applyDocumentPlacements(mesh,document);refreshSeamPlacementRest(mesh)
  const saved={scale:root.scale.clone(),quaternion:root.quaternion.clone(),position:root.position.clone(),modelPosition:root.children[0].position.clone(),parent:hoodie.parent}
  const temporaryGeometries = new Set(entries.map(entry => entry.geometry))
  const temporaryMaterials = new Set<THREE.Material>()
  let mergedGeometry: THREE.BufferGeometry | undefined
  let completed = false
  body.parent!.add(hoodie)
  try {
    root.scale.setScalar(1);root.quaternion.identity();root.position.set(0,-3.1,0);root.children[0].position.set(0,0,0);root.updateMatrixWorld(true);body.skeleton.update()
    for(const pin of mesh.pinConstraints){
      const id=mesh.panelIds[pin.particle] as keyof typeof arcs, arc=arcs[id]
      const base=arc.at(-1)!.distance/.004, t=mesh.panelUvs[pin.particle*2]*162.5/base
      const target=sampleCollar(arc,t).position.applyMatrix4(body.matrixWorld)
      pin.x=target.x;pin.y=target.y;pin.z=target.z
      target.toArray(mesh.positions,pin.particle*3);target.toArray(mesh.prevPositions,pin.particle*3)
    }
    refreshSeamPlacementRest(mesh)
    const avatar=rebuildAvatarMeshCollider([body,head],null,{id:'hood.body',skinOffset:.012,garmentThickness:.006,friction:.55,cellSize:.09,triangleStride:1})!
    const layer=rebuildAvatarMeshCollider([hoodie],null,{id:'hood.layer',skinOffset:.012,garmentThickness:.006,friction:.55,cellSize:.09,triangleStride:1})!
    const snapshot={version:1,proxies:[],meshColliders:[avatar.snapshot],lowResMeshPatches:[{...layer.snapshot,region:'chest' as const}]}
    const solver=new XPBDClothSolver(mesh,{...SOLVER_PRESETS.high,damping:.08,gravityDelayTime:.65})
    const started=performance.now();let maxMovement=0
    for(let step=0;step<240;step++){
      if(performance.now()-started>20000)throw Error('Hood authoring exceeded20 seconds before240 steps')
      const previous=new Float32Array(mesh.positions);solver.step(snapshot);maxMovement=0
      for(let i=0;i<mesh.positions.length;i++){if(!Number.isFinite(mesh.positions[i]))throw Error('Hood drape diverged');maxMovement=Math.max(maxMovement,Math.abs(mesh.positions[i]-previous[i]))}
      if(step%3===0)await new Promise(resolve=>setTimeout(resolve,0))
    }
    updateRenderPanels(runtime,entries,mesh.positions)
    const inverse=body.matrixWorld.clone().invert(),p=new THREE.Vector3()
    const geometries = entries.map(entry => {
      const position = entry.geometry.getAttribute('position')
      for (let i = 0; i < position.count; i++) { p.fromBufferAttribute(position, i).applyMatrix4(inverse); position.setXYZ(i, p.x, p.y, p.z) }
      const material = new THREE.MeshStandardMaterial()
      temporaryMaterials.add(material)
      const bound = bindFittedGarment(body, entry.geometry, entry.panel.panelId, material, 8)
      temporaryGeometries.add(bound.geometry)
      return bound.geometry
    })
    // Freeze the neck edge to the same collar positions/weights/correctives as
    // the actual torso, preserving a continuous attachment during animation.
    geometries.forEach((geometry,side)=>{
      const id=runtime.renderPanels[side].panelId as keyof typeof arcs,arc=arcs[id],uv=geometry.getAttribute('uv'),position=geometry.getAttribute('position')
      for(let i=0;i<position.count;i++)if(uv.getY(i)<.00001){
        const sample=sampleCollar(arc,uv.getX(i)*.65/arc.at(-1)!.distance)
        position.setXYZ(i,sample.position.x,sample.position.y,sample.position.z)
        const weights=new Map<number,number>(),sourceIndices=hoodie.geometry.getAttribute('skinIndex'),sourceWeights=hoodie.geometry.getAttribute('skinWeight')
        for(const [vertex,amount]of [[sample.a,1-sample.amount],[sample.b,sample.amount]])for(let c=0;c<4;c++){const bone=sourceIndices.array[vertex*4+c];weights.set(bone,(weights.get(bone)??0)+sourceWeights.array[vertex*4+c]*amount)}
        const strongest=[...weights].sort((a,b)=>b[1]-a[1]).slice(0,4),total=strongest.reduce((sum,e)=>sum+e[1],0)
        for(let c=0;c<4;c++){geometry.getAttribute('skinIndex').array[i*4+c]=strongest[c]?.[0]??0;geometry.getAttribute('skinWeight').array[i*4+c]=(strongest[c]?.[1]??0)/total}
        for(let m=0;m<(geometry.morphAttributes.position?.length??0);m++){const source=hoodie.geometry.morphAttributes.position![m],target=geometry.morphAttributes.position![m];target.setXYZ(i,source.getX(sample.a)*(1-sample.amount)+source.getX(sample.b)*sample.amount,source.getY(sample.a)*(1-sample.amount)+source.getY(sample.b)*sample.amount,source.getZ(sample.a)*(1-sample.amount)+source.getZ(sample.b)*sample.amount)}
      }
    })
    const geometry=mergedGeometry=mergeGarmentPanels(geometries),seams=bindSewnRenderSeams(geometry,document,runtime.renderPanels)
    const neckContinuity = { positionMax:0, correctiveMax:0, influenceMax:0, vertices:0 }
    let panelOffset = 0
    for(const renderPanel of runtime.renderPanels){
      const arc=arcs[renderPanel.panelId as keyof typeof arcs]
      for(let local=0;local<renderPanel.panelUvs.length/2;local++)if(renderPanel.panelUvs[local*2+1]<.00001){
        const i=panelOffset+local,sample=sampleCollar(arc,renderPanel.panelUvs[local*2]*.65/arc.at(-1)!.distance)
        neckContinuity.vertices++
        neckContinuity.positionMax=Math.max(neckContinuity.positionMax,new THREE.Vector3().fromBufferAttribute(geometry.getAttribute('position'),i).distanceTo(sample.position))
        const expected=new Map<number,number>(),actual=new Map<number,number>()
        for(const [vertex,amount]of [[sample.a,1-sample.amount],[sample.b,sample.amount]])for(let c=0;c<4;c++){const bone=hoodie.geometry.getAttribute('skinIndex').array[vertex*4+c];expected.set(bone,(expected.get(bone)??0)+hoodie.geometry.getAttribute('skinWeight').array[vertex*4+c]*amount)}
        for(let c=0;c<4;c++){const bone=geometry.getAttribute('skinIndex').array[i*4+c];actual.set(bone,(actual.get(bone)??0)+geometry.getAttribute('skinWeight').array[i*4+c])}
        for(const bone of new Set([...expected.keys(),...actual.keys()]))neckContinuity.influenceMax=Math.max(neckContinuity.influenceMax,Math.abs((expected.get(bone)??0)-(actual.get(bone)??0)))
        for(let m=0;m<(geometry.morphAttributes.position?.length??0);m++){
          const source=hoodie.geometry.morphAttributes.position![m],target=new THREE.Vector3().fromBufferAttribute(source,sample.a).lerp(new THREE.Vector3().fromBufferAttribute(source,sample.b),sample.amount)
          neckContinuity.correctiveMax=Math.max(neckContinuity.correctiveMax,target.distanceTo(new THREE.Vector3().fromBufferAttribute(geometry.morphAttributes.position![m],i)))
        }
      }
      panelOffset+=renderPanel.panelUvs.length/2
    }
    assertNeckContinuity(neckContinuity)
    // Seam freezing changes the base and corrective positions; derive normals
    // from those final surfaces rather than retaining pre-sewing shading.
    geometry.computeVertexNormals()
    const basePosition = geometry.getAttribute('position'), baseNormal = geometry.getAttribute('normal')
    geometry.morphAttributes.normal = (geometry.morphAttributes.position ?? []).map(morph => {
      const target = new THREE.BufferGeometry(), positions = new Float32Array(basePosition.count * 3)
      for (let i = 0; i < basePosition.count; i++) {
        positions[i*3] = basePosition.getX(i) + morph.getX(i)
        positions[i*3+1] = basePosition.getY(i) + morph.getY(i)
        positions[i*3+2] = basePosition.getZ(i) + morph.getZ(i)
      }
      target.setAttribute('position',new THREE.BufferAttribute(positions,3));target.setIndex(geometry.index!.clone());target.computeVertexNormals()
      const normal = target.getAttribute('normal'), values = new Float32Array(positions.length)
      for (let i = 0; i < basePosition.count; i++) {
        values[i*3] = normal.getX(i) - baseNormal.getX(i)
        values[i*3+1] = normal.getY(i) - baseNormal.getY(i)
        values[i*3+2] = normal.getZ(i) - baseNormal.getZ(i)
      }
      target.dispose();return new THREE.BufferAttribute(values,3)
    })
    // Hood UVs remain independent of torso atlas packing.

    geometry.computeBoundingBox();geometry.computeBoundingSphere()
    const result = {geometry,report:{pipeline:'Original PatternDocument mirrored panels → compileGarmentRuntime → XPBDClothSolver → renderer embedding',steps:240,elapsedMs:performance.now()-started,maxMovement,particles:mesh.particleCount,triangles:geometry.index!.count/3,seams,neckContinuity,neckPins:mesh.pinConstraints.length,collarArcs:Object.fromEntries(Object.entries(arcs).map(([id,arc])=>[id,{samples:arc.length,length:arc.at(-1)!.distance}])),document,limitations:['Neutral authoring drape, not runtime cloth or proven convergence','Neckline authoring pins follow actual torso collar; exported boundary shares interpolated collar rig/morphs but remains separate topology','Candidate requires back/front and body-extreme motion review']}}
    completed = true
    return result
  } finally {
    for (const geometry of temporaryGeometries) geometry.dispose()
    for (const material of temporaryMaterials) material.dispose()
    if (!completed) mergedGeometry?.dispose()
    hoodie.removeFromParent();saved.parent?.add(hoodie);root.scale.copy(saved.scale);root.quaternion.copy(saved.quaternion);root.position.copy(saved.position);root.children[0].position.copy(saved.modelPosition);root.updateMatrixWorld(true);body.skeleton.update()}
}
