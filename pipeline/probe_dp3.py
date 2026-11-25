"""DP with a hard T-wave constraint instead of a smooth RR penalty.

probe_rhythm.py explains why the RR penalty cannot be tuned to satisfy every
record: the failing segments are the irregular ones (p00006_s01 rrCV 0.40,
p00010_s00 irregular fraction 0.28, p00004_s01 0.18). A penalty that compares
each interval with a local reference punishes genuine ectopy -- and on an
irregular rhythm there is no reference to compare with.

The T wave, however, is a *mechanism*, not a statistic: it follows the QRS at a
fixed 160-450 ms lag and is always flatter than the QRS that precedes it. That
relationship holds at any heart rate and any degree of irregularity, so it can
be imposed as a hard constraint on which transitions the DP may take:

  forbid the transition j -> i  when  (cand[i] - cand[j]) in [160, 450] ms
                                    and slope(i) < slope_frac * slope(j)
  forbid taking i at all when it has no predecessor and lies in that window
  after a *stronger* candidate that the DP chose to skip

Long intervals keep only a weak cost, enough to discourage stacking two beats
where one is annotated, but far below what penalising ectopy would cost.

Usage:
  python -I probe_dp3.py [record ...]
  python -I probe_dp3.py --slope-frac 0.6 --long 0.5
"""
from __future__ import annotations

import json
import sys
import warnings

import numpy as np
from scipy.ndimage import median_filter

sys.path.insert(0, "D:/Rpeak-Desktop/pipeline")
from config import CATALOG  # noqa: E402
from detect import load  # noqa: E402
from detect4 import band, score_weighted  # noqa: E402
from probe_baseline import run_gqrs, run_twomax  # noqa: E402
from probe_dp import features  # noqa: E402
from probe_fuse import merge, snap  # noqa: E402

warnings.filterwarnings("ignore")
FS = 250


def select(cand, gain, slope_z, fs, slope_frac=0.6, t_lo_s=0.16, t_hi_s=0.45,
           rr_min_s=0.25, rr_max_s=2.5, long_cost=0.5, ref_rr_s=0.8):
    n = len(cand)
    if n == 0:
        return np.array([], dtype=int)
    t_lo, t_hi = int(t_lo_s * fs), int(t_hi_s * fs)
    rr_min, rr_max = int(rr_min_s * fs), int(rr_max_s * fs)
    ref_rr = ref_rr_s * fs

    skip = np.zeros(n)
    take = np.full(n, -np.inf)
    back = np.full(n, -1, dtype=int)

    for i in range(n):
        skip[i] = max(skip[i - 1] if i > 0 else 0.0,
                      take[i - 1] if i > 0 else -np.inf)
        lo = int(np.searchsorted(cand, cand[i] - rr_max))
        hi = int(np.searchsorted(cand, cand[i] - rr_min))
        best = skip[lo - 1] if lo > 0 else 0.0
        best_j = -1
        for j in range(lo, hi):
            if not np.isfinite(take[j]):
                continue
            dt = int(cand[i] - cand[j])
            # Hard T-wave constraint: this pair cannot both be beats.
            if t_lo <= dt <= t_hi and slope_z[i] < slope_frac * slope_z[j]:
                continue
            v = take[j]
            if dt > ref_rr:
                # Only long intervals carry a cost: a missing beat shows up as
                # an unusually long gap, whereas a short one is already handled
                # by the constraint above and the refractory floor.
                v -= long_cost * np.log(dt / ref_rr)
            if v > best:
                best, best_j = v, j
        take[i] = gain[i] + best
        back[i] = best_j

    sel, i = [], n - 1
    st = bool(np.isfinite(take[i]) and take[i] >= skip[i])
    while i >= 0:
        if st:
            sel.append(int(cand[i]))
            j = back[i]
            if j >= 0:
                i = j
                continue
            i -= 1
        else:
            i -= 1
        if i < 0:
            break
        st = bool(np.isfinite(take[i]) and take[i] >= skip[i])
    return np.array(sorted(sel), dtype=int)


def ref_rr_from(cand, peaks, fs):
    if len(peaks) < 20:
        return 0.8
    rr = np.diff(peaks) / fs
    rr = rr[(rr > 0.25) & (rr < 2.5)]
    if len(rr) < 10:
        return 0.8
    return float(np.median(rr))


def run(rec, w_amp=0.5, w_corr=1.0, w_slope=1.5, slope_frac=0.6,
        long_cost=0.5, t_lo=0.16, t_hi=0.45):
    sig, ref, fs, _ = load(rec)
    wide = band(sig, 0.5, 40.0, fs)
    tol = int(0.05 * fs)
    cand = merge([snap(run_gqrs(sig), wide, fs),
                  snap(run_twomax(sig, fs), wide, fs)], tol)
    if len(cand) < 10:
        return cand, ref, fs

    corr, amp_z, slope_z = features(wide, cand, fs)
    gain = w_amp * amp_z + w_corr * corr + w_slope * slope_z

    # 1st pass without the long-interval cost, purely to learn the rate.
    first = select(cand, gain, slope_z, fs, slope_frac, t_lo, t_hi,
                   long_cost=0.0, ref_rr_s=0.8)
    ref_rr = ref_rr_from(cand, first, fs)
    out = select(cand, gain, slope_z, fs, slope_frac, t_lo, t_hi,
                 long_cost=long_cost, ref_rr_s=ref_rr)
    return out, ref, fs


def main() -> None:
    kw = dict(w_amp=0.5, w_corr=1.0, w_slope=1.5, slope_frac=0.6,
              long_cost=0.5)
    mapping = {"--w-amp": "w_amp", "--w-corr": "w_corr", "--w-slope": "w_slope",
               "--slope-frac": "slope_frac", "--long": "long_cost",
               "--t-lo": "t_lo", "--t-hi": "t_hi"}
    a = sys.argv[1:]
    for flag, key in mapping.items():
        if flag in a:
            i = a.index(flag)
            kw[key] = float(a[i + 1])
            a = a[:i] + a[i + 2:]
    args = [x for x in a if not x.startswith("-")]
    index = json.loads((CATALOG / "f32" / "index.json").read_text())
    recs = args or [s["record"] for s in index]

    print(f"DP3 {kw}")
    print(f"{'record':14} {'ref':>6} {'det':>6} {'Se':>7} {'PPV':>7} {'F1':>7}")
    ses, ppvs, tot = [], [], {"tp": 0, "fp": 0, "fn": 0}
    for rec in recs:
        out, ref, fs = run(rec, **kw)
        sc = score_weighted(ref, out, fs)
        ses.append(sc["se"])
        ppvs.append(sc["ppv"])
        for m in tot:
            tot[m] += sc[m]
        print(f"{rec:14} {len(ref):6d} {len(out):6d} {sc['se']:7.2f} "
              f"{sc['ppv']:7.2f} {sc['f1']:7.2f}")
        print(f"   done {rec}", file=sys.stderr)

    se = 100 * tot["tp"] / max(tot["tp"] + tot["fn"], 1)
    ppv = 100 * tot["tp"] / max(tot["tp"] + tot["fp"], 1)
    print(f"\nOVERALL Se={se:.2f} PPV={ppv:.2f} "
          f"F1={2*se*ppv/max(se+ppv,1e-9):.2f}")
    print(f"median Se={np.median(ses):.2f} minSe={min(ses):.2f} "
          f"median PPV={np.median(ppvs):.2f} minPPV={min(ppvs):.2f}")
    print(f"segments<95 Se: {sum(1 for s in ses if s < 95)}/{len(ses)}  "
          f"<95 PPV: {sum(1 for p in ppvs if p < 95)}/{len(ppvs)}")


if __name__ == "__main__":
    main()
