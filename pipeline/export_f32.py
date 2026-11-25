"""Export physical float32 copies for fast evaluation in TypeScript.

The app itself reads the raw int16 `.dat` at runtime (via the replay source),
but the offline evaluator needs pre-scaled mV floats it can load without a
WFDB dependency. Output is 4 bytes/sample: 24 segments -> ~100 MB.

Usage: python -I export_f32.py [--limit N]
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
import wfdb

sys.path.insert(0, str(Path(__file__).resolve().parent))
from config import CATALOG, RAW  # noqa: E402

OUT = CATALOG / "f32"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--skip-existing", action="store_true",
                    help="leave .f32 files already on disk untouched; only export new ones")
    args = ap.parse_args()

    OUT.mkdir(parents=True, exist_ok=True)
    stems = sorted(RAW.rglob("*.hea"))
    if args.limit:
        stems = stems[: args.limit]

    # The index is rebuilt from every .f32 present, not just the ones converted
    # in this run: G5 adds records in batches, and an index covering only the
    # latest batch would make the app forget the earlier ones.
    index = []
    total = 0
    done = 0
    for i, h in enumerate(stems, 1):
        stem = h.with_suffix("")
        dest = OUT / f"{stem.name}.f32"
        if dest.exists() and args.skip_existing:
            sig = np.fromfile(dest, dtype=np.float32, count=3)  # cheap existence probe
            index.append({"record": stem.name, "file": dest.name,
                          "n": dest.stat().st_size // 4,
                          "exported_now": False})
            total += dest.stat().st_size
            continue
        rec = wfdb.rdrecord(str(stem))
        sig = rec.p_signal[:, 0].astype(np.float32)
        sig.tofile(dest)
        total += dest.stat().st_size
        done += 1
        index.append({
            "record": stem.name,
            "fs": rec.fs,
            "n": int(len(sig)),
            "file": dest.name,
            "mean": float(sig.mean()),
            "std": float(sig.std()),
            "exported_now": True,
        })
        print(f"[{i:3}/{len(stems)}] {stem.name}  {len(sig)} samples  "
              f"{dest.stat().st_size/1e6:.1f} MB")

    (OUT / "index.json").write_text(json.dumps(index, indent=1), encoding="utf-8")
    print(f"\n{len(index)} records indexed ({done} exported this run), "
          f"total {total/1e6:.1f} MB  -> {OUT}")


if __name__ == "__main__":
    main()
