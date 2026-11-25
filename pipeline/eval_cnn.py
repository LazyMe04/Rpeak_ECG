"""Per-patient evaluation of the trained beat CNN.

`train_cnn.py` reports pooled numbers over the six held-out patients. Pooled
numbers hide the thing a reader most needs to know: how much the score varies
between people. A class can look respectable in aggregate while one patient
contributes almost all of its true positives, which means the model recognises
one patient's rhythm rather than the rhythm.

This script re-runs the best checkpoint on each held-out patient separately and
prints the spread. It reads the validation record list from the checkpoint's
sidecar (`<ckpt>.train.json`) unless `--val-records` overrides it, so the
patient set is the one the model was never trained on by construction.

Usage:
  python -I eval_cnn.py --checkpoint ../data/models/beatcnn.pt
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


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--checkpoint", default="../data/models/beatcnn.pt")
    ap.add_argument("--val-records", nargs="*", default=None,
                    help="override the record list stored beside the checkpoint")
    ap.add_argument("--out", default=None, help="write the per-patient table as JSON")
    args = ap.parse_args()

    ck = torch.load(args.checkpoint, map_location="cpu", weights_only=False)
    extra = ck.get("extra") or {"kind": "none"}
    kind = extra.get("kind") or "none"
    extra_dim = 0 if kind == "none" else (3 if kind == "rr" else 1)
    model = BeatCNN(n_classes=len(AAMI_CLASSES), dropout=ck["args"]["dropout"],
                    extra_dim=extra_dim)
    model.load_state_dict(ck["state"])
    model.eval()

    records = args.val_records
    if not records:
        side = Path(args.checkpoint).with_suffix("")
        side = side.parent / (side.name + ".train.json")
        if not side.exists():
            raise SystemExit(f"no record list: pass --val-records (looked for {side})")
        records = json.loads(side.read_text())["val_records"]

    sh = load_shards(records)
    X, y, p = sh.X, sh.y, sh.p
    E = standardise(extra_matrix(sh, kind), extra, sh.rec)
    pooled = evaluate(model, X, E, y)
    print(f"pooled: {len(y)} beats, accuracy {pooled['accuracy']:.4f}, "
          f"macro-F1 {pooled['macro_f1']:.4f}\n")

    header = f"{'patient':>8} {'beats':>7}"
    for c in AAMI_CLASSES:
        header += f"  {c + ' Se':>6} {c + ' PPV':>7}"
    header += "   macroF1"
    print(header)

    per_patient = {}
    for pid in sorted(set(p.tolist())):
        m = p == pid
        ev = evaluate(model, X[m], E[m], y[m])
        row = f"{pid:>8} {int(m.sum()):>7}"
        for c in AAMI_CLASSES:
            v = ev["per_class"][c]
            row += f"  {v['se'] * 100:>5.1f}% {v['ppv'] * 100:>6.1f}%"
        row += f"   {ev['macro_f1']:.3f}"
        print(row)
        per_patient[str(pid)] = ev

    f1s = np.array([v["macro_f1"] for v in per_patient.values()])
    print(f"\nmacro-F1 across patients: mean {f1s.mean():.3f}, "
          f"worst {f1s.min():.3f}, best {f1s.max():.3f}")

    if args.out:
        Path(args.out).write_text(json.dumps(
            {"pooled": pooled, "per_patient": per_patient}, indent=1), encoding="utf-8")
        print(f"wrote {args.out}")


if __name__ == "__main__":
    main()
