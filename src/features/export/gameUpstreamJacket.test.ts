import test from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three/webgpu'
import { createDemoGarment, DEMO_GARMENT_PLACEMENTS } from '../clothing/demo/createDemoGarment'
import { toPatternDocument } from '../clothing/document/legacyAdapter'
import { compileGarmentRuntime } from '../clothing/compiler/compileGarmentRuntime'
import { splitOpenJacketPattern, clipCoveredInnerHoodie } from './gameUpstreamJacket'
import { bindSewnRenderSeams } from './exportSewnSeams'

test('split original jacket preserves eight conforming seams while leaving two real front openings', () => {
  const original=toPatternDocument(createDemoGarment(),DEMO_GARMENT_PLACEMENTS),saved=JSON.stringify(original)
  const document=splitOpenJacketPattern(original)
  assert.equal(JSON.stringify(original),saved)
  assert.equal(Object.keys(document.panels).length,3)
  assert.equal(Object.keys(document.seams).length,8)
  // Lower the free back neckline without changing its sewn endpoints.
  for(const side of ['left','right']) {
    const id=`torso-back-neck-${side}`,actual=document.panels['torso-back'].points[id],before=original.panels['torso-back'].points[id]
    assert.equal(actual.y,before.y)
    assert.equal(actual.x,before.x*1.10)
    const handle=side==='left'?'out':'in'
    assert.ok(Math.abs(actual[handle]!.y-before[handle]!.y-.16/(.004*.75))<1e-9)
  }
  assert.ok(Object.values(document.seams).every(seam=>seam.a.edgeId!=='opening'&&seam.b.edgeId!=='opening'))
  const compiled=compileGarmentRuntime(document,{quality:'high',seamSamples:18,renderSubdivisions:12})
  assert.deepEqual(compiled.issues.filter(issue=>issue.severity==='error'),[])
  assert.equal(compiled.value.renderPanels.length,3)
  assert.equal(compiled.value.simMesh.pinConstraints.length,4)
  assert.ok(compiled.value.simMesh.pinConstraints.every(pin=>[pin.x,pin.y,pin.z,pin.stiffness].every(Number.isFinite)))
  const count=compiled.value.renderPanels.reduce((sum,p)=>sum+p.panelUvs.length/2,0),geometry=new THREE.BufferGeometry()
  geometry.setAttribute('position',new THREE.BufferAttribute(new Float32Array(count*3),3))
  geometry.setAttribute('skinIndex',new THREE.BufferAttribute(new Uint16Array(count*4),4))
  const weights=new Float32Array(count*4);for(let i=0;i<count;i++)weights[i*4]=1
  geometry.setAttribute('skinWeight',new THREE.BufferAttribute(weights,4));geometry.morphAttributes.position=[]
  assert.ok(bindSewnRenderSeams(geometry,document,compiled.value.renderPanels).pairs>80)
  for(const side of ['left','right']){
    const panel=document.panels[`jacket-front-${side}`],opening=panel.edges.find(edge=>edge.id==='opening')!
    assert.equal(Math.abs(panel.points[opening.from].x),25)
    assert.equal(Math.abs(panel.points[opening.to].x),25)
  }
})


test('hidden inner cut deforms continuously across different joints and relative correctives', () => {
  const source=new THREE.BufferGeometry()
  source.setAttribute('position',new THREE.Float32BufferAttribute([.2,2.6,.1, .45,2.6,.1, .2,2.8,.1],3))
  source.setAttribute('uv',new THREE.Float32BufferAttribute([.2,.4, .3,.4, .2,.5],2))
  source.setAttribute('skinIndex',new THREE.Uint16BufferAttribute([0,0,0,0, 1,0,0,0, 0,0,0,0],4))
  source.setAttribute('skinWeight',new THREE.Float32BufferAttribute([1,0,0,0, 1,0,0,0, 1,0,0,0],4))
  source.morphTargetsRelative=true
  source.morphAttributes.position=[new THREE.Float32BufferAttribute([.02,0,0, .04,0,0, .02,0,0],3)]
  source.setIndex([0,1,2])
  const saved=Array.from(source.getAttribute('position').array),clipped=clipCoveredInnerHoodie(source)
  assert.deepEqual(Array.from(source.getAttribute('position').array),saved)
  assert.deepEqual(Array.from(source.index!.array),[0,1,2])
  const position=clipped.getAttribute('position')
  const cut=Array.from({length:position.count},(_,i)=>i).find(i=>Math.abs(position.getX(i)-.32)<1e-6&&Math.abs(position.getY(i)-2.6)<1e-6)!
  assert.notEqual(cut,undefined)
  assert.ok(Array.from({length:position.count},(_,i)=>i).some(i=>Math.abs(position.getX(i)-.2)<1e-6&&Math.abs(position.getY(i)-2.8)<1e-6),'open chest point survives')
  const bones=[new THREE.Bone(),new THREE.Bone()],mesh=new THREE.SkinnedMesh(clipped,new THREE.MeshBasicMaterial())
  mesh.add(...bones);mesh.updateMatrixWorld(true);mesh.bind(new THREE.Skeleton(bones));mesh.morphTargetInfluences![0]=.75
  bones[1].position.y=1;mesh.updateMatrixWorld(true);mesh.skeleton.update()
  const actual=mesh.getVertexPosition(cut,new THREE.Vector3())
  // The cut is 48% along the edge between the two independently moving joints.
  // It must interpolate both their deformation and the original shape delta.
  assert.ok(Math.abs(actual.x-(.32+(.02*.52+.04*.48)*.75))<1e-6)
  assert.ok(Math.abs(actual.y-(2.6+.48))<1e-6)
  assert.ok(Math.abs(actual.z-.1)<1e-6)
  assert.equal(clipped.morphTargetsRelative,true)
  source.dispose();clipped.dispose();(mesh.material as THREE.Material).dispose()
})


test('back collar keeps bending underlap above the hidden tapered shoulder cut', () => {
  const source=new THREE.BufferGeometry()
  source.setAttribute('position',new THREE.Float32BufferAttribute([.30,2.90,.1, .40,2.90,.1, .30,2.70,.1],3))
  source.setAttribute('uv',new THREE.Float32BufferAttribute([.7,.4, .8,.4, .7,.5],2))
  source.setAttribute('skinIndex',new THREE.Uint16BufferAttribute(new Uint16Array(12),4))
  source.setAttribute('skinWeight',new THREE.Float32BufferAttribute([1,0,0,0,1,0,0,0,1,0,0,0],4))
  source.setIndex([0,1,2]);source.morphTargetsRelative=true
  const clipped=clipCoveredInnerHoodie(source),p=clipped.getAttribute('position')
  assert.ok(Array.from({length:p.count},(_,i)=>i).some(i=>Math.abs(p.getX(i)-.30)<1e-6&&Math.abs(p.getY(i)-2.90)<1e-6),'actual upper collar point is retained')
  for(let i=0;i<p.count;i++){
    const y=p.getY(i),limit=y>=2.80?.34:y<=2.70?.16:.16+(y-2.70)*1.8
    assert.ok(Math.abs(p.getX(i))<=limit+1e-6)
  }
  source.dispose();clipped.dispose()
})
