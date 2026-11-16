import maplibregl from 'maplibre-gl';
import type {RadarFrame} from './radar';
import {getPalette, palettePixels, valueFactor} from './palettes';

const VERTEX = `#version 300 es
in vec2 a_pos;
uniform mat4 u_matrix;
out vec2 v_merc;
void main() {
  v_merc = a_pos;
  gl_Position = u_matrix * vec4(a_pos, 0.0, 1.0);
}
`;
const FRAGMENT = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 v_merc;
out vec4 fragColor;
uniform sampler2D u_gates;
uniform sampler2D u_lookup;
uniform sampler2D u_palette;
uniform vec2 u_radar_merc;
uniform float u_scale;
uniform float u_first;
uniform float u_step;
uniform float u_gates_count;
uniform float u_min;
uniform float u_max;
uniform float u_opacity;
uniform float u_value_factor;
uniform float u_legacy_velocity_nd;
void main() {
  vec2 offset = (v_merc - u_radar_merc) * u_scale;
  float east = offset.x;
  float north = -offset.y;
  float range = length(offset);
  float g = floor((range - u_first)/u_step + 0.5);
  if (g < 0.0 || g >= u_gates_count) discard;
  float az = degrees(atan(east, north));
  if (az < 0.0) az += 360.0;
  int bin = int(floor(az * 10.0)) % 3600;
  float token = texelFetch(u_lookup, ivec2(bin, 0), 0).r;
  if (token < 0.5) discard;
  int ray = int(token + 0.5) - 1;
  float value = texelFetch(u_gates, ivec2(int(g),ray),0).r;
  if (isnan(value) || isinf(value)) discard;
  if (u_legacy_velocity_nd > 0.5 && (abs(value+64.5)<0.0001 || abs(value+64.0)<0.0001)) discard;
  float fraction = clamp((value*u_value_factor-u_min)/max(u_max-u_min,0.001),0.0,1.0);
  vec4 color = texture(u_palette,vec2(fraction,0.5));
  fragColor = vec4(color.rgb * u_opacity, u_opacity);
}
`;

function shader(gl: WebGL2RenderingContext, type: number, code: string): WebGLShader {
  const s=gl.createShader(type);
  if(!s)throw new Error('Unable to create WebGL shader');
  gl.shaderSource(s,code);
  gl.compileShader(s);
  if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw new Error(gl.getShaderInfoLog(s)??'Shader compilation failed');
  return s;
}
function texture(gl: WebGL2RenderingContext): WebGLTexture {
  const t=gl.createTexture();
  if(!t)throw new Error('Unable to create GPU texture');
  return t;
}
function setupNearest(gl:WebGL2RenderingContext, tex:WebGLTexture,unit:number){
  gl.activeTexture(gl.TEXTURE0+unit);
  gl.bindTexture(gl.TEXTURE_2D,tex);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
}
export type GateHit = {value:number;rangeM:number;azimuth:number;ray:number;gate:number};

export class PolarRadarLayer {
  id='gr2lite-polar-radar';
  type:'custom'='custom';
  renderingMode:'2d'='2d';
  private map?:maplibregl.Map;
  private gl?:WebGL2RenderingContext;
  private program?:WebGLProgram;
  private vao?:WebGLVertexArrayObject;
  private vertexBuffer?:WebGLBuffer;
  private gateTexture?:WebGLTexture;
  private lookupTexture?:WebGLTexture;
  private paletteTexture?:WebGLTexture;
  private lookup:Float32Array = new Float32Array(3600);
  private radarXY:[number,number]=[0,0];
  private scale=1;
  private frame?:RadarFrame;
  private visible=true;
  setVisible(visible:boolean){this.visible=visible;this.map?.triggerRepaint();}
  private lastDataKey='';
  private gpuCache=new Map<string,{gate:WebGLTexture;lookup:WebGLTexture;lookupData:Float32Array;bytes:number}>();
  private gpuBytes=0;
  private readonly maxGpuBytes=96*1024*1024;
  onGpuStatus?: (status: string) => void;
  private firstDrawNotified=false;
  private gpuFailed=false;
  isReady():boolean { return Boolean(this.gl && this.program && this.vao); }
  private paletteStyle='operational';
  private opacity=0.85;

  onAdd(map:maplibregl.Map,gl:WebGL2RenderingContext) {
    this.map=map;this.gl=gl;
    if(!(gl instanceof WebGL2RenderingContext))throw new Error('WebGL2 is required');
    const program=gl.createProgram();
    if(!program)throw new Error('Unable to create radar GPU program');
    const vs=shader(gl,gl.VERTEX_SHADER,VERTEX),fs=shader(gl,gl.FRAGMENT_SHADER,FRAGMENT);
    gl.attachShader(program,vs);gl.attachShader(program,fs);gl.linkProgram(program);
    gl.deleteShader(vs);gl.deleteShader(fs);
    if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(program)??'Shader linking failed');
    this.program=program;
    this.vao=gl.createVertexArray()??undefined;
    this.vertexBuffer=gl.createBuffer()??undefined;
    if(!this.vao||!this.vertexBuffer)throw new Error('Unable to create GPU vertex buffer');
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER,this.vertexBuffer);
    const loc=gl.getAttribLocation(program,'a_pos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc,2,gl.FLOAT,false,0,0);
    gl.bindVertexArray(null);
    this.paletteTexture=texture(gl);
    if(this.frame)this.uploadFrame();
  }

  setFrame(frame:RadarFrame) {
    // Identical completed sweeps persist through later chunk snapshots.
    const d=frame.descriptor,s=frame.sweep;
    const identity=[frame.volume.radar_id,frame.moment,s.id,
      s.time_utc[0],s.time_utc[s.time_utc.length-1],
      d.rays,d.gates,d.first_gate_m,d.gate_spacing_m].join('|');
    if(identity===this.lastDataKey && this.frame){
      this.frame=frame;
      this.map?.triggerRepaint();
      return;
    }
    this.lastDataKey=identity;
    this.frame=frame;
    this.firstDrawNotified=false;
    this.gpuFailed=false;
    const previous=this.gpuCache.get(identity);
    if(previous&&this.gl){
      this.gpuCache.delete(identity);this.gpuCache.set(identity,previous);
      this.gateTexture=previous.gate;
      this.lookupTexture=previous.lookup;
      this.lookup=previous.lookupData;
      this.uploadGeometry();
      this.uploadPalette();
      this.map?.triggerRepaint();
      return;
    }
    // O(rays * 19) instead of O(rays * 3600) nearest-azimuth search.
    this.lookup=new Float32Array(3600);
    const errors=new Float32Array(3600).fill(Infinity);
    for(let i=0;i<frame.sweep.azimuth_deg.length;i++){
      const az=frame.sweep.azimuth_deg[i];
      if(!Number.isFinite(az))continue;
      const base=Math.round(az*10);
      for(let step=-9;step<=9;step++){
        const idx=((base+step)%3600+3600)%3600;
        const bearing=(idx+0.5)/10;
        const delta=Math.abs(((az-bearing+540)%360)-180);
        if(delta<=0.8 && delta<errors[idx]){
          errors[idx]=delta;
          this.lookup[idx]=i+1;
        }
      }
    }
    const lat=frame.volume.radar_lat,lon=frame.volume.radar_lon;
    const center=maplibregl.MercatorCoordinate.fromLngLat([lon,lat]);
    this.radarXY=[center.x,center.y];
    this.scale=40075016.686*Math.cos(lat*Math.PI/180);
    if(this.gl)this.uploadFrame();
    this.map?.triggerRepaint();
  }
  setPalette(style:string){this.paletteStyle=style;if(this.gl&&this.frame)this.uploadPalette();this.map?.triggerRepaint();}
  setOpacity(value:number){this.opacity=Math.max(0,Math.min(1,value));this.map?.triggerRepaint();}

  private uploadPalette(){
    const gl=this.gl!,frame=this.frame!,tex=this.paletteTexture!;
    const pixels=palettePixels(getPalette(frame.moment,this.paletteStyle));
    setupNearest(gl,tex,2);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT,1);
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA8,256,1,0,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
  }
  private uploadGeometry(){
    const gl=this.gl!,frame=this.frame!;
    if(!this.vertexBuffer)return;
    const maxM=frame.descriptor.first_gate_m+
      (frame.descriptor.gates-0.5)*frame.descriptor.gate_spacing_m;
    const latD=maxM/111320;
    const lonD=maxM/(111320*Math.max(0.05,Math.cos(frame.volume.radar_lat*Math.PI/180)));
    const lon=frame.volume.radar_lon,lat=frame.volume.radar_lat;
    const sw=maplibregl.MercatorCoordinate.fromLngLat([lon-lonD,lat-latD]);
    const ne=maplibregl.MercatorCoordinate.fromLngLat([lon+lonD,lat+latD]);
    const box=new Float32Array([sw.x,sw.y,ne.x,sw.y,sw.x,ne.y,ne.x,ne.y]);
    gl.bindBuffer(gl.ARRAY_BUFFER,this.vertexBuffer);
    gl.bufferData(gl.ARRAY_BUFFER,box,gl.DYNAMIC_DRAW);
  }
  private uploadFrame(){
    const gl=this.gl!,frame=this.frame!;
    const maxSize=gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    if(frame.descriptor.gates>maxSize||frame.descriptor.rays>maxSize)
      throw new Error('Radar sweep exceeds maximum GPU texture size');
    this.uploadGeometry();
    const gate=texture(gl),lookup=texture(gl);
    this.gateTexture=gate;this.lookupTexture=lookup;
    setupNearest(gl,gate,0);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT,1);
    gl.texImage2D(gl.TEXTURE_2D,0,gl.R32F,frame.descriptor.gates,
      frame.descriptor.rays,0,gl.RED,gl.FLOAT,frame.values);
    setupNearest(gl,lookup,1);
    gl.texImage2D(gl.TEXTURE_2D,0,gl.R32F,3600,1,0,gl.RED,gl.FLOAT,this.lookup);
    this.uploadPalette();
    const error=gl.getError();
    if(error!==gl.NO_ERROR){
      gl.deleteTexture(gate);gl.deleteTexture(lookup);
      throw new Error('WebGL texture upload error 0x'+error.toString(16));
    }
    const bytes=frame.values.byteLength+this.lookup.byteLength;
    this.gpuCache.set(this.lastDataKey,{gate,lookup,lookupData:this.lookup,bytes});
    this.gpuBytes+=bytes;
    // Evict old frames; never remove the currently bound textures.
    while((this.gpuBytes>this.maxGpuBytes||this.gpuCache.size>10)
          &&this.gpuCache.size>1){
      const [oldKey,oldEntry]=this.gpuCache.entries().next().value!;
      if(oldKey===this.lastDataKey)break;
      this.gpuCache.delete(oldKey);this.gpuBytes-=oldEntry.bytes;
      gl.deleteTexture(oldEntry.gate);gl.deleteTexture(oldEntry.lookup);
    }
    this.map?.triggerRepaint();
  }

  render(context: WebGLRenderingContext | WebGL2RenderingContext, options: maplibregl.CustomRenderMethodInput){
    if (!(context instanceof WebGL2RenderingContext)) return;
    const gl=context;
    if(!this.visible||!this.frame||!this.program||!this.vao)return;
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    const loc=(name:string)=>gl.getUniformLocation(this.program!,name);
    // MapLibre's documented Mercator projection matrix takes world [0,1] coordinates.
    // The world-space modelViewProjectionMatrix is not the appropriate input here.
    gl.uniformMatrix4fv(loc('u_matrix'),false,options.defaultProjectionData.mainMatrix);
    gl.uniform2f(loc('u_radar_merc'),...this.radarXY);
    gl.uniform1f(loc('u_scale'),this.scale);
    gl.uniform1f(loc('u_first'),this.frame.descriptor.first_gate_m);
    gl.uniform1f(loc('u_step'),this.frame.descriptor.gate_spacing_m);
    gl.uniform1f(loc('u_gates_count'),this.frame.descriptor.gates);
    const p=getPalette(this.frame.moment,this.paletteStyle);
    gl.uniform1f(loc('u_min'),p.min);gl.uniform1f(loc('u_max'),p.max);
    gl.uniform1f(loc('u_opacity'),this.opacity);
    gl.uniform1f(loc('u_value_factor'),valueFactor(this.frame.moment,this.frame.descriptor.units));
    const units=this.frame.descriptor.units.toLowerCase();
    gl.uniform1f(loc('u_legacy_velocity_nd'),
      this.frame.moment==='VEL'&&(units.includes('m/s')||units.includes('m s-1'))?1:0);
    for(let i=0;i<3;i++){const t=[this.gateTexture,this.lookupTexture,this.paletteTexture][i]!;
      gl.activeTexture(gl.TEXTURE0+i);gl.bindTexture(gl.TEXTURE_2D,t);}
    gl.uniform1i(loc('u_gates'),0);gl.uniform1i(loc('u_lookup'),1);gl.uniform1i(loc('u_palette'),2);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE,gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.DEPTH_TEST);
    // MapLibre may leave face culling enabled: our full radar quad must not be culled.
    gl.disable(gl.CULL_FACE);
    gl.drawArrays(gl.TRIANGLE_STRIP,0,4);
    gl.bindVertexArray(null);
    if(!this.firstDrawNotified && !this.gpuFailed){
      const error=gl.getError();
      if(error!==gl.NO_ERROR){
        this.gpuFailed=true;
        this.onGpuStatus?.('GPU ERROR 0x'+error.toString(16));
      }else{
        this.firstDrawNotified=true;
        this.onGpuStatus?.('GPU DRAW OK');
      }
    }
  }
  sample(lon:number,lat:number):GateHit|null{
    const frame=this.frame;
    if(!frame)return null;
    const here=maplibregl.MercatorCoordinate.fromLngLat([lon,lat]);
    const east=(here.x-this.radarXY[0])*this.scale;
    const north=(this.radarXY[1]-here.y)*this.scale;
    const rangeM=Math.hypot(east,north);
    const azimuth=(Math.atan2(east,north)*180/Math.PI+360)%360;
    const rayToken=this.lookup[Math.floor(azimuth*10)%3600];
    const ray=Math.round(rayToken)-1;
    const gate=Math.round((rangeM-frame.descriptor.first_gate_m)/frame.descriptor.gate_spacing_m);
    if(ray<0||gate<0||gate>=frame.descriptor.gates)return null;
    const value=frame.values[ray*frame.descriptor.gates+gate];
    if(!Number.isFinite(value))return null;
    if(frame.moment==='VEL' && (Math.abs(value+64.5)<0.0001||Math.abs(value+64.0)<0.0001))return null;
    return {value,rangeM,azimuth,ray,gate};
  }
  onRemove(_:maplibregl.Map,gl:WebGL2RenderingContext){
    for(const item of this.gpuCache.values()){
      gl.deleteTexture(item.gate);gl.deleteTexture(item.lookup);
    }
    this.gpuCache.clear();
    this.gpuBytes=0;
    if(this.paletteTexture)gl.deleteTexture(this.paletteTexture);
    if(this.vertexBuffer)gl.deleteBuffer(this.vertexBuffer);
    if(this.vao)gl.deleteVertexArray(this.vao);
    if(this.program)gl.deleteProgram(this.program);
    this.gl=undefined;
    this.lastDataKey='';
  }
}
