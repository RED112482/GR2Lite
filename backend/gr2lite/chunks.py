"""Incremental KMOB NEXRAD Level-II chunk ingestion (experimental).

Publishes only complete sweeps via xradar incomplete_sweep='drop'.
No arbitrary S3 keys from HTTP callers; anonymous public AWS only.
"""
from __future__ import annotations
from collections import defaultdict
from datetime import datetime, timezone
from threading import Thread, Lock
from pathlib import PurePosixPath
import logging
import re
import warnings
from time import perf_counter
from .live import LiveArchivePoller, RadarStore
from .decoder import decode_tree
from .aws_archive import BUCKET as ARCHIVE_BUCKET

LOG = logging.getLogger(__name__)
BUCKET = "unidata-nexrad-level2-chunks"
CHUNK_RE = re.compile(r"^KMOB/([0-9]{1,3})/([0-9]{8})-([0-9]{6})-([0-9]{3})-([SIE])$")
MAX_CHUNKS = 110
MAX_BYTES = 35 * 1024 * 1024

def parse_chunk(key: str):
    match = CHUNK_RE.fullmatch(key)
    if not match:
        return None
    cycle, day, clock, number, kind = match.groups()
    return (f"{day}_{clock}", int(number), kind)

def contiguous_prefix(keys: list[str]) -> list[str]:
    """Return only chunk numbers 1..N of a single volume with an S header."""
    indexed={}
    for key in keys:
        parsed=parse_chunk(key)
        if parsed:
            indexed[parsed[1]]=key
    if 1 not in indexed or parse_chunk(indexed[1])[2] != "S":
        return []
    ordered=[]
    for number in range(1, min(MAX_CHUNKS, len(indexed)) + 1):
        key=indexed.get(number)
        if key is None:
            break
        ordered.append(key)
        if parse_chunk(key)[2] == "E":
            break
    return ordered

def latest_listing(s3, prefix: str = 'KMOB/') -> tuple[str, list[str]]:
    """Choose the newest volume by UTC stamp, not rotating volume number.

    Listing all KMOB objects via S3 pagination is more efficient than making
    a separate network request for every cycle prefix.
    """
    groups=defaultdict(list)
    paginator=s3.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=BUCKET,Prefix=prefix):
        for entry in page.get("Contents",[]):
            key=entry["Key"]
            parsed=parse_chunk(key)
            if parsed:
                groups[parsed[0]].append(key)
    if not groups:
        raise RuntimeError("No currently available KMOB real-time chunks")
    for stamp in sorted(groups,reverse=True):
        ordered=contiguous_prefix(groups[stamp])
        if ordered:
            return stamp,ordered
    raise RuntimeError("KMOB chunk listing has no volume containing its S header")

class IncrementalChunkPoller(LiveArchivePoller):
    def __init__(self, store:RadarStore, interval:float=6):
        super().__init__(store,interval=max(5,interval))
        self.interval=max(5,float(interval))
        self.bytes_by_key:dict[str,bytes]={}
        self.last_snapshot:tuple[str,int]|None=None
        self.last_chunk_at:datetime|None=None
        self.last_chunk_count=0
        self.active_prefix: str|None=None
        self.discovery_polls=0
        self.active_completed=False
        self.fallback=LiveArchivePoller(store,interval=45)
        self.since_archive=0
        self._fallback_lock=Lock()
        self._fallback_running=False

    def poll_once(self)->bool:
        import xradar as xd
        now=datetime.now(timezone.utc)
        self.store.last_check=now
        started=perf_counter()
        # Fast path: poll only the current cycle prefix, not the whole bucket.
        # Periodically re-discover or immediately after a completed volume.
        rediscover=(self.active_prefix is None or self.active_completed or
                    self.discovery_polls>=5)
        if rediscover:
            stamp,keys=latest_listing(self.s3)
            self.active_prefix=keys[0].rsplit('/',1)[0]+'/'
            self.discovery_polls=0
        else:
            try:
                stamp,keys=latest_listing(self.s3,self.active_prefix)
            except RuntimeError:
                stamp,keys=latest_listing(self.s3)
                self.active_prefix=keys[0].rsplit('/',1)[0]+'/'
                self.discovery_polls=0
        self.active_completed=parse_chunk(keys[-1])[2]=='E'
        self.discovery_polls+=1
        discovery_ms=round((perf_counter()-started)*1000,1)
        new_chunk_count=0
        downloaded_bytes=0
        download_start=perf_counter()
        self.last_chunk_count=len(keys)
        self.store.chunk_count=len(keys)
        self.store.chunk_volume=stamp
        if len(keys)>MAX_CHUNKS:
            raise RuntimeError("Chunk safety limit exceeded")
        keep=set(keys)
        for key in list(self.bytes_by_key):
            if key not in keep:
                del self.bytes_by_key[key]
        for key in keys:
            if key not in self.bytes_by_key:
                obj=self.s3.get_object(Bucket=BUCKET,Key=key)
                body=obj["Body"].read(MAX_BYTES+1)
                if len(body)>MAX_BYTES:
                    raise ValueError("Oversized S3 chunk")
                self.bytes_by_key[key]=body
                new_chunk_count+=1
                downloaded_bytes+=len(body)
                self.last_chunk_at=now
        if sum(len(v) for v in self.bytes_by_key.values())>MAX_BYTES:
            raise ValueError("Chunk cache exceeds memory budget")
        download_ms=round((perf_counter()-download_start)*1000,1)
        candidate=(stamp,len(keys))
        if candidate==self.last_snapshot:
            return False
        decode_started=perf_counter()
        prior_snapshot=None
        for candidate_volume in self.store.list():
            if candidate_volume.descriptor.volume_id.startswith(f"KMOB{stamp}_CH"):
                prior_snapshot=self.store.get(candidate_volume.descriptor.volume_id)
                break
        with warnings.catch_warnings():
            warnings.filterwarnings("ignore",message=r"Dropped .* incomplete sweep")
            tree=xd.open_datatree(
                [self.bytes_by_key[k] for k in keys],
                engine="nexradlevel2",
                incomplete_sweep="drop",
                reindex_angle=False,
                mask_and_scale=True,
                decode_times=True,
            )
        try:
            if not any(g.startswith("/sweep_") for g in tree.groups):
                return False
            snapshot_id=f"KMOB{stamp}_CH{len(keys):03d}"
            volume=decode_tree(tree,"KMOB",snapshot_id,reuse=prior_snapshot)
            volume.descriptor.volume_complete = parse_chunk(keys[-1])[2] == "E"
        finally:
            tree.close()
        if not volume.descriptor.sweeps:
            return False
        # Only publish when newly completed sweeps exist; don't duplicate UI frames
        old=self.store.list()
        if old and old[0].descriptor.volume_id.startswith(f"KMOB{stamp}_CH"):
            if (len(volume.descriptor.sweeps)<=len(old[0].descriptor.sweeps)
                    and not (volume.descriptor.volume_complete and not old[0].descriptor.volume_complete)):
                self.last_snapshot=candidate
                return False
        decode_ms=round((perf_counter()-decode_started)*1000,1)
        publish_started=perf_counter()
        published=self.store.publish(volume)
        self.last_snapshot=candidate
        if not published:return False
        publish_ms=round((perf_counter()-publish_started)*1000,1)
        self.store.latency_metrics={
            "source":"chunks",
            "volume_id":snapshot_id,
            "discovery_ms":discovery_ms,
            "download_ms":download_ms,
            "decode_ms":decode_ms,
            "publish_ms":publish_ms,
            "total_ms":round((perf_counter()-started)*1000,1),
            "new_chunks":new_chunk_count,
            "download_bytes":downloaded_bytes,
            "sweeps":len(volume.descriptor.sweeps),
            "reused_sweeps":getattr(volume,"reused_sweep_count",0),
            "newly_decoded_sweeps":len(volume.descriptor.sweeps)-getattr(volume,"reused_sweep_count",0),
            "measured_at_utc":datetime.now(timezone.utc).isoformat(),
        }
        self.store.feed_source="chunks"
        LOG.info("Published %s with %s complete cuts",snapshot_id,len(volume.descriptor.sweeps))
        return True

    def _run_archive_fallback(self)->None:
        try:
            self.fallback.poll_once()
        except Exception as exc:
            LOG.warning("Completed-volume fallback unavailable: %s",exc)
        finally:
            with self._fallback_lock:
                self._fallback_running=False

    def run(self)->None:
        while not self.stop_event.is_set():
            try:
                self.poll_once()
                self.store.last_error=None
            except Exception as exc:
                self.store.last_error=f"Chunk feed: {type(exc).__name__}: {str(exc)[:150]}"
                LOG.warning("Chunk feed problem; preserving last snapshot: %s",exc)
            self.since_archive+=1
            if self.since_archive*self.interval>=120:
                self.since_archive=0
                # Archive fallback can take tens of seconds: run separately so it
                # never stalls the high-priority low-latency chunk feed.
                with self._fallback_lock:
                    if not self._fallback_running:
                        self._fallback_running=True
                        Thread(target=self._run_archive_fallback,
                               name="kmob-archive-fallback",daemon=True).start()
            self.stop_event.wait(self.interval)
