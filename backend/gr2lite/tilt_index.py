"""One coherent elevation rail spanning the current partial and prior complete volume.

All source IDs identify existing snapshots; no interpolated/mixed gate data is
constructed. The newest *available* sweep for each moment/angle is used.
"""
from __future__ import annotations
from datetime import datetime, timezone
from .decoder import DecodedVolume
from .models import Moment

def _sweep_time(s):
    times=[x for x in s.time_utc if x is not None]
    return max(times) if times else None

def _last_time(v):
    times=[_sweep_time(s) for s in v.descriptor.sweeps]
    return max((t for t in times if t is not None),default=None)

def build_tilt_index(volumes:list[DecodedVolume],max_previous_minutes:float=20.0)->dict:
    if not volumes:
        return {"volume_id":None,"previous_volume_id":None,"newest":None,"tilts":[]}
    latest=volumes[0].descriptor
    recent=_last_time(volumes[0])
    previous=None
    # Prefer an immediately preceding *complete* volume with the same VCP.
    for item in volumes[1:]:
        descriptor=item.descriptor
        t=_last_time(item)
        if descriptor.radar_id!=latest.radar_id or not t or not recent:continue
        gap=(recent-t).total_seconds()/60
        if not (0<=gap<=max_previous_minutes):continue
        if not descriptor.volume_complete:continue
        if latest.vcp and descriptor.vcp and latest.vcp!=descriptor.vcp:continue
        previous=descriptor
        break
    angles=[]
    newest_sweep=max(latest.sweeps,key=lambda s:(_sweep_time(s) or datetime.min.replace(tzinfo=timezone.utc)),default=None)
    # Two independent layers of availability: current volume first, then only
    # the preceding completed volume for angles not yet scanned in current.
    # Split REF/VEL cuts can select different source sweeps at the same tilt.
    for volume,is_current in ((previous,False),(latest,True)):
        if volume is None:continue
        for sweep in volume.sweeps:
            t=_sweep_time(sweep)
            if t is None:continue
            angle=float(sweep.fixed_angle_deg)
            row=next((x for x in angles if abs(x["angle"]-angle)<0.16),None)
            if row is None:
                row={"angle":angle,"moments":{},"current":False,"newest":False,
                     "count_current":0,"time_utc":None}
                angles.append(row)
            if is_current:
                row["current"]=True
                row["count_current"]+=1
            if is_current and newest_sweep and sweep.id==newest_sweep.id:
                row["newest"]=True
            for moment in sweep.moments:
                key=moment.value if isinstance(moment,Moment) else str(moment)
                entry={"volume_id":volume.volume_id,"sweep_id":sweep.id,
                       "time_utc":t.isoformat(),"current":is_current}
                old=row["moments"].get(key)
                # Current vs previous priority; within volume choose latest
                # measured ray (SAILS/MRLE returns) for that moment.
                if (old is None or (is_current and not old["current"])
                    or (old["current"]==is_current and entry["time_utc"]>old["time_utc"])):
                    row["moments"][key]=entry
            if row["time_utc"] is None or t.isoformat()>row["time_utc"]:
                row["time_utc"]=t.isoformat()
    angles.sort(key=lambda x:x["angle"])
    return {
        "volume_id":latest.volume_id,
        "previous_volume_id":previous.volume_id if previous else None,
        "volume_complete":latest.volume_complete,
        "vcp":latest.vcp,
        "newest":{"sweep_id":newest_sweep.id,"angle":newest_sweep.fixed_angle_deg,
                  "time_utc":_sweep_time(newest_sweep).isoformat()} if newest_sweep and _sweep_time(newest_sweep) else None,
        "tilts":angles,
    }
