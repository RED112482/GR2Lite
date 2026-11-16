"""Low-priority background backfill of the most recent hour of KMOB archives.

This runs separately from chunk ingestion. Only completed historical volumes
are used. Local disk history is optional and capped by DiskHistory.
"""
from datetime import datetime, timedelta, timezone
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Thread,Event
import logging

import boto3
from botocore import UNSIGNED
from botocore.config import Config

from .aws_archive import BUCKET
from .decoder import decode_archive
from .history import DiskHistory
from .live import scan_time, _KEY_RE

LOG=logging.getLogger(__name__)

class HourBackfill:
    def __init__(self,disk:DiskHistory,delay_seconds:int=40):
        self.disk=disk
        self.delay=max(0,delay_seconds)
        self.stop_event=Event()
        self.thread:Thread|None=None
        self.completed=0
        self.error:str|None=None

    def keys(self,s3,now:datetime)->list[str]:
        start=now-timedelta(minutes=self.disk.minutes)
        keys=[]
        for day in (start,now):
            prefix=day.strftime("%Y/%m/%d/")+"KMOB/"
            paginator=s3.get_paginator("list_objects_v2")
            for page in paginator.paginate(Bucket=BUCKET,Prefix=prefix):
                for obj in page.get("Contents",[]):
                    k=obj["Key"]
                    if _KEY_RE.fullmatch(k):
                        t=scan_time(k)
                        if start<=t<now-timedelta(minutes=2):
                            keys.append(k)
        # Avoid re-downloading missing history on every application refresh.
        return sorted(set(keys),key=scan_time,reverse=True)[:20]

    def run(self):
        if self.stop_event.wait(self.delay):return
        try:
            s3=boto3.client("s3",region_name="us-east-1",
                config=Config(signature_version=UNSIGNED,connect_timeout=8,read_timeout=30))
            now=datetime.now(timezone.utc)
            known={v.volume_id for v in self.disk.catalog()}
            for key in self.keys(s3,now):
                if self.stop_event.is_set():return
                id=Path(key).name
                if id in known:continue
                try:
                    with TemporaryDirectory(prefix="gr2lite-backfill-") as temp:
                        dest=Path(temp)/id
                        s3.download_file(BUCKET,key,str(dest))
                        volume=decode_archive(dest,"KMOB")
                        self.disk.save(volume)
                    known.add(id)
                    self.completed+=1
                except Exception as exc:
                    self.error=f"{type(exc).__name__}: {str(exc)[:120]}"
                    LOG.warning("Skipping historical %s: %s",id,exc)
                if self.stop_event.wait(3):return
        except Exception as exc:
            self.error=f"{type(exc).__name__}: {str(exc)[:120]}"
            LOG.warning("History backfill unavailable: %s",exc)

    def start(self):
        self.thread=Thread(target=self.run,name="gr2lite-history-backfill",daemon=True)
        self.thread.start()

    def stop(self):
        self.stop_event.set()
        if self.thread:self.thread.join(timeout=3)
