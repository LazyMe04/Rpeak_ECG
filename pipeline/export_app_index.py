"""Emit the compact segment index the app loads at startup.

The browser cannot open `catalog.sqlite`, and shipping all 24 columns would
carry annotation paths and WFDB bookkeeping the UI never reads. This flattens
the table into one small JSON array and merges in the per-segment detector
scores, so the picker can show both "what is in this segment" and "how well the
detector does on it" without a second request.

Output: data/catalog/segments.json  (~8 KB for 24 segments)

Usage: python -I export_app_index.py
"""
from __future__ import annotations

import json
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from config import CATALOG  # noqa: E402

OUT = CATALOG / "segments.json"


def main() -> None:
    db = sqlite3.connect(CATALOG / "catalog.sqlite")
    db.row_factory = sqlite3.Row
    rows = db.execute(
        "select record, patient, segment, fs, n_samples, duration_s, n_beats, "
        "n_N, n_S, n_V, n_Q, hr_mean, hr_min, hr_max, quality, ann_json, meta_json "
        "from segments order by patient, segment"
    ).fetchall()

    det_path = CATALOG / "detect_v4_result.json"
    det = {}
    if det_path.exists():
        det = {d["record"]: d for d in json.loads(det_path.read_text())}

    out = []
    for r in rows:
        d = det.get(r["record"])
        out.append({
            "record": r["record"],
            "patient": r["patient"],
            "segment": r["segment"],
            "fs": r["fs"],
            "nSamples": r["n_samples"],
            "durationS": round(r["duration_s"], 3),
            "nBeats": r["n_beats"],
            "counts": {
                "N": r["n_N"], "S": r["n_S"], "V": r["n_V"], "Q": r["n_Q"],
            },
            "hrMean": r["hr_mean"],
            "hrMin": r["hr_min"],
            "hrMax": r["hr_max"],
            "quality": r["quality"],
            # Paths are relative to data/, so the app can prefix them with its
            # own /data mount without knowing the absolute layout.
            "annPath": r["ann_json"],
            "detector": None if d is None else {
                "se": d["se"], "ppv": d["ppv"], "f1": d["f1"],
                "tp": d["tp"], "fp": d["fp"], "fn": d["fn"],
            },
        })

    OUT.write_text(json.dumps(out, indent=1), encoding="utf-8")
    print(f"wrote {OUT}  {OUT.stat().st_size} bytes  {len(out)} segments")


if __name__ == "__main__":
    main()
