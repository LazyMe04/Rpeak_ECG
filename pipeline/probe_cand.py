"""Where is the recall ceiling? Candidate-generation recall vs k_env and snap.

The detector can never recall a beat that is not in the candidate set, so the
candidate ceiling bounds everything downstream. check_snap.py showed that
ceiling is only 86-95% on several records. This probes the two knobs that
produce it, independently of the correlation stage.

  k_env  : envelope peak threshold, as a fraction of the rolling 99th percentile
  snap   : half-width in samples searched for the wideband maximum

Usage:
  python -I probe_cand.py [record ...]
"""
from __future__ import annotations

import json
import sys

import numpy as np
from scipy import signal as sps
from scipy.ndimage import percentile_filter

sys.path.insert(0, "D:/Rpeak-Desktop/pipeline")
from config import CATALOG  # noqa: E402
from detect import load  # noqa: E402
from detect4 import band, envelope  # noqa: E402

FS = 250


def recall_of(cand, ref, fs) -> float:
    tol = int(0.05 * fs)
    c = np.sort(cand)
    hit, j = 0, 0
    for r in ref:
        while j < len(c) and c[j] < r - tol:
            j += 1
        if j < len(c) and c[j] <= r + tol:
            hit += 1
            j += 1
    return 100 * hit / max(len(ref), 1)


def main() -> None:
    args = [a for a in sys.argv[1:] if not a.startswith("-")]
    index = json.loads((CATALOG / "f32" / "index.json").read_text())
    recs = args or ["p00000_s00", "p00006_s00", "p00004_s01", "p00010_s00",
                    "p00010_s01", "p00002_s01"]

    data = {}
    for r in recs:
        sig, ref, fs, _ = load(r)
        wide = band(sig, 0.5, 40.0, fs)
        narrow = band(sig, 10, 25, fs)
        integ, win = envelope(narrow, fs)
        data[r] = (ref, fs, wide, integ, (win - 1) // 2)
        print(f"loaded {r}", file=sys.stderr)

    print(f"{'k_env':>6} {'snap':>5} {'refr':>5} | " +
          " ".join(f"{r:>12}" for r in recs) + f" {'mean':>7} {'ncand':>8}")
    for k_env in (0.08, 0.05, 0.035, 0.025, 0.015):
        for half_ms in (70, 40, 25):
            for refr_ms in (300, 200):
                row, tot_cand = [], 0
                for r in recs:
                    ref, fs, wide, integ, delay = data[r]
                    n = int(10.0 * fs) | 1
                    scale = percentile_filter(integ, percentile=99, size=n,
                                              mode="nearest")
                    cand, _ = sps.find_peaks(
                        integ, height=k_env * scale,
                        distance=int(refr_ms / 1000 * fs))
                    cand = np.maximum(0, cand - delay)
                    half = int(half_ms / 1000 * fs)
                    snapped = []
                    for c in cand:
                        lo = max(0, c - half)
                        hi = min(len(wide) - 1, c + half)
                        snapped.append(lo + int(np.argmax(np.abs(wide[lo:hi + 1]))))
                    snapped = np.unique(np.array(snapped, dtype=int))
                    tot_cand += len(snapped)
                    row.append(recall_of(snapped, ref, fs))
                print(f"{k_env:6.3f} {half_ms:5d} {refr_ms:5d} | " +
                      " ".join(f"{v:12.2f}" for v in row) +
                      f" {np.mean(row):7.2f} {tot_cand:8d}")


if __name__ == "__main__":
    main()
