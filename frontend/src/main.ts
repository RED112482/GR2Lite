import maplibregl from 'maplibre-gl';
import './style.css';
import {fetchVolumes,fetchFrame,momentOrder,formatValue} from './radar';
import type {Moment,RadarFrame,VolumeDescriptor,SweepDescriptor} from './radar';
import {PolarRadarLayer} from './radarLayer';
import {getPalette,cssGradient} from './palettes';
import {installBoundaries} from './overlays';
import {PanelManager} from './panels';
import {valueFactor} from './palettes';

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
    sources:{},
    layers:[{id:'base',type:'background',paint:{'background-color':'#252b32'}}]
  },
  center:[-88.239,30.679],zoom:7,pitch:0,maxPitch:0,dragRotate:false
});
map.addControl(new maplibregl.NavigationControl({showCompass:false}),'top-right');
const radar=new PolarRadarLayer();
radar.onGpuStatus=(text)=>{el<HTMLSpanElement>('gpuLabel').textContent=text;};
map.once('load',()=>{try{map.addLayer(radar);}catch(e){showError(e);}});
map.on('error',e=>console.warn('Map tile or renderer warning',e.error));
let volume:VolumeDescriptor|undefined;
let moment:Moment='REF';
let sweep:SweepDescriptor|undefined;
let current:RadaFrameAlias|undefined;
type RadaFrameAlias = RadarFrame;
let request=0;
let feedMode:'archive'|'live'|'chunks'='archive';
let feedState='empty';
let availableVolumes:VolumeDescriptor[]=[];
let panelManager:PanelManager;
let syncing=false;
let boundariesLoaded=false;
panelManager=new PanelManager(map,el<HTMLDivElement>('panelGrid'),()=>apiInput.value.trim(),s=>{sweep=s;renderTiltOptions();void loadFrame();});
document.querySelectorAll<HTMLButtonElement>('#layoutButtons button').forEach(button=>{
  button.onclick=()=>panelManager.setCount(Number(button.dataset.panels) as 1|2|4|16);
});
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
  el<HTMLDivElement>('legend-gradient').style.background=cssGradient(p).replace('to right','to top');
  el<HTMLSpanElement>('legend-min').textContent=p.min+' '+p.unit;
  el<HTMLSpanElement>('legend-max').textContent=p.max+' '+p.unit;
  el<HTMLDivElement>('legend-title').textContent=moment+' • '+p.unit;
  const ticks=el<HTMLDivElement>('legend-ticks');
  ticks.replaceChildren();
  const step=moment==='REF'?5:moment==='VEL'?20:Math.max(0.1,(p.max-p.min)/10);
  const first=Math.ceil(p.min/step)*step;
  for(let value=first;value<=p.max;value+=step){
    const label=document.createElement('span');
    label.className='legend-tick';
    label.textContent=String(Math.round(value*10)/10);
    label.style.bottom=(100*(value-p.min)/(p.max-p.min))+'%';
    ticks.append(label);
  }
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
    let count=0, high=-Infinity, peak=-1;
    for(let j=0;j<frame.values.length;j++){
      const value=frame.values[j];
      if(Number.isFinite(value)){
        count++;
        if(value>high){high=value;peak=j;}
      }
    }
    const echoes=m==='REF' ? frame.values.reduce((n,value)=>n+(Number.isFinite(value)&&value>=5?1:0),0):null;
    el<HTMLSpanElement>('validLabel').textContent=
      count.toLocaleString()+' finite bins'+(echoes!==null?' • '+echoes.toLocaleString()+' ≥5 dBZ':'');
    if(!count)throw new Error('This radar cut contains no finite '+m+' gates. Try another tilt or radar moment.');
    el<HTMLSpanElement>('gpuLabel').textContent=radar.isReady()?'GPU UPLOADED':'GPU INITIALIZING';
    if(!radar.isReady())console.warn('Radar frame received but GPU layer is not ready; inspect browser console.');
    const selectedTimes=s.time_utc.filter(Boolean);
    const timestamp=selectedTimes.length?new Date(selectedTimes[0]).toISOString().slice(0,19).replace('T',' ')+'Z':'Time unavailable';
    el<HTMLSpanElement>('scanTime').textContent=timestamp;
    const pal=getPalette(moment,el<HTMLSelectElement>('palette').value);
    el<HTMLSpanElement>('momentLabel').textContent=moment+' • '+pal.unit;
    const timeList=v.sweeps.flatMap(s=>s.time_utc);
    const vst=timeList.length?new Date(Math.min(...timeList.map(t=>new Date(t).getTime()))).toISOString().slice(11,19)+'Z':'—';
    const latestTime=s.time_utc.length?new Date(s.time_utc[s.time_utc.length-1]).toISOString().slice(11,19)+'Z':'—';
    const maxRay=peak<0?0:Math.floor(peak/frame.descriptor.gates);
    const maxGate=peak<0?0:peak%frame.descriptor.gates;
    const rangeKm=(frame.descriptor.first_gate_m+maxGate*frame.descriptor.gate_spacing_m)/1000;
    const maxValue=high*valueFactor(moment,frame.descriptor.units);
    el<HTMLDivElement>('radarMeta').textContent=
      'Site: '+v.radar_id+'\nVST: '+vst+'\nProduct: '+latestTime+
      '\nTilt: '+s.fixed_angle_deg.toFixed(2)+'°'+
      '\nVCP: '+(v.vcp??'—')+'\nMoment: '+moment+'\nMax: '+(Number.isFinite(maxValue)?maxValue.toFixed(1):'—')+' '+pal.unit+
      '\nAz: '+(peak>=0?s.azimuth_deg[maxRay].toFixed(1):'—')+'°'+
      '\nRange: '+(peak>=0?rangeKm.toFixed(1):'—')+' km';
    el<HTMLSpanElement>('angleLabel').textContent=s.fixed_angle_deg.toFixed(2)+'° / CUT '+s.index;
    el<HTMLSpanElement>('volumeLabel').textContent=(feedMode==='chunks'?'CHUNKS':feedMode==='live'?'NEAR-LIVE':'ARCHIVE')+' • '+v.volume_id;
    el<HTMLDivElement>('gate').textContent='Click a valid radar gate to inspect the native '+m+' measurement.';
    setStatus(feedMode==='live' ? 'NEAR-LIVE • '+feedState.toUpperCase() : 'ARCHIVE READY',
      feedState==='stale'||feedState==='error'?'error': 'ok');
    clearError();
  }catch(e){if(id===request)showError(e);}
}
function currentHistory(){
  const id=volume?.volume_id;
  const select=el<HTMLSelectElement>('history');
  select.replaceChildren();
  for(const v of availableVolumes){
    const opt=document.createElement('option');
    opt.value=v.volume_id;
    const stamp=v.sweeps.length && v.sweeps[0].time_utc.length
      ? new Date(v.sweeps[0].time_utc[0]).toISOString().slice(0,19).replace('T',' ')+'Z'
      : v.volume_id;
    opt.textContent=stamp;
    select.appendChild(opt);
  }
  if(id&&availableVolumes.some(v=>v.volume_id===id))select.value=id;
}

async function chooseVolume(selected:VolumeDescriptor,initial:boolean){
  const oldMoment=moment,oldAngle=sweep?.fixed_angle_deg;
  const previousRadar=volume?.radar_id;
  volume=selected;
  el<HTMLElement>('radarName').textContent=selected.radar_id;
  const supported=momentOrder.filter(m=>selected.sweeps.some(s=>s.moments[m]));
  moment=supported.includes(oldMoment)?oldMoment:(supported.includes('REF')?'REF':supported[0]);
  if(!moment)throw new Error('Volume contains no supported radar moments');
  const candidates=selected.sweeps.filter(s=>s.moments[moment]);
  sweep=oldAngle===undefined||initial?candidates[0]
    :candidates.reduce((best,s)=>Math.abs(s.fixed_angle_deg-oldAngle)<Math.abs(best.fixed_angle_deg-oldAngle)?s:best,candidates[0]);
  if(!sweep)throw new Error('No radar elevation for '+moment);
  if(initial||previousRadar!==selected.radar_id){
    map.jumpTo({center:[selected.radar_lon,selected.radar_lat],zoom:7,bearing:0,pitch:0});
  }
  currentHistory();renderTiltOptions();
  await loadFrame();
}

async function syncRadar(initial=false){
  if(syncing)return;
  syncing=true;
  const root=apiInput.value.trim().replace(/\/$/,'');
  try{
    const response=await fetch(root+'/radar/status',{cache:'no-store'});
    if(!response.ok)throw new Error('Backend radar status: HTTP '+response.status);
    const info=await response.json() as {
      mode:'archive'|'live'|'chunks';state:string;latest_volume_id:string|null;feed_source?:string;
      age_seconds:number|null;last_error:string|null;last_check_utc:string|null;
    };
    feedMode=info.mode;feedState=info.state;
    const age=info.age_seconds===null?'unknown':Math.round(info.age_seconds/60)+' min';
    el<HTMLParagraphElement>('feedInfo').textContent=info.mode!=='archive'
      ? (info.mode==='chunks'?'Incremental chunks':'Completed volumes')+' • '+(info.feed_source??'feed')+' • latest ray '+age+' old'+
        (info.last_error?' • last update error: '+info.last_error:'')
      : 'Archived volume • automatic updates disabled';
    const list=await fetchVolumes(root);
    availableVolumes=list;
    const follow=el<HTMLInputElement>('followLive').checked;
    const target=follow?list[0]:list.find(v=>v.volume_id===volume?.volume_id)??list[0];
    if(!target){
      currentHistory();
      if(info.mode==='live'){
        setStatus(info.state==='error'?'FEED ERROR':'WAITING FOR KMOB',info.state==='error'?'error':'');
        clearError();
      }else if(initial)throw new Error('No archive loaded. Set GR2LITE_ARCHIVE_PATH and restart backend.');
      return;
    }
    if(initial||target.volume_id!==volume?.volume_id){
      await chooseVolume(target,initial);
    }else{
      currentHistory();
      setStatus(feedMode==='chunks'?'CHUNKS • '+feedState.toUpperCase():feedMode==='live'?'NEAR-LIVE • '+feedState.toUpperCase():'ARCHIVE READY',
        feedState==='stale'||feedState==='error'?'error':'ok');
    }
    if(!boundariesLoaded&&map.isStyleLoaded()){
      boundariesLoaded=true;
      void installBoundaries(map,root);
      void panelManager.loadBoundaries();
    }
    clearError();
  }catch(e){
    if(initial)showError(e);
    else{
      const msg=e instanceof Error?e.message:String(e);
      el<HTMLParagraphElement>('feedInfo').textContent='Connection failed: '+msg;
      setStatus('DISCONNECTED','error');
    }
  }finally{
    syncing=false;
  }
}
async function connect(){
  ++request;
  frameCache.clear();
  boundariesLoaded=false;
  clearError();setStatus('CONNECTING');
  localStorage.setItem('gr2lite-api',apiInput.value.trim());
  await syncRadar(true);
}
el<HTMLButtonElement>('connect').onclick=()=>{void connect();};
el<HTMLSelectElement>('history').onchange=async e=>{
  el<HTMLInputElement>('followLive').checked=false;
  const target=availableVolumes.find(v=>v.volume_id===(e.target as HTMLSelectElement).value);
  if(target)await chooseVolume(target,false);
};
el<HTMLInputElement>('followLive').onchange=()=>{
  if(el<HTMLInputElement>('followLive').checked)void syncRadar();
};
// Only one status poll can run at a time; keep history and view stable.
window.setInterval(()=>{void syncRadar();},12000);
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
    e.preventDefault();
    if(panelManager.count===16)return;
    // Strictly move to a greater/lower *elevation angle*: skip split-cut duplicates.
    const cuts=[...(volume?.sweeps.filter(s=>s.moments[moment])??[])]
      .sort((a,b)=>a.fixed_angle_deg-b.fixed_angle_deg);
    const angle=sweep?.fixed_angle_deg??-1;
    const chosen=e.key==='ArrowUp'
      ? cuts.find(s=>s.fixed_angle_deg>angle+0.16)
      : [...cuts].reverse().find(s=>s.fixed_angle_deg<angle-0.16);
    if(!chosen)return; // never wrap from highest to lowest on arrow-up
    sweep=chosen;
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
