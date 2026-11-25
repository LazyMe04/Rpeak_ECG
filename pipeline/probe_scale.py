"""How much does the pre-normalisation amplitude separate N from Q?

`normalise` in build_beats.py divides each window by its own robust spread,
which is right for morphology and wrong for "is this stretch usable": unusable
stretches are noisier and therefore larger. This probe measures the cue that
division throws away, per class, so the retrain that adds it as an input has a
number to beat rather than an intuition.

Reported per class: the quantiles of log(scale) -- the scale is what the
normaliser divides by, floored the same way it floors it -- plus a single
scalar AUC for N vs Q, computed by rank, which is the best a one-scalar
classifier could do.

Usage:
  python -I probe_scale.py --records p00019_s00 p00225_s00 --n 3000
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_beats import PRE, WIN, beat_list, cut, normalise  # noqa: E402
from config import AAMI_CLASSES, CATALOG  # noqa: E402


def window_scale(sig: np.ndarray, s: int) -> float:
    """The exact denominator `normalise` uses, recomputed from the raw window."""
    seg = cut(sig, s)
    core = seg[PRE - 50:PRE + 100]
    med = float(np.median(core))
    dev = np.abs(core - med)
    scale = float(np.quantile(dev, 0.9))
    return max(scale, 0.01 * float(np.abs(seg).max()), 1e-6)


def auc(pos: np.ndarray, neg: np.ndarray) -> float:
    """Rank AUC of `pos` scoring above `neg`, ties counted as half."""
    allv = np.concatenate([pos, neg])
    order = np.argsort(allv, kind="mergesort")
    ranks = np.empty(len(allv), dtype=np.float64)
    ranks[order] = np.arange(1, len(allv) + 1)
    # average ranks over ties
    sv = allv[order]
    i = 0
    while i < len(sv):
        j = i
        while j + 1 < len(sv) and sv[j + 1] == sv[i]:
            j += 1
        if j > i:
            ranks[order[i:j + 1]] = (i + 1 + j + 1) / 2
        i = j + 1
    rp = ranks[:len(pos)].sum()
    return float((rp - len(pos) * (len(pos) + 1) / 2) / (len(pos) * len(neg)))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--records", nargs="+", required=True)
    ap.add_argument("--n", type=int, default=3000, help="beats per record")
    args = ap.parse_args()

    per_class: dict[str, list[float]] = {c: [] for c in AAMI_CLASSES}
    for r in args.records:
        sig = np.fromfile(CATALOG / "f32" / f"{r}.f32", dtype=np.float32)
        beats = beat_list(r)
        rng = np.random.default_rng(0)
        if len(beats) > args.n:
            idx = rng.choice(len(beats), size=args.n, replace=False)
            beats = [beats[i] for i in sorted(idx)]
        for s, sym in beats:
            if s >= len(sig):
                continue
            per_class[sym].append(np.log(window_scale(sig, s)))

    print(f"{'class':>5} {'n':>7} {'p10':>7} {'p50':>7} {'p90':>7} {'mean':>7} {'sd':>6}")
    for c in AAMI_CLASSES:
        v = np.array(per_class[c], dtype=np.float64)
        if len(v) == 0:
            print(f"{c:>5} {0:>7}")
            continue
        q = np.quantile(v, [0.1, 0.5, 0.9])
        print(f"{c:>5} {len(v):>7} {q[0]:>7.3f} {q[1]:>7.3f} {q[2]:>7.3f} "
              f"{v.mean():>7.3f} {v.std():>6.3f}")

    n = np.array(per_class["N"], dtype=np.float64)
    for c in ("S", "V", "Q"):
        v = np.array(per_class[c], dtype=np.float64)
        if len(v) and len(n):
            print(f"AUC {c} vs N by log(scale) alone: {auc(v, n):.3f}")

    # Same question with the record's own median log(scale) removed: gain drift
    # differs between patients, so a within-record cue would be the one the
    # network can actually use at inference on a different person.
    if len(args.records) > 1:
        per_record: dict[str, dict[str, list[float]]] = {}
        for r in args.records:
            sig = np.fromfile(CATALOG / "f32" / f"{r}.f32", dtype=np.float32)
            beats = beat_list(r)
            rng = np.random.default_rng(0)
            if len(beats) > args.n:
                idx = rng.choice(len(beats), size=args.n, replace=False)
                beats = [beats[i] for i in sorted(idx)]
            vals = {c: [] for c in AAMI_CLASSES}
            for s, sym in beats:
                if s >= len(sig):
                    continue
                vals[sym].append(np.log(window_scale(sig, s)))
            allv = np.concatenate([np.array(x) for x in vals.values() if x])
            med = float(np.median(allv))
            per_record[r] = {c: (np.array(x) - med).tolist() for c, x in vals.items()}
        for c in ("S", "V", "Q"):
            aucs = []
            for r, d in per_record.items():
                p, q = np.array(d[c]), np.array(d["N"])
                if len(p) > 10 and len(q) > 10:
                    aucs.append(auc(p, q))
            if aucs:
                print(f"AUC {c} vs N within record (mean of {len(aucs)}): "
                      f"{np.mean(aucs):.3f}  [{min(aucs):.3f}..{max(aucs):.3f}]")



if __name__ == "__main__":
    main()
