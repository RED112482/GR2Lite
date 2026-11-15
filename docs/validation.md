# GR2Lite decoder validation plan

## Included automated tests

- Contract lengths, UTC ray times, native azimuth/elevation and first-gate geometry
- Native reflectivity/velocity preservation, including negative velocities
- NaN/missing gate preservation, little-endian binary bytes and API response shape
- Explicit rejection of nonuniform ranges, invalid radar IDs and unsafe S3 keys

## Still required: real KMOB Level-II integration tests

1. Pin a known KMOB archive key and SHA-256 checksum under `tests/reference_cases/`.
2. Decode with xradar, and compare independently with Py-ART (or trusted reference data).
3. Check file header/site lat/lon/alt, volume timestamps, all sweep fixed angles,
   ray counts, every available moment, spacing/first gate, scale/offset and NaNs.
4. Verify ray count across split cuts, changing VCPs and truncated files.
5. Compare random gates and predefined azimuth/range samples against reference.
6. Validate float32 serialization and round-trip frontend decoding.
7. Only after all that, mark real-data integration `PASS` and continue to Milestone 2.

Current state: **unit-tested synthetic adapter only**; real archive decode is not
verified by the bundled tests. No test claims operational suitability.
