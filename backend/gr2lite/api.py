"""Archive-only API. No untrusted filesystem paths are accepted over HTTP."""
from pathlib import Path
from time import monotonic
import httpx
import os
from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from pydantic import TypeAdapter
from .models import VolumeDescriptor
from fastapi.middleware.cors import CORSMiddleware
from .decoder import DecodedVolume, decode_archive
from .models import Moment
from .live import RadarStore, LiveArchivePoller
from .chunks import IncrementalChunkPoller

app = FastAPI(title="GR2Lite Archive API", version="0.1.0")
# Public cloud hosting needs explicit origin allowlisting; no wildcard credentials.
origins = [v.strip() for v in os.environ.get(
    "GR2LITE_CORS_ORIGINS",
    "http://localhost:5173,http://127.0.0.1:5173,https://red112482.github.io"
).split(",") if v.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_methods=["GET"],
    allow_headers=["*"],
)
CACHE: dict[str, DecodedVolume] = {}
LIVE_STORE = RadarStore(limit=int(os.environ.get("GR2LITE_HISTORY_VOLUMES", "2")))
LIVE_POLLER: LiveArchivePoller | None = None

def _all_volumes() -> list[DecodedVolume]:
    return LIVE_STORE.list() if LIVE_STORE.mode in ("live","chunks") else list(CACHE.values())

def _get_volume(volume_id: str) -> DecodedVolume | None:
    return LIVE_STORE.get(volume_id) if LIVE_STORE.mode in ("live","chunks") else CACHE.get(volume_id)

@app.get("/radar/status")
def radar_status():
    if LIVE_STORE.mode in ("live", "chunks"):
        return LIVE_STORE.status()
    volumes = list(CACHE.values())
    return {
        "mode": "archive", "state": "ready" if volumes else "empty",
        "latest_volume_id": volumes[0].descriptor.volume_id if volumes else None,
        "latest_ray_time_utc": None, "age_seconds": None,
        "volume_count": len(volumes), "last_check_utc": None,
        "last_success_utc": None, "last_error": None,
    }

# NOAA public reference layer IDs: CWA=1, counties=2, states=3.
# Bounded regional request avoids downloading nationwide feature polygons.
_BOUNDARIES = {"cwa": 1, "counties": 2, "states": 3}
_BOUNDARY_CACHE: dict[str, tuple[float, dict]] = {}
_NOAA_SERVICE = (
    "https://mapservices.weather.noaa.gov/static/rest/services/"
    "nws_reference_maps/nws_reference_map/MapServer"
)


@app.get("/boundaries/{kind}")
async def boundaries(kind: str):
    if kind not in _BOUNDARIES:
        raise HTTPException(404, "Unknown boundary type")
    cached = _BOUNDARY_CACHE.get(kind)
    if cached and monotonic() - cached[0] < 3600:
        return cached[1]
    params = {
        "where": "1=1",
        "geometry": "-94,25,-80,36",
        "geometryType": "esriGeometryEnvelope",
        "spatialRel": "esriSpatialRelIntersects",
        "inSR": 4326,
        "outSR": 4326,
        "outFields": "*",
        "returnGeometry": "true",
        "f": "geojson",
    }
    url = f"{_NOAA_SERVICE}/{_BOUNDARIES[kind]}/query"
    try:
        async with httpx.AsyncClient(timeout=35.0, follow_redirects=True) as client:
            response = await client.get(url, params=params)
            response.raise_for_status()
            features = response.json()
        if features.get("type") != "FeatureCollection" or not isinstance(features.get("features"), list):
            raise ValueError("NOAA service did not return GeoJSON features")
        # Only keep legitimate GeoJSON structures.
        _BOUNDARY_CACHE[kind] = (monotonic(), features)
        return features
    except (httpx.HTTPError, ValueError) as exc:
        raise HTTPException(503, f"NOAA boundary service unavailable: {type(exc).__name__}") from exc


@app.get("/volumes/{volume_id}/diagnostics")
def volume_diagnostics(volume_id: str):
    import numpy as np
    v = _get_volume(volume_id)
    if v is None:
        raise HTTPException(404, "Volume not loaded")
    summary = []
    for (sweep_id, moment), values in v.arrays.items():
        valid = np.isfinite(values)
        finite_count = int(np.count_nonzero(valid))
        summary.append({
            "sweep_id": sweep_id,
            "moment": moment.value,
            "finite_gates": finite_count,
            "total_gates": int(values.size),
            "min": float(np.min(values[valid])) if finite_count else None,
            "max": float(np.max(values[valid])) if finite_count else None,
        })
    return {"volume_id": volume_id, "radar_id": v.descriptor.radar_id, "moments": summary}



@app.get("/health")
def health():
    return {"status": "ok", "mode": LIVE_STORE.mode, "contract_version": "0.1.0"}


@app.get("/volumes/index")
def volume_index():
    """Cheap time navigator index; metadata for selected volumes fetched on demand."""
    records=[]
    for v in _all_volumes():
        sweeps=v.descriptor.sweeps
        end=max((max(s.time_utc) for s in sweeps if s.time_utc),default=None)
        records.append({
            "volume_id":v.descriptor.volume_id,
            "radar_id":v.descriptor.radar_id,
            "time_utc":end.isoformat() if end else None,
            "sweeps":len(sweeps),
        })
    return Response(__import__("json").dumps(records), media_type="application/json",
                    headers={"Cache-Control":"no-store"})


@app.get("/volumes")
def volumes():
    # Pydantic JSON serializes optional non-finite values as null instead of
    # allowing Starlette JSONResponse to crash with "Out of range float values".
    payload = TypeAdapter(list[VolumeDescriptor]).dump_json(
        [v.descriptor for v in _all_volumes()]
    )
    return Response(payload, media_type="application/json")


@app.get("/volumes/{volume_id}")
def volume(volume_id: str):
    v = _get_volume(volume_id)
    if v is None:
        raise HTTPException(404, "Volume not loaded")
    return Response(v.descriptor.model_dump_json(), media_type="application/json")


@app.get("/volumes/{volume_id}/sweeps/{sweep_id}/moments/{moment}")
def moment_bytes(volume_id: str, sweep_id: str, moment: Moment):
    v = _get_volume(volume_id)
    if v is None:
        raise HTTPException(404, "Volume not loaded")
    data = v.arrays.get((sweep_id, moment))
    if data is None:
        raise HTTPException(404, "Sweep/moment not available")
    return Response(data.tobytes(order="C"), media_type="application/octet-stream",
                    headers={"X-Array-Dtype": "float32-le", "X-Array-Shape": f"{data.shape[0]},{data.shape[1]}"})


def preload(path: str | Path, radar_id: str = "KMOB") -> str:
    decoded = decode_archive(path, radar_id)
    CACHE.clear()
    CACHE[decoded.descriptor.volume_id] = decoded
    return decoded.descriptor.volume_id


archive = os.environ.get("GR2LITE_ARCHIVE_PATH")

@app.on_event("startup")
def start_ingestion():
    global LIVE_POLLER
    mode=os.environ.get("GR2LITE_MODE","archive").lower()
    if mode == "chunks":
        LIVE_STORE.mode="chunks"
        LIVE_POLLER=IncrementalChunkPoller(
            LIVE_STORE,interval=float(os.environ.get("GR2LITE_CHUNK_POLL_SECONDS","12"))
        )
        LIVE_POLLER.start()
    elif mode == "live":
        LIVE_STORE.mode = "live"
        LIVE_POLLER = LiveArchivePoller(
            LIVE_STORE, interval=float(os.environ.get("GR2LITE_POLL_SECONDS", "45"))
        )
        LIVE_POLLER.start()
    elif archive:
        preload(archive, os.environ.get("GR2LITE_RADAR", "KMOB"))

@app.on_event("shutdown")
def stop_ingestion():
    if LIVE_POLLER is not None:
        LIVE_POLLER.stop()
