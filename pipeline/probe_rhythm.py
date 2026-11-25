"""Rhythm character of each record, from the annotations.

The DP's RR term assumes intervals cluster around a local reference. If a record
is atrial fibrillation -- or has frequent ectopy -- intervals do not cluster, and
the penalty actively removes real beats. This measures that assumption directly
so the DP is not blamed for a rhythm it was never designed for.

Metrics
  rr_cv      coefficient of variation of RR (AFib typically > 0.20)
  pnn50      fraction of successive RR differing by > 50 ms
  irregular  fraction of intervals more than 30% from their local median
  frac_rr_lt_0.55med  how often a real interval is short relative to local
                      rhythm -- this is the T-wave ambiguity rate, i.e. how
                      often a genuine beat is as close as a T wave would be

Usage:
  python -I probe_rhythm.py
"""
from __future__ import annotations

from pathlib import Path

import json
import sys

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from config import CATALOG  # noqa: E402
from detect import load  # noqa: E402


def local_median(rr, k=15):
    out = np.copy(rr)
    n = len(rr)
    for i in range(n):
        lo, hi = max(0, i - k), min(n, i + k + 1)
        out[i] = np.median(rr[lo:hi])
    return out


def main() -> None:
    index = json.loads((CATALOG / "f32" / "index.json").read_text())
    print(f"{'record':14} {'n':>6} {'HR':>5} {'rrCV':>6} {'pnn50':>6} "
          f"{'irreg':>6} {'short<.55':>9} {'q05':>6} {'q95':>6}")
    for s in index:
        rec = s["record"]
        _, ref, fs, _ = load(rec)
        rr = np.diff(ref) / fs
        if len(rr) < 20:
            continue
        lm = local_median(rr)
        cv = float(np.std(rr) / np.mean(rr))
        pnn50 = float(np.mean(np.abs(np.diff(rr)) > 0.05))
        irreg = float(np.mean(np.abs(rr - lm) / lm > 0.30))
        short = float(np.mean(rr < 0.55 * lm))
        print(f"{rec:14} {len(ref):6d} {60/np.median(rr):5.1f} {cv:6.3f} "
              f"{pnn50:6.3f} {irreg:6.3f} {short:9.3f} "
              f"{np.percentile(rr,5):6.3f} {np.percentile(rr,95):6.3f}")


if __name__ == "__main__":
    main()
