"""Does the union double-count single beats?

`merge` collapses two source peaks only when they are within 48 ms. gqrs and
2ma routinely place the same beat 60-140 ms apart (one snaps to the R apex, the
other to the steepest ramp, and the snap window is +-50 ms), so both survive as
separate candidates. Each then competes for the same annotated beat: one becomes
a TP and the other an FP that no reference beat is left to match.

That is a precision bug in the candidate construction, not a decision problem,
so it is worth measuring directly: sweep the merge tolerance and see whether
PPV rises without recall falling.

Usage:
  python -I probe_mergetol.py [record ...]
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
from detect4 import band, score_weighted  # noqa: E402
from probe_baseline import run_gqrs, run_twomax  # noqa: E402
from probe_dp import features  # noqa: E402
from probe_dp2 import dp_local, local_rr_ref, weak_pass  # noqa: E402
from probe_fuse import qrs_score, snap  # noqa: E402

warnings.filterwarnings("ignore")
FS = 250


def merge_tol(pk_list, tol):
    allpk = np.sort(np.concatenate(pk_list))
    keep = [allpk[0]]
    for p in allpk[1:]:
        if p - keep[-1] > tol:
            keep.append(p)
    return np.array(keep, dtype=int)


def main() -> None:
    args = [a for a in sys.argv[1:] if not a.startswith("-")]
    index = json.loads((CATALOG / "f32" / "index.json").read_text())
    recs = args or [s["record"] for s in index]

    base = {}
    for r in recs:
        sig, ref, fs, _ = load(r)
        wide = band(sig, 0.5, 40.0, fs)
        pk = [snap(run_gqrs(sig), wide, fs), snap(run_twomax(sig, fs), wide, fs)]
        base[r] = (sig, ref, fs, wide, pk)
        print(f"   loaded {r}", file=sys.stderr)

    print(f"{'tol_ms':>7} | {'Se':>7} {'PPV':>7} {'F1':>7} | {'medSe':>7} "
          f"{'minSe':>7} {'medPPV':>7} {'minPPV':>7} {'ncand':>7}")
    for tol_ms in (48, 80, 120, 160, 200):
        tol = int(tol_ms / 1000 * FS)
        ses, ppvs, tot, nc = [], [], {"tp": 0, "fp": 0, "fn": 0}, 0
        for r, (sig, ref, fs, wide, pk) in base.items():
            cand = merge_tol(pk, tol)
            nc += len(cand)
            if len(cand) < 10:
                continue
            corr, amp_z, slope_z = features(wide, cand, fs)
            weak = weak_pass(cand, corr, amp_z, slope_z, fs)
            rr_ref = local_rr_ref(cand, weak, fs)
            out = dp_local(cand, corr, amp_z, slope_z, fs, rr_ref,
                           0.5, 1.0, 1.5, 2.5)
            if len(out) > 20:
                rr2 = local_rr_ref(cand, out, fs)
                out = dp_local(cand, corr, amp_z, slope_z, fs, rr2,
                               0.5, 1.0, 1.5, 2.5)
            sc = score_weighted(ref, out, fs)
            ses.append(sc["se"])
            ppvs.append(sc["ppv"])
            for m in tot:
                tot[m] += sc[m]
        se = 100 * tot["tp"] / max(tot["tp"] + tot["fn"], 1)
        ppv = 100 * tot["tp"] / max(tot["tp"] + tot["fp"], 1)
        print(f"{tol_ms:7d} | {se:7.2f} {ppv:7.2f} "
              f"{2*se*ppv/max(se+ppv,1e-9):7.2f} | {np.median(ses):7.2f} "
              f"{min(ses):7.2f} {np.median(ppvs):7.2f} {min(ppvs):7.2f} {nc:7d}")


if __name__ == "__main__":
    main()
