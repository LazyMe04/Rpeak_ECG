"""Does the RR interval separate S from N? Measure before believing.

Class S is "supraventricular ectopic". The defining property of a premature
atrial contraction is not its shape -- it is that it arrives early and is
followed by a pause. A 250-sample window holds one second, which at a normal
rate does not contain either neighbouring R peak, so the network cannot see
that at all. That is the argument for feeding RR context as extra head inputs.

G8 is the reason this file exists rather than a retrain. `log(scale)` had a
good argument too (AUC 0.615 for Q vs N) and the network turned out not to use
it. So the cue is measured first, per class and within record, and the number
it reports is what a retrain would have to beat.

Features, all dimensionless and computed from the annotation samples alone:

  pre_ratio   RR(i-1, i) / median RR of the surrounding beats   -- prematurity
  post_ratio  RR(i, i+1) / median RR of the surrounding beats   -- the pause
  sum_ratio   (RR(i-1,i) + RR(i,i+1)) / (2 * median)            -- net timing

These are `build_beats.rr_ratios`, the same function that fills the shard, so
the probe measures exactly what a retrain would be given -- including its
clamping and its 1.0 fill at the record edges.

The median is taken over 25 beats each side, excluding the two intervals that
touch beat i: a run of ectopics must not drag its own baseline toward itself.
Ratios are the right scale because heart rate differs by patient; a raw RR in
samples would let the network identify the patient instead of the rhythm.

AUC is reported with the feature oriented so that "premature" scores high
(lower pre_ratio -> higher score), because that is the direction a classifier
would use.

Usage:
  python -I probe_rr.py --records p00019_s00 p00114_s00 --n 4000
  python -I probe_rr.py --split val          # the six held-out patients
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_beats import RR_NAMES, beat_list, rr_ratios  # noqa: E402
from config import AAMI_CLASSES  # noqa: E402
from probe_scale import auc  # noqa: E402

FEATS = ("pre_ratio", "post_ratio", "sum_ratio")


def rr_features(samples: np.ndarray) -> dict[str, np.ndarray]:
    """The shard's own ratios, unpacked by name so the probe cannot drift."""
    R = rr_ratios(np.asarray(samples, dtype=np.int64))
    assert tuple(FEATS) == tuple(RR_NAMES)
    return {name: R[:, i].astype(np.float64) for i, name in enumerate(FEATS)}


def load(records: list[str], n: int, seed: int = 0):
    """Sampled beats per record: (record, symbols, features).

    The ratios are computed on the **full** beat sequence and only then
    subsampled. Computing them on a sparse sample would stretch every interval
    and destroy the local median -- measured, it drops S vs N from AUC 0.93 to
    0.52, which looks like "the cue is useless" and is really an artefact of the
    probe. The shard builder never has that problem: it always sees the whole
    record.
    """
    out = []
    for r in records:
        beats = beat_list(r)
        samples = np.array([s for s, _ in beats], dtype=np.int64)
        syms = np.array([c for _, c in beats])
        feats = rr_features(samples)
        if n and len(beats) > n:
            idx = np.sort(np.random.default_rng(seed).choice(len(beats), size=n,
                                                             replace=False))
        else:
            idx = np.arange(len(beats))
        out.append((r, syms[idx], {k: v[idx] for k, v in feats.items()}))
    return out


def report(data, label: str) -> None:
    feats = ("pre_ratio", "post_ratio", "sum_ratio")
    print(f"\n=== {label} ===")
    print(f"{'class':>5} {'n':>7} " + " ".join(f"{f:>10}" for f in feats))
    print(f"{'':>5} {'':>7} " + " ".join(f"{'p10/p50/p90':>10}" for _ in feats))
    for c in AAMI_CLASSES:
        v = {f: np.concatenate([d[2][f][d[1] == c] for d in data]) for f in feats}
        n = int(np.isfinite(v["pre_ratio"]).sum())
        cells = []
        for f in feats:
            x = v[f][np.isfinite(v[f])]
            if len(x) < 10:
                cells.append(f"{'-':>10}")
                continue
            q = np.quantile(x, [0.1, 0.5, 0.9])
            cells.append(f"{q[0]:>3.2f}/{q[1]:>3.2f}/{q[2]:>3.2f}")
        print(f"{c:>5} {n:>7} " + " ".join(cells))

    n_ref = np.concatenate([d[2]["pre_ratio"][d[1] == "N"] for d in data])
    n_ref = n_ref[np.isfinite(n_ref)]
    for c in ("S", "V", "Q"):
        for f, sign in (("pre_ratio", -1), ("post_ratio", 1), ("sum_ratio", -1)):
            p = np.concatenate([d[2][f][d[1] == c] for d in data])
            p = p[np.isfinite(p)]
            if len(p) < 10:
                continue
            # sign -1: lower ratio = more premature = higher score
            sc = sign * p if sign == 1 else -p
            ref = n_ref if sign == 1 else -n_ref
            print(f"AUC {c} vs N by {f:>10}: {auc(sc, ref):.3f}"
                  f"   (n={len(p):,})")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--records", nargs="*", default=[])
    ap.add_argument("--split", choices=["val", "train"], default="")
    ap.add_argument("--n", type=int, default=4000, help="0 = every beat")
    ap.add_argument("--per-record", action="store_true",
                    help="also print each record's own AUC")
    args = ap.parse_args()

    records = list(args.records)
    if args.split:
        tr = Path("../data/models/beatcnn.train.json")
        import json
        d = json.loads(tr.read_text(encoding="utf-8"))
        key = "val_records" if args.split == "val" else "train_records"
        records += d[key]
    if not records:
        raise SystemExit("give --records ... or --split val|train")

    data = load(records, args.n)
    report(data, f"{len(records)} records, up to {args.n or 'all'} beats each")

    if args.per_record:
        print("\n=== per record, AUC S vs N by pre_ratio ===")
        for r, syms, f in data:
            p = f["pre_ratio"][syms == "S"]
            q = f["pre_ratio"][syms == "N"]
            p, q = p[np.isfinite(p)], q[np.isfinite(q)]
            if len(p) < 10 or len(q) < 10:
                print(f"  {r}  too few S ({len(p)})")
                continue
            print(f"  {r}  n_S={len(p):5d}  n_N={len(q):6d}  AUC {auc(-p, -q):.3f}")


if __name__ == "__main__":
    main()
