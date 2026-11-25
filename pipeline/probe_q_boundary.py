"""Is the N -> Q error a threshold problem? Measure before believing it.

G8 and G9 both ended the same way: an argument about a missing input was
proposed, measured, and only one of the two survived its ablation. The N -> Q
cell is now the largest single error class (16,682 normal beats called Q) and
`docs/classifier.md` says what is left is "a decision boundary, not a missing
input". That is a claim, and this script is what tests it.

The claim is only worth acting on if a decision rule tuned on some patients
still helps on patients it was not tuned on. So the grid is scored out of fold:
tune on five held-out patients, apply the rule to the sixth, rotate through all
six, and compare the out-of-fold macro-F1 against the plain argmax. Anything a
single pooled sweep gains but the out-of-fold sweep does not is the rule fitting
the six patients, which is the exact failure mode this project has already
caught twice.

Rules tried, all of them post-hoc on the same logits so no retrain is involved:

  * `q`   -- add a constant to Q's logit and nothing else. Cheap, one number,
    and it directly moves the N <-> Q line.
  * `qn`  -- add a constant to Q and the opposite to N. A bias on Q alone is
    absorbed by the softmax as a prior shift; moving N the other way lets the
    rule trade the two errors against each other rather than only shrinking Q.

Usage:
  python -I probe_q_boundary.py --checkpoint ../data/models/beatcnn.pt
  python -I probe_q_boundary.py --out ../data/models/beatcnn.qboundary.json
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
import torch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from config import AAMI_CLASSES  # noqa: E402
from cnn_model import BeatCNN  # noqa: E402
from train_cnn import (extra_matrix, load_shards, metrics_from_pred,  # noqa: E402
                       standardise)

DIMS = {"rr": 3, "log_scale": 1, "log_scale_record": 1}
Q = AAMI_CLASSES.index("Q")
N = AAMI_CLASSES.index("N")


def load_model(path: str):
    ck = torch.load(path, map_location="cpu", weights_only=False)
    extra = ck.get("extra") or {"kind": "none"}
    kind = extra.get("kind") or "none"
    m = BeatCNN(n_classes=len(AAMI_CLASSES), dropout=ck["args"]["dropout"],
                extra_dim=DIMS.get(kind, 0))
    m.load_state_dict(ck["state"])
    m.eval()
    return m, extra, kind


@torch.no_grad()
def logits_for(model, X, S, batch: int = 512) -> np.ndarray:
    out = [model(torch.from_numpy(X[i:i + batch].astype(np.float32)),
                 torch.from_numpy(S[i:i + batch].astype(np.float32))).numpy()
           for i in range(0, len(X), batch)]
    return np.concatenate(out)


def apply_rule(Z: np.ndarray, bias: np.ndarray) -> np.ndarray:
    return (Z + bias).argmax(1)


def sweep(Z: np.ndarray, y: np.ndarray, rule: str, grid) -> tuple[np.ndarray, float]:
    """Best bias on this subset, and its macro-F1."""
    best_b, best_f1 = np.zeros(len(AAMI_CLASSES)), -1.0
    for v in grid:
        b = np.zeros(len(AAMI_CLASSES))
        b[Q] = v
        if rule == "qn":
            b[N] = -v
        f1 = metrics_from_pred(y, apply_rule(Z, b))["macro_f1"]
        if f1 > best_f1:
            best_b, best_f1 = b, f1
    return best_b, best_f1


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--checkpoint", default="../data/models/beatcnn.pt")
    ap.add_argument("--val-records", nargs="*", default=None)
    ap.add_argument("--grid", type=float, nargs="*",
                    default=[-2.0, -1.5, -1.25, -1.0, -0.75, -0.5, -0.25, 0.0,
                             0.25, 0.5, 0.75, 1.0])
    ap.add_argument("--out", default="")
    ap.add_argument("--fixed", type=float, nargs="*", default=[-1.0, -0.75],
                    help="pooled score at these single constants, rule qn, plus "
                         "the per-patient table for the first of them")
    args = ap.parse_args()

    records = args.val_records
    if not records:
        side = Path(args.checkpoint).with_suffix("")
        records = json.loads(
            (side.parent / (side.name + ".train.json")).read_text())["val_records"]

    model, extra, kind = load_model(args.checkpoint)
    sh = load_shards(records)
    E = standardise(extra_matrix(sh, kind), extra, sh.rec)
    Z = logits_for(model, sh.X, E)
    y = sh.y
    p = sh.p
    patients = sorted(set(p.tolist()))

    real = metrics_from_pred(y, Z.argmax(1))
    print(f"pooled argmax: acc {real['accuracy']:.4f}  macro-F1 "
          f"{real['macro_f1']:.4f}  (N->Q {real['confusion'][0][3]}, "
          f"Q->N {real['confusion'][3][0]})\n")

    # A prior shift on one class is close to monotone in that class's count, so
    # the curve is worth seeing before the out-of-fold numbers. Both sweeps are
    # recorded; `pooled_sweep` is the symmetric rule the analysis and the app
    # talk about, `pooled_sweep_q_only` is the one-sided baseline.
    print("pooled sweep, rule = q only (tuned and scored on all six patients):")
    print(f"{'bias':>6} {'acc':>7} {'macroF1':>8}  "
          + "  ".join(f"{c + ' F1':>6}" for c in AAMI_CLASSES)
          + f"  {'N->Q':>6}")
    pooled_q = []
    for v in args.grid:
        b = np.zeros(len(AAMI_CLASSES))
        b[Q] = v
        ev = metrics_from_pred(y, apply_rule(Z, b))
        print(f"{v:>6.2f} {ev['accuracy']:>7.4f} {ev['macro_f1']:>8.4f}  "
              + "  ".join(f"{ev['per_class'][c]['f1']:>6.3f}" for c in AAMI_CLASSES)
              + f"  {ev['confusion'][0][3]:>6}")
        pooled_q.append({"bias": v, "accuracy": ev["accuracy"],
                         "macro_f1": ev["macro_f1"],
                         "n_to_q": ev["confusion"][0][3],
                         "per_class": {c: ev["per_class"][c]["f1"]
                                       for c in AAMI_CLASSES}})

    print("\npooled sweep, rule = qn (Q and N move in opposite directions):")
    print(f"{'bias':>6} {'acc':>7} {'macroF1':>8}  "
          + "  ".join(f"{c + ' F1':>6}" for c in AAMI_CLASSES)
          + f"  {'N->Q':>6} {'Q->N':>6}")
    pooled_rows = []
    for v in args.grid:
        b = np.zeros(len(AAMI_CLASSES))
        b[Q], b[N] = v, -v
        ev = metrics_from_pred(y, apply_rule(Z, b))
        print(f"{v:>6.2f} {ev['accuracy']:>7.4f} {ev['macro_f1']:>8.4f}  "
              + "  ".join(f"{ev['per_class'][c]['f1']:>6.3f}" for c in AAMI_CLASSES)
              + f"  {ev['confusion'][0][3]:>6} {ev['confusion'][3][0]:>6}")
        pooled_rows.append({"bias": v, "accuracy": ev["accuracy"],
                            "macro_f1": ev["macro_f1"],
                            "n_to_q": ev["confusion"][0][3],
                            "q_to_n": ev["confusion"][3][0],
                            "per_class": {c: ev["per_class"][c]["f1"]
                                          for c in AAMI_CLASSES}})

    print("\nout of fold -- tune on five patients, score the sixth, per rule:")
    oof = {}
    for rule in ("q", "qn"):
        tuned, preds = [], np.empty_like(y)
        for pid in patients:
            train_m = p != pid
            b, f1_in = sweep(Z[train_m], y[train_m], rule, args.grid)
            test_m = p == pid
            preds[test_m] = apply_rule(Z[test_m], b)
            tuned.append({"patient": int(pid), "bias": float(b[Q]),
                          "f1_in_fold": f1_in})
            print(f"  {rule}  held out {pid}: bias {b[Q]:+.2f} "
                  f"(in-fold {f1_in:.4f})")
        ev = metrics_from_pred(y, preds)
        base = real["macro_f1"]
        print(f"  {rule}: out-of-fold acc {ev['accuracy']:.4f}  macro-F1 "
              f"{ev['macro_f1']:.4f}  ({ev['macro_f1'] - base:+.4f} vs argmax)\n")
        oof[rule] = {"accuracy": ev["accuracy"], "macro_f1": ev["macro_f1"],
                     "delta_vs_argmax": ev["macro_f1"] - base,
                     "n_to_q": ev["confusion"][0][3],
                     "q_to_n": ev["confusion"][3][0],
                     "per_class": {c: ev["per_class"][c] for c in AAMI_CLASSES},
                     "folds": tuned}

    # A rule that ships has to be one constant, not one number per fold. Score
    # the fixed constants straight onto every patient and check the gain is not
    # carried by one of the six.
    fixed = {}
    if args.fixed:
        print("fixed constant, rule qn, pooled over all six (no tuning):")
        print(f"{'bias':>6} {'acc':>7} {'macroF1':>8}  "
              + "  ".join(f"{c + ' F1':>6}" for c in AAMI_CLASSES)
              + f"  {'N->Q':>6} {'Q->N':>6}")
        for v in args.fixed:
            b = np.zeros(len(AAMI_CLASSES))
            b[Q], b[N] = v, -v
            ev = metrics_from_pred(y, apply_rule(Z, b))
            print(f"{v:>6.2f} {ev['accuracy']:>7.4f} {ev['macro_f1']:>8.4f}  "
                  + "  ".join(f"{ev['per_class'][c]['f1']:>6.3f}"
                              for c in AAMI_CLASSES)
                  + f"  {ev['confusion'][0][3]:>6} {ev['confusion'][3][0]:>6}")
            fixed[v] = ev

        v0 = args.fixed[0]
        b = np.zeros(len(AAMI_CLASSES))
        b[Q], b[N] = v0, -v0
        print(f"\nper patient at bias {v0:+.2f} (rule qn): "
              f"argmax -> fixed")
        rows = []
        for pid in patients:
            m = p == pid
            a = metrics_from_pred(y[m], Z[m].argmax(1))
            f = metrics_from_pred(y[m], apply_rule(Z[m], b))
            print(f"  {pid}: {a['macro_f1']:.4f} -> {f['macro_f1']:.4f} "
                  f"({f['macro_f1'] - a['macro_f1']:+.4f})")
            rows.append({"patient": int(pid), "argmax": a["macro_f1"],
                         "fixed": f["macro_f1"]})
        fixed["per_patient"] = rows

        # The constant each patient would choose for itself. If the ones that
        # want a big bias are the ones whose recording is mostly unusable, the
        # rule is a per-recording prior and one constant cannot serve both.
        print("\nbest constant per patient (rule qn, scored on that patient "
              "alone -- an upper bound, not a rule):")
        own = []
        for pid in patients:
            m = p == pid
            best_v, best_f1 = 0.0, -1.0
            for v in args.grid:
                bb = np.zeros(len(AAMI_CLASSES))
                bb[Q], bb[N] = v, -v
                f1 = metrics_from_pred(y[m], apply_rule(Z[m], bb))["macro_f1"]
                if f1 > best_f1:
                    best_v, best_f1 = v, f1
            base = metrics_from_pred(y[m], Z[m].argmax(1))["macro_f1"]
            print(f"  {pid}: {best_f1:.4f} at bias {best_v:+.2f} "
                  f"({best_f1 - base:+.4f})")
            own.append({"patient": int(pid), "bias": best_v,
                        "macro_f1": best_f1, "delta": best_f1 - base})
        fixed["best_per_patient"] = own

    if args.out:
        Path(args.out).write_text(json.dumps(
            {"checkpoint": str(args.checkpoint), "grid": args.grid,
             "real": real, "pooled_sweep": pooled_rows,
             "pooled_sweep_q_only": pooled_q, "out_of_fold": oof,
             "fixed_qn": {str(k): v for k, v in fixed.items()}},
            indent=1), encoding="utf-8")
        print(f"wrote {args.out}")


if __name__ == "__main__":
    main()
