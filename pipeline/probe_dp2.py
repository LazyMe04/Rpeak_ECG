"""DP with a locally-adaptive reference RR.

The sweep found a best operating point of Se 97.24 / PPV 96.77 (F1 97.00) but no
single global reference RR satisfies every record. That is expected: the RR
penalty compares each interval with one number for the whole 70 minutes, so a
patient whose rate drifts (or who has long ectopic runs) is penalised exactly
where the true rhythm departs from the global median.

This version estimates the reference RR *locally*, from a smoothed rolling
median of the weak first-pass intervals, and passes it to the DP as a
per-candidate target. The penalty is then "does this interval match the rhythm
around me", which is the quantity T waves actually violate: a T wave is a short
interval relative to its neighbours regardless of the patient's baseline rate.

Usage:
  python -I probe_dp2.py [record ...]
  python -I probe_dp2.py --w-amp 0.5 --w-corr 1 --w-slope 1.5 --rr 2.5
"""
from __future__ import annotations

from pathlib import Path

import json
import sys
import warnings

import numpy as np
from scipy.ndimage import median_filter

sys.path.insert(0, str(Path(__file__).resolve().parent))
from config import CATALOG  # noqa: E402
from detect import load  # noqa: E402
from detect4 import band, score_weighted  # noqa: E402
from probe_baseline import run_gqrs, run_twomax  # noqa: E402
from probe_dp import features  # noqa: E402
from probe_fuse import merge, qrs_score, snap  # noqa: E402

warnings.filterwarnings("ignore")
FS = 250


def dp_local(cand, corr, amp_z, slope_z, fs, rr_ref, w_amp, w_corr, w_slope,
             rr_penalty, rr_min_s=0.25, rr_max_s=2.5):
    """Two-state DP where `rr_ref` is a per-candidate array of expected RR."""
    n = len(cand)
    if n == 0:
        return np.array([], dtype=int)
    gain = w_amp * amp_z + w_corr * corr + w_slope * slope_z
    rr_min = int(rr_min_s * fs)
    rr_max = int(rr_max_s * fs)

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
        ref_i = max(float(rr_ref[i]) * fs, 1.0)
        for j in range(lo, hi):
            if not np.isfinite(take[j]):
                continue
            rr = float(cand[i] - cand[j])
            v = take[j] - rr_penalty * abs(np.log(rr / ref_i))
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


def weak_pass(cand, corr, amp_z, slope_z, fs):
    n = len(cand)
    gain = amp_z + corr + 0.5 * slope_z
    rr_min = int(0.25 * fs)
    skip = np.zeros(n)
    take = np.full(n, -np.inf)
    back = np.full(n, -1, dtype=int)
    for i in range(n):
        skip[i] = max(skip[i - 1] if i > 0 else 0.0,
                      take[i - 1] if i > 0 else -np.inf)
        lo = int(np.searchsorted(cand, cand[i] - int(2.5 * fs)))
        hi = int(np.searchsorted(cand, cand[i] - rr_min))
        best = skip[lo - 1] if lo > 0 else 0.0
        best_j = -1
        for j in range(lo, hi):
            if np.isfinite(take[j]) and take[j] > best:
                best, best_j = take[j], j
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


def local_rr_ref(cand, weak, fs, win_s=300.0, floor_s=0.25):
    """Rolling median of the weak-pass interval, interpolated onto candidates."""
    if len(weak) < 20:
        return np.full(len(cand), 0.8)
    wpos = np.array(weak, dtype=float)
    wrr = np.diff(wpos) / fs
    wrr = np.clip(wrr, floor_s, 2.5)
    k = max(3, int(win_s / 8))          # neighbours in the rolling median
    km = k if k % 2 == 1 else k + 1
    sm = median_filter(wrr, size=km, mode="nearest")
    centres = 0.5 * (wpos[:-1] + wpos[1:])
    return np.interp(cand.astype(float), centres, sm)


def run(rec, w_amp=0.5, w_corr=1.0, w_slope=1.5, rr_penalty=2.5, win_s=300.0):
    sig, ref, fs, _ = load(rec)
    wide = band(sig, 0.5, 40.0, fs)
    tol = int(0.05 * fs)
    cand = merge([snap(run_gqrs(sig), wide, fs),
                  snap(run_twomax(sig, fs), wide, fs)], tol)
    if len(cand) < 10:
        return cand, ref, fs
    corr, amp_z, slope_z = features(wide, cand, fs)

    weak = weak_pass(cand, corr, amp_z, slope_z, fs)
    rr_ref = local_rr_ref(cand, weak, fs, win_s)
    out = dp_local(cand, corr, amp_z, slope_z, fs, rr_ref,
                   w_amp, w_corr, w_slope, rr_penalty)
    # Refine the local reference from the first full pass and re-run once.
    if len(out) > 20:
        rr_ref2 = local_rr_ref(cand, out, fs, win_s)
        out = dp_local(cand, corr, amp_z, slope_z, fs, rr_ref2,
                       w_amp, w_corr, w_slope, rr_penalty)
    return out, ref, fs


def main() -> None:
    kw = dict(w_amp=0.5, w_corr=1.0, w_slope=1.5, rr_penalty=2.5, win_s=300.0)
    mapping = {"--w-amp": "w_amp", "--w-corr": "w_corr", "--w-slope": "w_slope",
               "--rr": "rr_penalty", "--win": "win_s"}
    a = sys.argv[1:]
    for flag, key in mapping.items():
        if flag in a:
            i = a.index(flag)
            kw[key] = float(a[i + 1])
            a = a[:i] + a[i + 2:]
    args = [x for x in a if not x.startswith("-")]
    index = json.loads((CATALOG / "f32" / "index.json").read_text())
    recs = args or [s["record"] for s in index]

    print(f"DP-local {kw}")
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
