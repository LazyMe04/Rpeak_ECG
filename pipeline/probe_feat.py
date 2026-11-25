"""Feature distributions of true vs false detections in the raw union.

union_raw already has Se 99.30 (median 99.84), so recall is solved. Everything
left is precision: which features separate the ~9% extra peaks from real QRS
complexes, without touching the beats we already find.

Candidate features, all computable from the signal alone:
  amp      |wide| at the peak, relative to its rolling 95th percentile
  slope    max |d wide/dt| in +-40 ms, relative to the same percentile
  corr     max similarity to the record's QRS template clusters
  dt_prev  seconds since the previous union peak
  amp_ratio  amp / amp of previous union peak

If a combination cleanly separates the classes, it can be applied as a rule
inside the app; if nothing separates them, the extra peaks are genuine
ambiguity and the right answer is to accept the PPV.

Usage:
  python -I probe_feat.py [record ...]
"""
from __future__ import annotations

from pathlib import Path

import json
import sys
import warnings

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from config import CATALOG  # noqa: E402
from detect import load  # noqa: E402
from detect4 import band  # noqa: E402
from probe_baseline import run_gqrs, run_twomax  # noqa: E402
from probe_fuse import merge, qrs_score, snap  # noqa: E402

warnings.filterwarnings("ignore")
FS = 250


def main() -> None:
    args = [a for a in sys.argv[1:] if not a.startswith("-")]
    index = json.loads((CATALOG / "f32" / "index.json").read_text())
    recs = args or [s["record"] for s in index]

    feats_t: dict[str, list] = {k: [] for k in
                                ("amp", "slope", "corr", "dt_prev", "amp_ratio")}
    feats_f: dict[str, list] = {k: [] for k in feats_t}

    for rec in recs:
        sig, ref, fs, _ = load(rec)
        wide = band(sig, 0.5, 40.0, fs)
        tol = int(0.05 * fs)
        pk_g = snap(run_gqrs(sig), wide, fs)
        pk_m = snap(run_twomax(sig, fs), wide, fs)
        cand = merge([pk_g, pk_m], tol)
        if len(cand) < 10:
            continue

        corr, _ = qrs_score(wide, cand)
        aw = np.abs(wide)
        g = np.abs(np.gradient(wide))
        hs = int(0.04 * fs)
        half_amp = int(0.06 * fs)

        amp = np.array([aw[max(0, c - half_amp): c + half_amp + 1].max()
                        for c in cand])
        slope = np.array([g[max(0, c - hs): c + hs + 1].max() for c in cand])
        amp_n = amp / (np.percentile(amp, 95) + 1e-12)
        slope_n = slope / (np.percentile(slope, 95) + 1e-12)
        dt = np.diff(cand, prepend=cand[0] - int(1.0 * fs)) / fs
        amp_ratio = np.ones(len(cand))
        amp_ratio[1:] = amp_n[1:] / np.maximum(amp_n[:-1], 1e-9)

        it = np.zeros(len(cand), dtype=bool)
        j = 0
        for k, c in enumerate(cand):
            while j < len(ref) and ref[j] < c - tol:
                j += 1
            if j < len(ref) and ref[j] <= c + tol:
                it[k] = True

        for name, arr in (("amp", amp_n), ("slope", slope_n), ("corr", corr),
                          ("dt_prev", dt), ("amp_ratio", amp_ratio)):
            feats_t[name].extend(arr[it].tolist())
            feats_f[name].extend(arr[~it].tolist())
        print(f"   {rec}: tp={it.sum()} fp={(~it).sum()}", file=sys.stderr)

    print(f"\n{'feature':10} {'class':>5} {'p5':>7} {'p25':>7} {'p50':>7} "
          f"{'p75':>7} {'p95':>7} {'p99':>7}")
    for name in feats_t:
        for cls, arr in (("TRUE", feats_t[name]), ("FALSE", feats_f[name])):
            a = np.array(arr)
            if len(a) == 0:
                continue
            print(f"{name:10} {cls:>5} {np.percentile(a,5):7.3f} "
                  f"{np.percentile(a,25):7.3f} {np.median(a):7.3f} "
                  f"{np.percentile(a,75):7.3f} {np.percentile(a,95):7.3f} "
                  f"{np.percentile(a,99):7.3f}")

    # How much precision could a perfect single-feature rule buy?
    print("\nsingle-feature separation (FP fraction below each cut, "
          "TP fraction preserved):")
    for name in ("amp", "slope", "corr", "amp_ratio"):
        t = np.array(feats_t[name])
        f = np.array(feats_f[name])
        for cut in (0.3, 0.4, 0.5, 0.6, 0.7):
            tp = 100 * np.mean(t >= cut)
            fp_removed = 100 * np.mean(f < cut)
            print(f"  {name:9} >= {cut:.1f}: TP kept {tp:6.2f}%  "
                  f"FP removed {fp_removed:6.2f}%")
        print()


if __name__ == "__main__":
    main()
