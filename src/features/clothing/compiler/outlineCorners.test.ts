import test from 'node:test'
import assert from 'node:assert/strict'
import { buildPanelSimMesh } from './buildPanelSimMesh'
import { samplePatternOutline, sampleEdgeLoop } from '../geometry/patternSampling'
import type { PatternPanel } from '../document/types'

test('simulation preserves every authored outline and hole-polyline corner as an incident vertex',()=>{
  const panel:PatternPanel={id:'corners',name:'corners',closed:true,particleDistance:12,points:{
    a:{id:'a',x:0,y:0,kind:'corner',out:{x:20,y:-12}},b:{id:'b',x:113,y:0,kind:'corner',in:{x:-20,y:-12}},c:{id:'c',x:113,y:97,kind:'corner'},d:{id:'d',x:0,y:97,kind:'corner'},
    h0:{id:'h0',x:40,y:30,kind:'corner'},h1:{id:'h1',x:40,y:59,kind:'corner'},h2:{id:'h2',x:69,y:59,kind:'corner'},h3:{id:'h3',x:69,y:30,kind:'corner'},
  },edges:[{id:'top',from:'a',to:'b',curve:'cubic'},{id:'right',from:'b',to:'c',curve:'line'},{id:'bottom',from:'c',to:'d',curve:'line'},{id:'left',from:'d',to:'a',curve:'line'}],holes:[[{id:'h0',from:'h0',to:'h1',curve:'line'},{id:'h1',from:'h1',to:'h2',curve:'line'},{id:'h2',from:'h2',to:'h3',curve:'line'},{id:'h3',from:'h3',to:'h0',curve:'line'}]],placement:{position:{x:0,y:0,z:0},rotation:{x:0,y:0,z:0}}}
  const mesh=buildPanelSimMesh(panel,{quality:'medium'},0),triangles=mesh.panelInfo.triangleIndices
  const positions=mesh.panelLocalPositions
  const expected=[...samplePatternOutline(panel,12),...sampleEdgeLoop(panel,panel.holes![0],12)]
  for(const point of expected){
    const vertex=mesh.panelInfo.particleIndices.find(i=>Math.hypot(positions[i*2]-point.x,positions[i*2+1]-point.y)<1e-7)
    assert.notEqual(vertex,undefined,`missing outline corner ${point.x},${point.y}`)
    let incident=false
    for(let t=0;t<triangles.length;t+=3){const [a,b,c]=[triangles[t],triangles[t+1],triangles[t+2]];if(![a,b,c].includes(vertex!))continue
      const area=(positions[b*2]-positions[a*2])*(positions[c*2+1]-positions[a*2+1])-(positions[c*2]-positions[a*2])*(positions[b*2+1]-positions[a*2+1])
      if(Math.abs(area)>1e-8)incident=true
    }
    assert.ok(incident,'outline corner must be used by nondegenerate triangles')
  }
})
