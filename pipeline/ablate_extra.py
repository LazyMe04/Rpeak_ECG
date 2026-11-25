"""Ablate the head's extra inputs on the trained checkpoint.

The extras exist because a 1 s window cannot hold everything a beat is. That is
a hypothesis, and the cheap way to test it is to keep the weights and damage
the column:

  * `zero`  -- replace the column with its training mean (standardised 0). The
    network still has the input, so this measures how much of its decision it
    takes from it.
  * `shuffle` -- permute the column across the validation set, so the marginal
    distribution is intact and only the pairing with the window is destroyed.
    The drop from the real score is the information the column carries.
  * `zero <name>` -- for a multi-column model, zero one column at a time, which
    says which cue inside the block is doing the work.

None of these is a retrain: the weights are the ones trained with the real
input, so `zero` is a mild distribution shift and should be read as a lower
bound on dependence rather than as the score of a model without the input.

This file is what turned G8 into a negative result -- `log(scale)` ablated flat
at 0.578 -> 0.577 -- and it is the gate G9's timing ratios had to pass.

Usage:
  python -I ablate_extra.py --checkpoint ../data/models/beatcnn.pt
  python -I ablate_extra.py --checkpoint ../data/models/beatcnn.pt \
      --compare ../data/models/beatcnn_ctrl.pt --out ../data/models/beatcnn.ablate.json
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
import torch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from cnn_model import BeatCNN  # noqa: E402
from config import AAMI_CLASSES  # noqa: E402
from train_cnn import (evaluate, extra_matrix, load_shards,  # noqa: E402
                       standardise)

DIMS = {"rr": 3, "log_scale": 1, "log_scale_record": 1}


def load_model(ck_path: str) -> tuple[BeatCNN, dict, dict]:
    ck = torch.load(ck_path, map_location="cpu", weights_only=False)
    extra = ck.get("extra") or {"kind": "none"}
    kind = extra.get("kind") or "none"
    m = BeatCNN(n_classes=len(AAMI_CLASSES), dropout=ck["args"]["dropout"],
                extra_dim=DIMS.get(kind, 0))
    m.load_state_dict(ck["state"])
    m.eval()
    return m, extra, ck


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--checkpoint", default="../data/models/beatcnn.pt")
    ap.add_argument("--val-records", nargs="*", default=None)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--out", default="", help="write the table as JSON for the app")
    ap.add_argument("--compare", nargs="*", default=[],
                    help="also score these checkpoints, for the run-to-run table")
    args = ap.parse_args()

    model, extra, _ = load_model(args.checkpoint)
    kind = extra.get("kind") or "none"
    names = extra.get("names") or ["log(scale)"]

    records = args.val_records
    if not records:
        side = Path(args.checkpoint).with_suffix("")
        records = json.loads(
            (side.parent / (side.name + ".train.json")).read_text())["val_records"]

    sh = load_shards(records)
    X, y = sh.X, sh.y
    E = standardise(extra_matrix(sh, kind), extra, sh.rec)

    rng = np.random.default_rng(args.seed)
    variants: dict[str, np.ndarray] = {
        "real": E,
        "zero (training mean)": np.zeros_like(E),
        "shuffle": E[rng.permutation(len(E))],
    }
    if E.shape[1] > 1:
        for j, name in enumerate(names):
            v = E.copy()
            v[:, j] = 0.0
            variants[f"zero {name}"] = v

    print(f"{'variant':22} {'acc':>7} {'macroF1':>8}  "
          + "  ".join(f"{c + ' F1':>6}" for c in AAMI_CLASSES))
    table = {"extra": extra, "checkpoint": str(args.checkpoint), "rows": []}
    base = None
    for name, ev_in in variants.items():
        ev = evaluate(model, X, ev_in, y)
        print(f"{name:22} {ev['accuracy']:>7.4f} {ev['macro_f1']:>8.4f}  "
              + "  ".join(f"{ev['per_class'][c]['f1']:>6.3f}" for c in AAMI_CLASSES))
        table["rows"].append({"variant": name, "accuracy": ev["accuracy"],
                              "macro_f1": ev["macro_f1"],
                              "per_class": {c: ev["per_class"][c]["f1"]
                                            for c in AAMI_CLASSES}})
        if base is None:
            base = ev
        else:
            d = {c: ev["per_class"][c]["f1"] - base["per_class"][c]["f1"]
                 for c in AAMI_CLASSES}
            table["rows"][-1]["delta_f1"] = d
            print(f"{'':22} delta F1 vs real: " + ", ".join(
                f"{c} {v:+.3f}" for c, v in d.items()))

    if args.compare:
        table["runs"] = []
        print("\nrun-to-run comparison (same data, split and seed):")
        print(f"{'checkpoint':30} {'extra':18} {'acc':>7} {'macroF1':>8}")
        for path in args.compare:
            m2, e2, _ = load_model(path)
            kind2 = e2.get("kind") or "none"
            E2 = standardise(extra_matrix(sh, kind2), e2, sh.rec)
            ev = evaluate(m2, X, E2, y)
            name = Path(path).stem
            print(f"{name:30} {str(kind2):18} {ev['accuracy']:>7.4f} "
                  f"{ev['macro_f1']:>8.4f}")
            table["runs"].append({"checkpoint": name, "extra": kind2,
                                  "accuracy": ev["accuracy"],
                                  "macro_f1": ev["macro_f1"]})

    if args.out:
        Path(args.out).write_text(json.dumps(table, indent=1), encoding="utf-8")
        print(f"wrote {args.out}")


if __name__ == "__main__":
    main()
