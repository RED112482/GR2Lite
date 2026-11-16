import type {TiltIndex} from './tiltIndex';
import type {SweepDescriptor,VolumeDescriptor} from './radar';

export interface ScanStripState {
  newestId:string|null;
  angles:{angle:number;count:number;newest:boolean;selected:boolean;time:string}[];
  vcp:string;
  supplemental:string;
  supplementalTitle:string;
  avset:string;
  avsetTitle:string;
  progress:string;
  latestLabel:string;
}
const angleClose=(a:number,b:number)=>Math.abs(a-b)<0.16;
const timeMs=(s:SweepDescriptor)=>{
  const values=s.time_utc;
  const last=values.length?Date.parse(values[values.length-1]):NaN;
  return Number.isFinite(last)?last:-Infinity;
};
function clock(s:SweepDescriptor):string {
  const last=s.time_utc[s.time_utc.length-1];
  return last?new Date(last).toISOString().slice(11,19)+'Z':'—';
}
export function scanStripState(v:VolumeDescriptor,selectedId?:string):ScanStripState {
  const sweeps=[...v.sweeps].filter(s=>Number.isFinite(s.fixed_angle_deg))
    .sort((a,b)=>timeMs(a)-timeMs(b)||a.index-b.index);
  const newest=sweeps[sweeps.length-1];
  const angles:{angle:number;count:number;newest:boolean;selected:boolean;time:string}[]=[];
  for(const sweep of sweeps) {
    let group=angles.find(x=>angleClose(x.angle,sweep.fixed_angle_deg));
    if(!group) {
      group={angle:sweep.fixed_angle_deg,count:0,newest:false,selected:false,time:'—'};
      angles.push(group);
    }
    group.count++;
    group.newest=Boolean(newest&&sweep.id===newest.id);
    if(sweep.id===selectedId)group.selected=true;
    group.time=clock(sweep);
  }
  angles.sort((a,b)=>a.angle-b.angle);
  // Sequential split-cuts are not supplemental scans. Only count returns
  // to low elevations after a distinctly higher angle has been scanned.
  const seen:number[]=[];
  const supplementalAngles:number[]=[];
  let highestSeen=-Infinity;
  for(const sweep of sweeps) {
    const angle=sweep.fixed_angle_deg;
    if(seen.some(a=>angleClose(a,angle)) && highestSeen>angle+0.4 &&
       !supplementalAngles.some(a=>angleClose(a,angle))) {
      supplementalAngles.push(angle);
    }
    if(!seen.some(a=>angleClose(a,angle)))seen.push(angle);
    highestSeen=Math.max(highestSeen,angle);
  }
  const complete=v.volume_complete===true;
  let supplemental='OBSERVING';
  let supplementalTitle='Volume incomplete; supplemental scanning is not yet determined.';
  if(supplementalAngles.length>=2) {
    supplemental='MRLE?';
    supplementalTitle='Several low elevations repeated after higher cuts: an MRLE-like pattern, not an operator status confirmation.';
  }else if(supplementalAngles.length===1) {
    supplemental='SAILS / MRLE×1?';
    supplementalTitle='One low elevation repeated after higher cuts. SAILS and single-elevation MRLE cannot always be distinguished.';
  }else if(complete) {
    supplemental='NONE OBSERVED';
    supplementalTitle='No separated low-level rescans observed in the complete volume; this does not prove the operator setting.';
  }
  // Authoritative Level-II RDA metadata takes precedence over inferred scan
  // patterns. Message 5 supplies dynamic_scan_type, Message 2 AVSET state.
  const dynamic=v.dynamic_scan_type?.trim();
  if(dynamic) {
    const normalized=dynamic.toUpperCase().replace(/\s+/g,' ');
    if(normalized==='STANDARD' || normalized==='NONE') {
      supplemental='NONE';
    }else if(normalized.startsWith('SAILS')) {
      supplemental=normalized.replace(/\s*X\s*/,' × ');
    }else if(normalized.startsWith('MRLE')) {
      supplemental=normalized.replace(/\s*X\s*/,' × ');
    }else {
      supplemental=normalized;
    }
    supplementalTitle='Reported NEXRAD VCP dynamic scan type (Message 5): '+dynamic;
  }
  const avset=v.avset_enabled===true?'ON':v.avset_enabled===false?'OFF':'UNKNOWN';
  return {
    newestId:newest?.id??null,angles,
    vcp:v.vcp?.trim() || 'UNKNOWN',
    supplemental,supplementalTitle,
    avset,
    avsetTitle:v.avset_enabled===null||v.avset_enabled===undefined
      ?'NEXRAD RDA status Message 2 not available; AVSET setting unknown.'
      :'Reported NEXRAD RDA status Message 2: AVSET '+avset,
    progress:complete?'VOLUME COMPLETE':sweeps.length+' CUT'+(sweeps.length===1?'':'S')+' RECEIVED',
    latestLabel:newest?'LATEST '+newest.fixed_angle_deg.toFixed(1)+'° • '+clock(newest):'LATEST —',
  };
}
export function renderScanStrip(
  v:VolumeDescriptor|undefined,
  selectedId:string|undefined,
  onSelect:(angle:number)=>void,
  index?:TiltIndex,
  selectedVolumeId?:string
) {
  const list=document.getElementById('scanTilts');
  const vcp=document.getElementById('stripVcp');
  const mode=document.getElementById('stripStrategy');
  const avset=document.getElementById('stripAvset');
  const progress=document.getElementById('stripProgress');
  const latest=document.getElementById('stripLatest');
  if(!list||!vcp||!mode||!avset||!progress||!latest)return;
  if(!v) {
    list.replaceChildren();vcp.textContent='VCP —';mode.textContent='STRATEGY —';
    avset.textContent='AVSET —';progress.textContent='WAITING FOR SCANS';latest.textContent='LATEST —';return;
  }
  const state=scanStripState(v,selectedId);
  const indexed=Boolean(index?.volume_id===v.volume_id&&index.tilts.length);
  const vcpNumber=state.vcp.match(/\b(?:vcp\s*)?(\d{2,3})\b/i);
  vcp.textContent='VCP '+(vcpNumber?vcpNumber[1]:state.vcp);
  vcp.title=v.vcp?'VCP reported by decoder metadata':'VCP not supplied by decoder';
  mode.textContent=state.supplemental;
  mode.title=state.supplementalTitle;
  avset.textContent='AVSET '+state.avset;
  avset.title=state.avsetTitle;
  progress.textContent=state.progress+(indexed&&index!.previous_volume_id?' · PRIOR LEVELS SHOWN':'');
  latest.textContent=state.latestLabel;
  const fragment=document.createDocumentFragment();
  const displayed=indexed?index!.tilts.map(t=>({
    angle:t.angle,count:t.count_current,newest:t.newest,
    selected:Object.values(t.moments).some(src=>src?.volume_id===(selectedVolumeId??v.volume_id)&&src?.sweep_id===selectedId),
    time:t.time_utc?new Date(t.time_utc).toISOString().slice(11,19)+'Z':'—',
    prior:!t.current
  })):state.angles.map(t=>({...t,prior:false}));
  for(const item of displayed) {
    const b=document.createElement('button');
    b.type='button';
    b.className='scan-tilt'+(item.newest?' newest':'')+(item.selected?' selected':'')+(item.prior?' prior':'');
    b.dataset.source=item.prior?'previous':'current';
    b.textContent=item.angle.toFixed(1)+'°';
    b.title=item.angle.toFixed(2)+'° • '+(item.prior?'PREVIOUS COMPLETE VOLUME':'CURRENT VOLUME')+' • '+item.count+' current-volume cut(s) • latest '+item.time+
      (item.newest?' • NEWEST RECEIVED CUT':'');
    b.setAttribute('aria-label',b.title);
    if(item.prior){
      const tag=document.createElement('span');tag.className='scan-prior-tag';tag.textContent='PREV';b.append(tag);
    }
    if(item.count>1) {
      const count=document.createElement('span');
      count.className='scan-repeat';
      count.textContent='×'+item.count;
      b.append(count);
    }
    if(item.newest)b.setAttribute('data-newest','true');
    b.onclick=()=>onSelect(item.angle);
    fragment.append(b);
  }
  list.replaceChildren(fragment);
}
