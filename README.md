# GR2Lite — Milestone 1 (experimental)

A foundation for a **browser-based**, high-performance native NEXRAD Level-II
radar interrogation application. Milestone 1 includes a Python archive adapter,
versioned JSON/binary radar data contract, AWS KMOB archive retrieval, unit tests,
and a minimal archive API. It **does not yet include** a radar viewer, real-time
streaming, or an operationally verified Level-II decode of a real KMOB volume.

## Python development

Requires Python 3.12+.

```bash
cd backend
python -m venv .venv
# Activate .venv (Windows: .venv\\Scripts\\activate; Linux: source .venv/bin/activate)
python -m pip install -e '.[test]'
pytest -q
```

## Find and download an archived KMOB volume

```bash
gr2lite list-kmob 2024-06-04 --limit 10
# Copy one resulting exact S3 key, then:
gr2lite download-kmob 2024/06/04/KMOB/KMOB20240604_210000_V06 --out ./data
# The key above is a format example, not a verified existing file.
gr2lite decode ./data/ACTUAL_FILENAME --json ./data/volume.json
```

## Run archive API

```bash
export GR2LITE_ARCHIVE_PATH=/absolute/path/to/KMOB_FILE
uvicorn gr2lite.api:app --host 127.0.0.1 --port 8000
```

In a cloud container, mount the archive and set `GR2LITE_ARCHIVE_PATH` as an
environment variable. The supplied Dockerfile is a backend packaging starting
point, **not a deployed service**. Public deployment requires authentication,
object-store integration, resource limits and safe startup/error handling.

## Key architecture rules

1. Preserve native radial/gate geometry, not PNGs as authoritative data.
2. Preserve original decoded moments and ray times.
3. Reject unsupported geometry rather than silently interpolate.
4. Use `float32-le` arrays for MVP transport.
5. Validate archived KMOB data against independent readers before Milestone 2.

See [radar contract](docs/radar-contract.md) and [validation plan](docs/validation.md).

## Sources

NEXRAD public archive: https://registry.opendata.aws/noaa-nexrad/
Reader: https://docs.openradarscience.org/projects/xradar/

Independent experimental project, not an official NWS warning system.
