"""Current partial volume + previous complete elevation rail tests."""
from datetime import datetime,timezone,timedelta
from types import SimpleNamespace as N
from gr2lite.tilt_index import build_tilt_index
from gr2lite.models import Moment

START=datetime(2026,11,16,6,0,tzinfo=timezone.utc)

def scan(id,angles,complete,vcp="212",offset=0):
    sweeps=[]
    for i,angle in enumerate(angles):
        t=START+timedelta(minutes=offset,seconds=i*10)
        sweeps.append(N(id=f"sweep_{i}",index=i,fixed_angle_deg=angle,
                        time_utc=[t],moments={Moment.REF:object(),Moment.VEL:object()}))
    return N(descriptor=N(volume_id=id,radar_id="KMOB",vcp=vcp,
                          volume_complete=complete,sweeps=sweeps))

def test_rolling_rail_uses_previous_upper_tilts():
    now=scan("NEW",[0.5,0.9],False,offset=5)
    prev=scan("OLD",[0.5,0.9,1.8,2.4,3.1],True)
    index=build_tilt_index([now,prev])
    assert [t["angle"] for t in index["tilts"]]==[0.5,0.9,1.8,2.4,3.1]
    assert [t["current"] for t in index["tilts"]]==[True,True,False,False,False]
    assert index["tilts"][3]["moments"]["REF"]["volume_id"]=="OLD"
    assert index["tilts"][0]["moments"]["VEL"]["volume_id"]=="NEW"
    assert index["previous_volume_id"]=="OLD"

def test_rolling_rail_ignores_incomplete_previous_or_different_vcp():
    now=scan("NEW",[0.5],False,offset=5)
    incomplete=scan("OLD",[0.5,0.9,2.4],False)
    wrong=scan("WRONG",[0.5,0.9,2.4],True,vcp="35")
    for previous in (incomplete,wrong):
        index=build_tilt_index([now,previous])
        assert len(index["tilts"])==1
        assert index["previous_volume_id"] is None

def test_rolling_rail_promotes_newly_arrived_tilt_and_repeat():
    prev=scan("OLD",[0.5,0.9,1.8],True)
    now=scan("NEW",[0.5,0.9,1.8,0.5],False,offset=5)
    index=build_tilt_index([now,prev])
    assert index["newest"]["angle"]==0.5
    assert index["tilts"][0]["count_current"]==2
    assert index["tilts"][0]["moments"]["REF"]["sweep_id"]=="sweep_3"
    assert all(t["current"] for t in index["tilts"])
