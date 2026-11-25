"""Signed offset between detections and reference annotations.

If detections are consistently late or early by a fixed amount, the failures are
a fiducial-point convention mismatch, not missed beats. That is fixed once, at
refinement time, instead of by loosening tolerance in the scorer.

Usage:
  python -I probe_offset.py [record ...]
"""
from __future__ import annotations

import json
import sys

import numpy as np

sys.path.insert(0, "D:/Rpeak-Desktop/pipeline")
from config import CATALOG  # noqa: E402
from detect import load  # noqa: E402
from detect4 import band, score_weighted  # noqa: E402
from detect5 import detect  # noqa: E402

FS = 250


def offsets(sig, ref, peaks, fs):
    """Signed offset (samples) from each reference beat to the nearest
    detection within 250 ms."""
    out = []
    for r in ref:
        lo = np.searchsorted(peaks, r - int(0.25 * fs))
        hi = np.searchsorted(peaks, r + int(0.25 * fs))
        if hi > lo:
            seg = peaks[lo:hi]
            k = int(np.argmin(np.abs(seg - r)))
            out.append(int(seg[k] - r))
    return np.array(out)


def main() -> None:
    args = [a for a in sys.argv[1:] if not a.startswith("-")]
    index = json.loads((CATALOG / "f32" / "index.json").read_text())
    recs = args or [s["record"] for s in index]

    print(f"{'record':14} {'n':>6} {'med':>6} {'mean':>7} {'p5':>6} {'p95':>6} "
          f"{'|off|>50ms':>11} {'Se@50':>7} {'Se@150':>7}")
    for rec in recs:
        sig, ref, fs, _ = load(rec)
        peaks, _ = detect(sig, fs, 0.08, thresh=0.25)
        peaks = np.sort(peaks)
        o = offsets(sig, ref, peaks, fs)
        if len(o) == 0:
            continue
        ms = o / fs * 1000
        tol50 = int(0.05 * fs)
        tol150 = int(0.15 * fs)

        def se_at(tol):
            used = np.zeros(len(ref), dtype=bool)
            hit = 0
            for p in peaks:
                k = np.searchsorted(ref, p)
                for j in (k - 1, k, k + 1):
                    if 0 <= j < len(ref) and not used[j] and abs(int(ref[j]) - int(p)) <= tol:
                        used[j] = True
                        hit += 1
                        break
            return 100 * hit / len(ref)

        print(f"{rec:14} {len(o):6d} {np.median(ms):6.1f} {ms.mean():7.1f} "
              f"{np.percentile(ms,5):6.1f} {np.percentile(ms,95):6.1f} "
              f"{100*np.mean(np.abs(ms)>50):10.1f}% {se_at(tol50):7.2f} "
              f"{se_at(tol150):7.2f}")


if __name__ == "__main__":
    main()
