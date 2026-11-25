"""Does a bias derived from the training set match the one tuned on eval?

`probe_q_boundary.py` finds that a symmetric logit bias on N and Q (rule `qn`,
constant -1.00) lifts pooled macro-F1 0.5965 -> 0.6234. Two things make that
number untrustworthy on its own:

  * -1.00 was picked by looking at the six held-out patients, which is the
    thing every ablation in this project exists to prevent;
  * the per-patient change ranges from +0.085 to -0.037, because Q is 1.0% of
    p00019 and 35.8% of p00114. One constant cannot be right for both.

So the rule a reviewer would accept is the one that needs no validation labels:
the model is trained with inverse-sqrt class weights and sees a capped,
balanced-per-class batch distribution, so its implied prior is not the
deployment prior, and the textbook correction is

    bias_c = log(q_train(c)) - log(1/K)

with `q_train` the class frequency of the *training* records. If that lands on
the same constant the eval sweep likes, the gain is not a fitted artefact.

Reported here: the role-reversal prior correction on its own, at several
strengths, plus the same correction made per record (no per-record labels
either -- the strength is still the one constant, only the direction adapts).

Usage:
  python -I probe_q_prior.py
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
N = AAMI_CLASSES.index("N")
Q = AAMI_CLASSES.index("Q")
K = len(AAMI_CLASSES)


def load_model(path: str):
    ck = torch.load(path, map_location="cpu", weights_only=False)
    extra = ck.get("extra") or {"kind": "none"}
    kind = extra.get("kind") or "none"
    m = BeatCNN(n_classes=K, dropout=ck["args"]["dropout"],
                extra_dim=DIMS.get(kind, 0))
    m.load_state_dict(ck["state"])
    m.eval()
    return m, extra, kind, ck


@torch.no_grad()
def logits_for(model, X, S, batch: int = 512) -> np.ndarray:
    return np.concatenate([
        model(torch.from_numpy(X[i:i + batch].astype(np.float32)),
              torch.from_numpy(S[i:i + batch].astype(np.float32))).numpy()
        for i in range(0, len(X), batch)])


def show(tag: str, y: np.ndarray, pred: np.ndarray) -> dict:
    ev = metrics_from_pred(y, pred)
    print(f"{tag:38} acc {ev['accuracy']:.4f}  macro-F1 {ev['macro_f1']:.4f}"
          f"  N->Q {ev['confusion'][0][3]:>5}  Q->N {ev['confusion'][3][0]:>5}"
          "   " + "  ".join(f"{c} {ev['per_class'][c]['f1']:.3f}"
                             for c in AAMI_CLASSES))
    return ev


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--checkpoint", default="../data/models/beatcnn.pt")
    ap.add_argument("--out", default="")
    args = ap.parse_args()

    model, extra, kind, ck = load_model(args.checkpoint)
    side = Path(args.checkpoint).with_suffix("")
    splits = json.loads((side.parent / (side.name + ".train.json")).read_text())
    val_records = splits["val_records"]

    # Training prior, from the training shards themselves.
    tr = load_shards(splits["train_records"])
    q_train = np.bincount(tr.y, minlength=K) / len(tr.y)
    print("training prior: " + "  ".join(f"{c} {v:.3f}"
                                         for c, v in zip(AAMI_CLASSES, q_train)))
    b_prior = np.log(q_train) - np.log(1.0 / K)
    print("implied bias log(q_train) - log(1/K): "
          + "  ".join(f"{c} {v:+.3f}" for c, v in zip(AAMI_CLASSES, b_prior)),
          "\n")

    sh = load_shards(val_records)
    E = standardise(extra_matrix(sh, kind), extra, sh.rec)
    Z = logits_for(model, sh.X, E)
    y, p = sh.y, sh.p

    base = show("argmax", y, Z.argmax(1))
    out = {"training_prior": q_train.tolist(),
           "prior_bias": b_prior.tolist(),
           "argmax": {"accuracy": base["accuracy"],
                      "macro_f1": base["macro_f1"]}}

    print("\nfull prior correction, several strengths "
          "(s = 0 is no change, s = 1 is the textbook bias):")
    rows = []
    for s in (0.25, 0.5, 0.75, 1.0, 1.25):
        ev = show(f"s = {s:.2f}", y, (Z + s * b_prior).argmax(1))
        rows.append({"strength": s, "accuracy": ev["accuracy"],
                     "macro_f1": ev["macro_f1"],
                     "n_to_q": ev["confusion"][0][3],
                     "q_to_n": ev["confusion"][3][0]})
    out["prior_correction"] = rows

    # The G9 rule for comparison, same six patients, no tuning here either.
    print("\nsymmetric qn for comparison:")
    try:
        qb = json.loads((side.parent / (side.name + ".qboundary.json"))
                        .read_text())["fixed_qn"]
        for k in ("-1.0", "-0.75"):
            if k in qb:
                print(f"  fixed bias {float(k):+.2f}  acc "
                      f"{qb[k]['accuracy']:.4f}  macro-F1 "
                      f"{qb[k]['macro_f1']:.4f}")
                out.setdefault("qn_fixed", {})[k] = {
                    "accuracy": qb[k]["accuracy"],
                    "macro_f1": qb[k]["macro_f1"]}
    except FileNotFoundError:
        print("  (run probe_q_boundary.py --out first)")

    if args.out:
        Path(args.out).write_text(json.dumps(out, indent=1), encoding="utf-8")
        print(f"\nwrote {args.out}")


if __name__ == "__main__":
    main()
