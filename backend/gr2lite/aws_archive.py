"""Explicit AWS archive downloader for local/CI use. No web-facing arbitrary keys."""
from pathlib import Path
import re
import boto3
from botocore import UNSIGNED
from botocore.config import Config

BUCKET = "unidata-nexrad-level2"


def list_kmob_volumes(date: str, limit: int = 20) -> list[str]:
    """YYYY-MM-DD, returns S3 object keys, excluding metadata objects."""
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date):
        raise ValueError("Expected YYYY-MM-DD")
    y, m, d = date.split("-")
    client = boto3.client("s3", config=Config(signature_version=UNSIGNED), region_name="us-east-1")
    prefix = f"{y}/{m}/{d}/KMOB/"
    result = []
    for page in client.get_paginator("list_objects_v2").paginate(Bucket=BUCKET, Prefix=prefix):
        for obj in page.get("Contents", []):
            key = obj["Key"]
            if key.endswith((".gz", ".bz2")) or re.search(r"KMOB\d{8}_\d{6}_V\d{2}$", key):
                result.append(key)
            if len(result) >= limit:
                return result
    return result


def download_kmob(key: str, directory: str | Path) -> Path:
    if not re.fullmatch(r"\d{4}/\d{2}/\d{2}/KMOB/KMOB\d{8}_\d{6}_V\d{2}(?:\.(?:gz|bz2))?", key):
        raise ValueError("Only validated KMOB Level-II archive keys accepted")
    dest_dir = Path(directory)
    dest_dir.mkdir(parents=True, exist_ok=True)
    out = dest_dir / Path(key).name
    boto3.client("s3", config=Config(signature_version=UNSIGNED), region_name="us-east-1").download_file(BUCKET, key, str(out))
    return out
