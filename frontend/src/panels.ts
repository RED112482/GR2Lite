import maplibregl from 'maplibre-gl';
import {PanelGpu} from './panelGpu';
import type {PanelDraw} from './panelGpu';
import type {TiltIndex,TiltSource} from './tiltIndex';
import {getBoundary} from './boundaryData';

import {isNoData} from './radar';
import type {Moment, RadarFrame, SweepDescriptor, VolumeDescriptor} from './radar';
import {getPalette,palettePixels,valueFactor,cssGradient} from './palettes';

type Count=1|2|4|16;
type Tile={sweep:SweepDescriptor;moment:Moment;label:string;source?:TiltSource;newest?:boolean;volume?:VolumeDescriptor};
type TileCell={
  box:HTMLDivElement;canvas:HTMLCanvasElement;caption:HTMLSpanElement;
  bar:HTMLDivElement;gradient:HTMLDivElement;high:HTMLSpanElement;low:HTMLSpanElement;
  tile:Tile;frame?:RadarFrame;key:string;
};
type Segments={color:string;lines:number[][][]}[];
function uniqueAngles(vol:VolumeDescriptor):SweepDescriptor[]{
  const sorted=[...vol.sweeps].sort((a,b)=>a.fixed_angle_deg-b.fixed_angle_deg||a.index-b.index);
  const out:SweepDescriptor[]=[];
  for(const s of sorted)if(!out.some(x=>Math.abs(s.fixed_angle_deg-x.fixed_angle_deg)<0.16))out.push(s);
  return out;
}
function bestCut(vol:VolumeDescriptor,m:Moment,angle:number):SweepDescriptor|undefined{
  return vol.sweeps.filter(s=>Boolean(s.moments[m]))
    .sort((a,b)=>Math.abs(a.fixed_angle_deg-angle)-Math.abs(b.fixed_angle_deg-angle))[0];
}
function lookupFor(f:RadarFrame):Int16Array{
  const result=new Int16Array(3600).fill(-1);
  const errors=new Float32Array(3600).fill(Infinity);
  for(let i=0;i<f.sweep.azimuth_deg.length;i++){
    const az=f.sweep.azimuth_deg[i];
    for(let step=-9;step<=9;step++){
      const idx=((Math.round(az*10)+step)%3600+3600)%3600;
      const err=Math.abs((((idx+0.5)/10-az+540)%360)-180);
      if(err<errors[idx]&&err<=0.8){errors[idx]=err;result[idx]=i;}
    }
  }
  return result;
}
function projection(lon:number,lat:number):[number,number]{
  const p=maplibregl.MercatorCoordinate.fromLngLat([lon,lat]);return [p.x,p.y];
}
function drawFrame(canvas:HTMLCanvasElement,f:RadarFrame,map:maplibregl.Map,segments:Segments){
  const rect=canvas.getBoundingClientRect();
  if(rect.width<8||rect.height<8)return;
  const maxPixels=rect.width*rect.height>400000?250:180;
  const w=Math.max(80,Math.round(Math.min(rect.width,maxPixels)));
  const h=Math.max(60,Math.round(w*rect.height/rect.width));
  canvas.width=w;canvas.height=h;
  const ctx=canvas.getContext('2d',{alpha:false});
  if(!ctx)return;
  const img=ctx.createImageData(w,h);
  const pixels=img.data;
  const pal=getPalette(f.moment,'operational'), colors=palettePixels(pal);
  const factor=valueFactor(f.moment,f.descriptor.units);
  const mapSize=map.getContainer().getBoundingClientRect();
  const fullWorldPx=512*2**map.getZoom();
  // All panel views share one camera center and the same geographic footprint.
  const deltaX=rect.width/fullWorldPx/w;
  const deltaY=rect.height/fullWorldPx/h;
  const [cx,cy]=projection(map.getCenter().lng,map.getCenter().lat);
  const [rx,ry]=projection(f.volume.radar_lon,f.volume.radar_lat);
  const scale=40075016.686*Math.cos(f.volume.radar_lat*Math.PI/180);
  const lookup=lookupFor(f),gates=f.descriptor.gates;
  const first=f.descriptor.first_gate_m,step=f.descriptor.gate_spacing_m;
  for(let y=0;y<h;y++){
    const north=(ry-(cy+(y+0.5-h/2)*deltaY))*scale;
    for(let x=0;x<w;x++){
      const i=(y*w+x)*4;
      const east=(cx+(x+0.5-w/2)*deltaX-rx)*scale;
      const range=Math.hypot(east,north);
      const gate=Math.round((range-first)/step);
      const az=(Math.atan2(east,north)*180/Math.PI+360)%360;
      const ray=lookup[Math.floor(az*10)%3600];
      let value=NaN;
      if(ray>=0&&gate>=0&&gate<gates){
        const raw=f.values[ray*gates+gate];
        if(!isNoData(f.moment,raw,f.descriptor.units))value=raw*factor;
      }
      if(Number.isFinite(value)&&!(f.moment==='REF'&&value<pal.min)){
        const index=Math.max(0,Math.min(255,Math.round(255*(value-pal.min)/(pal.max-pal.min))))*4;
        pixels[i]=colors[index];pixels[i+1]=colors[index+1];pixels[i+2]=colors[index+2];
      }else{
        const background=f.moment==='VEL'?0:24;
        pixels[i]=background;pixels[i+1]=f.moment==='VEL'?0:30;pixels[i+2]=f.moment==='VEL'?0:39;
      }
      pixels[i+3]=255;
    }
  }
  ctx.putImageData(img,0,0);
  for(const shape of segments){
    ctx.strokeStyle=shape.color;ctx.lineWidth=0.7;
    ctx.beginPath();
    for(const line of shape.lines){
      let start=true;
      for(const pair of line){
        const [wx,wy]=projection(pair[0],pair[1]);
        const sx=(wx-cx)/deltaX+w/2,sy=(wy-cy)/deltaY+h/2;
        if(start){ctx.moveTo(sx,sy);start=false;}else ctx.lineTo(sx,sy);
      }
    }
    ctx.stroke();
  }
}
/** Boundaries are lightweight transparent Canvas2D strokes, not radar pixels. */
/** Cache identical boundary rasters across all tiles. Outlines are the
 * same at a given camera, footprint and tile size; drawing county polylines
 * sixteen times per layout was a major CPU bottleneck.
 */
const outlinesCache=new Map<string,HTMLCanvasElement>();
function drawOutlines(canvas:HTMLCanvasElement,map:maplibregl.Map,segments:Segments){
 const rect=canvas.getBoundingClientRect();if(rect.width<8||rect.height<8)return;
 const ratio=Math.min(devicePixelRatio||1,1.25);
 const width=Math.max(1,Math.round(rect.width*ratio));
 const height=Math.max(1,Math.round(rect.height*ratio));
 if(canvas.width!==width||canvas.height!==height){canvas.width=width;canvas.height=height;}
 const ctx=canvas.getContext('2d');if(!ctx)return;
 const center=map.getCenter(),zoom=map.getZoom();
 const key=[segments.length,width,height,center.lng.toFixed(5),center.lat.toFixed(5),zoom.toFixed(4)].join('|');
 let source=outlinesCache.get(key);
 if(!source){
  source=document.createElement('canvas');source.width=width;source.height=height;
  const painter=source.getContext('2d');
  if(!painter)return;
  painter.setTransform(ratio,0,0,ratio,0,0);
  const [cx,cy]=projection(center.lng,center.lat);
  // Native MapLibre zoom: one screen CSS pixel equals 1/(512*2^zoom)
  // Mercator world units on BOTH axes. No axis-dependent distortion.
  const pxPerWorld=512*2**zoom;
  for(const shape of segments){
   painter.strokeStyle=shape.color;painter.lineWidth=0.8;painter.beginPath();
   for(const line of shape.lines){
    let first=true;
    for(const pair of line){
     const [wx,wy]=pair;
     const x=(wx-cx)*pxPerWorld+rect.width/2;
     const y=(wy-cy)*pxPerWorld+rect.height/2;
     if(first){painter.moveTo(x,y);first=false;}else painter.lineTo(x,y);
    }
   }
   painter.stroke();
  }
  outlinesCache.set(key,source);
  while(outlinesCache.size>5)outlinesCache.delete(outlinesCache.keys().next().value!);
 }
 ctx.clearRect(0,0,width,height);
 ctx.drawImage(source,0,0);
}
function extractLines(geometry:{type:string;coordinates:any}):number[][][]{
  if(!geometry||!geometry.coordinates)return [];
  const g=geometry;
  if(g.type==='Polygon')return g.coordinates;
  if(g.type==='MultiPolygon')return g.coordinates.flat();
  if(g.type==='MultiLineString')return g.coordinates;
  if(g.type==='LineString')return [g.coordinates];
  return [];
}
export class PanelManager {
  count:Count=1;
  private page=0;
  private rollingIndex?:TiltIndex;
  private sourceCache=new Map<string,{volume:VolumeDescriptor;sweep:SweepDescriptor}>();
  private indexSignature='';
  private selectedIndex=0;
  private overrides=new Map<number,{moment:Moment;angle:number}>();
  private layoutAngle:number|undefined;
  private layoutMoment:Moment|undefined;
  private segments:Segments=[];
  private gpu:PanelGpu;
  private rendered:PanelDraw[]=[];
  private cells:TileCell[]=[];
  private structure='';
  private boundariesRequested=false;
  private lightOutlines:Segments=[];
  private fastOutlines:Segments=[];
  private fastLightOutlines:Segments=[];
  private redrawOutlinesTimer=0;
  private generation=0;
  private timer=0;
  constructor(private map:maplibregl.Map,private grid:HTMLDivElement,
              private api:()=>string,private selectCut:(s:SweepDescriptor)=>void,
              private loadFrame:(volume:VolumeDescriptor,sweep:SweepDescriptor,moment:Moment)=>Promise<RadarFrame>,
              private getDescriptor:(id:string)=>Promise<VolumeDescriptor>,
              private onSelected:(tile:Tile)=>void,
              private onLayoutChange:(count:Count)=>void){
    this.gpu=new PanelGpu(this.grid,this.map);
    this.gpu.onFailure=()=>this.schedule();
    map.on('move',()=>this.gpu.schedule());
    map.on('moveend',()=>{
      window.clearTimeout(this.redrawOutlinesTimer);
      this.redrawOutlinesTimer=window.setTimeout(()=>this.refreshViewport(),90);
    });
    this.grid.addEventListener('wheel',e=>{
      e.preventDefault();
      this.map.zoomTo(Math.max(2,Math.min(14,this.map.getZoom()+(e.deltaY<0?0.4:-0.4))),{duration:0});
    },{passive:false});
    let pointer:{x:number;y:number;lastX:number;lastY:number;dragging:boolean}|null=null;
    let deltaX=0,deltaY=0,panFrame=0;
    const flushPan=()=>{
      panFrame=0;
      const dx=deltaX,dy=deltaY;deltaX=0;deltaY=0;
      if(dx||dy)this.map.panBy([-dx,-dy],{duration:0});
    };
    this.grid.addEventListener('pointerdown',e=>{
      if(e.button!==0)return;
      pointer={x:e.clientX,y:e.clientY,lastX:e.clientX,lastY:e.clientY,dragging:false};
    });
    this.grid.addEventListener('pointermove',e=>{
      if(!pointer)return;
      if(!pointer.dragging&&Math.hypot(e.clientX-pointer.x,e.clientY-pointer.y)>5)
        pointer.dragging=true;
      if(pointer.dragging){
        deltaX+=e.clientX-pointer.lastX;
        deltaY+=e.clientY-pointer.lastY;
        if(!panFrame)panFrame=requestAnimationFrame(flushPan);
      }
      pointer.lastX=e.clientX;pointer.lastY=e.clientY;
    });
    const finishPan=()=>{
      if(panFrame){cancelAnimationFrame(panFrame);flushPan();}
      pointer=null;
    };
    this.grid.addEventListener('pointerup',finishPan);
    this.grid.addEventListener('pointercancel',finishPan);
    this.grid.addEventListener('pointerleave',finishPan);
  }
  setRollingIndex(index:TiltIndex){
    const signature=[index.volume_id,index.previous_volume_id,
      ...index.tilts.map(t=>[t.angle,t.newest,
        ...Object.values(t.moments).map(s=>s?.volume_id+':'+s?.sweep_id)].join('/'))].join('|');
    this.rollingIndex=index;
    if(signature!==this.indexSignature){
      this.indexSignature=signature;
      this.sourceCache.clear();
      if(this.count===16)this.schedule();
    }
  }
  private sourceKey(source:TiltSource){return source.volume_id+'|'+source.sweep_id;}
  private refreshViewport(){
    if(this.count===1)return;
    this.gpu.schedule();
    if(this.gpu.ready){
      const lines=this.count===16?this.fastLightOutlines:this.fastOutlines;
      for(const item of this.rendered)drawOutlines(item.canvas,this.map,lines);
    }else this.schedule();
  }
  async loadBoundaries(){
    if(this.boundariesRequested)return;
    this.boundariesRequested=true;
    const color:Record<string,string>={counties:'#697e91',states:'#c5d3e1',cwa:'#efb65f'};
    this.segments=[];
    for(const kind of ['counties','states','cwa']){
      try{
        const json=await getBoundary(this.api(),kind as 'states'|'counties'|'cwa');
        const lines:number[][][]=[];
        for(const feat of json.features??[]){
          for(const rawLine of extractLines(feat.geometry)){
            // Keep the boundary strokes lightweight in 16-panel mode.
            if(rawLine.length<2)continue;
            const stride=Math.max(1,Math.floor(rawLine.length/600));
            const subset=rawLine.filter((_:unknown,i:number)=>i%stride===0);
            if(subset[subset.length-1]!==rawLine[rawLine.length-1])subset.push(rawLine[rawLine.length-1]);
            lines.push(subset);
          }
        }
        this.segments.push({color:color[kind],lines});
      }catch(e){console.warn('Panel boundary fetch failed:',kind,e);}
    }
    this.lightOutlines=this.segments.filter(s=>s.color!=='#697e91');
    // Project once on ingest, not on every drag/map event.
    this.fastOutlines=this.segments.map(shape=>({
      color:shape.color,
      lines:shape.lines.map(line=>line.map(pair=>projection(pair[0],pair[1])))
    }));
    this.fastLightOutlines=this.fastOutlines.filter(s=>s.color!=='#697e91');
    outlinesCache.clear();
    this.refreshViewport();
  }
  setCount(count:Count){
    this.count=count;this.page=0;this.selectedIndex=0;this.overrides.clear();
    this.layoutAngle=this.current?.angle;
    this.layoutMoment=this.current?.moment;this.onLayoutChange(count);this.schedule();
    const label=document.getElementById('panelSelection');if(label)label.textContent=this.selectionLabel();
    if(count>1)void this.loadBoundaries();
    document.querySelectorAll<HTMLButtonElement>('#layoutButtons button, #headerLayouts button').forEach(
      b=>b.classList.toggle('active',Number(b.dataset.panels)===count));
  }
  schedule(){
    window.clearTimeout(this.timer);
    this.timer=window.setTimeout(()=>{void this.renderCurrent();},120);
  }
  private current?:{volume:VolumeDescriptor;moment:Moment;angle:number};
  update(volume:VolumeDescriptor,moment:Moment,sweep:SweepDescriptor){
    const changed=this.current?.volume.volume_id!==volume.volume_id;
    const previous=this.current;
    this.current={volume,moment,angle:sweep.fixed_angle_deg};
    if(changed && previous && volume.radar_id!==previous.volume.radar_id){
      this.overrides.clear();this.layoutAngle=sweep.fixed_angle_deg;this.layoutMoment=moment;
    }
    if(changed && volume.volume_id.split('_CH')[0]!==previous?.volume.volume_id.split('_CH')[0])this.page=0;
    // Selected-tile interrogation must never rebuild every panel.
    // Product/elevation edits already schedule their own tile refresh.
    if(changed||!previous||this.count===1)this.schedule();
  }
  /** Resolve each pane independently. Selection controls apply to that pane only. */
  private tiles():Tile[]{
    if(!this.current)return [];
    const {volume}=this.current;
    const moment=this.layoutMoment??this.current.moment;
    const angle=this.layoutAngle??this.current.angle;
    const angles=uniqueAngles(volume);
    if(!angles.length)return [];
    if(this.count===16&&this.rollingIndex?.tilts.length){
      return this.rollingIndex.tilts.slice(this.page*16,(this.page+1)*16)
        .map(t=>{
          const preferred=this.overrides.get(this.page*16+
            this.rollingIndex!.tilts.slice(this.page*16,(this.page+1)*16).indexOf(t))?.moment??moment;
          const name=(t.moments[preferred]?preferred:
            t.moments.REF?'REF':t.moments.VEL?'VEL':
            Object.keys(t.moments)[0]) as Moment;
          const source=t.moments[name];
          if(!source)return null;
          const resolved=this.sourceCache.get(this.sourceKey(source));
          return {
            sweep:resolved?.sweep??angles.find(s=>Math.abs(s.fixed_angle_deg-t.angle)<0.16)??angles[0],
            volume:resolved?.volume,
            moment:name,
            label:t.angle.toFixed(1)+'°',
            source,
            newest:t.newest,
          } as Tile;
        }).filter((t):t is Tile=>Boolean(t));
    }
    const index=angles.reduce((best,s,i)=>
      Math.abs(s.fixed_angle_deg-angle)<Math.abs(angles[best].fixed_angle_deg-angle)?i:best,0);
    const requested=this.count===16
      ?angles.slice(this.page*16,(this.page+1)*16).map(s=>({angle:s.fixed_angle_deg,moment}))
      :this.count===2
        ?[{angle:angles[index].fixed_angle_deg,moment:'REF' as Moment},
          {angle:angles[index].fixed_angle_deg,moment:'VEL' as Moment}]
        :[{angle:angles[index].fixed_angle_deg,moment:'REF' as Moment},
          {angle:angles[index].fixed_angle_deg,moment:'VEL' as Moment},
          {angle:angles[Math.min(angles.length-1,index+1)].fixed_angle_deg,moment:'REF' as Moment},
          {angle:angles[Math.min(angles.length-1,index+1)].fixed_angle_deg,moment:'VEL' as Moment}];
    return requested.map((base,i)=>{
      const custom=this.overrides.get(this.page*16+i)??base;
      const actualAngle=this.count===16?base.angle:custom.angle;
      let s=bestCut(volume,custom.moment,actualAngle);
      // Split cuts may have a REF/VEL cut for the same angle. Do not mislabel
      // a distant elevation as this pane's selected elevation.
      if(!s||Math.abs(s.fixed_angle_deg-actualAngle)>0.18){
        s=angles.find(a=>Math.abs(a.fixed_angle_deg-actualAngle)<0.18)??angles[index];
      }
      const product:Moment=s.moments[custom.moment] ? custom.moment :
        s.moments.REF?'REF':s.moments.VEL?'VEL':
        Object.keys(s.moments)[0] as Moment;
      return {sweep:s,moment:product,label:s.fixed_angle_deg.toFixed(1)+'°'};
    });
  }
  selectionLabel():string { return this.count===1?'Single-panel view':'Editing panel '+(this.selectedIndex+1)+' of '+this.count+(this.gpu.ready?' • GPU':' • CPU fallback'); }
  active():Tile|undefined {
    if(this.count===1)return undefined;
    return this.tiles()[this.selectedIndex];
  }
  private activate(index:number) {
    this.selectedIndex=index;
    const label=document.getElementById('panelSelection');
    if(label)label.textContent=this.selectionLabel();
    this.grid.querySelectorAll('.panel-tile').forEach((node,i)=>
      node.classList.toggle('active',i===index));
    const tile=this.active();
    if(tile)this.onSelected(tile);
  }
  setProduct(moment:Moment):boolean {
    if(this.count===1||!this.current)return false;
    const tile=this.active();
    if(!tile)return false;
    const target=bestCut(this.current.volume,moment,tile.sweep.fixed_angle_deg);
    if(!target || Math.abs(target.fixed_angle_deg-tile.sweep.fixed_angle_deg)>0.18)return false;
    const key=this.page*16+this.selectedIndex;
    this.overrides.set(key,{moment,angle:tile.sweep.fixed_angle_deg});
    this.schedule();
    const next=this.active();
    if(next)this.onSelected(next);
    return true;
  }
  selectAngle(angle:number):boolean {
    if(this.count!==16||!this.current)return false;
    const options=this.rollingIndex?.tilts.map(t=>t.angle)??uniqueAngles(this.current.volume).map(s=>s.fixed_angle_deg);
    const found=options.findIndex(a=>Math.abs(a-angle)<0.16);
    if(found<0)return false;
    const nextPage=Math.floor(found/16);
    if(this.page!==nextPage){
      this.page=nextPage;
      this.selectedIndex=found%16;
      this.schedule();
      const selected=this.active();
      if(selected)this.onSelected(selected);
    }else{
      this.activate(found%16);
    }
    return true;
  }
  setElevation(angle:number):boolean {
    if(this.count===1||this.count===16||!this.current)return false;
    const tile=this.active();
    if(!tile)return false;
    const chosen=bestCut(this.current.volume,tile.moment,angle);
    if(!chosen||Math.abs(chosen.fixed_angle_deg-angle)>0.18)return false;
    this.overrides.set(this.page*16+this.selectedIndex,{moment:tile.moment,angle:chosen.fixed_angle_deg});
    this.schedule();
    const next=this.active();
    if(next)this.onSelected(next);
    return true;
  }
  stepElevation(direction:-1|1):boolean {
    if(this.count===1||this.count===16||!this.current)return false;
    const tile=this.active();
    if(!tile)return false;
    const available=uniqueAngles(this.current.volume)
      .filter(s=>this.current!.volume.sweeps.some(t=>
        Math.abs(t.fixed_angle_deg-s.fixed_angle_deg)<0.18&&t.moments[tile.moment]));
    const angle=tile.sweep.fixed_angle_deg;
    const chosen=direction===1
      ?available.find(s=>s.fixed_angle_deg>angle+0.16)
      :[...available].reverse().find(s=>s.fixed_angle_deg<angle-0.16);
    return chosen?this.setElevation(chosen.fixed_angle_deg):false;
  }

  async renderCurrent(){
    const generation=++this.generation;
    if(this.count===1||!this.current){
      this.grid.classList.add('hidden');
      this.gpu.clear();
      return;
    }
    this.grid.classList.remove('hidden');
    this.grid.dataset.panels=String(this.count);
    this.grid.dataset.renderer=this.gpu.ready?'gpu':'cpu';
    const status=document.getElementById('panelSelection');
    if(status)status.textContent=this.selectionLabel();
    const {volume}=this.current;
    const cols=this.count===2?2:this.count===4?2:4;
    const rows=this.count===2?1:this.count===4?2:4;
    this.grid.style.gridTemplateColumns='repeat('+cols+',minmax(0,1fr))';
    this.grid.style.gridTemplateRows='repeat('+rows+',minmax(0,1fr))';
    const tiles=this.tiles();
    const structure=this.count+'|'+this.page+'|'+tiles.length;
    const structuralChange=structure!==this.structure ||
      this.cells.some(c=>!c.box.isConnected);
    if(structuralChange){
      this.structure=structure;
      this.grid.replaceChildren(this.gpu.canvas);
      this.cells=[];
      const fragment=document.createDocumentFragment();
      for(let i=0;i<tiles.length;i++){
        const tile=tiles[i];
        const box=document.createElement('div');box.className='panel-tile';
        const plot=document.createElement('div');plot.className='panel-plot';
        const canvas=document.createElement('canvas');plot.append(canvas);
        const caption=document.createElement('span');caption.className='panel-caption';
        const bar=document.createElement('div');bar.className='mini-colorbar';
        const high=document.createElement('span'),low=document.createElement('span');
        const gradient=document.createElement('div');gradient.className='mini-colorbar-gradient';
        bar.append(high,gradient,low);box.append(plot,caption,bar);
        const cell:TileCell={box,canvas,caption,bar,gradient,high,low,tile,key:''};
        const slot=i;
        box.addEventListener('click',()=>this.activate(slot));
        box.addEventListener('dblclick',()=>{
          this.activate(slot);
          this.setCount(1);
          this.selectCut(cell.tile.sweep);
        });
        canvas.addEventListener('click',event=>{
          const f=cell.frame;
          if(!f)return;
          const rect=canvas.getBoundingClientRect();
          const xf=(event.clientX-rect.left)/rect.width;
          const yf=(event.clientY-rect.top)/rect.height;
          const zoomScale=512*2**this.map.getZoom();
          const [cx,cy]=projection(this.map.getCenter().lng,this.map.getCenter().lat);
          const [rx,ry]=projection(f.volume.radar_lon,f.volume.radar_lat);
          const scale=40075016.686*Math.cos(f.volume.radar_lat*Math.PI/180);
          const east=(cx+(xf-0.5)*rect.width/zoomScale-rx)*scale;
          const north=(ry-cy-(yf-0.5)*rect.height/zoomScale)*scale;
          const range=Math.hypot(east,north);
          const az=(Math.atan2(east,north)*180/Math.PI+360)%360;
          const lookup=lookupFor(f);
          const ray=lookup[Math.floor(az*10)%3600];
          const gate=Math.round((range-f.descriptor.first_gate_m)/f.descriptor.gate_spacing_m);
          const raw=ray>=0&&gate>=0&&gate<f.descriptor.gates
            ?f.values[ray*f.descriptor.gates+gate]:NaN;
          const value=isNoData(f.moment,raw,f.descriptor.units)?
            NaN:raw*valueFactor(f.moment,f.descriptor.units);
          const info=document.getElementById('gate');
          if(info)info.textContent=f.moment+' • '+cell.tile.label+' • '+f.sweep.id+
            '\nGate: '+(Number.isFinite(value)?
              value.toFixed(2)+' '+getPalette(f.moment,'operational').unit:'NO DATA')+
            '\nAzimuth: '+az.toFixed(2)+'°\nRange: '+(range/1000).toFixed(2)+' km';
        });
        this.cells.push(cell);
        fragment.append(box);
      }
      this.grid.append(fragment);
    }
    const newest=volume.sweeps.reduce<SweepDescriptor|undefined>((best,s)=>{
      const stamp=Date.parse(s.time_utc[s.time_utc.length-1]??'');
      const prior=Date.parse(best?.time_utc[best.time_utc.length-1]??'');
      return !best||(Number.isFinite(stamp)&&stamp>prior)?s:best;
    },undefined);
    const needed:TileCell[]=[];
    const gpuJobs:PanelDraw[]=[];
    const outlines=this.count===16?this.lightOutlines:this.segments;
    const gpuOutlines=this.count===16?this.fastLightOutlines:this.fastOutlines;
    for(let i=0;i<tiles.length;i++){
      const tile=tiles[i],cell=this.cells[i];
      cell.tile=tile;
      const isNewest=this.count===16 &&
        (tile.newest||(newest&&!this.rollingIndex?.tilts.length&&
          Math.abs(tile.sweep.fixed_angle_deg-newest.fixed_angle_deg)<0.16));
      cell.box.classList.toggle('latest-sweep',Boolean(isNewest));
      cell.box.classList.toggle('active',i===this.selectedIndex);
      const pal=getPalette(tile.moment,'operational');
      cell.high.textContent=pal.max+' '+pal.unit;
      cell.low.textContent=pal.min+' '+pal.unit;
      cell.gradient.style.background=cssGradient(pal).replace('to right','to top');
      const source=tile.source;
      const key=[source?.volume_id??volume.volume_id,
        source?.sweep_id??tile.sweep.id,tile.moment,tile.label].join('|');
      // Keep the same canvas, gate buffer and GPU texture if this pane's
      // actual radar source hasn't changed. No full-grid teardown.
      if(cell.key===key&&cell.frame){
        if(!this.gpu.ready)drawFrame(cell.canvas,cell.frame,this.map,outlines);
        else {drawOutlines(cell.canvas,this.map,gpuOutlines);gpuJobs.push({canvas:cell.canvas,frame:cell.frame});}
        continue;
      }
      cell.key=key;cell.frame=undefined;
      cell.caption.textContent=tile.moment+' • '+tile.label+' • loading…';
      needed.push(cell);
    }
    this.rendered=gpuJobs;
    this.gpu.setTiles(gpuJobs);
    let next=0;
    // 6 in-flight tiles while still bounded; matching gate requests are
    // deduplicated by the shared frontend frame cache.
    const workers=Array.from({length:Math.min(6,needed.length)},async()=>{
      while(next<needed.length&&generation===this.generation){
        const cell=needed[next++],tile=cell.tile;
        try{
          let actualVolume=volume,actualSweep=tile.sweep;
          if(this.count===16&&tile.source){
            const source=tile.source;
            const resolved=this.sourceCache.get(this.sourceKey(source));
            actualVolume=resolved?.volume??await this.getDescriptor(source.volume_id);
            const actual=resolved?.sweep??
              actualVolume.sweeps.find(s=>s.id===source.sweep_id);
            if(!actual)throw Error('Missing sweep '+source.sweep_id);
            actualSweep=actual;
            tile.sweep=actual;tile.volume=actualVolume;
            this.sourceCache.set(this.sourceKey(source),{volume:actualVolume,sweep:actual});
          }
          const frame=await this.loadFrame(actualVolume,actualSweep,tile.moment);
          if(generation!==this.generation||!cell.box.isConnected)return;
          cell.frame=frame;
          const last=actualSweep.time_utc[actualSweep.time_utc.length-1];
          cell.caption.textContent=tile.moment+' • '+tile.label+
            (last?' • '+new Date(last).toISOString().slice(11,19)+'Z':'');
          if(this.gpu.ready){
            drawOutlines(cell.canvas,this.map,outlines);
            gpuJobs.push({canvas:cell.canvas,frame});
            this.rendered=[...gpuJobs];
            this.gpu.setTiles(this.rendered);
          }else{
            drawFrame(cell.canvas,frame,this.map,outlines);
          }
        }catch(e){
          cell.caption.textContent=tile.moment+' • '+tile.label+' • unavailable';
          console.warn('Radar tile unavailable',e);
        }
        if(!this.gpu.ready)await new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()));
      }
    });
    void Promise.all(workers);
    // The pager only changes on layout/page changes.
    if(structuralChange&&this.count===16){
      const count=this.rollingIndex?.tilts.length??uniqueAngles(volume).length;
      if(count>16){
        const pages=Math.ceil(count/16);
        const controls=document.createElement('div');controls.className='panel-pagination';
        const prev=document.createElement('button');prev.textContent='◀';prev.disabled=this.page===0;
        prev.onclick=()=>{this.page--;this.schedule();};
        const label=document.createElement('span');label.textContent=(this.page+1)+' / '+pages;
        const nextButton=document.createElement('button');nextButton.textContent='▶';
        nextButton.disabled=this.page>=pages-1;
        nextButton.onclick=()=>{this.page++;this.schedule();};
        controls.append(prev,label,nextButton);this.grid.append(controls);
      }
    }
  }
}
