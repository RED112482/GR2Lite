"""Archive-only API. No untrusted filesystem paths are accepted over HTTP."""
from pathlib import Path
import os
from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from .decoder import DecodedVolume, decode_archive
from .models import Moment

app = FastAPI(title="GR2Lite Archive API", version="0.1.0")
CACHE: dict[str, DecodedVolume] = {}


@app.get("/health")
def health():
    return {"status": "ok", "mode": "archive", "contract_version": "0.1.0"}


@app.get("/volumes")
def volumes():
    return [v.descriptor.model_dump(mode="json") for v in CACHE.values()]


@app.get("/volumes/{volume_id}")
def volume(volume_id: str):
    if volume_id not in CACHE:
        raise HTTPException(404, "Volume not loaded")
    return CACHE[volume_id].descriptor


@app.get("/volumes/{volume_id}/sweeps/{sweep_id}/moments/{moment}")
def moment_bytes(volume_id: str, sweep_id: str, moment: Moment):
    if volume_id not in CACHE:
        raise HTTPException(404, "Volume not loaded")
    data = CACHE[volume_id].arrays.get((sweep_id, moment))
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
if archive:
    @app.on_event("startup")
    def load_server_archive():
        preload(archive, os.environ.get("GR2LITE_RADAR", "KMOB"))
