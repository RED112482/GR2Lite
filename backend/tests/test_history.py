"""Disk-backed 60-minute history regression tests (no AWS calls)."""
from datetime import datetime, timezone, timedelta
import numpy as np
from gr2lite.history import DiskHistory, scan_group
from gr2lite.models import Moment, MomentDescriptor, SweepDescriptor, VolumeDescriptor
from gr2lite.decoder import DecodedVolume

def volume(id,minutes_ago=2):
    now=datetime.now(timezone.utc)-timedelta(minutes=minutes_ago)
    moment=MomentDescriptor(name=Moment.REF,source_variable="DBZH",units="dBZ",
        rays=2,gates=2,first_gate_m=250,gate_spacing_m=250)
    sweep=SweepDescriptor(id="sweep_0",index=0,fixed_angle_deg=0.5,
        ray_count=2,azimuth_deg=[0.0,1.0],elevation_deg=[0.5,0.5],
        time_utc=[now,now+timedelta(seconds=1)],moments={Moment.REF:moment})
    descriptor=VolumeDescriptor(volume_id=id,radar_id="KMOB",radar_lat=30.68,
        radar_lon=-88.23,sweeps=[sweep])
    return DecodedVolume(descriptor,{("sweep_0",Moment.REF):np.array([[0,12],[45,22]],dtype="<f4")})

def test_history_roundtrip_and_reload(tmp_path):
    history=DiskHistory(tmp_path,minutes=60,max_gb=1)
    v=volume("KMOB20261115_210000_CH001")
    history.save(v)
    loaded=history.load(v.descriptor.volume_id)
    assert loaded is not None
    assert loaded.descriptor.volume_id==v.descriptor.volume_id
    np.testing.assert_array_equal(loaded.arrays[("sweep_0",Moment.REF)],
                                  v.arrays[("sweep_0",Moment.REF)])
    assert len(history.catalog())==1
    history.close()

def test_same_volume_keeps_latest_completed_sweeps(tmp_path):
    history=DiskHistory(tmp_path,minutes=60,max_gb=1)
    old=volume("KMOB20261115_210000_CH001")
    new=volume("KMOB20261115_210000_CH014")
    history.save(old)
    history.save(new)
    assert [v.volume_id for v in history.catalog()]==[new.descriptor.volume_id]
    assert history.load(old.descriptor.volume_id) is None
    history.close()

def test_old_history_not_saved(tmp_path):
    history=DiskHistory(tmp_path,minutes=60,max_gb=1)
    history.save(volume("KMOB_OLD",minutes_ago=120))
    assert history.catalog()==[]
    history.close()

def test_chunk_group_consolidation():
    assert scan_group("KMOB20261115_210000_CH001")==scan_group("KMOB20261115_210000_CH020")
