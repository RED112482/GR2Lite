import maplibregl from 'maplibre-gl';
import {getBoundary} from './boundaryData';

import {isNoData} from './radar';
import type {Moment, RadarFrame, SweepDescriptor, VolumeDescriptor} from './radar';
import {getPalette,palettePixels,valueFactor,cssGradient} from './palettes';

type Count=1|2|4|16;
type Tile={sweep:SweepDescriptor;moment:Moment;label:string};
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
  const deltaX=mapSize.width/fullWorldPx/w,deltaY=mapSize.height/fullWorldPx/h;
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
  private selectedIndex=0;
  private overrides=new Map<number,{moment:Moment;angle:number}>();
  private segments:Segments=[];
  private boundariesRequested=false;
  private generation=0;
  private timer=0;
  constructor(private map:maplibregl.Map,private grid:HTMLDivElement,
              private api:()=>string,private selectCut:(s:SweepDescriptor)=>void,
              private loadFrame:(volume:VolumeDescriptor,sweep:SweepDescriptor,moment:Moment)=>Promise<RadarFrame>,
              private onSelected:(tile:Tile)=>void,
              private onLayoutChange:(count:Count)=>void){
    map.on('moveend',()=>this.schedule());
    this.grid.addEventListener('wheel',e=>{
      e.preventDefault();
      this.map.zoomTo(Math.max(2,Math.min(14,this.map.getZoom()+(e.deltaY<0?0.4:-0.4))),{duration:0});
    },{passive:false});
    let pointer:{x:number;y:number}|null=null;
    this.grid.addEventListener('pointerdown',e=>{pointer={x:e.clientX,y:e.clientY};});
    this.grid.addEventListener('pointerup',e=>{
      if(pointer){
        const dx=e.clientX-pointer.x,dy=e.clientY-pointer.y;
        if(Math.abs(dx)+Math.abs(dy)>6)this.map.panBy([-dx,-dy],{duration:0});
      }
      pointer=null;
    });
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
    this.schedule();
  }
  setCount(count:Count){
    this.count=count;this.page=0;this.selectedIndex=0;this.overrides.clear();this.onLayoutChange(count);this.schedule();
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
    if(changed && previous && volume.radar_id!==previous.volume.radar_id)this.overrides.clear();
    if(changed && volume.volume_id.split('_CH')[0]!==previous?.volume.volume_id.split('_CH')[0])this.page=0;
    // Selected-tile interrogation must never rebuild every panel.
    // Product/elevation edits already schedule their own tile refresh.
    if(changed||!previous||this.count===1)this.schedule();
  }
  /** Resolve each pane independently. Selection controls apply to that pane only. */
  private tiles():Tile[]{
    if(!this.current)return [];
    const {volume,moment,angle}=this.current;
    const angles=uniqueAngles(volume);
    if(!angles.length)return [];
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
  selectionLabel():string { return this.count===1?'Single-panel view':'Editing panel '+(this.selectedIndex+1)+' of '+this.count; }
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
    const options=uniqueAngles(this.current.volume);
    const found=options.findIndex(s=>Math.abs(s.fixed_angle_deg-angle)<0.16);
    if(found<0)return false;
    const nextPage=Math.floor(found/16);
    if(this.page!==nextPage){
      this.page=nextPage;
      this.selectedIndex=found%16;
      this.schedule();
    }else{
      this.activate(found%16);
    }
    const selected=this.active();
    if(selected)this.onSelected(selected);
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
    this.grid.replaceChildren();
    if(this.count===1||!this.current){
      this.grid.classList.add('hidden');return;
    }
    this.grid.classList.remove('hidden');
    this.grid.dataset.panels=String(this.count);
    const {volume}=this.current;
    const columns=this.count===2?2:this.count===4?2:4;
    this.grid.style.gridTemplateColumns='repeat('+columns+',minmax(0,1fr))';
    this.grid.style.gridTemplateRows='repeat('+(this.count===2?1:this.count===4?2:4)+',minmax(0,1fr))';
    const tiles=this.tiles();
    const jobs=tiles.map((tile,index)=>{
      const box=document.createElement('div');box.className='panel-tile';
      if(index===this.selectedIndex)box.classList.add('active');
      const canvas=document.createElement('canvas');
      const caption=document.createElement('span');caption.className='panel-caption';
      caption.textContent=tile.moment+' • '+tile.label+' • loading…';
      const palette=getPalette(tile.moment,'operational');
      const bar=document.createElement('div');bar.className='mini-colorbar';
      const high=document.createElement('span');high.textContent=palette.max+' '+palette.unit;
      const low=document.createElement('span');low.textContent=palette.min+' '+palette.unit;
      const gradient=document.createElement('div');gradient.className='mini-colorbar-gradient';
      gradient.style.background=cssGradient(palette).replace('to right','to top');
      bar.append(high,gradient,low);
      box.append(canvas,caption,bar);this.grid.append(box);
      box.addEventListener('dblclick',()=>{this.activate(index);this.setCount(1);this.selectCut(tile.sweep);});
      box.addEventListener('click',()=>this.activate(index));
      return {tile,canvas,caption};
    });
    // Populate all panels immediately, then fetch/render at bounded concurrency.
    // This avoids synchronous 16-panel rendering freezing map interactions.
    let next=0;
    const workers=Array.from({length:Math.min(4,jobs.length)},async()=>{
      while(next<jobs.length&&this.generation===generation){
        const {tile,canvas,caption}=jobs[next++];
        try{
          const frame=await this.loadFrame(volume,tile.sweep,tile.moment);
          if(this.generation!==generation)return;
          const boundaryLines=this.count===16
            ?this.segments.filter(s=>s.color!=='#697e91'):this.segments;
          drawFrame(canvas,frame,this.map,boundaryLines);
          const last=tile.sweep.time_utc[0];
          caption.textContent=tile.moment+' • '+tile.label+(last?' • '+new Date(last).toISOString().slice(11,19)+'Z':'');
          canvas.onclick=(e)=>{
            const rect=canvas.getBoundingClientRect();
            const xf=(e.clientX-rect.left)/rect.width, yf=(e.clientY-rect.top)/rect.height;
            const mapSize=this.map.getContainer().getBoundingClientRect();
            const world=512*2**this.map.getZoom();
            const [cx,cy]=projection(this.map.getCenter().lng,this.map.getCenter().lat);
            const [rx,ry]=projection(frame.volume.radar_lon,frame.volume.radar_lat);
            const scale=40075016.686*Math.cos(frame.volume.radar_lat*Math.PI/180);
            const east=(cx+(xf-0.5)*mapSize.width/world-rx)*scale;
            const north=(ry-cy-(yf-0.5)*mapSize.height/world)*scale;
            const range=Math.hypot(east,north);
            const az=(Math.atan2(east,north)*180/Math.PI+360)%360;
            const lookup=lookupFor(frame);
            const ray=lookup[Math.floor(az*10)%3600];
            const gate=Math.round((range-frame.descriptor.first_gate_m)/frame.descriptor.gate_spacing_m);
            const raw=ray>=0&&gate>=0&&gate<frame.descriptor.gates
              ?frame.values[ray*frame.descriptor.gates+gate]:NaN;
            const value=isNoData(frame.moment,raw,frame.descriptor.units)
              ?NaN:raw*valueFactor(frame.moment,frame.descriptor.units);
            const unit=getPalette(frame.moment,'operational').unit;
            const info=document.getElementById('gate');
            if(info)info.textContent=frame.moment+' • '+tile.label+' • '+tile.sweep.id+
              '\nGate: '+(Number.isFinite(value)?value.toFixed(2)+' '+unit:'NO DATA')+
              '\nAzimuth: '+az.toFixed(2)+'°\nRange: '+(range/1000).toFixed(2)+' km'+
              '\nRadial / gate: '+ray+' / '+gate;
          };
        }catch(e){
          caption.textContent=tile.moment+' • '+tile.label+' • unavailable';
          console.warn('Tile unavailable',e);
        }
        // Yield one frame after each tile so controls stay responsive.
        await new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()));
      }
    });
    void Promise.all(workers);
    if(this.count===16&&uniqueAngles(volume).length>16){
      const pages=Math.ceil(uniqueAngles(volume).length/16);
      const controls=document.createElement('div');controls.className='panel-pagination';
      const prev=document.createElement('button');prev.textContent='◀';prev.disabled=this.page===0;
      prev.onclick=()=>{this.page--;this.schedule();};
      const label=document.createElement('span');label.textContent=(this.page+1)+' / '+pages;
      const next=document.createElement('button');next.textContent='▶';next.disabled=this.page>=pages-1;
      next.onclick=()=>{this.page++;this.schedule();};
      controls.append(prev,label,next);this.grid.append(controls);
    }
  }
}
