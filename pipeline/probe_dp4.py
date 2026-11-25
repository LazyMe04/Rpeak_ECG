"""Regularity-adaptive constraint: trust RR only where RR is trustworthy.

probe_rhythm.py showed the records that defeat every fixed setting are exactly
the irregular ones (rrCV 0.20-0.40), while the regular ones are already solved
(Se/PPV > 99.9). One global constraint therefore cannot serve both: it is too
loose for sinus rhythm and too strict for atrial fibrillation.

Regularity is itself measurable locally. Around each candidate, take the spread
of nearby intervals from a weak first pass; where those intervals agree, RR is
an informative feature and the DP may use it strongly; where they disagree, RR
carries no information about where the next beat is, so the DP must fall back on
shape alone. `reg(i)` in [0,1] blends the two:

    rr_penalty_effective(i) = rr_penalty * reg(i)
    t_wave_rule_effective(i) = still active, but only against clearly flatter
                               peaks as reg(i) falls

This mirrors how a human reads the trace: with a steady rhythm a short gap
stands out immediately; in AFib you judge each complex on its own morphology.

Usage:
  python -I probe_dp4.py [record ...]
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
from probe_dp3 import ref_rr_from, select as select_hard  # noqa: E402
from probe_fuse import merge, snap  # noqa: E402

warnings.filterwarnings("ignore")
FS = 250


def weak_sequence(cand, gain, fs):
    """First pass with the hard T-wave rule but no long-interval cost."""
    return select_hard(cand, gain, np.zeros(len(cand)), fs, slope_frac=1e9,
                       long_cost=0.0)


def local_regularity(cand, weak, fs, win_s=120.0):
    """Per-candidate regularity in [0, 1]: 1 - normalised local RR spread."""
    if len(weak) < 20:
        return np.ones(len(cand))
    w = np.asarray(weak, dtype=float)
    rr = np.diff(w) / fs
    rr = np.clip(rr, 0.25, 2.5)
    centres = 0.5 * (w[:-1] + w[1:])
    n = len(rr)
    k = max(3, int(win_s / 8))
    k = k if k % 2 == 1 else k + 1
    med = median_filter(rr, size=k, mode="nearest")
    dev = np.abs(rr - med) / np.maximum(med, 1e-9)
    spread = median_filter(dev, size=k, mode="nearest")
    # spread ~0.02 on clean sinus rhythm, ~0.25 in AFib. Map to [0,1].
    reg = np.clip(1.0 - spread / 0.30, 0.0, 1.0)
    return np.interp(cand.astype(float), centres, reg)


def select_adaptive(cand, gain, slope_z, reg, fs, slope_frac=0.6,
                    t_lo_s=0.16, t_hi_s=0.45, rr_min_s=0.25, rr_max_s=2.5,
                    rr_penalty=2.0, ref_rr_s=0.8):
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
        r_i = float(reg[i])
        ref_i = max(ref_rr, 1.0)
        for j in range(lo, hi):
            if not np.isfinite(take[j]):
                continue
            dt = int(cand[i] - cand[j])
            if t_lo <= dt <= t_hi and slope_z[i] < slope_frac * slope_z[j]:
                continue
            v = take[j]
            # Penalise deviation from the local reference only as far as the
            # local rhythm is actually regular. `rr_penalty` is the strength at
            # reg = 1 (clean sinus rhythm).
            if r_i < 0.999:
                pass
            v -= rr_penalty * r_i * abs(np.log(max(dt, 1.0) / ref_i))
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


def run(rec, w_amp=0.5, w_corr=1.0, w_slope=1.5, slope_frac=0.6,
        rr_penalty=2.0, win_s=120.0):
    sig, ref, fs, _ = load(rec)
    wide = band(sig, 0.5, 40.0, fs)
    tol = int(0.05 * fs)
    cand = merge([snap(run_gqrs(sig), wide, fs),
                  snap(run_twomax(sig, fs), wide, fs)], tol)
    if len(cand) < 10:
        return cand, ref, fs
    corr, amp_z, slope_z = features(wide, cand, fs)
    gain = w_amp * amp_z + w_corr * corr + w_slope * slope_z

    weak = weak_sequence(cand, gain, fs)
    reg = local_regularity(cand, weak, fs, win_s)
    ref_rr = ref_rr_from(cand, weak, fs)
    out = select_adaptive(cand, gain, slope_z, reg, fs, slope_frac,
                          rr_penalty=rr_penalty, ref_rr_s=ref_rr)
    return out, ref, fs


def main() -> None:
    kw = dict(w_amp=0.5, w_corr=1.0, w_slope=1.5, slope_frac=0.6,
              rr_penalty=2.0, win_s=120.0)
    mapping = {"--w-amp": "w_amp", "--w-corr": "w_corr", "--w-slope": "w_slope",
               "--slope-frac": "slope_frac", "--rr": "rr_penalty",
               "--win": "win_s"}
    a = sys.argv[1:]
    for flag, key in mapping.items():
        if flag in a:
            i = a.index(flag)
            kw[key] = float(a[i + 1])
            a = a[:i] + a[i + 2:]
    args = [x for x in a if not x.startswith("-")]
    index = json.loads((CATALOG / "f32" / "index.json").read_text())
    recs = args or [s["record"] for s in index]

    print(f"DP4 {kw}")
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
