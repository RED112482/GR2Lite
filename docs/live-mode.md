# GR2Lite live-mode quick start

**Experimental:** The default launcher now polls **incremental KMOB Level-II S/I/E chunks** from the public real-time AWS bucket. Complete sweeps are published as chunks arrive; incomplete sweeps are dropped. The completed-volume source remains a fallback.
Publication latency and the radar VCP determine update frequency.

## Windows: easiest

1. Install Python 3.12 and Node.js LTS once.
2. Download/extract the latest repo; double-click `Start-GR2Lite.cmd`.
3. Allow the initial Python and npm installations; two console windows start.
4. Open `http://127.0.0.1:5173/GR2Lite/` if it does not open automatically.

The launcher sets `GR2LITE_MODE=chunks` for the backend. Archive mode is
still available with `GR2LITE_ARCHIVE_PATH` and no live-mode variable.
`Follow latest volume` controls automatic switching. Unchecking it lets
you review a recent volume while new ones arrive. Radar product, cut angle,
pan and zoom are retained during auto-updates.

## Manual

Backend, from `backend/`:

```powershell
$env:GR2LITE_MODE = "chunks"
$env:GR2LITE_CHUNK_POLL_SECONDS = "6"
.\.venv\Scripts\python.exe -m pip install -e .
.\.venv\Scripts\python.exe -m uvicorn gr2lite.api:app --host 127.0.0.1 --port 8000
```

Frontend, from `frontend/`: `npm.cmd install` then `npm.cmd run dev`.

Check `http://127.0.0.1:8000/radar/status` for the source state, actual
radar-ray age, last ingestion check and any last error. `/volumes` lists
the retained snapshots (newest first); `/health` checks API health.

## Reliability and known limitations

- The data service downloads and decodes one complete volume at a time on a
  background worker; the web UI stays interactive.
- Only fully decoded volumes are published. On transient failures, the last
  volume is kept and its timestamp and feed error are exposed.
- Memory history defaults to **two** volumes (`GR2LITE_HISTORY_VOLUMES`,
  clamped to 1–6), not an unbounded cache.
- UTC timestamps and an explicit LIVE/DELAYED/STALE feed state prevent the
  mistaken impression that an old volume is current.
- Chunk polling defaults to 6 seconds (minimum 5); fallback completed-volume checking is approximately every 2 minutes.
- There is not yet a persistent cloud deployment, validated end-to-end chunk latency,
  authenticated multi-user service, validated gate geodesy, or complete
  end-to-end scan latency benchmark.
- The frontend `Follow latest volume` setting is not a live confirmation
  unless the backend source mode says `live`.
- For NWS warning operations, use approved systems, not this experimental
  application.

Source documentation:
https://registry.opendata.aws/noaa-nexrad/
https://docs.openradarscience.org/projects/xradar/en/stable/notebooks/nexrad_read_chunks.html

## Verifying incremental mode

Open `http://127.0.0.1:8000/radar/status`. Expect `mode: chunks` and,
after at least one complete sweep has arrived, `feed_source: chunks`.
The number of sweeps should increase **within a single volume** as complete cuts
become available. The viewer must retain map position across each update.
If a chunk sequence is invalid, the last good radar stays visible. After a
sustained outage, the completed-volume archive source can supply fallback data;
`feed_source: archive-fallback` means the latest **displayed** volume came
from that source. It is not equivalent to incremental live ingestion.

The chunk feed uses the rolling bucket `unidata-nexrad-level2-chunks` and is
not guaranteed to provide each sweep within a particular number of seconds.
