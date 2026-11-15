# Radar contract 0.1.0

This contract is an internal API, not a NEXRAD interchange standard.

- `GET /volumes`: array of `VolumeDescriptor` JSON values.
- `GET /volumes/{volume_id}`: one `VolumeDescriptor`.
- `GET /volumes/{volume_id}/sweeps/{sweep_id}/moments/{moment}`: little-endian
  IEEE-754 `float32` values, row-major `(rays, gates)`; no envelope.
- `X-Array-Shape: rays,gates`; `X-Array-Dtype: float32-le`.
- `NaN` means unavailable/masked gate. Actual decoded zero is preserved.
- Units come from each xradar variable; **never assume all velocity is kt**.
- Each sweep includes actual per-ray azimuth, elevation, UTC timestamps.
- Each moment includes first range gate center (m), spacing (m), ray/gate counts.
- Range is slant range. Geodetic gate coordinates and beam heights are not
  yet in this contract, and need a validated Earth-model/geodesy implementation.
- The adapter preserves native rays and does not perform angular reindexing.
- `source=archive` only; live/partial data is explicitly outside v0.1.

## Known limitations

This milestone's normalizer requires constant gate spacing *within each
moment* and a shared ray axis for moments in a cut. Different moments can have
different range geometry. Some real files may expose per-moment range dimensions
or odd sweep layouts requiring adapter extensions; the decoder intentionally
rejects cases it cannot represent faithfully rather than silently resampling.
The API caches only one volume and is not hardened with authentication, quotas,
CORS policy or external persistence for Internet production traffic.
