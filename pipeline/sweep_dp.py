"""Sweep the DP cost weights on the fusion candidate set.

probe_dp.py reached Se 97.88 / PPV 95.56 (F1 96.70), the best so far. Its
remaining losses are concentrated in three records where the heart rate is high
and the T wave is tall (p00006_s00, p00006_s01, p00010_s01), which is precisely
the regime the RR penalty is supposed to handle. The penalty's strength is
therefore the decisive parameter, along with how much weight the shape features
carry against the timing term.

Records are loaded once and the features cached, so the sweep is affordable.

Usage:
  python -I sweep_dp.py [record ...]
"""
from __future__ import annotations

import json
import itertools
import sys
import warnings

import numpy as np

sys.path.insert(0, "D:/Rpeak-Desktop/pipeline")
from config import CATALOG  # noqa: E402
from detect import load  # noqa: E402
from detect4 import band, score_weighted  # noqa: E402
from probe_baseline import run_gqrs, run_twomax  # noqa: E402
from probe_dp import dp_select, features, estimate_rr  # noqa: E402
from probe_fuse import merge, snap  # noqa: E402

warnings.filterwarnings("ignore")
FS = 250


def load_cached(rec):
    sig, ref, fs, _ = load(rec)
    wide = band(sig, 0.5, 40.0, fs)
    tol = int(0.05 * fs)
    cand = merge([snap(run_gqrs(sig), wide, fs),
                  snap(run_twomax(sig, fs), wide, fs)], tol)
    corr, amp_z, slope_z = features(wide, cand, fs)
    r = estimate_rr(cand, corr, amp_z, slope_z, fs)
    return cand, corr, amp_z, slope_z, ref, fs, r


def evaluate(store, **kw):
    ses, ppvs, tot = [], [], {"tp": 0, "fp": 0, "fn": 0}
    for rec, (cand, corr, amp_z, slope_z, ref, fs, r) in store.items():
        if r is None:
            continue
        out = dp_select(cand, corr, amp_z, slope_z, fs, r, **kw)
        if len(out) > 20:
            rr2 = np.diff(out) / fs
            rr2 = rr2[(rr2 > 0.25) & (rr2 < 2.5)]
            if len(rr2) > 5:
                r2 = float(np.median(rr2))
                if 0.3 < r2 < 2.0:
                    out = dp_select(cand, corr, amp_z, slope_z, fs, r2, **kw)
        sc = score_weighted(ref, out, fs)
        ses.append(sc["se"])
        ppvs.append(sc["ppv"])
        for m in tot:
            tot[m] += sc[m]
    se = 100 * tot["tp"] / max(tot["tp"] + tot["fn"], 1)
    ppv = 100 * tot["tp"] / max(tot["tp"] + tot["fp"], 1)
    f1 = 2 * se * ppv / max(se + ppv, 1e-9)
    return f1, se, ppv, np.median(ses), min(ses), np.median(ppvs), min(ppvs)


def main() -> None:
    args = [a for a in sys.argv[1:] if not a.startswith("-")]
    index = json.loads((CATALOG / "f32" / "index.json").read_text())
    recs = args or [s["record"] for s in index]
    store = {}
    for r in recs:
        store[r] = load_cached(r)
        print(f"   loaded {r}", file=sys.stderr)

    print(f"{'w_amp':>5} {'w_corr':>6} {'w_slope':>7} {'rr':>5} | {'Se':>7} "
          f"{'PPV':>7} {'F1':>7} | {'medSe':>7} {'minSe':>7} {'medPPV':>7} "
          f"{'minPPV':>7}")
    rows = []
    for w_amp, w_corr, w_slope, rr in itertools.product(
            (0.5, 1.0, 2.0), (1.0, 2.0, 4.0), (0.0, 0.5, 1.5),
            (0.8, 1.5, 2.5, 4.0)):
        f1, se, ppv, mse, nse, mpp, npp = evaluate(
            store, w_amp=w_amp, w_corr=w_corr, w_slope=w_slope,
            rr_penalty=rr)
        rows.append((f1, se, ppv, mse, nse, mpp, npp,
                     w_amp, w_corr, w_slope, rr))
        if f1 > 97.3:
            print(f"{w_amp:5.1f} {w_corr:6.1f} {w_slope:7.1f} {rr:5.1f} | "
                  f"{se:7.2f} {ppv:7.2f} {f1:7.2f} | {mse:7.2f} {nse:7.2f} "
                  f"{mpp:7.2f} {npp:7.2f}")

    rows.sort(reverse=True)
    print("\nTop 10 by F1:")
    for r in rows[:10]:
        print(f"  w_amp={r[7]} w_corr={r[8]} w_slope={r[9]} rr={r[10]} -> "
              f"Se={r[1]:.2f} PPV={r[2]:.2f} F1={r[0]:.2f} "
              f"(medSe {r[3]:.2f}, minSe {r[4]:.2f}, medPPV {r[5]:.2f}, "
              f"minPPV {r[6]:.2f})")

    # The ship gate is not F1: it is Se and PPV on *every* patient.
    ok = [r for r in rows if r[4] >= 95 and r[6] >= 95]
    if ok:
        best = max(ok, key=lambda r: r[0])
        print(f"\nBest meeting minSe>=95 and minPPV>=95: w_amp={best[7]} "
              f"w_corr={best[8]} w_slope={best[9]} rr={best[10]} -> "
              f"Se={best[1]:.2f} PPV={best[2]:.2f} F1={best[0]:.2f}")
    else:
        print("\nNo configuration meets minSe>=95 and minPPV>=95.")


if __name__ == "__main__":
    main()
