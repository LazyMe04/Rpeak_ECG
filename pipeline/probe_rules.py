"""Combined precision rules on the raw union.

probe_feat.py measured single-feature separation and found three usable signals,
each with a different trade-off:
  corr    >= 0.60 keeps 96.6% of TP while removing 37.6% of FP
  slope   >= 0.40 keeps 93.3% of TP while removing 36.2% of FP
  amp_ratio, dt_prev below 0.5 s removes T waves

They are partly independent -- corr measures shape, slope measures sharpness,
dt_prev measures timing relative to the previous peak -- so a conjunction should
do better than any one. This sweeps conjunctions and reports the operating
points on the full 24-segment set, so the shipped configuration is chosen from
evidence rather than guessed.

Usage:
  python -I probe_rules.py [record ...]
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


def features(wide, cand, fs):
    corr, _ = qrs_score(wide, cand, fs=fs)
    aw = np.abs(wide)
    g = np.abs(np.gradient(wide))
    hs = int(0.04 * fs)
    ha = int(0.06 * fs)
    amp = np.array([aw[max(0, c - ha): c + ha + 1].max() for c in cand])
    slope = np.array([g[max(0, c - hs): c + hs + 1].max() for c in cand])
    amp_n = amp / (np.percentile(amp, 95) + 1e-12)
    slope_n = slope / (np.percentile(slope, 95) + 1e-12)
    dt = np.diff(cand, prepend=cand[0] - int(1.0 * fs)) / fs
    return corr, slope_n, amp_n, dt


def apply_rules(cand, corr, slope, amp, dt, c_cut, s_cut, a_cut, dt_cut):
    keep = (corr >= c_cut) & (slope >= s_cut) & (amp >= a_cut)
    # Timing rule: a peak very soon after another surviving peak is kept only if
    # it is clearly a QRS by shape; this is what removes tall T waves without a
    # blanket short-RR deletion (which would drop real ectopics).
    if dt_cut > 0:
        short = dt < dt_cut
        strong = (corr >= c_cut + 0.2) & (slope >= s_cut + 0.15)
        keep = keep & (~short | strong)
    return cand[keep]


def main() -> None:
    args = [a for a in sys.argv[1:] if not a.startswith("-")]
    index = json.loads((CATALOG / "f32" / "index.json").read_text())
    recs = args or [s["record"] for s in index]

    store = {}
    for rec in recs:
        sig, ref, fs, _ = load(rec)
        wide = band(sig, 0.5, 40.0, fs)
        tol = int(0.05 * fs)
        cand = merge([snap(run_gqrs(sig), wide, fs),
                      snap(run_twomax(sig, fs), wide, fs)], tol)
        if len(cand) < 10:
            continue
        store[rec] = (cand, *features(wide, cand, fs), ref, fs)
        print(f"   loaded {rec}", file=sys.stderr)

    grid = [(c, s, a, d)
            for c in (0.45, 0.55, 0.65, 0.75)
            for s in (0.0, 0.30, 0.40, 0.50)
            for a in (0.0, 0.30, 0.40)
            for d in (0.0, 0.45)]

    print(f"{'corr':>5} {'slope':>6} {'amp':>5} {'dt':>5} | {'Se':>7} {'PPV':>7} "
          f"{'F1':>7} | {'medSe':>7} {'minSe':>7} {'medPPV':>7} {'minPPV':>7}")
    rows = []
    for c_cut, s_cut, a_cut, dt_cut in grid:
        ses, ppvs, tot = [], [], {"tp": 0, "fp": 0, "fn": 0}
        for rec, (cand, corr, slope, amp, dt, ref, fs) in store.items():
            out = apply_rules(cand, corr, slope, amp, dt, c_cut, s_cut, a_cut,
                              dt_cut)
            if len(out) < 10:
                out = cand
            sc = score_weighted(ref, out, fs)
            ses.append(sc["se"])
            ppvs.append(sc["ppv"])
            for m in tot:
                tot[m] += sc[m]
        se = 100 * tot["tp"] / max(tot["tp"] + tot["fn"], 1)
        ppv = 100 * tot["tp"] / max(tot["tp"] + tot["fp"], 1)
        f1 = 2 * se * ppv / max(se + ppv, 1e-9)
        rows.append((f1, se, ppv, c_cut, s_cut, a_cut, dt_cut,
                     np.median(ses), min(ses), np.median(ppvs), min(ppvs)))
        if f1 > 96.0 or (se > 98.5 and ppv > 96.0):
            print(f"{c_cut:5.2f} {s_cut:6.2f} {a_cut:5.2f} {dt_cut:5.2f} | "
                  f"{se:7.2f} {ppv:7.2f} {f1:7.2f} | "
                  f"{np.median(ses):7.2f} {min(ses):7.2f} "
                  f"{np.median(ppvs):7.2f} {min(ppvs):7.2f}")

    rows.sort(reverse=True)
    print("\nTop 8 by F1:")
    for r in rows[:8]:
        print(f"  corr>={r[3]:.2f} slope>={r[4]:.2f} amp>={r[5]:.2f} "
              f"dt>={r[6]:.2f} -> Se={r[1]:.2f} PPV={r[2]:.2f} F1={r[0]:.2f} "
              f"(medSe {r[7]:.2f}, minSe {r[8]:.2f}, medPPV {r[9]:.2f}, "
              f"minPPV {r[10]:.2f})")

    best = max(rows, key=lambda r: (r[8] >= 95, r[10] >= 95, r[0]))
    print(f"\nBest with minSe>=95 and minPPV>=95: corr>={best[3]:.2f} "
          f"slope>={best[4]:.2f} amp>={best[5]:.2f} dt>={best[6]:.2f} -> "
          f"Se={best[1]:.2f} PPV={best[2]:.2f} F1={best[0]:.2f}")


if __name__ == "__main__":
    main()
