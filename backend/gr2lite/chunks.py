"""Incremental KMOB NEXRAD Level-II chunk ingestion (experimental).

Publishes only complete sweeps via xradar incomplete_sweep='drop'.
No arbitrary S3 keys from HTTP callers; anonymous public AWS only.
"""
from __future__ import annotations
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import PurePosixPath
import logging
import re
import warnings
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

def latest_listing(s3) -> tuple[str, list[str]]:
    """Discover short-lived volume prefixes and select newest by timestamp, not cycle ID."""
    prefixes=[]
    paginator=s3.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=BUCKET,Prefix="KMOB/",Delimiter="/"):
        prefixes.extend(entry["Prefix"] for entry in page.get("CommonPrefixes",[]))
    groups=defaultdict(list)
    for prefix in prefixes:
        for page in paginator.paginate(Bucket=BUCKET,Prefix=prefix):
            for entry in page.get("Contents",[]):
                key=entry["Key"]
                parsed=parse_chunk(key)
                if parsed:
                    groups[(prefix,parsed[0])].append(key)
    if not groups:
        raise RuntimeError("No currently available KMOB real-time chunks")
    candidates=sorted(groups, key=lambda p:p[1],reverse=True)
    for key in candidates:
        keys=contiguous_prefix(groups[key])
        if keys:
            return key[1],keys
    raise RuntimeError("KMOB chunk listing has no volume containing its S header")

class IncrementalChunkPoller(LiveArchivePoller):
    def __init__(self, store:RadarStore, interval:float=12):
        super().__init__(store,interval=max(5,interval))
        self.interval=max(5,float(interval))
        self.bytes_by_key:dict[str,bytes]={}
        self.last_snapshot:tuple[str,int]|None=None
        self.last_chunk_at:datetime|None=None
        self.last_chunk_count=0
        self.fallback=LiveArchivePoller(store,interval=45)
        self.since_archive=0

    def poll_once(self)->bool:
        import xradar as xd
        now=datetime.now(timezone.utc)
        self.store.last_check=now
        stamp,keys=latest_listing(self.s3)
        self.last_chunk_count=len(keys)
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
                self.last_chunk_at=now
        if sum(len(v) for v in self.bytes_by_key.values())>MAX_BYTES:
            raise ValueError("Chunk cache exceeds memory budget")
        candidate=(stamp,len(keys))
        if candidate==self.last_snapshot:
            return False
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
            volume=decode_tree(tree,"KMOB",snapshot_id)
        finally:
            tree.close()
        if not volume.descriptor.sweeps:
            return False
        # Only publish when newly completed sweeps exist; don't duplicate UI frames
        old=self.store.list()
        if old and old[0].descriptor.volume_id.startswith(f"KMOB{stamp}_CH"):
            if len(volume.descriptor.sweeps)<=len(old[0].descriptor.sweeps):
                self.last_snapshot=candidate
                return False
        self.store.publish(volume)
        self.last_snapshot=candidate
        self.store.feed_source="chunks"
        LOG.info("Published %s with %s complete cuts",snapshot_id,len(volume.descriptor.sweeps))
        return True

    def run(self)->None:
        while not self.stop_event.is_set():
            try:
                self.poll_once()
                self.store.last_error=None
            except Exception as exc:
                self.store.last_error=f"Chunk feed: {type(exc).__name__}: {str(exc)[:150]}"
                LOG.warning("Chunk feed problem; preserving last snapshot: %s",exc)
            # Fallback only when no fresh snapshot for 10 minutes; never replace fresher data.
            self.since_archive+=1
            if self.since_archive*self.interval>=120:
                self.since_archive=0
                try:
                    self.fallback.poll_once()
                    self.store.feed_source = "archive-fallback" if self.store.feed_source != "chunks" else self.store.feed_source
                except Exception as exc:
                    LOG.warning("Completed-volume fallback unavailable: %s",exc)
            self.stop_event.wait(self.interval)
