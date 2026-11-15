# GR2Lite — Experimental Level-II radar viewer

A browser-based Doppler radar interrogation prototype with native polar-gate rendering,
interactive map navigation, official NOAA CWA/state/county boundaries and
incremental KMOB Level-II chunk ingestion.

**Not approved for operational NWS warning decisions.** The decoder,
moment geometry, streaming latency and color mapping require additional
independent real-data validation.

## Quick start (Windows)

Install **Python 3.12** and **Node.js LTS** once. Download the current
repository ZIP, extract it, and double-click **Start-GR2Lite.cmd**.

The launcher prepares the isolated Python and npm dependencies, starts the
backend using `GR2LITE_MODE=chunks`, starts the Vite browser application,
and opens <http://127.0.0.1:5173/GR2Lite/>.

The frontend API address should be `/api`. The backend status page is
<http://127.0.0.1:8000/radar/status>.

## Multi-panel operation

- **1 panel:** full interactive WebGL2 map.
- **2 panels:** REF and VEL at the closest available cut angle.
- **4 panels:** REF/VEL at the selected elevation and next elevation.
- **16 panels:** all **unique** elevation angles from lowest to highest;
  if more than 16, use the page arrows. These panels are optimized Canvas2D
  previews of the native gates, with map outlines and a shared camera.
- Up/down arrows in **1/2/4-panel** modes move only to a genuinely
  higher/lower angle (no wrapping from highest to lowest).
- Wheel and drag in multi-panel mode adjust the shared geographic viewport.
  Click a tile to interrogate the nearest native gate; double-click to open
  that tilt in the single WebGL view.
- The VST/product readout includes UTC time, VCP when present, current tilt,
  moment and maximum decoded sample details.

## Incremental radar ingestion

Default `GR2LITE_MODE=chunks` reads from the rolling
`unidata-nexrad-level2-chunks` S3 bucket, ordering S/I/E chunks, checking
for gaps, and calling xradar with `incomplete_sweep="drop"`. When complete
sweeps become available, the backend publishes a new immutable snapshot.
Partial sweeps do not replace valid displayed radar. The legacy completed-
volume ingest path remains a fallback.

- Default poll interval: 12 seconds. No latency guarantee.
- Source indicators: `CHUNKS` (incremental) versus `FALLBACK` (archive).
- UTC acquisition timestamps, stale/delayed status, and latest completed
  sweep count visible at `/radar/status`.
- Retains the newest two snapshots by default; preserves pan/zoom and
  closest elevation when following live data.
- Pulling from S3 requires working Internet access.
- **This is an experimental first implementation**; automated unit tests
  cannot substitute for a live ingest run and comparison with GR2Analyst.

## Architecture

- `backend/gr2lite/chunks.py`: S3 chunk discovery, sequential download,
  complete-sweep assembly and archive fallback
- `backend/gr2lite/live.py`: bounded historical snapshots and feed status
- `backend/gr2lite/decoder.py`: xradar adapter
- `frontend/src/radarLayer.ts`: native-gate WebGL2 renderer
- `frontend/src/panels.ts`: synchronized multi-panel previews
- `frontend/src/palettes.ts`: reflectivity/velocity reference-inspired ramps
- `docs/live-mode.md`: manual deployment and troubleshooting
- `docs/radar-contract.md`: JSON and binary transport contract

The React/GPU and chunk layer remain experimental research components, not
a certified warning platform. Cloud hosting remains a future task: GitHub
Pages hosts static resources but cannot run this Python backend.

Data: <https://registry.opendata.aws/noaa-nexrad/>
Chunk decoding: <https://docs.openradarscience.org/projects/xradar/en/stable/notebooks/nexrad_read_chunks.html>
