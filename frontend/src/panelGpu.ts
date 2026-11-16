import maplibregl from 'maplibre-gl';
import type {RadarFrame} from './radar';
import {getPalette,palettePixels,valueFactor} from './palettes';

export type PanelDraw={canvas:HTMLCanvasElement;frame:RadarFrame};
export type BoundaryKind='states'|'counties'|'cwa';
export type ProjectedBoundaries={kind:BoundaryKind;color:string;lines:number[][][]}[];
type GpuBoundary={kind:BoundaryKind;buffer:WebGLBuffer;count:number;color:[number,number,number]};
type Entry={gate:WebGLTexture;lookup:WebGLTexture;palette:WebGLTexture;bytes:number};
const VERT=`#version 300 es
void main() {
 vec2 p=vec2(float((gl_VertexID<<1)&2),float(gl_VertexID&2));
 gl_Position=vec4(p*2.0-1.0,0,1);
}`;
const FRAG=`#version 300 es
precision highp float;
precision highp sampler2D;
out vec4 color;
uniform sampler2D u_gate,u_lookup,u_palette;
uniform vec4 u_rect;
uniform vec2 u_center,u_span,u_radar;
uniform float u_scale,u_first,u_spacing,u_min,u_max,u_factor,u_nd;
uniform int u_gates,u_rays;
void main(){
 vec2 uv=(gl_FragCoord.xy-u_rect.xy)/u_rect.zw;
 vec2 merc=u_center+vec2((uv.x-0.5)*u_span.x,(0.5-uv.y)*u_span.y);
 vec2 meters=(merc-u_radar)*u_scale;
 int gate=int(floor((length(meters)-u_first)/u_spacing+0.5));
 if(gate<0||gate>=u_gates){color=vec4(0,0,0,1);return;}
 float az=degrees(atan(meters.x,-meters.y));
 if(az<0.0)az+=360.0;
 int bin=int(floor(az*10.0))%3600;
 float token=texelFetch(u_lookup,ivec2(bin,0),0).r;
 int ray=int(token+0.5)-1;
 if(token<0.5||ray<0||ray>=u_rays){color=vec4(0,0,0,1);return;}
 float value=texelFetch(u_gate,ivec2(gate,ray),0).r;
 if(isnan(value)||isinf(value)||
   (u_nd>0.5&&(abs(value+64.5)<0.0001||abs(value+64.0)<0.0001))){
   color=vec4(0,0,0,1);return;
 }
 float part=clamp((value*u_factor-u_min)/max(0.001,u_max-u_min),0.0,1.0);
 color=vec4(texture(u_palette,vec2(part,0.5)).rgb,1);
}`;
// Draw outlines using the SAME scissored viewport and camera uniforms as
// radar gates. No second CPU canvas to lag behind when the user drags.
const LINE_VERT=`#version 300 es
layout(location=0) in vec2 a_position;
uniform vec2 u_origin;
uniform vec2 u_camera;
uniform vec2 u_span;
void main(){
 vec2 offset=a_position-(u_camera-u_origin);
 gl_Position=vec4(2.0*offset.x/u_span.x,-2.0*offset.y/u_span.y,0.0,1.0);
}`;
const LINE_FRAG=`#version 300 es
precision mediump float;
uniform vec3 u_line_color;
out vec4 color;
void main(){color=vec4(u_line_color,1.0);}
`;
function shader(gl:WebGL2RenderingContext,type:number,src:string){
 const s=gl.createShader(type);if(!s)throw Error('Shader allocation failed');
 gl.shaderSource(s,src);gl.compileShader(s);
 if(!gl.getShaderParameter(s,gl.COMPILE_STATUS)){
  const msg=gl.getShaderInfoLog(s)||'Shader compile failed';gl.deleteShader(s);throw Error(msg);
 }
 return s;
}
function azimuthLookup(f:RadarFrame){
 const a=new Float32Array(3600),error=new Float32Array(3600).fill(Infinity);
 for(let i=0;i<f.sweep.azimuth_deg.length;i++){
  const az=f.sweep.azimuth_deg[i];if(!Number.isFinite(az))continue;
  const base=Math.round(az*10);
  for(let d=-9;d<=9;d++){
   const k=((base+d)%3600+3600)%3600;
   const distance=Math.abs(((az-(k+0.5)/10+540)%360)-180);
   if(distance<=0.8&&distance<error[k]){a[k]=i+1;error[k]=distance;}
  }
 }
 return a;
}
export class PanelGpu {
 readonly canvas:HTMLCanvasElement;
 private gl:WebGL2RenderingContext|null=null;
 private program:WebGLProgram|null=null;
 private vao:WebGLVertexArrayObject|null=null;
 private lineProgram:WebGLProgram|null=null;
 private lineVao:WebGLVertexArrayObject|null=null;
 private lineData:GpuBoundary[]=[];
 private lineOrigin:[number,number]=[0,0];
 private outlines:ProjectedBoundaries=[];
 private visibility:Record<BoundaryKind,boolean>={states:true,counties:true,cwa:true};
 private lineUniforms=new Map<string,WebGLUniformLocation|null>();
 private cache=new Map<string,Entry>();
 private bytes=0;
 private pending=false;
 private lastDrawMs=0;
 private lastDrawAt=0;
 private drawNumber=0;
 private tiles:PanelDraw[]=[];
 private lost=false;
 private failed=false;
 onFailure?:()=>void;
 private uniforms=new Map<string,WebGLUniformLocation|null>();
 readonly maxBytes=120*1024*1024;
 error='';
 constructor(private grid:HTMLDivElement,private map:maplibregl.Map){
  this.canvas=document.createElement('canvas');this.canvas.className='panel-gpu-surface';
  this.canvas.setAttribute('aria-hidden','true');grid.prepend(this.canvas);
  this.canvas.addEventListener('webglcontextlost',e=>{
   e.preventDefault();this.lost=true;this.gl=null;this.program=null;
   this.onFailure?.();
   this.cache.clear();this.uniforms.clear();this.lineData=[];this.lineProgram=null;
   this.bytes=0;
  });
  this.canvas.addEventListener('webglcontextrestored',()=>{
   this.lost=false;this.initialize();this.onFailure?.();this.schedule();
  });
  this.initialize();
 }
 get ready(){return !!(this.gl&&this.program&&!this.lost&&!this.failed);}
 private initialize(){
  try{
   const gl=this.canvas.getContext('webgl2',{
    alpha:false,antialias:false,depth:false,stencil:false,
    preserveDrawingBuffer:false,powerPreference:'high-performance'
   });
   if(!gl)throw Error('WebGL2 unavailable');
   const vs=shader(gl,gl.VERTEX_SHADER,VERT),fs=shader(gl,gl.FRAGMENT_SHADER,FRAG);
   const p=gl.createProgram();if(!p)throw Error('Program allocation failed');
   gl.attachShader(p,vs);gl.attachShader(p,fs);gl.linkProgram(p);
   gl.deleteShader(vs);gl.deleteShader(fs);
   if(!gl.getProgramParameter(p,gl.LINK_STATUS))throw Error(gl.getProgramInfoLog(p)||'Link error');
   const lvs=shader(gl,gl.VERTEX_SHADER,LINE_VERT);
   const lfs=shader(gl,gl.FRAGMENT_SHADER,LINE_FRAG);
   const lines=gl.createProgram();if(!lines)throw Error('Line program allocation failed');
   gl.attachShader(lines,lvs);gl.attachShader(lines,lfs);
   gl.linkProgram(lines);gl.deleteShader(lvs);gl.deleteShader(lfs);
   if(!gl.getProgramParameter(lines,gl.LINK_STATUS))
     throw Error(gl.getProgramInfoLog(lines)||'Line shader link error');
   this.lineProgram=lines;
   this.lineVao=gl.createVertexArray();
   this.lineUniforms.clear();
   for(const name of ['u_origin','u_camera','u_span','u_line_color'])
     this.lineUniforms.set(name,gl.getUniformLocation(lines,name));
   this.gl=gl;this.program=p;this.vao=gl.createVertexArray();
   this.failed=false;
   this.uniforms.clear();
   for(const name of ['u_gate','u_lookup','u_palette','u_rect',
      'u_center','u_span','u_radar','u_scale','u_first','u_spacing',
      'u_gates','u_rays','u_min','u_max','u_factor','u_nd'])
      this.uniforms.set(name,gl.getUniformLocation(p,name));
   gl.useProgram(p);gl.bindVertexArray(this.vao);
   for(const [name,n] of [['u_gate',0],['u_lookup',1],['u_palette',2]] as const)
    gl.uniform1i(gl.getUniformLocation(p,name),n);
  }catch(e){this.error=String(e);this.failed=true;console.warn('GPU panels disabled:',e);
   this.onFailure?.();}
 }
 private key(f:RadarFrame){
  const s=f.sweep,d=f.descriptor;
  return [f.volume.radar_id,f.volume.volume_id.split('_CH')[0],f.moment,s.id,
   s.time_utc[0],s.time_utc[s.time_utc.length-1],d.rays,d.gates,d.first_gate_m,d.gate_spacing_m].join('|');
 }
 private texture(unit:number,internal:number,w:number,h:number,format:number,
                 type:number,data:ArrayBufferView){
  const gl=this.gl!,t=gl.createTexture();if(!t)throw Error('GPU texture failed');
  gl.activeTexture(gl.TEXTURE0+unit);gl.bindTexture(gl.TEXTURE_2D,t);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT,1);
  gl.texImage2D(gl.TEXTURE_2D,0,internal,w,h,0,format,type,data);
  return t;
 }
 private fetchTextures(f:RadarFrame):Entry{
  const key=this.key(f),hit=this.cache.get(key);
  if(hit){this.cache.delete(key);this.cache.set(key,hit);return hit;}
  const gl=this.gl!,max=gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
  if(f.descriptor.gates>max||f.descriptor.rays>max)throw Error('Radar texture exceeds GPU maximum');
  const gate=this.texture(0,gl.R32F,f.descriptor.gates,f.descriptor.rays,gl.RED,gl.FLOAT,f.values);
  const lookup=this.texture(1,gl.R32F,3600,1,gl.RED,gl.FLOAT,azimuthLookup(f));
  const palette=this.texture(2,gl.RGBA8,256,1,gl.RGBA,gl.UNSIGNED_BYTE,
   palettePixels(getPalette(f.moment,'operational')));
  const entry={gate,lookup,palette,bytes:f.values.byteLength+15424};
  this.cache.set(key,entry);this.bytes+=entry.bytes;
  while((this.bytes>this.maxBytes||this.cache.size>22)&&this.cache.size>1){
   const [k,v]=this.cache.entries().next().value as [string,Entry];
   this.cache.delete(k);this.bytes-=v.bytes;
   gl.deleteTexture(v.gate);gl.deleteTexture(v.lookup);gl.deleteTexture(v.palette);
  }
  return entry;
 }
 setBoundaries(shapes:ProjectedBoundaries){
  this.outlines=shapes;
  this.uploadOutlines();
  this.schedule();
 }
 setBoundaryVisibility(visible:Record<BoundaryKind,boolean>){
  this.visibility={...visible};
  this.schedule();
 }
 private uploadOutlines(){
  const gl=this.gl;
  if(!gl||!this.lineProgram)return;
  for(const item of this.lineData)gl.deleteBuffer(item.buffer);
  this.lineData=[];
  const first=this.outlines.flatMap(s=>s.lines).find(line=>line.length>=2);
  this.lineOrigin=first?[first[0][0],first[0][1]]:[0,0];
  const [ox,oy]=this.lineOrigin;
  for(const shape of this.outlines){
    const verts:number[]=[];
    for(const line of shape.lines){
      for(let i=1;i<line.length;i++){
        const a=line[i-1],b=line[i];
        if(!Number.isFinite(a[0]+a[1]+b[0]+b[1]))continue;
        verts.push(a[0]-ox,a[1]-oy,b[0]-ox,b[1]-oy);
      }
    }
    if(!verts.length)continue;
    const buffer=gl.createBuffer();if(!buffer)continue;
    gl.bindBuffer(gl.ARRAY_BUFFER,buffer);
    gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(verts),gl.STATIC_DRAW);
    const css=shape.color.replace('#','');
    const color:[number,number,number]=[
      parseInt(css.slice(0,2),16)/255,
      parseInt(css.slice(2,4),16)/255,
      parseInt(css.slice(4,6),16)/255
    ];
    this.lineData.push({kind:shape.kind,buffer,count:verts.length/2,color});
  }
 }
 private drawLines(camera:maplibregl.MercatorCoordinate,spanX:number,spanY:number){
  const gl=this.gl!,program=this.lineProgram;
  if(!program||!this.lineData.length)return;
  gl.useProgram(program);
  gl.bindVertexArray(this.lineVao);
  const u=(s:string)=>this.lineUniforms.get(s)??null;
  gl.uniform2f(u('u_origin'),this.lineOrigin[0],this.lineOrigin[1]);
  gl.uniform2f(u('u_camera'),camera.x,camera.y);
  gl.uniform2f(u('u_span'),spanX,spanY);
  for(const line of this.lineData){
    if(!this.visibility[line.kind])continue;
    gl.uniform3f(u('u_line_color'),...line.color);
    gl.bindBuffer(gl.ARRAY_BUFFER,line.buffer);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0,2,gl.FLOAT,false,0,0);
    gl.drawArrays(gl.LINES,0,line.count);
  }
  gl.useProgram(this.program);
  gl.bindVertexArray(this.vao);
 }
 setTiles(tiles:PanelDraw[]){this.tiles=tiles;this.schedule();}
 get drawMs(){return this.lastDrawMs;}
 clear(){this.tiles=[];this.schedule();}
 schedule(){
  if(this.pending)return;
  this.pending=true;
  const paint=(time:number)=>{
   if(!this.grid.isConnected||this.grid.classList.contains('hidden')){
     this.pending=false;return;
   }
   // Coalesce pointer-move events. At 16 panes, limit redraw to ~30 fps;
   // native-gate textures stay resident, but fragment shader work is costly.
   const minInterval=this.grid.dataset.panels==='16'?32:
     this.grid.dataset.panels==='4'?22:15;
   if(this.lastDrawAt&&time-this.lastDrawAt<minInterval){
     requestAnimationFrame(paint);return;
   }
   this.pending=false;
   this.lastDrawAt=time;
   this.draw();
  };
  requestAnimationFrame(paint);
 }
 private draw(){
  const started=performance.now();
  const gl=this.gl,p=this.program;if(!gl||!p||this.lost)return;
  const outer=this.grid.getBoundingClientRect();if(outer.width<1||outer.height<1)return;
  // Scale capped to protect the GPU; 16 views are still native-gate rendered.
  const ratio=Math.min(devicePixelRatio||1,this.grid.dataset.panels==='16'?1:1.25);
  const w=Math.max(1,Math.round(outer.width*ratio)),h=Math.max(1,Math.round(outer.height*ratio));
  if(this.canvas.width!==w||this.canvas.height!==h){this.canvas.width=w;this.canvas.height=h;}
  gl.disable(gl.DEPTH_TEST);gl.disable(gl.BLEND);gl.disable(gl.SCISSOR_TEST);
  gl.viewport(0,0,w,h);gl.clearColor(0,0,0,1);gl.clear(gl.COLOR_BUFFER_BIT);
  gl.useProgram(p);gl.bindVertexArray(this.vao);
  const u=(name:string)=>this.uniforms.get(name)??null;
  const center=maplibregl.MercatorCoordinate.fromLngLat(this.map.getCenter());
  const world=512*2**this.map.getZoom();
  // A common MERCATOR UNITS PER PIXEL preserves radar geometry without
  // forcing rectangular panel tiles into tiny centered square viewports.
  // Each tile has its own correct rectangular geographic extent (X and Y).
  const mercatorPerCssPixel=1/world;
  gl.uniform2f(u('u_center'),center.x,center.y);
  gl.enable(gl.SCISSOR_TEST);
  for(const job of this.tiles){
   if(!job.canvas.isConnected)continue;
   const box=job.canvas.getBoundingClientRect();
   const x=Math.max(0,Math.round((box.left-outer.left)*ratio));
   const y=Math.max(0,Math.round((outer.bottom-box.bottom)*ratio));
   const tw=Math.min(w-x,Math.round(box.width*ratio));
   const th=Math.min(h-y,Math.round(box.height*ratio));
   if(tw<=0||th<=0)continue;
   try{
    const f=job.frame,t=this.fetchTextures(f),pal=getPalette(f.moment,'operational');
    const radar=maplibregl.MercatorCoordinate.fromLngLat([f.volume.radar_lon,f.volume.radar_lat]);
    gl.uniform4f(u('u_rect'),x,y,tw,th);
    gl.uniform2f(u('u_span'),box.width*mercatorPerCssPixel,box.height*mercatorPerCssPixel);
    gl.uniform2f(u('u_radar'),radar.x,radar.y);
    gl.uniform1f(u('u_scale'),40075016.686*Math.cos(f.volume.radar_lat*Math.PI/180));
    gl.uniform1f(u('u_first'),f.descriptor.first_gate_m);
    gl.uniform1f(u('u_spacing'),f.descriptor.gate_spacing_m);
    gl.uniform1i(u('u_gates'),f.descriptor.gates);
    gl.uniform1i(u('u_rays'),f.descriptor.rays);
    gl.uniform1f(u('u_min'),pal.min);gl.uniform1f(u('u_max'),pal.max);
    gl.uniform1f(u('u_factor'),valueFactor(f.moment,f.descriptor.units));
    const units=f.descriptor.units.toLowerCase();
    gl.uniform1f(u('u_nd'),f.moment==='VEL'&&(units.includes('m/s')||units.includes('m s-1'))?1:0);
    for(const [i,tex] of [t.gate,t.lookup,t.palette].entries()){
     gl.activeTexture(gl.TEXTURE0+i);gl.bindTexture(gl.TEXTURE_2D,tex);
    }
    gl.viewport(x,y,tw,th);gl.scissor(x,y,tw,th);
    gl.drawArrays(gl.TRIANGLES,0,3);
    this.drawLines(center,box.width*mercatorPerCssPixel,box.height*mercatorPerCssPixel);
   }catch(e){this.fail(e);return;}
  }
  gl.disable(gl.SCISSOR_TEST);
  this.lastDrawMs=performance.now()-started;
  // gl.getError() may synchronize with the GPU and stall interactive panning.
  // Sample it periodically instead of on every displayed frame.
  if(++this.drawNumber%60===0){
   const error=gl.getError();
   if(error!==gl.NO_ERROR)this.fail('WebGL error 0x'+error.toString(16));
  }
 }
 private fail(reason:unknown){
  if(this.failed)return;
  this.error=String(reason);this.failed=true;
  console.warn('Multi-panel GPU falling back to CPU:',reason);
  this.onFailure?.();
 }
}
