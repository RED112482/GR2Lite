# GR2Lite — Experimental Level-II Radar Viewer

**Current: near-live KMOB completed-volume refresh + archived playback.**
The WebGL2 radar viewer shows native polar gates with state, county and NWS CWA
reference overlays. This is an experimental research tool, **not approved for
operational warning decisions**.

## Windows quick start

Install **Python 3.12** and **Node.js LTS** once. Download the repository and
double-click **[Start-GR2Lite.cmd](Start-GR2Lite.cmd)**. It sets up isolated
dependencies, launches the local radar backend and frontend, and opens the
browser viewer. Internet access is needed to query the public AWS Level-II feed.

The backend can also be run in historical archive mode using
`GR2LITE_ARCHIVE_PATH`. See
**[Live mode and manual launch instructions](docs/live-mode.md)**.

## What works

- Native Level-II REF/VEL/SW/CC/ZDR/PHI rendering via WebGL2
- Native-value gate sampling and elevation/cut selection
- MapLibre dark basemap without an API key; official NOAA boundary overlays
- Automatically checking the latest *complete* KMOB volume on AWS
- Bounded volume history, Follow Latest toggle, UTC timestamps and stale state
- Preservation of map zoom/pan, radar moment and closest elevation during updates
- Backend API status `/radar/status` and `/volumes`; live errors are visible
- GitHub Actions test/build workflows

## Next technical milestones

1. **Incremental chunk ingestion** (low-latency S/I/E fragments and completed
   sweep publication) rather than waiting for completed archive volumes
2. More memory-efficient gate caching and fast history playback
3. Accurate long-range gate geodesy and independent radar validation
4. Native SRM, dealiasing controls, QTor/tortosity overlays
5. Authenticated cloud backend with persistent low-latency connection and
   availability monitoring

The current AWS feed is the public `unidata-nexrad-level2` **completed-volume**
bucket. The `unidata-nexrad-level2-chunks` bucket supports earlier sweep
updates, but that mechanism is **not integrated yet**. Do not interpret the
`NEAR-LIVE` label as a guarantee of true per-sweep real-time latency.

Source information: https://registry.opendata.aws/noaa-nexrad/ and
https://docs.openradarscience.org/projects/xradar/en/stable/notebooks/nexrad_read_chunks.html

## Repository layout

- `backend/gr2lite/` — decoding, AWS polling, archive/history API
- `frontend/src/` — map, WebGL2 radar layer, controls and gate sampling
- `docs/` — radar data contract, validation and live-mode instructions
- `.github/workflows/` — automated unit tests and frontend build

Python API is local by default; the frontend is served by Vite locally.
The repository contains a Dockerfile to prepare for cloud deployment but
**does not yet deploy a cloud service**. GitHub Pages alone cannot host the
running Python radar backend.
