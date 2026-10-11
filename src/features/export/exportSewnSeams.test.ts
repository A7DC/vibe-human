import test from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three/webgpu'
import { createDemoGarment, DEMO_GARMENT_PLACEMENTS } from '../clothing/demo/createDemoGarment'
import { toPatternDocument } from '../clothing/document/legacyAdapter'
import { compileGarmentRuntime } from '../clothing/compiler/compileGarmentRuntime'
import { bindSewnRenderSeams } from './exportSewnSeams'

test('original demo seam correspondence freezes positions, rig and corrective deltas while preserving UVs', () => {
  const document = toPatternDocument(createDemoGarment(), DEMO_GARMENT_PLACEMENTS)
  const runtime = compileGarmentRuntime(document, {quality:'high',seamSamples:18,renderSubdivisions:12}).value
  const count = runtime.renderPanels.reduce((sum,panel)=>sum+panel.panelUvs.length/2,0)
  const p = new Float32Array(count*3), uv=new Float32Array(count*2), joints=new Uint16Array(count*4), weights=new Float32Array(count*4), morph=new Float32Array(count*3)
  let offset=0
  for (const [side,panel] of runtime.renderPanels.entries()) for(let i=0;i<panel.panelUvs.length/2;i++) { const j=offset++;p[j*3]=panel.panelUvs[i*2];p[j*3+1]=panel.panelUvs[i*2+1];p[j*3+2]=side*.03;uv[j*2]=panel.panelUvs[i*2];uv[j*2+1]=panel.panelUvs[i*2+1];joints[j*4]=side;weights[j*4]=1;morph[j*3]=side*.08 }
  const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.BufferAttribute(p,3));geometry.setAttribute('uv',new THREE.BufferAttribute(uv,2));geometry.setAttribute('skinIndex',new THREE.BufferAttribute(joints,4));geometry.setAttribute('skinWeight',new THREE.BufferAttribute(weights,4));geometry.morphTargetsRelative=true;geometry.morphAttributes.position=[new THREE.BufferAttribute(morph,3)]
  const savedUv=uv.slice(), result=bindSewnRenderSeams(geometry,document,runtime.renderPanels)
  assert.ok(result.groups>50);assert.deepEqual(uv,savedUv)
  let shared=0
  for(let i=0;i<count;i++)if(p[i*3+2]>.001&&p[i*3+2]<.029){shared++;assert.ok(Math.abs(p[i*3+2]-.015)<1e-6);assert.ok(Math.abs(morph[i*3]-.04)<1e-6);assert.equal(weights[i*4],.5);assert.equal(weights[i*4+1],.5)}
  assert.equal(shared,result.groups*2)
})
