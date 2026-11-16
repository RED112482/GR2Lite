import type maplibregl from 'maplibre-gl';
import {getBoundary} from './boundaryData';

type Kind = 'states' | 'counties' | 'cwa';
const config: Record<Kind, {layer:string; color:string; width:number; checkbox:string}> = {
  states: {layer:'gr2lite-states',color:'#c5d0dd',width:1.7,checkbox:'overlayStates'},
  counties: {layer:'gr2lite-counties',color:'#71869b',width:0.75,checkbox:'overlayCounties'},
  cwa: {layer:'gr2lite-cwa',color:'#f0b86d',width:2,checkbox:'overlayCwa'}
};
const allKinds:Kind[]=['states','counties','cwa'];

export async function installBoundaries(map:maplibregl.Map,root:string):Promise<void>{
  const notice=document.getElementById('overlay-status');
  const updateVisibility=()=>{
    for(const kind of allKinds){
      const cfg=config[kind];
      const toggle=document.getElementById(cfg.checkbox) as HTMLInputElement;
      if(map.getLayer(cfg.layer)){
        map.setLayoutProperty(cfg.layer,'visibility',toggle.checked?'visible':'none');
      }
    }
  };
  for(const kind of allKinds){
    const c=config[kind];
    (document.getElementById(c.checkbox) as HTMLInputElement).onchange=updateVisibility;
  }
  let successes=0;
  for(const kind of allKinds){
    const configItem=config[kind];
    try{
      const data=await getBoundary(root,kind);
      if(!map.getSource(configItem.layer)){
        map.addSource(configItem.layer,{type:'geojson',data});
        map.addLayer({
          id:configItem.layer,
          type:'line',
          source:configItem.layer,
          paint:{
            'line-color':configItem.color,
            'line-width':configItem.width,
            'line-opacity':0.9
          }
        });
      }else{
        (map.getSource(configItem.layer) as maplibregl.GeoJSONSource).setData(data);
      }
      successes++;
    }catch(error){
      console.warn('Boundary layer '+kind+' unavailable:',error);
    }
  }
  updateVisibility();
  if(notice)notice.textContent=successes===3
    ?'Official NOAA outlines: states, counties and CWAs'
    :'NOAA boundaries loaded: '+successes+'/3. Check backend /boundaries endpoints and server logs.';
}
