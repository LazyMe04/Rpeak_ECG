"""Sweep template length: the correlation is bimodal because the template is too
short to lock onto the whole QRS complex."""
from __future__ import annotations

from pathlib import Path

import sys

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from detect import load  # noqa: E402
from detect4 import band, envelope, pearson_window  # noqa: E402
from detect5 import build_template_from, select_beats  # noqa: E402
from scipy import signal as sps
from scipy.ndimage import percentile_filter


def run(rec: str, half_ms: float, thresh: float) -> tuple:
    sig, ref, fs, _ = load(rec)
    wide = band(sig, 0.5, 40.0, fs)
    narrow = band(sig, 10, 25, fs)
    integ, win = envelope(narrow, fs)
    delay = (win - 1) // 2
    n = int(10.0 * fs) | 1
    scale = percentile_filter(integ, percentile=99, size=n, mode="nearest")
    cand, _ = sps.find_peaks(integ, height=0.08 * scale, distance=int(0.3 * fs))
    cand = np.maximum(0, cand - delay)

    half = int(0.07 * fs)
    snapped = []
    for c in cand:
        lo, hi = max(0, c - half), min(len(wide) - 1, c + half)
        snapped.append(lo + int(np.argmax(np.abs(wide[lo:hi + 1]))))
    cand = np.unique(np.array(snapped, dtype=int))

    tmpl = build_template_from(wide, cand, fs, half_ms=half_ms)
    if tmpl is None:
        return 0, 0
    scores = np.abs(pearson_window(wide, tmpl, cand))
    out = select_beats(cand, scores, fs, thresh=thresh)

    tol = int(0.05 * fs)
    used = np.zeros(len(ref), dtype=bool)
    tp = 0
    for d in out:
        k = int(np.searchsorted(ref, d))
        for j in (k - 1, k, k + 1):
            if 0 <= j < len(ref) and not used[j] and abs(int(ref[j]) - d) <= tol:
                used[j] = True
                tp += 1
                break
    se = 100 * tp / max(len(ref), 1)
    ppv = 100 * tp / max(len(out), 1)
    return se, ppv


def main() -> None:
    recs = sys.argv[1:] or ["p00000_s00", "p00004_s01", "p00010_s01", "p00006_s00"]
    for half in (90, 140, 200):
        for th in (0.25, 0.45):
            print(f"\n=== half_ms={half} thresh={th} ===")
            for rec in recs:
                se, ppv = run(rec, half, th)
                print(f"  {rec:14} Se={se:6.2f}  PPV={ppv:6.2f}")


if __name__ == "__main__":
    main()
