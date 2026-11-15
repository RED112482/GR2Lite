"""Archive-only API. No untrusted filesystem paths are accepted over HTTP."""
from pathlib import Path
import os
from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from pydantic import TypeAdapter
from .models import VolumeDescriptor
from fastapi.middleware.cors import CORSMiddleware
from .decoder import DecodedVolume, decode_archive
from .models import Moment

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


@app.get("/health")
def health():
    return {"status": "ok", "mode": "archive", "contract_version": "0.1.0"}


@app.get("/volumes")
def volumes():
    # Pydantic JSON serializes optional non-finite values as null instead of
    # allowing Starlette JSONResponse to crash with "Out of range float values".
    payload = TypeAdapter(list[VolumeDescriptor]).dump_json(
        [v.descriptor for v in CACHE.values()]
    )
    return Response(payload, media_type="application/json")


@app.get("/volumes/{volume_id}")
def volume(volume_id: str):
    if volume_id not in CACHE:
        raise HTTPException(404, "Volume not loaded")
    return Response(CACHE[volume_id].descriptor.model_dump_json(), media_type="application/json")


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
