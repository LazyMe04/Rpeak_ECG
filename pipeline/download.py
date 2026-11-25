"""G1 downloader: fetch icentia11k segments from the public PhysioNet S3 mirror.

Design rules:
  * everything lands under D:\\Rpeak-Desktop\\data\\raw
  * idempotent (skips files already present with correct size)
  * hard disk guard: aborts before the volume drops below MIN_FREE_GB
  * no aws cli dependency (plain HTTPS GET)

Usage:
  python -I download.py --patients 12 --segments 2
  python -I download.py --patients 20 --segments 50 --start 0
"""
from __future__ import annotations

import argparse
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from config import MIN_FREE_GB, RAW, S3_BASE, free_gb  # noqa: E402

SIZES = {"hea": None, "dat": 2_097_154, "atr": None}


def patient_dir(pid: int) -> str:
    return f"p{pid // 10000:02d}/p{pid:05d}"


def fetch(url: str, dest: Path, expect: int | None) -> bool:
    if dest.exists():
        return False
    tmp = dest.with_suffix(dest.suffix + ".part")
    for attempt in range(3):
        try:
            with urllib.request.urlopen(url, timeout=60) as r, open(tmp, "wb") as f:
                header_len = r.headers.get("Content-Length")
                while chunk := r.read(1 << 20):
                    f.write(chunk)
            got = tmp.stat().st_size
            if expect is not None and got != expect:
                raise IOError(f"size mismatch {got} != {expect}")
            if header_len is not None and got != int(header_len):
                raise IOError(f"truncated: {got} != {header_len}")
            tmp.replace(dest)
            return True
        except (urllib.error.URLError, TimeoutError, IOError) as e:
            tmp.unlink(missing_ok=True)
            if attempt == 2:
                raise
            time.sleep(2 * (attempt + 1))
    return False


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--patients", type=int, default=12, help="how many patient ids")
    ap.add_argument("--segments", type=int, default=2, help="segments per patient")
    ap.add_argument("--start", type=int, default=0, help="first patient index")
    ap.add_argument("--stride", type=int, default=1, help="step between patient ids")
    args = ap.parse_args()

    t0 = time.time()
    total_bytes = 0
    downloaded = 0
    skipped = 0

    for i in range(args.patients):
        pid = args.start + i * args.stride
        rel = patient_dir(pid)
        for s in range(args.segments):
            stem = f"p{pid:05d}_s{s:02d}"
            out = RAW / rel
            out.mkdir(parents=True, exist_ok=True)

            if free_gb() < MIN_FREE_GB + 3:
                print(f"ABORT: only {free_gb():.1f} GB free", file=sys.stderr)
                return

            for ext in ("hea", "dat", "atr"):
                url = f"{S3_BASE}/{rel}/{stem}.{ext}"
                dest = out / f"{stem}.{ext}"
                before = dest.stat().st_size if dest.exists() else 0
                got = fetch(url, dest, SIZES[ext])
                if got:
                    total_bytes += dest.stat().st_size - before
                    downloaded += 1
                else:
                    skipped += 1
        print(f"  p{pid:05d}  free={free_gb():.1f}GB  elapsed={time.time()-t0:.0f}s")

    dt = time.time() - t0
    print(f"\ndownloaded {downloaded} files, {total_bytes/1e6:.1f} MB "
          f"in {dt:.0f}s ({total_bytes/1e6/max(dt,1):.2f} MB/s), skipped {skipped}")
    print(f"free space left: {free_gb():.1f} GB")


if __name__ == "__main__":
    main()
