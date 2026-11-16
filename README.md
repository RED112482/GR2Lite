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
- **2 panels:** REF and VEL at the closest available cut angle. Each tile has its own colorbar.
- **Editing a pane:** click the pane once (blue outline), then use the sidebar
  product buttons and elevation selector to change **only that pane**.
  The selected-pane label identifies which pane is being edited. Product and
  elevation choices persist independently during incremental updates.
  In 16-panel mode each pane retains its assigned elevation (ascending),
  but its radar moment can be changed. Double-click a pane to maximize it.
- **4 panels:** REF/VEL at the selected elevation and next elevation, with separately labeled colorbars.
- **16 panels:** all **unique** elevation angles from lowest to highest;
  if more than 16, use the page arrows. These panels are optimized Canvas2D
  previews of the native gates, with map outlines and a shared camera.
- Up/down arrows in **1/2/4-panel** modes move only to a genuinely
  higher/lower angle (no wrapping from highest to lowest).
- **Left/right arrows:** step backward/forward through historical volume times.
  The time slider and Play button loop through the locally cached history;
  LIVE returns to the newest available radar data.
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

- Default poll interval: 6 seconds. No latency guarantee.
- Source indicators: `CHUNKS` (incremental) versus `FALLBACK` (archive).
- UTC acquisition timestamps, stale/delayed status, and latest completed
  sweep count visible at `/radar/status`.
- Retains the newest two snapshots in **RAM** by default and up to **60
  minutes on disk** (default cap 4 GiB), with historical archive backfill
  beginning after initial live startup. The coverage readout reports what
  is actually available; coverage builds progressively and is not guaranteed
  until backfill succeeds.
- Retains pan/zoom, moment and closest elevation while following new chunks.
- The frontend fetches a compact time index and downloads detailed metadata
  only when a volume is selected; previously received complete sweeps share
  their gate buffers across new chunk snapshots.
- GPU renderer skips uploading unchanged complete sweeps, and uses
  `texSubImage2D` when the new scan's texture dimensions are unchanged.
  These are **sweep-level** updates, not per-radial GPU patching yet.
- Pulling from S3 requires working Internet access.
- **This is an experimental first implementation**; automated unit tests
  cannot substitute for a live ingest run and comparison with GR2Analyst.

## Architecture

- `backend/gr2lite/chunks.py`: S3 chunk discovery, sequential download,
  complete-sweep assembly and archive fallback
- `backend/gr2lite/live.py`: bounded hot snapshots and feed status
- `backend/gr2lite/history.py`: disk-backed radar history and memory mapped arrays
- `backend/gr2lite/backfill.py`: low-priority archive recovery of recent history
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

## Performance and correctness limitations

The current code is an experimental iteration toward GR2-like responsiveness:
2/4/16 panels are lightweight Canvas previews and not yet sixteen independent
GPU views. Complete sweeps still pass through xradar before becoming visible,
so ingest is incremental **by complete sweep**, not decoded radial-by-radial.
Initial history backfill can take several minutes and may put noticeable load
on older computers. The local history is limited by available disk space and
is not guaranteed to cover 60 minutes during an outage. Velocity is displayed
in **knots** when the source supplies m/s; source arrays remain unmodified.

If the Windows launcher has already prepared the Python environment, it skips
re-running pip on each subsequent launch. The selected radar is currently KMOB.

Validation: check `/radar/status` for `feed_source`, `age_seconds`,
`history_minutes_available` and `history_error`, and test the panel and time
controls in a browser. The project is not an approved NWS warning-decision tool.

## Velocity ND and missing-data handling

The Level-II data moment uses raw codes **0** (below threshold/no data) and
**1** (range folded). These are not valid radial velocities. GR2Lite now
normalizes known decoded representations to **NaN** in the Python decoder,
and includes a frontend compatibility guard for older cached samples decoded
to **-64.5/-64.0 m/s** (which previously appeared around -125 kt).
The 2/4/16-panel velocity previews use black backgrounds for ND; the
single WebGL display leaves missing gates unpainted so the dark basemap shows
through. The original velocity measurements are not converted from m/s
to knots until display time. Older disk snapshots should still be visually
safe due to the frontend guard.
