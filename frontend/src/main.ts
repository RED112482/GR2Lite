import maplibregl from 'maplibre-gl';
import './style.css';
import {fetchVolumes,fetchFrame,momentOrder,formatValue} from './radar';
import type {Moment,RadarFrame,VolumeDescriptor,SweepDescriptor} from './radar';
import {PolarRadarLayer} from './radarLayer';
import {getPalette,cssGradient} from './palettes';

const el=<T extends HTMLElement>(id:string)=>document.getElementById(id) as T;
const apiInput=el<HTMLInputElement>('apiRoot');
apiInput.value=localStorage.getItem('gr2lite-api')||'/api';
const status=el<HTMLSpanElement>('status');
const message=el<HTMLDivElement>('map-error');
function setStatus(text:string,kind:'ok'|'error'|''=''){
  status.textContent=text;
  status.className='status '+kind;
}
function showError(error:unknown){
  const text=error instanceof Error?error.message:String(error);
  setStatus('ERROR','error');message.textContent=text;message.classList.remove('hidden');
  console.error(error);
}
function clearError(){message.classList.add('hidden');message.textContent='';}
const map=new maplibregl.Map({
  container:'map',
  style:{
    version:8,
    sources:{carto:{type:'raster',tiles:[
      'https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
      'https://b.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
      'https://c.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png'
    ],tileSize:256,attribution:'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'}},
    layers:[{id:'base',type:'raster',source:'carto'}]
  },
  center:[-88.239,30.679],zoom:7,pitch:0,maxPitch:0,dragRotate:false
});
map.addControl(new maplibregl.NavigationControl({showCompass:false}),'top-right');
const radar=new PolarRadarLayer();
map.once('load',()=>{try{map.addLayer(radar);}catch(e){showError(e);}});
map.on('error',e=>console.warn('Map tile or renderer warning',e.error));
let volume:VolumeDescriptor|undefined;
let moment:Moment='REF';
let sweep:SweepDescriptor|undefined;
let current:RadaFrameAlias|undefined;
type RadaFrameAlias = RadarFrame;
let request=0;
const frameCache=new Map<string,RadarFrame>();
function cacheKey(v:VolumeDescriptor,s:SweepDescriptor,m:Moment){return v.volume_id+'|'+s.id+'|'+m;}
function currentMomentOptions():Moment[]{return volume?momentOrder.filter(m=>volume!.sweeps.some(s=>s.moments[m])):[];}
function setMoments(){
  const holder=el<HTMLDivElement>('moments');holder.replaceChildren();
  const supported=currentMomentOptions();
  for(const m of momentOrder){
    const b=document.createElement('button');b.textContent=m;b.disabled=!supported.includes(m);
    b.className=moment===m?'active':'';
    b.onclick=async()=>{
      moment=m;
      const candidate=volume?.sweeps.find(s=>s.id===sweep?.id&&s.moments[m])
        ??volume?.sweeps.find(s=>s.moments[m]);
      if(candidate){sweep=candidate;renderTiltOptions();await loadFrame();}
    };holder.appendChild(b);
  }
}
function renderTiltOptions(){
  const select=el<HTMLSelectElement>('tilt');select.replaceChildren();
  for(const s of volume?.sweeps??[]){
    if(!s.moments[moment])continue;
    const opt=document.createElement('option');
    opt.value=s.id;opt.textContent='#'+s.index+'  •  '+s.fixed_angle_deg.toFixed(2)+'°';
    select.appendChild(opt);
  }
  if(sweep)select.value=sweep.id;
}
function paintLegend(){
  const p=getPalette(moment,el<HTMLSelectElement>('palette').value);
  el<HTMLDivElement>('legend-gradient').style.background=cssGradient(p);
  el<HTMLSpanElement>('legend-min').textContent=String(p.min);
  el<HTMLSpanElement>('legend-max').textContent=String(p.max);
  el<HTMLDivElement>('legend-title').textContent=moment+' color scale';
}
async function loadFrame(){
  if(!volume||!sweep)return;
  const id=++request,v=volume,s=sweep,m=moment;
  setMoments();paintLegend();setStatus('LOADING');
  try {
    const key=cacheKey(v,s,m);
    let frame=frameCache.get(key);
    if(!frame){
      frame=await fetchFrame(apiInput.value.trim(),v,s,m);
      frameCache.set(key,frame);
      if(frameCache.size>5)frameCache.delete(frameCache.keys().next().value!);
    }
    if(id!==request)return;
    current=frame;
    radar.setFrame(frame);
    const selectedTimes=s.time_utc.filter(Boolean);
    const timestamp=selectedTimes.length?new Date(selectedTimes[0]).toISOString().slice(0,19).replace('T',' ')+'Z':'Time unavailable';
    el<HTMLSpanElement>('scanTime').textContent=timestamp;
    el<HTMLSpanElement>('momentLabel').textContent=moment+' • '+frame.descriptor.units;
    el<HTMLSpanElement>('angleLabel').textContent=s.fixed_angle_deg.toFixed(2)+'° / CUT '+s.index;
    el<HTMLSpanElement>('volumeLabel').textContent='ARCHIVE • '+v.volume_id;
    el<HTMLDivElement>('gate').textContent='Click a valid radar gate to inspect the native '+m+' measurement.';
    setStatus('ARCHIVE READY','ok');clearError();
  }catch(e){if(id===request)showError(e);}
}
async function connect(){
  ++request;clearError();setStatus('CONNECTING');
  const root=apiInput.value.trim().replace(/\/$/,'');
  localStorage.setItem('gr2lite-api',root);
  try{
    const volumes=await fetchVolumes(root);
    if(!volumes.length)throw new Error('Backend is reachable, but no archive is preloaded. Set GR2LITE_ARCHIVE_PATH before starting uvicorn.');
    volume=volumes[0];
    if(volume.radar_id!=='KMOB')console.warn('A different radar is loaded:',volume.radar_id);
    el<HTMLElement>('radarName').textContent=volume.radar_id;
    frameCache.clear();
    moment=volume.sweeps.some(s=>s.moments.REF)?'REF':currentMomentOptions()[0];
    sweep=volume.sweeps.find(s=>s.moments[moment]);
    if(!sweep)throw new Error('No supported radar moments found');
    renderTiltOptions();
    map.jumpTo({center:[volume.radar_lon,volume.radar_lat],zoom:7,bearing:0,pitch:0});
    await loadFrame();
  }catch(e){showError(e);}
}
el<HTMLButtonElement>('connect').onclick=connect;
el<HTMLSelectElement>('tilt').onchange=async e=>{
  sweep=volume?.sweeps.find(s=>s.id===(e.target as HTMLSelectElement).value);
  await loadFrame();
};
el<HTMLSelectElement>('palette').onchange=()=>{
  radar.setPalette(el<HTMLSelectElement>('palette').value);paintLegend();
};
el<HTMLInputElement>('opacity').oninput=e=>{
  radar.setOpacity(Number((e.target as HTMLInputElement).value)/100);
};
el<HTMLButtonElement>('recenter').onclick=()=>map.easeTo({
  center:volume?[volume.radar_lon,volume.radar_lat]:[-88.239,30.679],zoom:7,duration:500
});
map.on('click',e=>{
  const f=current;if(!f)return;
  const hit=radar.sample(e.lngLat.lng,e.lngLat.lat);
  el<HTMLDivElement>('gate').textContent=hit
    ?'Value: '+formatValue(hit.value,f.descriptor.units)
      +'\nAzimuth: '+hit.azimuth.toFixed(2)+'°'
      +'\nSlant range (approx): '+(hit.rangeM/1000).toFixed(2)+' km'
      +'\nRadial / gate: '+hit.ray+' / '+hit.gate
      +'\nLatitude / longitude: '+e.lngLat.lat.toFixed(4)+', '+e.lngLat.lng.toFixed(4)
    :'No valid '+moment+' gate at the selected position.';
});
window.addEventListener('keydown',e=>{
  if(e.target instanceof HTMLInputElement||e.target instanceof HTMLSelectElement)return;
  if(e.key==='ArrowUp'||e.key==='ArrowDown'){
    e.preventDefault();const cuts=volume?.sweeps.filter(s=>s.moments[moment])??[];
    const idx=cuts.findIndex(s=>s.id===sweep?.id);
    if(!cuts.length)return;
    sweep=cuts[(idx+(e.key==='ArrowUp'?1:-1)+cuts.length)%cuts.length];
    renderTiltOptions();void loadFrame();
  }
  if(e.key==='Delete'&&volume){
    e.preventDefault();
    const next:Moment=moment==='REF'?'VEL':'REF';
    if(currentMomentOptions().includes(next)){
      moment=next;
      sweep=volume.sweeps.find(s=>s.id===sweep?.id&&s.moments[next])??volume.sweeps.find(s=>s.moments[next]);
      renderTiltOptions();void loadFrame();
    }
  }
});
paintLegend();
map.once('load',()=>{void connect();});
