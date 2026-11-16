from datetime import datetime, timezone
import numpy as np
import pytest
import xarray as xr
from fastapi.testclient import TestClient
from gr2lite.decoder import decode_tree, _range_geometry
from gr2lite.models import Moment
from gr2lite.api import app, CACHE


def sample_tree():
    times = np.array(["2024-06-04T21:00:00", "2024-06-04T21:00:03"], dtype="datetime64[ns]")
    coords = {"azimuth": ("azimuth", [10.0, 12.0]),
              "elevation": ("azimuth", [0.5, 0.55]),
              "time": ("azimuth", times),
              "range": ("range", [250.0, 500.0, 750.0])}
    sweep = xr.Dataset({"DBZH": (("azimuth", "range"), [[10.0, 11.0, np.nan], [12.0, 13.0, 14.0]], {"units": "dBZ"}),
                        "VRADH": (("azimuth", "range"), [[1.0, -2.0, 3.0], [4.0, 5.0, 6.0]], {"units": "m/s"}),
                        "sweep_fixed_angle": xr.DataArray(0.5)}, coords=coords)
    root = xr.Dataset(coords={"latitude": 30.679, "longitude": -88.239, "altitude": 70.0})
    return xr.DataTree.from_dict({"/": root, "/sweep_0": sweep})


def test_decoder_preserves_native_gate_values():
    volume = decode_tree(sample_tree(), "KMOB", "fixture")
    d = volume.descriptor
    assert d.radar_id == "KMOB" and d.sweeps[0].ray_count == 2
    assert d.sweeps[0].moments[Moment.REF].gate_spacing_m == 250
    arr = volume.arrays[("sweep_0", Moment.REF)]
    assert arr.dtype == np.dtype("float32") and arr.shape == (2, 3)
    assert float(arr[0, 1]) == 11.0 and np.isnan(arr[0, 2])
    assert d.sweeps[0].time_utc[0] == datetime(2024, 6, 4, 21, 0, tzinfo=timezone.utc)


def test_binary_array_bytes_and_api():
    volume = decode_tree(sample_tree(), "KMOB", "fixture")
    CACHE.clear()
    CACHE["fixture"] = volume
    with TestClient(app) as client:
        response = client.get("/volumes/fixture/sweeps/sweep_0/moments/VEL")
        assert response.status_code == 200
        assert response.headers["x-array-shape"] == "2,3"
        arr = np.frombuffer(response.content, dtype="<f4").reshape(2, 3)
        assert arr[0, 1] == -2
        assert client.get("/volumes/missing").status_code == 404
    CACHE.clear()


def test_bad_range_geometry_rejected():
    da = xr.DataArray([[1, 2, 3]], dims=("azimuth", "range"), coords={"range": [250, 500, 900]})
    with pytest.raises(ValueError, match="nonuniform"):
        _range_geometry(da)


def test_invalid_radar_rejected():
    with pytest.raises(ValueError, match="four-character"):
        decode_tree(sample_tree(), "MOB", "fixture")


def test_missing_gate_is_not_converted_to_zero():
    result = decode_tree(sample_tree(), "KMOB", "fixture")
    raw = result.arrays[("sweep_0", Moment.REF)].tobytes()
    assert np.isnan(np.frombuffer(raw, dtype="<f4")[2])

def test_nonfinite_optional_radar_altitude_is_normalized_and_api_returns_json():
    tree = sample_tree()
    tree["/"]["altitude"] = xr.DataArray(np.nan)
    volume = decode_tree(tree, "KMOB", "nan-alt")
    assert volume.descriptor.radar_alt_m is None
    CACHE.clear()
    CACHE["nan-alt"] = volume
    try:
        with TestClient(app) as client:
            response = client.get("/volumes")
            assert response.status_code == 200
            data = response.json()
            assert len(data) == 1
            assert data[0]["radar_alt_m"] is None
            assert data[0]["sweeps"][0]["moments"]["REF"]["gates"] == 3
    finally:
        CACHE.clear()

def test_velocity_scaled_special_codes_render_nd():
    from gr2lite.decoder import _sanitize_level2_special_values
    values=np.array([[-64.5,-64.0,-63.5,-15.0,22.0]],dtype="<f4")
    da=xr.DataArray(values,dims=("azimuth","range"),attrs={"units":"m/s"})
    da.encoding["scale_factor"]=0.5
    da.encoding["add_offset"]=-64.5
    cleaned=_sanitize_level2_special_values(da,values.copy(),Moment.VEL)
    assert np.isnan(cleaned[0,0]) and np.isnan(cleaned[0,1])
    assert cleaned[0,2]==-63.5 and cleaned[0,3]==-15
    # Mask only known special codes; do not replace all strong velocities.
    assert np.isfinite(cleaned[0,4])

def test_velocity_special_codes_without_encoding_metadata():
    from gr2lite.decoder import _sanitize_level2_special_values
    arr=np.array([[-64.5,-64.0,-63.5,5]],dtype="<f4")
    da=xr.DataArray(arr,dims=("azimuth","range"),attrs={"units":"m/s"})
    result=_sanitize_level2_special_values(da,arr.copy(),Moment.VEL)
    assert np.isnan(result[0,0]) and np.isnan(result[0,1])
    assert result[0,2]==-63.5

def test_volume_metadata_gzip_and_plain_json_responses():
    from gzip import decompress
    volume=decode_tree(sample_tree(),"KMOB","fixture")
    CACHE.clear()
    CACHE["fixture"]=volume
    try:
        with TestClient(app) as client:
            zipped=client.get("/volumes/fixture",headers={"Accept-Encoding":"gzip"})
            assert zipped.status_code==200
            assert zipped.headers.get("content-encoding") in (None,"gzip")
            assert zipped.json()["volume_id"]=="fixture"
            plain=client.get("/volumes/fixture",headers={"Accept-Encoding":"identity"})
            assert plain.status_code==200
            assert plain.headers.get("content-encoding") is None
            assert plain.json()["sweeps"][0]["ray_count"]==2
    finally:
        CACHE.clear()
