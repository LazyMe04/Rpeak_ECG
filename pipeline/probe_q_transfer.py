"""Is the N/Q bias a property of the recipe, or of one checkpoint?

`probe_q_boundary.py` showed a symmetric logit bias on N and Q (b_q = -bias,
b_n = +bias, constant -1.00) lifts the shipped model's macro-F1 0.5965 -> 0.6234,
and out-of-fold over the six patients gave +0.0256, so the six did not each get
a rule of their own. That still leaves the objection G8 taught this project to
make: 0.05 macro-F1 is the run-to-run spread between two retrains of the same
recipe, so a +0.027 gain on one checkpoint could be that checkpoint's luck.

The test is to apply the *same* constant, unchanged, to every checkpoint the
recipe has produced. If the direction and rough size hold across an
extra-input-free control, a per-record log(scale) model, the G8 model and the
shipped G9 model, then the bias is a property of how these models are trained
(capped per-class batches and inverse-sqrt class weights leave the decision
boundary off the deployment prior) rather than of one lucky run. If it holds for
one and not the others, it does not ship.

Usage:
  python -I probe_q_transfer.py --bias -1.0
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


def load_model(path: Path):
    ck = torch.load(path, map_location="cpu", weights_only=False)
    extra = ck.get("extra") or {"kind": "none"}
    kind = extra.get("kind") or "none"
    m = BeatCNN(n_classes=K, dropout=ck["args"]["dropout"],
                extra_dim=DIMS.get(kind, 0))
    m.load_state_dict(ck["state"])
    m.eval()
    return m, extra, kind


@torch.no_grad()
def logits_for(model, X, S, batch: int = 512) -> np.ndarray:
    return np.concatenate([
        model(torch.from_numpy(X[i:i + batch].astype(np.float32)),
              torch.from_numpy(S[i:i + batch].astype(np.float32))).numpy()
        for i in range(0, len(X), batch)])


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--models", nargs="*", default=[
        "../data/models/beatcnn_ctrl.pt",
        "../data/models/beatcnn_rec.pt",
        "../data/models/v2/beatcnn.pt",
        "../data/models/beatcnn.pt",
    ])
    ap.add_argument("--bias", type=float, default=-1.0)
    ap.add_argument("--out", default="")
    args = ap.parse_args()

    sh = load_shards(json.loads(
        Path("../data/models/beatcnn.train.json").read_text())["val_records"])
    y = sh.y
    b = np.zeros(K)
    b[Q], b[N] = args.bias, -args.bias
    print(f"same validation set for every model: {len(y)} beats; "
          f"bias q {args.bias:+.2f}, n {-args.bias:+.2f}\n")
    print(f"{'checkpoint':28} {'extra':18} {'argmax':>8} {'biased':>8} "
          f"{'delta':>8}   N->Q            Q->N")
    rows = []
    for path in args.models:
        p = Path(path)
        if not p.exists():
            print(f"{p.name:28} missing")
            continue
        m, extra, kind = load_model(p)
        E = standardise(extra_matrix(sh, kind), extra, sh.rec)
        Z = logits_for(m, sh.X, E)
        a = metrics_from_pred(y, Z.argmax(1))
        f = metrics_from_pred(y, (Z + b).argmax(1))
        # The archive keeps G8's run as `v2/beatcnn.pt`, so the stem alone gives
        # two rows called "beatcnn". Name it by the directory it lives in.
        label = p.stem if p.parent.name == "models" else f"{p.parent.name}/{p.stem}"
        print(f"{label:28} {kind:18} {a['macro_f1']:>8.4f} "
              f"{f['macro_f1']:>8.4f} {f['macro_f1'] - a['macro_f1']:>+8.4f}   "
              f"{a['confusion'][0][3]:>6}->{f['confusion'][0][3]:<6} "
              f"{a['confusion'][3][0]:>6}->{f['confusion'][3][0]:<6}")
        rows.append({"checkpoint": label, "extra": kind,
                     "argmax": a["macro_f1"], "biased": f["macro_f1"],
                     "delta": f["macro_f1"] - a["macro_f1"],
                     "n_to_q": [a["confusion"][0][3], f["confusion"][0][3]],
                     "q_to_n": [a["confusion"][3][0], f["confusion"][3][0]],
                     "biased_per_class": {c: f["per_class"][c]["f1"]
                                          for c in AAMI_CLASSES}})

    d = np.array([r["delta"] for r in rows])
    print(f"\ndelta across {len(d)} checkpoints: mean {d.mean():+.4f}, "
          f"min {d.min():+.4f}, max {d.max():+.4f}, "
          f"all positive: {bool((d > 0).all())}")

    if args.out:
        Path(args.out).write_text(json.dumps(
            {"bias": args.bias, "rows": rows}, indent=1), encoding="utf-8")
        print(f"wrote {args.out}")


if __name__ == "__main__":
    main()
