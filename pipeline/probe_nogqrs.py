"""End-to-end detector without gqrs.

probe_unionrecall.py found that replacing gqrs with local maxima of |0.5-40 Hz|
*raises* candidate recall (mean 98.67 vs 97.48, worst case 95.02 vs 91.09) while
removing the one component that would be hardest to port to TypeScript.

That result inverts the expected trade-off, so it is verified end to end here:
the same DP and the same rules, only the candidate source changes. If the
aggregate accuracy holds or improves, gqrs leaves the production detector and
the Python and TypeScript implementations can share every stage.

Usage:
  python -I probe_nogqrs.py [record ...]
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
from probe_baseline import run_twomax  # noqa: E402
from probe_dp import features  # noqa: E402
from probe_dp3 import ref_rr_from  # noqa: E402
from probe_dp4 import local_regularity, select_adaptive, weak_sequence  # noqa: E402
from probe_fuse import merge, snap  # noqa: E402
from probe_ktmpl import all_local_maxima  # noqa: E402

warnings.filterwarnings("ignore")
FS = 250


def run(rec, w_amp=0.5, w_corr=1.0, w_slope=1.5, slope_frac=0.6,
        rr_penalty=2.0, reg_win_s=120.0, min_dist_ms=120.0):
    sig, ref, fs, _ = load(rec)
    wide = band(sig, 0.5, 40.0, fs)
    tol = int(0.05 * fs)
    cand = merge([
        snap(run_twomax(sig, fs), wide, fs),
        snap(all_local_maxima(np.abs(wide), int(min_dist_ms / 1000 * fs)),
             wide, fs),
    ], tol)
    if len(cand) < 10:
        return cand, ref, fs
    corr, amp_z, slope_z = features(wide, cand, fs)
    gain = w_amp * amp_z + w_corr * corr + w_slope * slope_z
    weak = weak_sequence(cand, gain, fs)
    reg = local_regularity(cand, weak, fs, reg_win_s)
    ref_rr = ref_rr_from(cand, weak, fs)
    out = select_adaptive(cand, gain, slope_z, reg, fs, slope_frac,
                          rr_penalty=rr_penalty, ref_rr_s=ref_rr)
    return out, ref, fs


def main() -> None:
    args = [a for a in sys.argv[1:] if not a.startswith("-")]
    index = json.loads((CATALOG / "f32" / "index.json").read_text())
    recs = args or [s["record"] for s in index]

    print(f"{'record':14} {'ref':>6} {'det':>6} {'Se':>7} {'PPV':>7} {'F1':>7}")
    ses, ppvs, tot = [], [], {"tp": 0, "fp": 0, "fn": 0}
    for rec in recs:
        out, ref, fs = run(rec)
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
