"""Inspect the correlation peak population against the annotations.

Shows how the matched-filter score is distributed for true beats versus
everything else, so the decision threshold can be set from data.
"""
from __future__ import annotations

from pathlib import Path

import sys

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from detect import load  # noqa: E402
from detect5 import band, detect  # noqa: E402


def main() -> None:
    recs = sys.argv[1:] or ["p00010_s01", "p00000_s00"]
    for rec in recs:
        sig, ref, fs, _ = load(rec)
        # permissive candidate generation, no DP
        peaks, dbg = detect(sig, fs, 0.08, rr_penalty=0.08, use_dp=False)
        pc = dbg["pcorr"]
        corr = dbg["corr"]
        score = corr[np.clip(pc, 0, len(corr) - 1)]

        tol = int(0.06 * fs)
        is_true = np.zeros(len(pc), dtype=bool)
        j = 0
        for k, p in enumerate(pc):
            while j < len(ref) and ref[j] < p - tol:
                j += 1
            if j < len(ref) and abs(int(ref[j]) - int(p)) <= tol:
                is_true[k] = True

        t = score[is_true]
        f = score[~is_true]
        print(f"\n{rec}")
        print(f"  candidates={len(pc)}  true={is_true.sum()}  false={(~is_true).sum()}")
        if len(t):
            print(f"  TRUE  score: p1={np.percentile(t,1):.3f} p10={np.percentile(t,10):.3f} "
                  f"median={np.median(t):.3f} p90={np.percentile(t,90):.3f}")
        if len(f):
            print(f"  FALSE score: p50={np.percentile(f,50):.3f} p90={np.percentile(f,90):.3f} "
                  f"p99={np.percentile(f,99):.3f} p99.9={np.percentile(f,99.9):.3f}")
        # how many exact-match candidate duplicates
        print(f"  ref={len(ref)}  cand/ref={len(pc)/len(ref):.2f}")


if __name__ == "__main__":
    main()
