"""Bounded automatic Level-II *completed-volume* ingestion.

This is near-live archive polling, NOT low-latency incremental chunk streaming.
A separate future chunk adapter will handle incomplete elevations.
"""
from __future__ import annotations
from collections import OrderedDict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Event, Lock, Thread
import logging
import os
import re
import time

import boto3
from botocore import UNSIGNED
from botocore.config import Config

from .aws_archive import BUCKET
from .decoder import DecodedVolume, decode_archive
from .history import DiskHistory, end_time, scan_group

LOG = logging.getLogger(__name__)
_KEY_RE = re.compile(r"^\d{4}/\d{2}/\d{2}/KMOB/KMOB\d{8}_\d{6}_V\d{2}(?:\.(?:gz|bz2))?$")


def scan_time(key: str) -> datetime:
    name = Path(key).name
    return datetime.strptime(name[4:19], "%Y%m%d_%H%M%S").replace(tzinfo=timezone.utc)


def latest_kmob_key(s3, now: datetime | None = None) -> str | None:
    """Check today's and yesterday's archive prefix; ignore metadata/other sites."""
    now = now or datetime.now(timezone.utc)
    keys: list[str] = []
    for date in (now - timedelta(days=1), now):
        prefix = date.strftime("%Y/%m/%d/") + "KMOB/"
        paginator = s3.get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=BUCKET, Prefix=prefix):
            keys.extend(obj["Key"] for obj in page.get("Contents", []) if _KEY_RE.fullmatch(obj["Key"]))
    return max(keys, key=scan_time) if keys else None


class RadarStore:
    """Shared memory state with atomic decoded-volume publication."""
    def __init__(self, limit: int = 3):
        self._lock = Lock()
        self._items: OrderedDict[str, DecodedVolume] = OrderedDict()
        self.limit = max(1, min(limit, 6))
        history_root = os.environ.get('GR2LITE_HISTORY_DIR')
        self.disk = DiskHistory(history_root, minutes=int(os.environ.get('GR2LITE_HISTORY_MINUTES','60')),
                                max_gb=float(os.environ.get('GR2LITE_HISTORY_MAX_GB','4'))) if history_root else None
        self._last_group = None
        self.mode = "archive"
        self.last_check: datetime | None = None
        self.last_success: datetime | None = None
        self.last_error: str | None = None
        self.feed_source = "archive"
        self.chunk_count = 0
        self.chunk_volume = None

    def publish(self, volume: DecodedVolume) -> bool:
        with self._lock:
            def last_ray(v):
                if v is None: return None
                stamps=[max(s.time_utc) for s in v.descriptor.sweeps if s.time_utc]
                return max(stamps) if stamps else None
            incoming=last_ray(volume)
            newest=next(iter(self._items.values()), None)
            existing=last_ray(newest)
            if incoming is not None and existing is not None and incoming < existing:
                return False
            key=volume.descriptor.volume_id
            group=scan_group(key)
            # Persist the final, most complete version of the preceding scan.
            if newest is not None and self.disk and scan_group(newest.descriptor.volume_id)!=group:
                self.disk.save_async(newest)
            # Chunk snapshots for the same volume are versions, not separate
            # history entries. Replacing avoids 1GB of redundant scans.
            for prior in list(self._items):
                if scan_group(prior)==group and prior!=key:
                    self._items.pop(prior,None)
            self._items[key]=volume
            self._items.move_to_end(key,last=False)
            while len(self._items)>self.limit:
                _,outgoing=self._items.popitem(last=True)
                if self.disk:self.disk.save_async(outgoing)
            self.last_success=datetime.now(timezone.utc)
            self.last_error=None
            return True

    def list(self)->list[DecodedVolume]:
        with self._lock:
            items=list(self._items.values())
            if self.disk:
                known={scan_group(v.descriptor.volume_id) for v in items}
                for desc in self.disk.catalog():
                    if scan_group(desc.volume_id) not in known:
                        items.append(DecodedVolume(desc,{}))
                        known.add(scan_group(desc.volume_id))
            def key(v):
                return end_time(v) or datetime.min.replace(tzinfo=timezone.utc)
            return sorted(items,key=key,reverse=True)

    def get(self,key:str)->DecodedVolume|None:
        with self._lock:
            cached=self._items.get(key)
        if cached is not None:return cached
        return self.disk.load(key) if self.disk else None

    def status(self)->dict:
        with self._lock:
            v=next(iter(self._items.values()),None)
            latest=v.descriptor.volume_id if v else None
            sample_time=end_time(v) if v else None
            age=(datetime.now(timezone.utc)-sample_time).total_seconds() if sample_time else None
            all_volumes=self.list()
            first=end_time(all_volumes[-1]) if all_volumes else None
            coverage=(sample_time-first).total_seconds()/60 if sample_time and first else 0
            return {
                "mode":self.mode,
                "feed_source":self.feed_source,
                "chunk_count":self.chunk_count,
                "chunk_volume":self.chunk_volume,
                "complete_sweeps":len(v.descriptor.sweeps) if v else 0,
                "state":("error" if self.last_error and not v else
                         "empty" if not v else
                         "stale" if age is not None and age>1200 and self.mode!="archive" else
                         "delayed" if age is not None and age>600 and self.mode!="archive" else
                         "ready"),
                "latest_volume_id":latest,
                "latest_ray_time_utc":sample_time.isoformat() if sample_time else None,
                "age_seconds":round(age) if age is not None else None,
                "volume_count":len(all_volumes),
                "history_minutes_available":round(coverage,1),
                "history_target_minutes":self.disk.minutes if self.disk else None,
                "history_error":self.disk.error if self.disk else None,
                "last_check_utc":self.last_check.isoformat() if self.last_check else None,
                "last_success_utc":self.last_success.isoformat() if self.last_success else None,
                "last_error":self.last_error,
            }


class LiveArchivePoller:
    def __init__(self, store: RadarStore, interval: float = 45):
        self.store = store
        self.interval = max(20, float(interval))
        self.stop_event = Event()
        self.thread: Thread | None = None
        self.last_key: str | None = None
        self.s3 = boto3.client(
            "s3", region_name="us-east-1",
            config=Config(signature_version=UNSIGNED, retries={"max_attempts": 3},
                          connect_timeout=8, read_timeout=30),
        )

    def poll_once(self) -> bool:
        self.store.last_check = datetime.now(timezone.utc)
        key = latest_kmob_key(self.s3)
        if key is None:
            raise RuntimeError("No recent KMOB completed-volume objects found")
        if key == self.last_key:
            return False
        # Never store raw radar data in the repo and never publish partial decode.
        with TemporaryDirectory(prefix="gr2lite-") as temp:
            local = Path(temp) / Path(key).name
            self.s3.download_file(BUCKET, key, str(local))
            result = decode_archive(local, "KMOB")
            published=self.store.publish(result)
        if published:
            self.store.feed_source = "archive-fallback" if self.store.mode == "chunks" else "archive"
        self.last_key = key
        LOG.info("Published KMOB volume %s", result.descriptor.volume_id)
        return True

    def run(self) -> None:
        while not self.stop_event.is_set():
            try:
                self.poll_once()
                # Successful checks clear intermittent network warnings.
                self.store.last_error = None
            except Exception as exc:
                LOG.exception("Radar update failed; retaining last good volume")
                self.store.last_error = f"{type(exc).__name__}: {str(exc)[:180]}"
            self.stop_event.wait(self.interval)

    def start(self) -> None:
        self.thread = Thread(target=self.run, name="kmob-live-archive", daemon=True)
        self.thread.start()

    def stop(self) -> None:
        self.stop_event.set()
        if self.thread is not None:
            self.thread.join(timeout=5)
