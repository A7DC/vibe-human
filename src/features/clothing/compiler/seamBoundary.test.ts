import test from 'node:test'
import assert from 'node:assert/strict'
import { createDemoGarment, DEMO_GARMENT_PLACEMENTS } from '../demo/createDemoGarment'
import { toPatternDocument } from '../document/legacyAdapter'
import { compileGarmentRuntime } from './compileGarmentRuntime'
import { buildSeamConstraints } from './buildSeamConstraints'
import type { CompiledPanelSimMesh } from './buildPanelSimMesh'
import type { PatternDocument, PatternPanel } from '../document/types'

function boundaryVertices(triangles: Uint32Array) {
  const edges=new Map<string,number>()
  for(let i=0;i<triangles.length;i+=3)for(let j=0;j<3;j++){
    const a=triangles[i+j],b=triangles[i+(j+1)%3],key=[a,b].sort((a,b)=>a-b).join(':')
    edges.set(key,(edges.get(key)??0)+1)
  }
  return new Set([...edges].filter(([,count])=>count===1).flatMap(([key])=>key.split(':').map(Number)))
}
function panel(id:string,z:number):PatternPanel {
  return {id,name:id,points:{a:{id:'a',x:0,y:0,kind:'corner'},b:{id:'b',x:100,y:0,kind:'corner'},c:{id:'c',x:100,y:100,kind:'corner'},d:{id:'d',x:0,y:100,kind:'corner'}},edges:[{id:'top',from:'a',to:'b',curve:'line'},{id:'right',from:'b',to:'c',curve:'line'},{id:'bottom',from:'c',to:'d',curve:'line'},{id:'left',from:'d',to:'a',curve:'line'}],closed:true,particleDistance:12,placement:{position:{x:0,y:0,z},rotation:{x:0,y:0,z:0}}}
}
function document(a:PatternPanel,b:PatternPanel):PatternDocument {
  return {id:'test',name:'test',panels:{[a.id]:a,[b.id]:b},seams:{join:{id:'join',name:'join',a:{panelId:a.id,edgeId:'top'},b:{panelId:b.id,edgeId:'top'},strength:1}}}
}
test('authored tee sewing constrains outline vertices, never nearby interior rows',()=>{
  const garment=createDemoGarment()
  for(const p of Object.values(garment.patterns))for(const side of ['left','right'])p.points[`${p.id}-${side}-sleeve-top`].y=p.points[`${p.id}-${side}-shoulder`].y
  const runtime=compileGarmentRuntime(toPatternDocument(garment,DEMO_GARMENT_PLACEMENTS),{quality:'high',seamSamples:18,renderSubdivisions:1}).value
  const boundary=boundaryVertices(runtime.simMesh.triangles)
  const interior=runtime.simMesh.seamConstraints.flatMap(c=>[c.a,c.b]).filter(i=>!boundary.has(i))
  assert.deepEqual(interior,[])
  const simUv=runtime.simMesh.panelUvs
  for(let i=0;i<runtime.simMesh.triangles.length;i+=3){
    const [a,b,c]=Array.from(runtime.simMesh.triangles.subarray(i,i+3))
    const area=(simUv[b*2]-simUv[a*2])*(simUv[c*2+1]-simUv[a*2+1])-(simUv[c*2]-simUv[a*2])*(simUv[b*2+1]-simUv[a*2+1])
    assert.ok(Math.abs(area)>1e-9,'simulation triangles must not trigger degenerate embedding fallback')
  }
  for(const panel of runtime.renderPanels)for(let v=0;v<panel.panelUvs.length/2;v++){
    let u=0,w=0
    for(let c=0;c<3;c++){
      const i=panel.embedding.simTriangles[v*3+c],weight=panel.embedding.barycentrics[v*3+c]
      assert.ok(weight>=-1e-4,'render outline must be supported without extrapolation')
      u+=simUv[i*2]*weight;w+=simUv[i*2+1]*weight
    }
    assert.ok(Math.hypot(u-panel.panelUvs[v*2],w-panel.panelUvs[v*2+1])<1e-6)
  }
})
test('unequal seam densities cover both complete edges in monotonic order',()=>{
  const a=panel('a',0),b=panel('b',1)
  const make=(count:number,offset:number):CompiledPanelSimMesh=>{
    const local=Array.from({length:count},(_,i)=>[100*i/(count-1),0]);local.push([50,100])
    const triangles=[];for(let i=0;i<count-1;i++)triangles.push(offset+i,offset+i+1,offset+count)
    return {panelInfo:{particleIndices:local.map((_,i)=>offset+i),triangleIndices:new Uint32Array(triangles)},panelLocalPositions:local.flat(),positions:local.flatMap(([x,y])=>[x*.004,y*.004,offset?1:0])} as CompiledPanelSimMesh
  }
  for(const [na,nb]of [[3,6],[6,3]]){
    const ma=make(na,0),mb=make(nb,na+1),constraints=buildSeamConstraints(document(a,b),{a:ma,b:mb},18)
    assert.equal(constraints.length,Math.max(na,nb))
    assert.deepEqual([...new Set(constraints.map(c=>c.a))].sort((a,b)=>a-b),Array.from({length:na},(_,i)=>i))
    assert.deepEqual([...new Set(constraints.map(c=>c.b))].sort((a,b)=>a-b),Array.from({length:nb},(_,i)=>na+1+i))
  }
})
test('curved seams retain actual curved boundary samples',()=>{
  const a=panel('a',0),b=panel('b',1)
  for(const p of [a,b]){p.edges[0].curve='cubic';p.points.a.out={x:20,y:-35};p.points.b.in={x:80,y:-35}}
  const runtime=compileGarmentRuntime(document(a,b),{quality:'medium',seamSamples:18,renderSubdivisions:1}).value
  const boundary=boundaryVertices(runtime.simMesh.triangles)
  assert.ok(runtime.simMesh.seamConstraints.length>8)
  for(const c of runtime.simMesh.seamConstraints){assert.ok(boundary.has(c.a)&&boundary.has(c.b));assert.ok(Math.abs(c.rest-1)<1e-6)}
})

test('nonuniform seam spacing cannot leave shorter-edge particles unsewn',()=>{
  const make=(samples:number[],offset:number):CompiledPanelSimMesh=>{
    const local=samples.map(t=>[100*t,0]);local.push([50,100]);const count=samples.length
    const triangles=[];for(let i=0;i<count-1;i++)triangles.push(offset+i,offset+i+1,offset+count)
    return {panelInfo:{particleIndices:local.map((_,i)=>offset+i),triangleIndices:new Uint32Array(triangles)},panelLocalPositions:local.flat(),positions:local.flatMap(([x,y])=>[x*.004,y*.004,offset?1:0])} as CompiledPanelSimMesh
  }
  const a=panel('a',0),b=panel('b',1),ma=make([0,.01,.02,1],0),mb=make([0,.3,.6,1],5)
  const constraints=buildSeamConstraints(document(a,b),{a:ma,b:mb},18)
  assert.deepEqual([...new Set(constraints.map(c=>c.a))].sort((a,b)=>a-b),[0,1,2,3])
  assert.deepEqual([...new Set(constraints.map(c=>c.b))].sort((a,b)=>a-b),[5,6,7,8])
})
