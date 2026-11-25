"""Sweep the hard-constraint parameters of probe_dp3.

probe_dp3 (hard T-wave constraint) reached the best recall so far, Se 98.02 with
median Se 99.27, but precision stayed at 95.59 because the constraint only
forbids a *pair*; a false peak with no competing predecessor is still taken.
Two further controls decide whether it survives:

  slope_frac  how much flatter a peak must be to count as a T wave; raising it
              rejects more, at the risk of discarding real low-amplitude beats
  long_cost   how strongly a missing beat is penalised; raising it fills gaps
              more aggressively but invites a second peak into each interval

Records are loaded and featurised once, so the sweep is affordable.

Usage:
  python -I sweep_dp3.py [record ...]
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
from probe_dp import features  # noqa: E402
from probe_dp3 import ref_rr_from, select  # noqa: E402
from probe_fuse import merge, snap  # noqa: E402

warnings.filterwarnings("ignore")
FS = 250


def main() -> None:
    args = [a for a in sys.argv[1:] if not a.startswith("-")]
    index = json.loads((CATALOG / "f32" / "index.json").read_text())
    recs = args or [s["record"] for s in index]

    store = {}
    for r in recs:
        sig, ref, fs, _ = load(r)
        wide = band(sig, 0.5, 40.0, fs)
        tol = int(0.05 * fs)
        cand = merge([snap(run_gqrs(sig), wide, fs),
                      snap(run_twomax(sig, fs), wide, fs)], tol)
        corr, amp_z, slope_z = features(wide, cand, fs)
        store[r] = (cand, corr, amp_z, slope_z, ref, fs)
        print(f"   loaded {r}", file=sys.stderr)

    print(f"{'sf':>4} {'long':>5} {'amp':>4} {'corr':>5} {'slp':>4} | "
          f"{'Se':>7} {'PPV':>7} {'F1':>7} | {'medSe':>7} {'minSe':>7} "
          f"{'medPPV':>7} {'minPPV':>7}")
    rows = []
    for sf, lc, wa, wc, ws in itertools.product(
            (0.4, 0.6, 0.8, 1.0), (0.0, 0.5, 1.5, 3.0),
            (0.5,), (1.0,), (1.5,)):
        ses, ppvs, tot = [], [], {"tp": 0, "fp": 0, "fn": 0}
        for r, (cand, corr, amp_z, slope_z, ref, fs) in store.items():
            if len(cand) < 10:
                continue
            gain = wa * amp_z + wc * corr + ws * slope_z
            first = select(cand, gain, slope_z, fs, sf, long_cost=0.0)
            rr = ref_rr_from(cand, first, fs)
            out = select(cand, gain, slope_z, fs, sf, long_cost=lc, ref_rr_s=rr)
            sc = score_weighted(ref, out, fs)
            ses.append(sc["se"])
            ppvs.append(sc["ppv"])
            for m in tot:
                tot[m] += sc[m]
        se = 100 * tot["tp"] / max(tot["tp"] + tot["fn"], 1)
        ppv = 100 * tot["tp"] / max(tot["tp"] + tot["fp"], 1)
        f1 = 2 * se * ppv / max(se + ppv, 1e-9)
        rows.append((f1, se, ppv, np.median(ses), min(ses), np.median(ppvs),
                     min(ppvs), sf, lc))
        print(f"{sf:4.1f} {lc:5.1f} {wa:4.1f} {wc:5.1f} {ws:4.1f} | "
              f"{se:7.2f} {ppv:7.2f} {f1:7.2f} | {np.median(ses):7.2f} "
              f"{min(ses):7.2f} {np.median(ppvs):7.2f} {min(ppvs):7.2f}")

    rows.sort(reverse=True)
    print("\nTop 5 by F1:")
    for r in rows[:5]:
        print(f"  slope_frac={r[7]} long={r[8]} -> Se={r[1]:.2f} "
              f"PPV={r[2]:.2f} F1={r[0]:.2f} (medSe {r[3]:.2f}, "
              f"minSe {r[4]:.2f}, medPPV {r[5]:.2f}, minPPV {r[6]:.2f})")
    ok = [r for r in rows if r[4] >= 95 and r[6] >= 95]
    print(f"\nconfigs meeting minSe>=95 and minPPV>=95: {len(ok)}")
    for r in ok[:3]:
        print(f"  slope_frac={r[7]} long={r[8]} -> Se={r[1]:.2f} "
              f"PPV={r[2]:.2f} F1={r[0]:.2f}")


if __name__ == "__main__":
    main()
