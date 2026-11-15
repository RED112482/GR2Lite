"""xradar adapter for complete NEXRAD Level-II archive files.

This intentionally does not decode incomplete live chunks. The only output
used by the frontend is our versioned contract, not xradar internals.
"""
from __future__ import annotations
from dataclasses import dataclass
from pathlib import Path
import re
import numpy as np
import xarray as xr
from .models import Moment, MomentDescriptor, SweepDescriptor, VolumeDescriptor

ALIASES = {
    Moment.REF: ("DBZH", "reflectivity", "REF"),
    Moment.VEL: ("VRADH", "velocity", "VEL"),
    Moment.SW: ("WRADH", "spectrum_width", "SW"),
    Moment.ZDR: ("ZDR", "differential_reflectivity"),
    Moment.CC: ("RHOHV", "cross_correlation_ratio", "CC"),
    Moment.PHI: ("PHIDP", "differential_phase"),
    Moment.KDP: ("KDP", "specific_differential_phase"),
}


@dataclass
class DecodedVolume:
    descriptor: VolumeDescriptor
    arrays: dict[tuple[str, Moment], np.ndarray]


def _find_variable(ds: xr.Dataset, aliases: tuple[str, ...]) -> str | None:
    lookup = {x.lower(): x for x in ds.data_vars}
    return next((lookup[a.lower()] for a in aliases if a.lower() in lookup), None)


def _scalar(value) -> float:
    return float(np.asarray(value).reshape(-1)[0])


def _timestamp_list(values: np.ndarray) -> list:
    from datetime import datetime, timezone
    result = []
    for t in np.asarray(values).astype("datetime64[ns]").reshape(-1):
        if np.isnat(t):
            raise ValueError("Missing ray timestamp")
        result.append(datetime.fromtimestamp(int(t.astype("int64")) / 1e9, tz=timezone.utc))
    return result


def _range_geometry(da: xr.DataArray) -> tuple[float, float]:
    if "range" not in da.coords:
        raise ValueError(f"{da.name}: missing per-moment range coordinate")
    r = np.asarray(da.coords["range"].values, dtype=float)
    if r.size < 2 or not np.all(np.isfinite(r)):
        raise ValueError(f"{da.name}: invalid range coordinate")
    delta = np.diff(r)
    if np.any(delta <= 0) or not np.allclose(delta, delta[0], rtol=1e-5, atol=0.01):
        raise ValueError(f"{da.name}: nonuniform range requires future geometry contract")
    return float(r[0]), float(delta[0])


def _read_sweep(ds: xr.Dataset, sweep_id: str, idx: int):
    if "azimuth" not in ds or "elevation" not in ds or "time" not in ds:
        raise ValueError(f"{sweep_id}: missing required radial coordinate")
    az = np.asarray(ds["azimuth"].values, dtype=float).reshape(-1)
    el = np.asarray(ds["elevation"].values, dtype=float).reshape(-1)
    times = _timestamp_list(ds["time"].values)
    n = az.size
    if not n or len(el) != n or len(times) != n or not np.all(np.isfinite(az)) or not np.all(np.isfinite(el)):
        raise ValueError(f"{sweep_id}: invalid radial coordinate arrays")
    moments = {}
    arrays = {}
    for moment, names in ALIASES.items():
        var = _find_variable(ds, names)
        if var is None:
            continue
        da = ds[var]
        dims = list(da.dims)
        if len(dims) != 2 or "range" not in dims:
            raise ValueError(f"{sweep_id}/{var}: unexpected dimensions {dims}")
        radial_dim = next(d for d in dims if d != "range")
        values = np.asarray(da.transpose(radial_dim, "range").values)
        if values.shape[0] != n:
            raise ValueError(f"{sweep_id}/{var}: ray count mismatch")
        first, step = _range_geometry(da)
        values = np.ascontiguousarray(values.astype("<f4"))
        values[~np.isfinite(values)] = np.nan
        desc = MomentDescriptor(name=moment, source_variable=var,
                                units=str(da.attrs.get("units", "unknown")),
                                rays=n, gates=values.shape[1],
                                first_gate_m=first, gate_spacing_m=step)
        moments[moment] = desc
        arrays[(sweep_id, moment)] = values
    if not moments:
        raise ValueError(f"{sweep_id}: no supported moments found")
    angle = _scalar(ds["sweep_fixed_angle"].values) if "sweep_fixed_angle" in ds else float(np.median(el))
    return SweepDescriptor(id=sweep_id, index=idx, fixed_angle_deg=angle,
                           ray_count=n, azimuth_deg=az.tolist(), elevation_deg=el.tolist(),
                           time_utc=times, moments=moments), arrays


def decode_tree(tree, radar_id: str, volume_id: str) -> DecodedVolume:
    """Adapt an xradar DataTree (also usable with synthetic test trees)."""
    radar_id = radar_id.upper()
    if not re.fullmatch(r"K[A-Z0-9]{3}", radar_id):
        raise ValueError("Expected a four-character CONUS ICAO radar identifier, e.g. KMOB")
    root = tree["/"].ds
    for coord in ("latitude", "longitude"):
        if coord not in root:
            raise ValueError(f"Root missing {coord}; cannot locate radar")
    lat, lon = _scalar(root["latitude"].values), _scalar(root["longitude"].values)
    alt = _scalar(root["altitude"].values) if "altitude" in root else None
    ids = sorted((k.lstrip("/") for k in tree.groups if re.fullmatch(r"/sweep_\d+", k)),
                 key=lambda k: int(k.split("_")[-1]))
    if not ids:
        raise ValueError("No sweep groups found")
    sweeps, arrays = [], {}
    for sweep_id in ids:
        desc, data = _read_sweep(tree[sweep_id].ds, sweep_id, int(sweep_id.split("_")[-1]))
        sweeps.append(desc)
        arrays.update(data)
    return DecodedVolume(
        VolumeDescriptor(volume_id=volume_id, radar_id=radar_id,
                         radar_lat=lat, radar_lon=lon, radar_alt_m=alt, sweeps=sweeps), arrays)


def decode_archive(path: str | Path, radar_id: str = "KMOB") -> DecodedVolume:
    import xradar as xd
    p = Path(path)
    if not p.is_file():
        raise FileNotFoundError(p)
    tree = xd.io.open_nexradlevel2_datatree(str(p), reindex_angle=False,
                                            mask_and_scale=True, decode_times=True)
    try:
        return decode_tree(tree, radar_id, p.name)
    finally:
        tree.close()
