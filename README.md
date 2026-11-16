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
- GPU renderer caches recently displayed gate and azimuth textures in a
  **96 MiB GPU LRU** so time looping can revisit frames without repeat
  uploads. A linear-time lookup replaces the earlier per-bin/ray scan.
  These remain **sweep-level** updates, not per-radial GPU patching yet.
- The browser keeps a **160 MiB native-gate buffer** and prefetches the next
  several radar times with at most two concurrent downloads. Select the
  target loop rate (1.7/3.3/6.7 fps); actual speed depends on cache readiness
  and the computer's rendering performance.
- Radar metadata responses use lightweight HTTP gzip (native float32 gate
  responses remain uncompressed), and the full map and panels share cached
  NOAA reference outlines.
- A slow completed-volume fallback runs on a separate thread so it cannot
  block incremental S3 chunk checks.
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

The browser/WebGL and chunk layers remain experimental research components, not
a certified warning platform. Cloud hosting remains a future task: GitHub
Pages hosts static resources but cannot run this Python backend.

Data: <https://registry.opendata.aws/noaa-nexrad/>
Chunk decoding: <https://docs.openradarscience.org/projects/xradar/en/stable/notebooks/nexrad_read_chunks.html>

## Performance and correctness limitations

The current code is an experimental iteration toward GR2-like responsiveness:
2/4/16 panels share a dedicated WebGL2 GPU renderer (one context) rather than
creating sixteen independent GPU contexts. Canvas2D remains only for boundary
strokes and as a fallback on unsupported or failing graphics hardware. Complete sweeps still pass through xradar before becoming visible,
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

## Live scan-status strip

A permanent strip beneath the app header shows **unique elevation angles**
in ascending order, updating when complete Level-II sweeps arrive. The
**green-glowing elevation** is the latest received cut (using actual ray
timestamps); the blue outline is the cut currently selected for interrogation.
Repeated elevations show their repeat count, and clicking a tilt navigates to
that elevation. The strip continues monitoring the newest volume while you
navigate historical radar loops.

- **VCP:** from xradar root `scan_name` (NEXRAD Message 5), when available.
- **SAILS/MRLE/standard:** from `dynamic_scan_type` (Message 5); this is
  authoritative when the metadata is present.
- **AVSET ON/OFF:** from `avset_enabled` (Message 2), not from guessing whether
  the current volume has reached its maximum elevation.
- **UNKNOWN:** used when the relevant message has not been seen or cannot be
  decoded. Without authoritative metadata the strip may show a tentative
  observation (marked with `?`) based on repeated low-level elevations.
- An incomplete live volume reports its number of *completed* received sweeps;
  the status changes to VOLUME COMPLETE only when the S3 end-of-volume chunk
  is received.

Data-field references: [xradar NEXRAD Level-II backend](https://docs.openradarscience.org/projects/xradar/en/latest/_modules/xradar/io/backends/nexrad_level2.html)
and [NWS Radar Operations Center scanning techniques](https://www.roc.noaa.gov/radar-techniques.php).

### Next planned engineering milestone

**Instrument radar latency and rendering performance** before increasing scope:
measure chunk arrival-to-decode, decode-to-publish, API download, WebGL upload,
and actual frame-loop rates across 1/2/4/16 panels. Then replace repeated
whole-volume decoding with sweep-oriented incremental decoding and migrate the
remaining Canvas2D panel previews to reusable GPU rendering. The target is
smooth, predictable navigation without compromising the integrity of NEXRAD
missing-data and range-folded gate handling.

## Performance diagnostics (latency milestone)

The sidebar's **LIVE PERFORMANCE** section separates these measurements:

- **Latest ray age (seconds):** current client-observed `/radar/status` estimate
  of elapsed time since the newest decoded radar radial. This is *not* AWS
  publishing latency or guaranteed end-to-end delivery latency.
- **Chunk discovery (ms):** elapsed time spent listing S3 chunk objects.
- **Chunk download (ms):** elapsed time fetching newly discovered chunk bytes.
- **Decode / publish (ms):** xradar assembly/decoding, followed by atomic
  publishing of a usable sweep snapshot.
- **Gate transfer (ms):** browser `fetch` plus binary response read; shows
  **CACHED** when gate arrays are reused from browser memory.
- **GPU upload (ms):** synchronous WebGL texture preparation/submission time,
  with **cached** shown for repeated frames. It is not asynchronous GPU
  execution/completion time.
- **Frame load (ms):** the duration of selecting and preparing a frame for
  display (can include a network request). This is *not* a measured on-screen
  presentation or FPS metric.

The backend exposes the last **successful published chunk** timings under
`latency_metrics` in `GET /radar/status`; timings stay associated with their
`volume_id`, `measured_at_utc`, `new_chunks`, and `download_bytes`.
Missing measurements are shown as —, never fabricated. Use these observations
to choose between decoder optimization, network strategy, or GPU work. A
more rigorous future benchmark should add frame presentation timestamps and
percentile distributions across sustained live sessions.

## Rolling full-volume elevation rail

The status strip now uses `GET /radar/tilts` to build a coherent elevation
sequence from the **current partial volume** plus the **immediately preceding
completed volume** (same radar/VCP and no more than 20 minutes older).
This is particularly useful early in a new volume: low levels are already
fresh, while the most recent upper levels belong to the prior complete scan.

- **Solid chip:** that elevation has been received in the current volume.
- **Dashed/dim `PREV` chip:** elevation is not yet present in the new volume;
  the newest available matching cut is from the previous complete volume.
- **Glowing green:** actual latest received cut, independent of the selected tilt.
- **Blue outline:** selected cut, including when it came from the older volume.
- Up/down arrows in single-panel and supported multi-panel modes navigate
  the entire rolling angle sequence, crossing the volume boundary when needed.
- A click on a `PREV` chip loads the actual older volume and sweep ID. It does
  not substitute a low-level gate or interpolate one volume into another.
- For SAILS/MRLE repeat cuts, the latest acquisition of a given angle/product
  is preferred. Current-volume data always replaces previous-volume data
  as those elevations arrive.
- Changing VCP or losing prior complete-volume data gracefully limits
  navigation to the elevations actually available; it does not invent missing
  cuts.

This is an *availability* rail, not a synthetic merged Level-II volume.
Radar data and acquisition timestamps remain tied to their original source.

## Incremental sweep reuse (performance milestone)

Previously, every newly arrived S/I/E chunk caused GR2Lite to recopy and
normalize all previously completed sweeps when rebuilding a volume snapshot.
The live decoder now checks each finished sweep's radar, source volume, ray
timestamps, azimuths, elevations, moment set, range spacing, and units before
reusing its already decoded native float32 buffers. Changed or newly received
sweeps still decode normally. This preserves the original Level-II gate
values, missing-data masks, and the independent time/tilt status rail.

The sidebar's **Decoded / reused cuts** diagnostic separates newly processed
sweeps from sweeps reused unchanged. **Decode / publish** shows the observed
duration. Note that xradar still parses the incoming chunk sequence to build
the updated DataTree; this optimization targets the application-level gate
array extraction and conversion, not the underlying radial parsing. It is
not yet true partial-radial decoding or a measured guarantee of latency gains.

## Shared GPU renderer for 2 / 4 / 16 panels

The multi-panel viewer now uses a **single WebGL2 context** for radar values,
with a scissored viewport per tile. Each panel samples its native float32
polar gates and azimuth lookup directly in its fragment shader. An LRU cache
limits GPU gate/lookup/colorbar textures to about **120 MiB**. Velocity
missing-data and range-folded Level-II special codes remain masked, and the
existing REF/VEL display palettes are preserved. State/county/CWA outlines
still use lightweight transparent Canvas2D strokes above the GPU display.

Panel selection, independent moment/elevation changes, click-to-interrogate,
double-click-to-maximize, rolling elevation status and one-hour time looping
remain unchanged. Panning/zooming requests a shader redraw rather than
re-rasterizing every radar pixel in JavaScript.

The sidebar panel-selection text indicates **GPU** or **CPU fallback**. If
WebGL2 initialization, context or drawing fails, the existing Canvas2D
rendering path is used instead. This should be treated as an experimental
performance implementation until visually verified with live KMOB sweeps
on the target workstation; build and browser UI tests alone do not establish
correct pixel-level output or guaranteed frame rates.

## Equal-aspect multi-panel layouts and performance

The 2-, 4-, and 16-panel modes now use **equal-sized grid cells** with
**full-bleed rectangular radar plots** in each tile. Each panel uses the
same projected geographic distance **per screen pixel** in both directions,
so radar pixels fill the available panel without distorting radial geometry.
The GPU shader, native-gate click sampling, the CPU fallback and reference
outlines now all use that same MapLibre zoom projection.
The 16-panel layout uses a 4×4 grid and shows **all rolling available unique
elevations** from current and preceding complete volumes (paged only above
16). The most recently acquired elevation has a green ring around its pane;
the separately selected pane keeps its blue selection outline.

For better responsiveness, unchanged panel DOM elements are retained across
moment, tilt, and live-snapshot updates. The browser reuses decoded gates
and WebGL textures, limits concurrent gate downloads to six tiles, and
reuses a single rendered reference-outline canvas across all same-sized
panes rather than reprojecting county/state/CWA lines 16 times. Sixteen-panel
GPU framebuffer resolution is capped to reduce GPU fill-rate usage, while
native gate samples are preserved (only display resolution changes).
The CPU Canvas fallback remains available.

These optimizations improve the rendering architecture but do not promise
the same FPS on every Windows GPU. The browser regression suite checks
equal geometry, prior-volume upper cuts, the newest ring, and DOM reuse;
real continuous-radar performance should still be checked locally.

### November 16 — panel pan and geographic reference correction

A follow-up to the 16-panel GPU work eliminated the small, letterboxed
centered-square plots. 2, 4, and 16 panels now **fill their equal grid cells**;
the radial data is *not stretched*, because horizontal and vertical Mercator
scales are identical per physical screen pixel.

State, county and CWA outlines now use the identical geographic transform
as the radar shader. The previous fixed-vertex-stride simplification could
create erroneous long straight line segments along complex coastlines;
the new screen-tolerance Douglas–Peucker simplifier preserves major turns.
Geographic boundary points are projected once, and their raster is shared
between panels instead of repeatedly recomputing features during panning.

Pointer dragging is now continuous (pan-by updates coalesced into animation
frames), and GPU redraws are throttled to avoid excessive work (approximately
30 fps target with 16 panels, higher in smaller layouts). WebGL errors are
sampled periodically instead of synchronizing every frame. The actual visual
frame rate and workstation-level overlay accuracy should still be tested
against a live Level-II scan.

## GPU boundary overlays synchronized with radar (November 16)

In 2/4/16 panel mode, state, county, and NWS CWA outlines now render
**in the same WebGL2 frame and geographic transform** as each radar tile.
Previous versions redrew boundary pixels on separate Canvas2D elements
after map movement, causing overlays to trail radar and block UI interaction.

Projected NOAA geometry is uploaded once as GPU line buffers, then drawn
with the same viewport, Mercator center and scale as the radar gates in
each active panel. There is no per-drag CPU coastline rasterization or
90-ms delayed outline refresh on the GPU path.

The sidebar checkboxes for **State boundaries**, **County boundaries**, and
**NWS CWA boundaries** apply immediately in both the main MapLibre display
and the 2/4/16 panel renderer. Each layer can be hidden independently.
The CPU fallback still respects the toggles. Disabling a layer skips its
WebGL draw calls rather than drawing it invisibly.

If WebGL2 is unavailable, the slower Canvas2D fallback remains in place.
Actual movement responsiveness should still be checked on the intended GPU.
