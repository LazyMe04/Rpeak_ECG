"""Measure discriminative features between true QRS complexes and T waves.

The detector confuses tall broad T waves with QRS complexes because both carry
energy in the 5-15 Hz band. This script quantifies which measurable feature
separates them, so the fix is chosen from evidence rather than intuition.

Compared at each true annotation (QRS) and at 40% of the way to the next beat
(where the T wave sits in this dataset).

Usage: python -I feature_probe.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
from scipy import signal as sps
from scipy.ndimage import maximum_filter1d

sys.path.insert(0, str(Path(__file__).resolve().parent))
from config import CATALOG  # noqa: E402
from detect import load  # noqa: E402

FS = 250
HALF = int(0.06 * FS)  # +/-60 ms window around a candidate


def features(sig: np.ndarray, idx: np.ndarray) -> dict:
    """Per-candidate feature vectors."""
    bands = {}
    for name, lo, hi in (("b5_15", 5, 15), ("b10_25", 10, 25), ("b15_35", 15, 35),
                         ("b2_8", 2, 8)):
        sos = sps.butter(2, [lo, hi], btype="band", fs=FS, output="sos")
        bands[name] = np.abs(sps.sosfilt(sos, sig))

    slope = np.abs(np.diff(sig, prepend=sig[0]))
    # slope smoothed slightly to be robust to single-sample spikes
    slope = maximum_filter1d(slope, size=3)

    out = {"amp": [], "slope": [], "width": [], "ratio": [], "ratio2": []}
    n = len(sig)
    for i in idx:
        lo, hi = max(0, i - HALF), min(n, i + HALF)
        if hi - lo < 10:
            continue
        seg_slope = slope[lo:hi]
        out["slope"].append(float(seg_slope.max()))
        out["amp"].append(float(np.ptp(sig[lo:hi])))
        out["ratio"].append(float(bands["b15_35"][lo:hi].max() /
                                  (bands["b2_8"][lo:hi].max() + 1e-12)))
        out["ratio2"].append(float(bands["b10_25"][lo:hi].max() /
                                   (bands["b5_15"][lo:hi].max() + 1e-12)))
        # width at half max of |d/dt| -> narrow for QRS
        pk = float(seg_slope.max())
        if pk > 0:
            above = seg_slope >= 0.5 * pk
            out["width"].append(float(above.sum()) / FS * 1000)
        else:
            out["width"].append(0.0)
    return {k: np.array(v) for k, v in out.items()}


def summarize(name: str, f: dict) -> None:
    print(f"  {name:10} n={len(f['slope'])}  "
          f"slope[max]={np.median(f['slope']):.3f}  "
          f"amp={np.median(f['amp']):.3f}  "
          f"hf/lf={np.median(f['ratio']):.3f}  "
          f"b10_25/b5_15={np.median(f['ratio2']):.3f}  "
          f"width={np.median(f['width']):5.1f} ms")


def main() -> None:
    index = json.loads((CATALOG / "f32" / "index.json").read_text())
    for entry in index[:6]:
        rec = entry["record"]
        sig, ref, fs, _ = load(rec)
        if len(ref) < 50:
            continue
        rr = np.diff(ref)
        # T wave proxy: 40% of the way to the next beat, only for ordinary beats
        ok = np.where((rr > 0.4 * FS) & (rr < 1.5 * FS))[0]
        tw = (ref[ok] + 0.40 * rr[ok]).astype(int)
        tw = tw[(tw > HALF) & (tw < len(sig) - HALF)]

        q = features(sig, ref)
        t = features(sig, tw)
        print(f"\n{rec}  (n_beats={len(ref)})")
        summarize("QRS", q)
        summarize("T-wave", t)

        # How separable is each feature? report ratio of medians
        print(f"  separability (QRS/T): slope={np.median(q['slope'])/max(np.median(t['slope']),1e-9):.2f}x "
              f"hf/lf={np.median(q['ratio'])/max(np.median(t['ratio']),1e-9):.2f}x "
              f"width={np.median(t['width'])/max(np.median(q['width']),1e-9):.2f}x")


if __name__ == "__main__":
    main()
