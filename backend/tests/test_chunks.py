"""Chunk sequencing and discovery tests use mock S3 listings; no live dependency."""
from gr2lite.chunks import parse_chunk, contiguous_prefix, latest_listing

def key(cycle,stem,n,kind):
    return f"KMOB/{cycle}/{stem}-{n:03d}-{kind}"

def test_parse_and_gap_handling():
    stem="20261115-184500"
    a=[key(42,stem,1,"S"),key(42,stem,2,"I"),key(42,stem,4,"I")]
    assert parse_chunk(a[0]) == ("20261115_184500",1,"S")
    assert contiguous_prefix(a)==a[:2]
    assert contiguous_prefix(a[1:])==[]
    assert parse_chunk("KMOB/42/../../bad") is None

class Paginator:
    def paginate(self, Bucket, Prefix):
        assert Prefix == "KMOB/"
        yield {"Contents":[
            {"Key":key(999,"20261114-235800",1,"S")},
            {"Key":key(0,"20261115-000200",1,"S")},
            {"Key":key(0,"20261115-000200",2,"I")},
        ]}
class S3:
    def get_paginator(self, name):
        assert name=="list_objects_v2"
        return Paginator()

def test_latest_by_time_not_cyclic_volume():
    stamp,keys=latest_listing(S3())
    assert stamp=="20261115_000200"
    assert len(keys)==2
