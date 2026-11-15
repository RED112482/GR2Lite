import argparse
import json
from pathlib import Path
from .decoder import decode_archive
from .aws_archive import list_kmob_volumes, download_kmob


def main():
    parser = argparse.ArgumentParser(description="GR2Lite Milestone 1 archive utilities")
    sub = parser.add_subparsers(dest="cmd", required=True)
    find = sub.add_parser("list-kmob")
    find.add_argument("date")
    find.add_argument("--limit", type=int, default=20)
    download = sub.add_parser("download-kmob")
    download.add_argument("key")
    download.add_argument("--out", default="./data")
    decode = sub.add_parser("decode")
    decode.add_argument("path")
    decode.add_argument("--radar", default="KMOB")
    decode.add_argument("--json", help="Optional path to save metadata JSON")
    args = parser.parse_args()
    if args.cmd == "list-kmob":
        print("\n".join(list_kmob_volumes(args.date, args.limit)))
    elif args.cmd == "download-kmob":
        print(download_kmob(args.key, args.out))
    elif args.cmd == "decode":
        result = decode_archive(args.path, args.radar)
        payload = result.descriptor.model_dump_json(indent=2)
        if args.json:
            Path(args.json).write_text(payload)
        print(json.dumps({"radar": result.descriptor.radar_id,
                          "sweeps": len(result.descriptor.sweeps),
                          "moments": sorted({m.value for s in result.descriptor.sweeps for m in s.moments}),
                          "volume_id": result.descriptor.volume_id}, indent=2))

if __name__ == "__main__":
    main()
