"""Ablate the fusion stages to see which one costs recall.

probe_fuse.py reached PPV 97.3 but recall only 90.2, and the loss is in the two
post-processing rules rather than in the union:
  * `score >= 0.75` rejects real beats whose morphology matches no cluster
    (p00010_s01 drops to Se 43)
  * `rr_clean` deletes ectopic beats, which are real annotations

This reports the union's own ceiling, then each rule's effect, so the final
detector only keeps a rule that earns its cost.

Usage:
  python -I probe_fuse_ablate.py [record ...]
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
from probe_ktmpl import all_local_maxima  # noqa: E402
from probe_fuse import merge, qrs_score, rr_clean, snap  # noqa: E402

warnings.filterwarnings("ignore")
FS = 250


def main() -> None:
    args = [a for a in sys.argv[1:] if not a.startswith("-")]
    index = json.loads((CATALOG / "f32" / "index.json").read_text())
    recs = args or [s["record"] for s in index]

    variants = ["union_raw", "score0.0", "score0.5", "score0.7", "rr_only"]
    agg = {v: [] for v in variants}
    print(f"{'record':14} " + " ".join(f"{v:>16}" for v in variants))
    for rec in recs:
        sig, ref, fs, _ = load(rec)
        wide = band(sig, 0.5, 40.0, fs)
        tol = int(0.05 * fs)
        pk_g = snap(run_gqrs(sig), wide, fs)
        pk_m = snap(run_twomax(sig, fs), wide, fs)
        cand = merge([pk_g, pk_m], tol)
        sc, _ = qrs_score(wide, cand)
        line = []
        for v in variants:
            if v == "union_raw":
                out = cand
            elif v == "rr_only":
                out = rr_clean(cand, sc + 1.0, fs)
            else:
                fl = float(v.replace("score", ""))
                keep = sc >= fl
                if keep.sum() < 10:
                    keep = np.ones(len(cand), dtype=bool)
                out = cand[keep]
            s = score_weighted(ref, out, fs)
            agg[v].append((s["se"], s["ppv"]))
            line.append(f"{s['se']:7.2f}/{s['ppv']:7.2f}")
        print(f"{rec:14} " + " ".join(f"{x:>16}" for x in line))
        print(f"   done {rec}", file=sys.stderr)

    print()
    for v in variants:
        se = [a for a, _ in agg[v]]
        pp = [b for _, b in agg[v]]
        print(f"{v:12} meanSe={np.mean(se):6.2f} medSe={np.median(se):6.2f} "
              f"minSe={min(se):6.2f} | meanPPV={np.mean(pp):6.2f} "
              f"medPPV={np.median(pp):6.2f} minPPV={min(pp):6.2f}")


if __name__ == "__main__":
    main()
