"""Check whether candidate snapping loses beats, and why."""
from __future__ import annotations

from pathlib import Path

import sys

import numpy as np
from scipy import signal as sps
from scipy.ndimage import percentile_filter

sys.path.insert(0, str(Path(__file__).resolve().parent))
from detect import load  # noqa: E402
from detect4 import band, envelope  # noqa: E402


def main() -> None:
    rec = sys.argv[1] if len(sys.argv) > 1 else "p00000_s00"
    sig, ref, fs, _ = load(rec)
    wide = band(sig, 0.5, 40.0, fs)
    narrow = band(sig, 10, 25, fs)
    integ, win = envelope(narrow, fs)
    delay = (win - 1) // 2

    n = int(10.0 * fs) | 1
    scale = percentile_filter(integ, percentile=99, size=n, mode="nearest")
    thr = 0.08 * scale
    raw_cand, _ = sps.find_peaks(integ, height=thr, distance=int(0.3 * fs))
    shifted = np.maximum(0, raw_cand - delay)

    tol = int(0.05 * fs)

    def recall(cands):
        hit = 0
        j = 0
        c = np.sort(cands)
        for r in ref:
            while j < len(c) and c[j] < r - tol:
                j += 1
            if j < len(c) and c[j] <= r + tol:
                hit += 1
        return 100 * hit / len(ref)

    print(f"{rec}: ref={len(ref)}")
    print(f"  raw envelope peaks      : {len(raw_cand):6d}  recall={recall(raw_cand):.2f}%")
    print(f"  after delay compensation: {len(shifted):6d}  recall={recall(shifted):.2f}%")

    half = int(0.07 * fs)
    snapped = []
    for c in shifted:
        lo, hi = max(0, c - half), min(len(wide) - 1, c + half)
        snapped.append(lo + int(np.argmax(np.abs(wide[lo:hi + 1]))))
    snapped = np.unique(np.array(snapped))
    print(f"  after wideband snap     : {len(snapped):6d}  recall={recall(snapped):.2f}%")

    # where do misses come from?
    tol2 = int(0.05 * fs)
    missed = []
    j = 0
    for r in ref:
        while j < len(snapped) and snapped[j] < r - tol2:
            j += 1
        if not (j < len(snapped) and snapped[j] <= r + tol2):
            missed.append(r)
    print(f"  missed beats            : {len(missed)}")
    if missed:
        idx = np.array(missed[:5])
        print(f"  sample missed positions : {idx[:5].tolist()}")
        for i in idx[:3]:
            lo, hi = max(0, i - half), min(len(wide) - 1, i + half)
            print(f"    beat {i}: wide ptp={np.ptp(wide[lo:hi]):.3f} "
                  f"raw ptp={np.ptp(sig[lo:hi]):.3f}")


if __name__ == "__main__":
    main()
