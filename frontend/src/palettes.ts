import type {Moment} from './radar';
export type Stop=[number,string];
export interface Palette {min:number;max:number;stops:Stop[];unit:string}
// Reference-inspired GR2 color ramps. Values are not a proprietary color-table file.
const ref:Stop[]=[[-30,'#05000e'],[-25,'#22003b'],[-20,'#40076e'],[-15,'#7066a2'],[-10,'#a2a2a8'],[-5,'#50555d'],[0,'#08090d'],[5,'#888888'],[10,'#4a4d4d'],[15,'#087c36'],[20,'#05d74b'],[25,'#067b24'],[30,'#e4ea38'],[35,'#fcb900'],[40,'#d88e0b'],[45,'#ff8d17'],[50,'#ee3227'],[55,'#fa0315'],[60,'#b6000b'],[65,'#e100a6'],[70,'#f700da'],[75,'#8b0296'],[80,'#f1e9ed']];
const vel:Stop[]=[[-200,'#15151c'],[-170,'#250037'],[-150,'#690064'],[-125,'#ff00b9'],[-100,'#a50655'],[-80,'#241f4c'],[-60,'#0081a5'],[-40,'#00bfd3'],[-20,'#18b647'],[-5,'#026d2b'],[0,'#4f5555'],[5,'#8f7757'],[20,'#f12126'],[40,'#ac0007'],[60,'#ed127e'],[80,'#f35cba'],[100,'#f48a37'],[125,'#f9d03a'],[150,'#ebf528'],[170,'#d0d39c'],[200,'#f6fff4']];
const ramp:Stop[]=[[0,'#10283e'],[0.25,'#3c90c0'],[0.5,'#63bf91'],[0.75,'#e5d85a'],[1,'#e4565f']];
export function valueFactor(moment:Moment,units:string):number{
  return moment==='VEL' && /m\/?s|m s-1|meter/i.test(units)?1.943844492:1;
}
export function getPalette(moment:Moment,variant:string):Palette{
  if(moment==='REF')return {min:-30,max:80,unit:'dBZ',stops:variant==='contrast'?[[-30,'#000'],[0,'#10265c'],[10,'#00a6d6'],[20,'#13a240'],[30,'#c4eb21'],[40,'#f1a200'],[50,'#e92e31'],[60,'#9e18a0'],[75,'#ffeff9'],[80,'#fff']]:ref};
  if(moment==='VEL')return {min:-200,max:200,unit:'kt',stops:vel};
  if(moment==='CC')return {min:0,max:1.05,unit:'',stops:[[0,'#a72b42'],[0.7,'#e77661'],[0.85,'#eac956'],[0.95,'#75c87c'],[0.99,'#3da4b2'],[1.05,'#a0cbe1']]};
  if(moment==='ZDR')return {min:-4,max:8,unit:'dB',stops:[[-4,'#734bb1'],[-1,'#5a8ae1'],[0,'#888b98'],[1,'#4bac84'],[3,'#e0dc62'],[5,'#ec8e49'],[8,'#ca365b']]};
  const scale=moment==='PHI'?360:moment==='SW'?25:10;
  const min=moment==='PHI'||moment==='SW'?0:-2;
  return {min,max:min+scale,unit:moment==='PHI'?'°':moment==='SW'?'m/s':'',stops:ramp.map(([f,c])=>[min+f*scale,c])};
}
function rgb(hex:string):number[]{
  const h=hex.slice(1);const x=h.length===3?h.split('').map(c=>c+c).join(''):h;
  return [0,2,4].map(i=>parseInt(x.slice(i,i+2),16));
}
export function palettePixels(p:Palette):Uint8Array{
  const out=new Uint8Array(256*4);
  for(let i=0;i<256;i++){
    const v=p.min+(p.max-p.min)*i/255;
    let a=p.stops[0],b=p.stops[p.stops.length-1];
    for(let j=0;j<p.stops.length-1;j++)if(v>=p.stops[j][0]&&v<=p.stops[j+1][0]){a=p.stops[j];b=p.stops[j+1];break;}
    const t=Math.max(0,Math.min(1,(v-a[0])/Math.max(1e-6,b[0]-a[0])));
    const ca=rgb(a[1]),cb=rgb(b[1]);
    for(let k=0;k<3;k++)out[4*i+k]=Math.round(ca[k]*(1-t)+cb[k]*t);
    out[4*i+3]=255;
  }
  return out;
}
export function cssGradient(p:Palette):string{
  return 'linear-gradient(to right,'+p.stops.map(s=>s[1]+' '+(100*(s[0]-p.min)/(p.max-p.min)).toFixed(1)+'%').join(',')+')';
}
