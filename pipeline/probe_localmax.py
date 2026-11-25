"""Absolute candidate ceiling: is there ANY local extremum near each beat?

If a reference beat has no local maximum of |wide| within +-50 ms, no
peak-picking generator can ever find it, and the ceiling is set by the
annotation convention rather than the algorithm. That distinction decides
whether to keep tuning the detector or to change how a detection is placed.

Usage:
  python -I probe_localmax.py [record ...]
"""
from __future__ import annotations

import sys

import numpy as np
from scipy import signal as sps

sys.path.insert(0, "D:/Rpeak-Desktop/pipeline")
from detect import load  # noqa: E402
from detect4 import band  # noqa: E402


def main() -> None:
    args = [a for a in sys.argv[1:] if not a.startswith("-")]
    recs = args or ["p00000_s00", "p00006_s00", "p00004_s01", "p00010_s00",
                    "p00010_s01", "p00002_s01"]

    print(f"{'record':14} {'ref':>6} | local max of |wide| within tol")
    for tol_ms in (50, 80, 120, 200, 250):
        pass

    for rec in recs:
        sig, ref, fs, _ = load(rec)
        wide = band(sig, 0.5, 40.0, fs)
        aw = np.abs(wide)
        lm, _ = sps.find_peaks(aw)
        row = []
        for tol_ms in (50, 80, 120, 200, 250):
            tol = int(tol_ms / 1000 * fs)
            hit = 0
            for r in ref:
                lo = np.searchsorted(lm, r - tol)
                hi = np.searchsorted(lm, r + tol)
                if hi > lo:
                    hit += 1
            row.append(100 * hit / len(ref))
        print(f"{rec:14} {len(ref):6d} | " +
              "  ".join(f"{t}ms={v:6.2f}" for t, v in
                        zip((50, 80, 120, 200, 250), row)))

    # Distribution of the distance from a beat to the closest local maximum.
    print("\ndistance from beat to nearest local max of |wide| (ms):")
    for rec in recs:
        sig, ref, fs, _ = load(rec)
        wide = band(sig, 0.5, 40.0, fs)
        lm, _ = sps.find_peaks(np.abs(wide))
        d = []
        for r in ref:
            k = np.searchsorted(lm, r)
            cands = [lm[j] for j in (k - 1, k) if 0 <= j < len(lm)]
            if cands:
                d.append(min(abs(int(c) - int(r)) for c in cands))
        d = np.array(d) / fs * 1000
        print(f"  {rec:14} n={len(d)} p50={np.median(d):5.1f} "
              f"p90={np.percentile(d,90):5.1f} p99={np.percentile(d,99):5.1f} "
              f"max={d.max():6.1f}")


if __name__ == "__main__":
    main()
