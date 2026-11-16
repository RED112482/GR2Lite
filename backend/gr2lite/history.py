"""Disk-backed rolling radar history, separate from bounded hot memory.

Snapshots are written only after leaving a volume, so each additional sweep
does not rewrite an entire Level-II volume. Older snapshots are mmap-loaded
on demand. This is a local cache, not durable cloud object storage.
"""
from __future__ import annotations
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone, timedelta
from hashlib import sha256
from pathlib import Path
from threading import RLock
import logging
import os
import shutil
import time
import numpy as np

from .decoder import DecodedVolume
from .models import VolumeDescriptor, Moment

LOG=logging.getLogger(__name__)
def scan_group(volume_id: str)->str:
    # Chunk snapshots change _CHnnn for each complete sweep; consolidate them.
    return volume_id.split("_CH",1)[0]

def end_time(v:DecodedVolume)->datetime|None:
    times=[max(s.time_utc) for s in v.descriptor.sweeps if s.time_utc]
    return max(times) if times else None

class DiskHistory:
    def __init__(self, root: str|Path, minutes: int=60, max_gb: float=4):
        self.root=Path(root).expanduser().resolve()
        self.root.mkdir(parents=True,exist_ok=True)
        self.minutes=max(15,min(240,minutes))
        self.max_bytes=int(max(1,max_gb)*1024**3)
        self.lock=RLock()
        self.executor=ThreadPoolExecutor(max_workers=1,thread_name_prefix="gr2lite-history")
        self.error:str|None=None
        self._catalog:dict[str,VolumeDescriptor]={}
        self._reload_catalog()

    def _directory(self,id:str)->Path:
        return self.root/sha256(id.encode("utf-8")).hexdigest()[:24]

    def _reload_catalog(self)->None:
        # Parse persisted descriptor files once at startup instead of rereading
        # tens of thousands of radial timestamps every 12-second status poll.
        with self.lock:
            self._catalog.clear()
            for folder in self.root.iterdir():
                metadata=folder/"descriptor.json"
                if not metadata.is_file():continue
                try:
                    desc=VolumeDescriptor.model_validate_json(metadata.read_text(encoding="utf-8"))
                    self._catalog[desc.volume_id]=desc
                except Exception as exc:
                    LOG.warning("Skipping invalid cached radar metadata %s: %s",folder,exc)

    def catalog(self)->list[VolumeDescriptor]:
        with self.lock:
            return list(self._catalog.values())

    def save_async(self, volume:DecodedVolume):
        if not hasattr(volume.descriptor,"model_dump_json"):return
        return self.executor.submit(self.save,volume)

    def save(self, volume:DecodedVolume)->None:
        desc=volume.descriptor
        if not desc.sweeps:return
        sample=end_time(volume)
        if sample is None or sample < datetime.now(timezone.utc)-timedelta(minutes=self.minutes+2):
            return
        # Same scan is represented by latest incremental snapshot only.
        with self.lock:
            for old in self.catalog():
                if scan_group(old.volume_id)==scan_group(desc.volume_id) and old.volume_id!=desc.volume_id:
                    shutil.rmtree(self._directory(old.volume_id),ignore_errors=True)
                    self._catalog.pop(old.volume_id,None)
            folder=self._directory(desc.volume_id)
            if folder.exists():return
            temporary=Path(str(folder)+".partial")
            shutil.rmtree(temporary,ignore_errors=True)
            temporary.mkdir(parents=True)
            try:
                for (sweep,moment),values in volume.arrays.items():
                    np.save(temporary/f"{sweep}_{moment.value}.npy",values,allow_pickle=False)
                (temporary/"descriptor.json").write_text(desc.model_dump_json(),encoding="utf-8")
                temporary.rename(folder)
                self._catalog[desc.volume_id]=desc
                self.prune()
                self.error=None
            except Exception as exc:
                self.error=f"{type(exc).__name__}: {exc}"
                shutil.rmtree(temporary,ignore_errors=True)
                LOG.warning("History snapshot failed: %s",exc)

    def load(self, id:str)->DecodedVolume|None:
        folder=self._directory(id)
        meta=folder/"descriptor.json"
        if not meta.is_file():return None
        try:
            desc=VolumeDescriptor.model_validate_json(meta.read_text(encoding="utf-8"))
            if desc.volume_id!=id:return None
            arrays={}
            for sweep in desc.sweeps:
                for moment in sweep.moments:
                    path=folder/f"{sweep.id}_{moment.value}.npy"
                    if path.is_file():
                        arrays[(sweep.id,moment)]=np.load(path,mmap_mode="r",allow_pickle=False)
            return DecodedVolume(desc,arrays)
        except Exception as exc:
            self.error=f"{type(exc).__name__}: {exc}"
            return None

    def prune(self):
        with self.lock:
            entries=[]
            cutoff=datetime.now(timezone.utc)-timedelta(minutes=self.minutes)
            total=0
            for desc in list(self._catalog.values()):
                folder=self._directory(desc.volume_id)
                if not folder.is_dir():
                    self._catalog.pop(desc.volume_id,None)
                    continue
                last=max((max(s.time_utc) for s in desc.sweeps if s.time_utc),default=None)
                size=sum(p.stat().st_size for p in folder.iterdir() if p.is_file())
                if last is None or last<cutoff:
                    shutil.rmtree(folder,ignore_errors=True)
                    self._catalog.pop(desc.volume_id,None)
                else:
                    entries.append((last,desc.volume_id,folder,size))
                    total+=size
            for _,id,folder,size in sorted(entries):
                if total<=self.max_bytes:break
                shutil.rmtree(folder,ignore_errors=True)
                self._catalog.pop(id,None)
                total-=size
                self.error="History disk capacity reached; oldest volumes removed"

    def close(self):
        self.executor.shutdown(wait=False,cancel_futures=False)
