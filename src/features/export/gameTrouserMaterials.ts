import * as THREE from 'three/webgpu'
import type { PatternDocument } from '../clothing/document/types'

type PanelRange = { panelId: string; start: number; count: number }
type Point = { x: number; y: number }
type Line = { a: Point; b: Point; kind: string }
const PANEL_IDS = ['negative-front', 'positive-front', 'negative-back', 'positive-back']

/** Four real pattern panels share a tint-neutral denim atlas. Only UVs change;
 * the caller retains the original geometry, rig, correctives and colour tint. */
export function createAuthoredTrouserFabric(geometry: THREE.BufferGeometry, document: PatternDocument): THREE.DataTexture {
  const ranges = geometry.userData.panelVertexRanges as PanelRange[] | undefined
  const uv = geometry.getAttribute('uv')
  if (!ranges || !uv || ranges.length !== 4 || new Set(ranges.map(r => r.panelId)).size !== 4
    || ranges.some(r => !PANEL_IDS.includes(r.panelId))) throw new Error('Trouser fabric requires four authored panel UV ranges')
  if (geometry.userData.fabricAtlas) throw new Error('Trouser UV atlas was already packed')
  const width = 512, tile = 256, pixels = new Uint8Array(width * width * 4)
  const distance = (p: Point, line: Line, aspect: number) => {
    const dx = (line.b.x-line.a.x)*aspect, dy = line.b.y-line.a.y
    const px = (p.x-line.a.x)*aspect, py = p.y-line.a.y
    const t = THREE.MathUtils.clamp((px*dx+py*dy)/Math.max(1e-12,dx*dx+dy*dy),0,1)
    return Math.hypot(px-t*dx,py-t*dy)
  }
  // Validate every document/range before touching the supplied UV attribute.
  const panels = ranges.map(range => {
    const panel = document.panels[range.panelId]
    if (!panel || range.start < 0 || range.count <= 0 || range.start+range.count > uv.count) throw new Error(`Invalid trouser panel ${range.panelId}`)
    const points = Object.values(panel.points), xs=points.map(p=>p.x), ys=points.map(p=>p.y)
    const minX=Math.min(...xs), minY=Math.min(...ys), spanX=Math.max(...xs)-minX, spanY=Math.max(...ys)-minY
    if (!(spanX>0 && spanY>0)) throw new Error(`Degenerate trouser panel ${range.panelId}`)
    const point=(id:string):Point=>{const p=panel.points[id];if(!p)throw new Error(`Missing trouser construction point ${id}`);return{x:(p.x-minX)/spanX,y:(p.y-minY)/spanY}}
    const lines:Line[]=panel.edges.map(edge=>({a:point(edge.from),b:point(edge.to),kind:edge.id}))
    const inner=point('waist-inner'),outer=point('waist-outer'),hip=point('hip')
    return{range,lines,inner,outer,hip,aspect:spanX/spanY,front:range.panelId.endsWith('front'),slot:PANEL_IDS.indexOf(range.panelId)}
  })
  for(const {range,lines,inner,outer,hip,aspect,front,slot} of panels){
    const col=slot%2,row=Math.floor(slot/2)
    const along=(amount:number,y:number):Point=>({x:THREE.MathUtils.lerp(inner.x,outer.x,amount),y})
    const details:Line[]=[]
    if(front){
      // The slanted pocket opens from the actual outside waist toward the hip.
      details.push({a:along(.64,.035),b:{x:THREE.MathUtils.lerp(inner.x,hip.x,.88),y:.17},kind:'pocket'})
      // A narrow parallel fly stitch beside the sewn central rise, no dark fold.
      for(const edge of lines.filter(l=>l.kind==='rise-upper'))details.push({a:{x:edge.a.x+(outer.x-inner.x)*.055,y:edge.a.y},b:{x:edge.b.x+(outer.x-inner.x)*.055,y:edge.b.y},kind:'fly'})
    }else{
      const pocket=[along(.25,.085),along(.80,.085),along(.76,.195),along(.52,.22),along(.29,.195)]
      for(let i=0;i<pocket.length;i++)details.push({a:pocket[i],b:pocket[(i+1)%pocket.length],kind:'pocket'})
    }
    for(let y=0;y<tile;y++)for(let x=0;x<tile;x++){
      const p={x:THREE.MathUtils.clamp((x-1)/254,0,1),y:THREE.MathUtils.clamp((y-1)/254,0,1)}
      // Low contrast diagonal twill, neutral RGB so cream/navy/wine remain true.
      const twill=((x+y*2)%5)<2?1.6:-1.1
      let shade=244+twill+Math.sin(x*1.7+y*.13)*.65
      let nearest=Infinity,kind=''
      for(const line of lines){const d=distance(p,line,aspect);if(d<nearest){nearest=d;kind=line.kind}}
      if(nearest<.0028)shade*=.93
      if(kind==='waist'||kind==='hem'){
        if(nearest<.014)shade*=.98
        if(Math.abs(nearest-.014)<.002||Math.abs(nearest-.020)<.0018)shade*=.86
      }else if(kind.startsWith('outer')&&Math.abs(nearest-.007)<.0018)shade*=.90
      for(const line of details){const d=distance(p,line,aspect);if(d<.0023)shade*=line.kind==='fly'?.86:.81;else if(d<.0045)shade*=.96}
      const at=((row*tile+y)*width+col*tile+x)*4
      pixels[at]=pixels[at+1]=pixels[at+2]=Math.round(shade);pixels[at+3]=255
    }
    for(let i=range.start;i<range.start+range.count;i++)uv.setXY(i,(col*tile+1+uv.getX(i)*254)/width,(row*tile+1+uv.getY(i)*254)/width)
  }
  uv.needsUpdate=true;geometry.userData.fabricAtlas='trousers'
  const texture=new THREE.DataTexture(pixels,width,width,THREE.RGBAFormat)
  texture.name='trousers-authored-panel-denim';texture.colorSpace=THREE.SRGBColorSpace
  texture.magFilter=THREE.LinearFilter;texture.minFilter=THREE.LinearMipmapLinearFilter;texture.generateMipmaps=true;texture.needsUpdate=true
  return texture
}
