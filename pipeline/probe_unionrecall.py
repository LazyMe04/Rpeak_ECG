"""Which candidate union keeps the recall without depending on gqrs?

The shipped detector unions gqrs with the classic two-moving-average detector
and reaches 99.3% candidate recall. gqrs is a substantial C algorithm (biquad
pre-filter, rough peak pass, then a rate-limited refinement) and porting it to
TypeScript faithfully is the riskiest part of bringing the detector into the
app.

This measures candidate recall for unions built only from generators that are
straightforward to port, so the port can drop gqrs if the cost is small. Recall
here is the pre-DP ceiling: the DP only ever removes candidates, never adds
them.

Usage:
  python -I probe_unionrecall.py
"""
from __future__ import annotations

from pathlib import Path

import json
import sys
import warnings

import numpy as np
from scipy import signal as sps
from scipy.ndimage import percentile_filter

sys.path.insert(0, str(Path(__file__).resolve().parent))
from config import CATALOG  # noqa: E402
from detect import load  # noqa: E402
from detect4 import band, envelope  # noqa: E402
from probe_baseline import run_gqrs, run_twomax  # noqa: E402
from probe_fuse import merge, snap  # noqa: E402
from probe_ktmpl import all_local_maxima  # noqa: E402

warnings.filterwarnings("ignore")
FS = 250


def recall_of(cand, ref, fs) -> float:
    if len(cand) == 0:
        return 0.0
    tol = int(0.05 * fs)
    c = np.sort(np.unique(cand))
    hit, j = 0, 0
    for r in ref:
        while j < len(c) and c[j] < r - tol:
            j += 1
        if j < len(c) and c[j] <= r + tol:
            hit += 1
            j += 1
    return 100 * hit / max(len(ref), 1)


def env_candidates(sig, fs, lo=10.0, hi=25.0, k=0.08):
    nb = band(sig, lo, hi, fs)
    integ, win = envelope(nb, fs)
    delay = (win - 1) // 2
    scale = percentile_filter(integ, percentile=99,
                              size=int(10.0 * fs) | 1, mode="nearest")
    pk, _ = sps.find_peaks(integ, height=k * scale, distance=int(0.2 * fs))
    return np.maximum(0, pk - delay)


def gradient_candidates(wide, fs, k=0.15):
    g = np.abs(np.gradient(wide))
    scale = percentile_filter(g, percentile=99,
                              size=int(10.0 * fs) | 1, mode="nearest")
    pk, _ = sps.find_peaks(g, height=k * scale, distance=int(0.2 * fs))
    return pk


def main() -> None:
    index = json.loads((CATALOG / "f32" / "index.json").read_text())

    combos = {
        "gqrs+2ma (reference)": ("g", "m"),
        "2ma+absMax": ("m", "x"),
        "2ma+env10-25": ("m", "e"),
        "2ma+gradient": ("m", "d"),
        "2ma+env+gradient": ("m", "e", "d"),
        "2ma+env+absMax": ("m", "e", "x"),
        "2ma+env+gradient+absMax": ("m", "e", "d", "x"),
    }
    totals = {k: [] for k in combos}

    print(f"{'record':14} " + " ".join(f"{k[:20]:>21}" for k in combos))
    for s in index:
        rec = s["record"]
        sig, ref, fs, _ = load(rec)
        wide = band(sig, 0.5, 40.0, fs)
        tol = int(0.05 * fs)
        src = {
            "g": snap(run_gqrs(sig), wide, fs),
            "m": snap(run_twomax(sig, fs), wide, fs),
            "x": snap(all_local_maxima(np.abs(wide), int(0.12 * fs)), wide, fs),
            "e": snap(env_candidates(sig, fs), wide, fs),
            "d": snap(gradient_candidates(wide, fs), wide, fs),
        }
        cells = []
        for name, keys in combos.items():
            c = merge([src[k] for k in keys], tol)
            r = recall_of(c, ref, fs)
            totals[name].append(r)
            cells.append(f"{r:10.2f}({len(c):7d})")
        print(f"{rec:14} " + " ".join(f"{c:>21}" for c in cells))
        print(f"   done {rec}", file=sys.stderr)

    print()
    for name in combos:
        v = totals[name]
        print(f"{name:30} mean={np.mean(v):6.2f} min={min(v):6.2f} "
              f"median={np.median(v):6.2f}")


if __name__ == "__main__":
    main()
