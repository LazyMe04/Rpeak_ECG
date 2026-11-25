"""Error structure of the current detector.

Answers three questions that determine whether the fix is local templates,
a better feature, or neither:
  1. Are false positives T waves? -> are they ~0.2-0.5 s after a true beat?
  2. Are missed beats clustered in time (a noisy stretch) or spread out?
  3. Does detection quality vary along the 70-minute segment?

Usage:
  python -I diag_errors.py [record ...]
"""
from __future__ import annotations

from pathlib import Path

import json
import sys
from collections import Counter

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from config import CATALOG  # noqa: E402
from detect import load  # noqa: E402
from detect4 import band, score_weighted  # noqa: E402
from detect5 import detect  # noqa: E402

FS = 250


def main() -> None:
    args = [a for a in sys.argv[1:] if not a.startswith("-")]
    index = json.loads((CATALOG / "f32" / "index.json").read_text())
    recs = args or [s["record"] for s in index]

    for rec in recs:
        sig, ref, fs, _ = load(rec)
        peaks, _ = detect(sig, fs, 0.08, thresh=0.25)
        peaks = np.sort(peaks)

        # --- false positives -------------------------------------------------
        tol = int(0.05 * fs)
        matched = np.zeros(len(peaks), dtype=bool)
        j = 0
        for r in ref:
            lo = np.searchsorted(peaks, r - tol)
            hi = np.searchsorted(peaks, r + tol)
            for k in range(lo, hi):
                if not matched[k]:
                    matched[k] = True
                    break
        fps = peaks[~matched]

        # offset of each FP from the nearest preceding true beat
        offs = []
        for f in fps:
            k = np.searchsorted(ref, f)
            if k > 0:
                offs.append(int(f - ref[k - 1]))
        offs = np.array(offs) if offs else np.array([0])

        near_qrs = int(((offs > 0) & (offs < int(0.12 * fs))).sum())
        t_zone = int(((offs >= int(0.16 * fs)) & (offs <= int(0.45 * fs))).sum())
        other = len(offs) - near_qrs - t_zone

        # --- misses by 5-minute bin -----------------------------------------
        used = np.zeros(len(ref), dtype=bool)
        for p in peaks:
            k = np.searchsorted(ref, p)
            for jj in (k - 1, k, k + 1):
                if 0 <= jj < len(ref) and not used[jj] and abs(int(ref[jj]) - int(p)) <= tol:
                    used[jj] = True
                    break
        miss = ~used

        binsec = 300
        nb = int(len(sig) / (binsec * fs)) + 1
        bins_se = []
        for b in range(nb):
            lo, hi = b * binsec * fs, min(len(sig), (b + 1) * binsec * fs)
            m = (ref >= lo) & (ref < hi)
            if m.sum() > 5:
                bins_se.append((b * 5, int(m.sum()), 100 * (1 - miss[m].mean())))

        print(f"\n=== {rec} ===")
        print(f"  ref={len(ref)} det={len(peaks)} fp={len(fps)} "
              f"missed={int(miss.sum())}")
        print(f"  FP offsets: <120ms from a beat {near_qrs}, "
              f"160-450ms (T-wave zone) {t_zone}, elsewhere {other}")
        if len(fps):
            h, e = np.histogram(offs / fs, bins=[0, .04, .08, .12, .16, .2, .25,
                                                 .3, .35, .4, .5, .8, 5.0])
            print(f"  FP offset histogram (s): {h.tolist()}")
        bad = [b for b in bins_se if b[2] < 90]
        print(f"  5-min bins with Se<90: {len(bad)}/{len(bins_se)}")
        if bad:
            print(f"    worst: {sorted(bad, key=lambda x: x[2])[:6]}")


if __name__ == "__main__":
    main()
