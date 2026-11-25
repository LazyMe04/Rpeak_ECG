"""RR-constrained DP applied only to the high-recall union.

The union of gqrs and 2ma already contains 99.3% of annotated beats, so the
question is no longer "find beats" but "remove the ~9% extra bumps". Every
previous DP attempt failed because it ran over 100k raw local maxima, where a
wrong skip or take is very cheap. Over a union of ~5-7k candidates, each of
which is a real candidate event, the DP is a small, well-posed pruning problem.

Model: two states per candidate (take / skip), maximising

  sum over taken i of  [ w_amp * amp_z(i) + w_corr * corr(i) + w_slope * slope_z(i) ]
  minus rr_penalty * |log(rr(i) / ref_rr)|

The RR term is what rejects T waves: a T wave sits 0.2-0.45 s after its QRS,
which is a large log-distance from a 0.7 s reference, while a genuine ectopic
costs only a moderate amount and is kept. `ref_rr` is the record's median RR,
re-estimated from the first pass and applied in a second pass, so the model
adapts to the patient's rate without tracking instantaneous RR (which would
defeat the purpose by accepting whatever spacing the FPs produce).

Usage:
  python -I probe_dp.py [record ...]
  python -I probe_dp.py --w-amp 1 --w-corr 2 --w-slope 0.5 --rr 1.5
"""
from __future__ import annotations

import json
import sys
import warnings

import numpy as np

sys.path.insert(0, "D:/Rpeak-Desktop/pipeline")
from config import CATALOG  # noqa: E402
from detect import load  # noqa: E402
from detect4 import band, score_weighted  # noqa: E402
from probe_baseline import run_gqrs, run_twomax  # noqa: E402
from probe_fuse import merge, qrs_score, snap  # noqa: E402

warnings.filterwarnings("ignore")
FS = 250


def zscore(x, lo=2, hi=98):
    lo_v, hi_v = np.percentile(x, lo), np.percentile(x, hi)
    return np.clip((x - lo_v) / max(hi_v - lo_v, 1e-9), 0.0, 1.5)


def features(wide, cand, fs, kmeans_init="rng"):
    corr, _ = qrs_score(wide, cand, fs=fs, kmeans_init=kmeans_init)
    aw = np.abs(wide)
    g = np.abs(np.gradient(wide))
    hs, ha = int(0.04 * fs), int(0.06 * fs)
    amp = np.array([aw[max(0, c - ha): c + ha + 1].max() for c in cand])
    slope = np.array([g[max(0, c - hs): c + hs + 1].max() for c in cand])
    return corr, zscore(amp), zscore(slope)


def dp_select(cand, corr, amp_z, slope_z, fs, ref_rr_s, w_amp=1.0, w_corr=2.0,
              w_slope=0.5, rr_penalty=1.5, rr_min_s=0.25, rr_max_s=2.5,
              skip_floor=0.0):
    """Exact DP over take/skip with a reference-RR deviation cost.

    Transitions:
      skip[i] = max(skip[i-1], take[i-1])
      take[i] = gain(i) + max( skip[i-1],
                               max over j with rr in [rr_min, rr_max] of
                                   take[j] - rr_penalty*|log(rr/ref_rr)| )
    `skip[i-1]` as a parent is what lets the chain restart after a long pause
    without dropping everything before it.
    """
    n = len(cand)
    if n == 0:
        return np.array([], dtype=int)

    gain = w_amp * amp_z + w_corr * corr + w_slope * slope_z + skip_floor
    rr_min = int(rr_min_s * fs)
    rr_max = int(rr_max_s * fs)
    ref_rr = ref_rr_s * fs

    skip = np.zeros(n)
    take = np.full(n, -np.inf)
    back = np.full(n, -1, dtype=int)   # -1 means restart here

    for i in range(n):
        prev = max(skip[i - 1] if i > 0 else 0.0,
                   take[i - 1] if i > 0 else -np.inf)
        skip[i] = prev

        lo = int(np.searchsorted(cand, cand[i] - rr_max))
        hi = int(np.searchsorted(cand, cand[i] - rr_min))
        best = skip[lo - 1] if lo > 0 else 0.0
        best_j = -1
        for j in range(lo, hi):
            if not np.isfinite(take[j]):
                continue
            rr = float(cand[i] - cand[j])
            cost = rr_penalty * abs(np.log(rr / ref_rr))
            v = take[j] - cost
            if v > best:
                best, best_j = v, j
        take[i] = gain[i] + best
        back[i] = best_j

    # Traceback over both states. When a take state has no predecessor, the
    # chain restarted there; the beats before it are still encoded in skip[], so
    # we step back one index and continue in whichever state is better rather
    # than stopping. Stopping here silently discarded every earlier beat, which
    # is what collapsed p00010_s01 to 15 detections.
    sel = []
    i = n - 1
    state_take = bool(np.isfinite(take[i]) and take[i] >= skip[i])
    while i >= 0:
        if state_take:
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
        state_take = bool(np.isfinite(take[i]) and take[i] >= skip[i])
    return np.array(sorted(sel), dtype=int)


def estimate_rr(cand, corr, amp_z, slope_z, fs):
    """Reference RR estimated from the detections alone.

    The app never sees annotations, so the DP cannot be given the true rate.
    A first pass with a weak RR term produces a nearly-unfiltered sequence --
    still containing T waves, but with enough true beats that the median
    interval is dominated by the real cardiac cycle.
    """
    weak = dp_select(cand, corr, amp_z, slope_z, fs, 0.8,
                     rr_penalty=0.15)
    if len(weak) < 10:
        return None
    rr = np.diff(weak) / fs
    rr = rr[(rr > 0.25) & (rr < 2.5)]
    if len(rr) < 5:
        return None
    return float(np.median(rr))


def run(rec, **kw):
    sig, ref, fs, _ = load(rec)
    wide = band(sig, 0.5, 40.0, fs)
    tol = int(0.05 * fs)
    cand = merge([snap(run_gqrs(sig), wide, fs),
                  snap(run_twomax(sig, fs), wide, fs)], tol)
    if len(cand) < 10:
        return cand, ref, fs
    corr, amp_z, slope_z = features(wide, cand, fs)

    ref_rr = estimate_rr(cand, corr, amp_z, slope_z, fs)
    if ref_rr is None:
        return cand, ref, fs
    out = dp_select(cand, corr, amp_z, slope_z, fs, ref_rr, **kw)
    # Second pass: re-estimate the reference RR from the first pass output,
    # which is closer to the true rate because it no longer contains the T
    # waves the first pass removed.
    if len(out) > 20:
        rr2 = np.diff(out) / fs
        rr2 = rr2[(rr2 > 0.25) & (rr2 < 2.5)]
        if len(rr2) > 5:
            ref_rr2 = float(np.median(rr2))
            if 0.3 < ref_rr2 < 2.0:
                out = dp_select(cand, corr, amp_z, slope_z, fs, ref_rr2, **kw)
    return out, ref, fs


def main() -> None:
    kw = dict(w_amp=1.0, w_corr=2.0, w_slope=0.5, rr_penalty=1.5)
    pairs = {"--w-amp": "w_amp", "--w-corr": "w_corr", "--w-slope": "w_slope",
             "--rr": "rr_penalty", "--skip": "skip_floor"}
    a = sys.argv[1:]
    for flag, key in pairs.items():
        if flag in a:
            i = a.index(flag)
            kw[key] = float(a[i + 1])
            a = a[:i] + a[i + 2:]
    args = [x for x in a if not x.startswith("-")]
    index = json.loads((CATALOG / "f32" / "index.json").read_text())
    recs = args or [s["record"] for s in index]

    print(f"DP {kw}")
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
