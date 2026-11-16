"""Near-live completed-volume feed tests; AWS calls are always mocked."""
from datetime import datetime, timezone
from types import SimpleNamespace
from gr2lite.live import latest_kmob_key, RadarStore, LiveArchivePoller

class Paginator:
    def paginate(self, Bucket, Prefix):
        if Prefix == "2026/11/14/KMOB/":
            yield {"Contents":[
                {"Key":"2026/11/14/KMOB/KMOB20261114_230000_V06"},
                {"Key":"2026/11/14/KMOB/KMOB20261114_230000_V06_MDM"},
            ]}
        elif Prefix == "2026/11/15/KMOB/":
            yield {"Contents":[{"Key":"2026/11/15/KMOB/KMOB20261115_000100_V06"}]}
        else:
            yield {"Contents":[]}

class S3:
    def get_paginator(self, name):
        assert name == "list_objects_v2"
        return Paginator()

def test_latest_key_across_midnight_and_filters_metadata():
    key=latest_kmob_key(S3(),datetime(2026,11,15,0,3,tzinfo=timezone.utc))
    assert key == "2026/11/15/KMOB/KMOB20261115_000100_V06"

def test_store_history_evicts_oldest():
    store=RadarStore(limit=2)
    for n in range(3):
        d=SimpleNamespace(descriptor=SimpleNamespace(volume_id=f"KMOB{n}",sweeps=[]))
        store.publish(d)
    assert [v.descriptor.volume_id for v in store.list()] == ["KMOB2","KMOB1"]

def test_poll_noop_when_key_unchanged(monkeypatch):
    store=RadarStore()
    poller=LiveArchivePoller(store)
    poller.s3=S3()
    monkeypatch.setattr("gr2lite.live.latest_kmob_key",lambda *_:"2026/11/15/KMOB/KMOB20261115_000100_V06")
    poller.last_key="2026/11/15/KMOB/KMOB20261115_000100_V06"
    assert poller.poll_once() is False

def test_status_and_history_nested_lock_not_stuck():
    import threading
    store=RadarStore(limit=2)
    result=[]
    t=threading.Thread(target=lambda:result.append(store.status()),daemon=True)
    t.start()
    t.join(timeout=1)
    assert not t.is_alive(), "Radar status deadlocked while reading history"
    assert result[0]["state"] == "empty"
    assert result[0]["volume_count"] == 0

def test_radar_status_exports_last_published_ingest_metrics():
    store=RadarStore(limit=2)
    store.latency_metrics={"discovery_ms":12.5,"download_ms":85.0,"decode_ms":220.0,"publish_ms":1.5}
    status=store.status()
    assert status["latency_metrics"]["decode_ms"] == 220.0
    assert status["latency_metrics"]["discovery_ms"] == 12.5
