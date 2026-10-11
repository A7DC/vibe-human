import test from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three/webgpu'
import { createDemoGarment, DEMO_GARMENT_PLACEMENTS } from '../clothing/demo/createDemoGarment'
import { toPatternDocument } from '../clothing/document/legacyAdapter'
import { compileGarmentRuntime } from '../clothing/compiler/compileGarmentRuntime'
import { splitOpenJacketPattern } from './gameUpstreamJacket'
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
