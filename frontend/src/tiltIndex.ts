/** Per-moment newest-available scan source across adjacent radar volumes. */
import type {Moment} from './radar';
export interface TiltSource {
  volume_id:string;
  sweep_id:string;
  time_utc:string;
  current:boolean;
}
export interface TiltRow {
  angle:number;
  moments:Partial<Record<Moment,TiltSource>>;
  current:boolean;
  newest:boolean;
  count_current:number;
  time_utc:string|null;
}
export interface TiltIndex {
  volume_id:string|null;
  previous_volume_id:string|null;
  volume_complete?:boolean;
  vcp?:string|null;
  newest:{sweep_id:string;angle:number;time_utc:string}|null;
  tilts:TiltRow[];
}
export async function fetchTiltIndex(root:string):Promise<TiltIndex> {
  const response=await fetch(root.replace(/\/$/,'')+'/radar/tilts',{cache:'no-store'});
  if(!response.ok)throw new Error('Radar tilt index HTTP '+response.status);
  return response.json() as Promise<TiltIndex>;
}
