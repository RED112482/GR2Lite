export type Moment = 'REF' | 'VEL' | 'SW' | 'ZDR' | 'CC' | 'PHI' | 'KDP';
export const momentOrder: Moment[] = ['REF', 'VEL', 'SW', 'CC', 'ZDR', 'PHI', 'KDP'];
export interface MomentDescriptor {
  name: Moment;
  source_variable: string;
  units: string;
  rays: number;
  gates: number;
  first_gate_m: number;
  gate_spacing_m: number;
  encoding: 'float32-le';
}
export interface SweepDescriptor {
  id: string;
  index: number;
  fixed_angle_deg: number;
  ray_count: number;
  azimuth_deg: number[];
  elevation_deg: number[];
  time_utc: string[];
  moments: Partial<Record<Moment, MomentDescriptor>>;
}
export interface VolumeDescriptor {
  contract_version: '0.1.0';
  volume_id: string;
  radar_id: string;
  vcp?: string|null;
  radar_lat: number;
  radar_lon: number;
  radar_alt_m: number | null;
  sweeps: SweepDescriptor[];
}
export interface RadarFrame {
  volume: VolumeDescriptor;
  sweep: SweepDescriptor;
  moment: Moment;
  descriptor: MomentDescriptor;
  values: Float32Array;
}
export async function fetchVolumes(root: string): Promise<VolumeDescriptor[]> {
  const res = await fetch(root.replace(/\/$/, '') + '/volumes');
  if (!res.ok) throw new Error('Could not retrieve archive volumes (HTTP ' + res.status + ')');
  const json = await res.json() as VolumeDescriptor[];
  if (!Array.isArray(json) || !json.every(v => v.contract_version === '0.1.0')) {
    throw new Error('Unsupported radar data contract');
  }
  return json;
}
export async function fetchFrame(root: string, volume: VolumeDescriptor, sweep: SweepDescriptor, moment: Moment): Promise<RadarFrame> {
  const descriptor = sweep.moments[moment];
  if (!descriptor) throw new Error('Moment not available on this cut');
  const url = [root.replace(/\/$/, ''), 'volumes', encodeURIComponent(volume.volume_id), 'sweeps', encodeURIComponent(sweep.id), 'moments', moment].join('/');
  const response = await fetch(url);
  if (!response.ok) throw new Error('Radar gate request failed (HTTP ' + response.status + ')');
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength !== descriptor.rays * descriptor.gates * 4) {
    throw new Error('Binary gate count mismatch: refusing to render incomplete frame');
  }
  if (descriptor.encoding !== 'float32-le') throw new Error('Unsupported binary radar encoding');
  const values = new Float32Array(bytes);
  return {volume, sweep, moment, descriptor, values};
}
export function nearestRay(azimuths: number[], bearingDeg: number): { ray: number; error: number } {
  let ray = -1, error = Infinity;
  for (let i = 0; i < azimuths.length; i++) {
    const diff = Math.abs(((azimuths[i] - bearingDeg + 540) % 360) - 180);
    if (diff < error) { error = diff; ray = i; }
  }
  return {ray, error};
}
export function formatValue(value: number, units: string): string {
  return Number.isFinite(value) ? value.toFixed(2) + ' ' + units : 'NO DATA';
}
