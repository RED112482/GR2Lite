import type {Moment} from './radar';

type Stop = [number, string];
export interface Palette {min:number; max:number; stops:Stop[]}
const ref: Stop[] = [[-20,'#172332'],[0,'#3b6270'],[5,'#3cbbca'],[15,'#238b46'],[25,'#68c43e'],[35,'#d9e44f'],[45,'#e4a43e'],[55,'#e75039'],[65,'#c02561'],[75,'#9136a7'],[85,'#f6dcef']];
const vel: Stop[] = [[-80,'#8c4da2'],[-50,'#305dc5'],[-30,'#1fa6b2'],[-15,'#279d51'],[-2,'#95dd80'],[0,'#333945'],[2,'#f9c2b8'],[15,'#f25b63'],[30,'#b4204b'],[50,'#d369ad'],[80,'#f5d8f0']];
const grayscale: Stop[] = [[0,'#10283e'],[0.25,'#3c90c0'],[0.5,'#63bf91'],[0.75,'#e5d85a'],[1,'#e4565f']];
export function getPalette(moment:Moment, variant:string): Palette {
  if (moment === 'REF') return {min:-20,max:85,stops:variant==='contrast'? [[-20,'#142337'],[0,'#092d7c'],[10,'#00a6d6'],[20,'#13a240'],[30,'#c4eb21'],[40,'#f1a200'],[50,'#e92e31'],[60,'#9e18a0'],[75,'#ffeff9'],[85,'#fff']]:ref};
  if (moment === 'VEL') return {min:-80,max:80,stops:vel};
  if (moment === 'CC') return {min:0,max:1.05,stops:[[0,'#a72b42'],[0.7,'#e77661'],[0.85,'#eac956'],[0.95,'#75c87c'],[0.99,'#3da4b2'],[1.05,'#a0cbe1']]};
  if (moment === 'ZDR') return {min:-4,max:8,stops:[[-4,'#734bb1'],[-1,'#5a8ae1'],[0,'#888b98'],[1,'#4bac84'],[3,'#e0dc62'],[5,'#ec8e49'],[8,'#ca365b']]};
  if (moment === 'PHI') return {min:0,max:360,stops:grayscale.map(([f,c])=>[f*360,c])};
  if (moment === 'SW') return {min:0,max:25,stops:grayscale.map(([f,c])=>[f*25,c])};
  return {min:-2,max:8,stops:grayscale.map(([f,c])=>[f*10-2,c])};
}
function rgb(hex: string): number[] {
  const h=hex.slice(1); const x=h.length===3?h.split('').map(c=>c+c).join(''):h;
  return [0,2,4].map(i=>parseInt(x.slice(i,i+2),16));
}
export function palettePixels(p:Palette): Uint8Array {
  const out=new Uint8Array(256*4);
  for(let i=0;i<256;i++){
    const v=p.min+(p.max-p.min)*i/255;
    let a=p.stops[0],b=p.stops[p.stops.length-1];
    for(let j=0;j<p.stops.length-1;j++){
      if(v>=p.stops[j][0]&&v<=p.stops[j+1][0]){a=p.stops[j];b=p.stops[j+1];break;}
    }
    const t=Math.max(0,Math.min(1,(v-a[0])/Math.max(1e-6,b[0]-a[0])));
    const ca=rgb(a[1]),cb=rgb(b[1]);
    for(let k=0;k<3;k++)out[4*i+k]=Math.round(ca[k]*(1-t)+cb[k]*t);
    out[4*i+3]=255;
  }
  return out;
}
export function cssGradient(p:Palette):string {
  return 'linear-gradient(to right,'+p.stops.map(s=>s[1]+' '+(100*(s[0]-p.min)/(p.max-p.min)).toFixed(1)+'%').join(',')+')';
}
