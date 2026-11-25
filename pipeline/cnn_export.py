"""Export the trained beat CNN to the app's inference format.

The app has no ONNX runtime and adding one is a 3rd-party bundle in a project
whose whole premise is a readable, self-contained rebuild. Instead the weights
travel as plain JSON and a hand-written forward pass in TypeScript runs them
(`app/src/lib/ecg/cnn.ts`). That is viable only if the two implementations are
kept honest, so this exporter also writes the exact activation it computed for
a handful of held-out windows; `app/scripts/test-cnn.ts` re-runs the same
windows through the TypeScript path and compares logits.

Layout of the JSON, chosen so the TypeScript reader is a loop rather than a
framework:
  {
    "version": 2,
    "window": 250, "fs": 250, "pre": 100,
    "classes": ["N","S","V","Q"],
    "norm": {"method": "median-q90-core", "core": [-50, 100],
             "quantile": 0.9, "floor": 0.01},
    "extra": {"kind": "rr", "names": [...], "center": [...], "std": [...]},
    "blocks": [
      {"conv": {"w": [cout][cin][k], "b": [cout]}, "act": "relu", "pool": 4}
    ],
    "head": [{"w": [out][in], "b": [out], "act": "relu"|null}, ...],
    "parity": [{"raw": [250 floats], "logits": [4 floats],
                "rr": {"peaks": [51 samples], "index": 25, "z": [3 floats]}}]
  }

`extra` says how to build the head's extra inputs, which a 1 s window cannot
hold. Two kinds have shipped: `rr` (three timing ratios, derived by the app from
the surrounding peaks, standardised by the stored centre and spread) and
`log_scale` / `log_scale_record` (the amplitude the normaliser divides away).
Version 1 had no such input; the app rejects a head whose width disagrees with
the document, so a stale JSON cannot silently misalign.

Usage:
  python -I cnn_export.py --checkpoint ../data/models/beatcnn.pt \
      --out ../data/models/beatcnn.json
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
import torch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_beats import RR_HALF, beat_list, cut  # noqa: E402
from cnn_model import ARCH, BeatCNN  # noqa: E402
from config import AAMI_CLASSES, BEATS, CATALOG  # noqa: E402


def bn_fold(conv_w: torch.Tensor, sd: dict, i: int, eps: float) -> tuple[np.ndarray, np.ndarray]:
    """Fold BatchNorm into the preceding conv.

    Folding removes four tensors per block from the runtime and one whole class
    of bug: the app never has to remember whether BN runs before or after the
    activation. The maths is exact in eval mode, which is the only mode the app
    uses.
    """
    gamma = sd[f"features.{i}.bn.weight"]
    beta = sd[f"features.{i}.bn.bias"]
    mean = sd[f"features.{i}.bn.running_mean"]
    var = sd[f"features.{i}.bn.running_var"]

    std = torch.sqrt(var + eps)
    scale = gamma / std  # (cout,)
    w = conv_w * scale[:, None, None]
    b = beta - mean * scale
    return w.numpy().astype(np.float32), b.numpy().astype(np.float32)


def export(ckpt_path: str, out_path: str, n_parity: int = 8) -> dict:
    ck = torch.load(ckpt_path, map_location="cpu", weights_only=False)
    a = ck["args"]
    extra = ck.get("extra") or {"kind": "none", "center": 0.0, "std": 1.0}
    kind = extra.get("kind") or "none"
    extra_dim = {"rr": 3, "log_scale": 1, "log_scale_record": 1}.get(kind, 0)
    model = BeatCNN(n_classes=len(AAMI_CLASSES), dropout=a["dropout"],
                    extra_dim=extra_dim)
    model.load_state_dict(ck["state"])
    model.eval()

    blocks = []
    sd = ck["state"]
    n_blocks = len(ARCH)
    for i in range(n_blocks):
        w = sd[f"features.{i}.conv.weight"]
        cw, cb = bn_fold(w, sd, i, eps=1e-5)
        blocks.append({"conv": {"w": cw.tolist(), "b": cb.tolist()},
                       "act": "relu", "pool": ARCH[i][3]})

    head = []
    # head.0 Linear -> ReLU -> head.3 Linear
    for li, act in ((0, "relu"), (3, None)):
        head.append({"w": sd[f"head.{li}.weight"].numpy().astype(np.float32).tolist(),
                     "b": sd[f"head.{li}.bias"].numpy().astype(np.float32).tolist(),
                     "act": act})

    # Parity windows: taken from the validation records, which the network saw
    # only through the metric. Deliberately not training windows.
    #
    # Each row carries the window *before* normalisation, so the TypeScript test
    # re-runs the whole chain -- normalise, log(scale), standardise, forward --
    # rather than starting from an input Python already prepared. A shape check
    # would catch none of those, and a wrong one degrades every classification
    # without throwing. For the per-record transform the row also carries the
    # record's centre and spread, because the app derives those from the segment
    # it is classifying and the test has to be able to reproduce them.
    #
    # For the timing ratios the row carries the surrounding *peak positions*
    # instead of the ratios themselves, so the test calls the app's own
    # `rrFeatures` -- median and all -- on a real peak sequence rather than
    # checking only the standardisation of a number Python computed.
    val_records = ck["args"].get("val_records") or []
    parity = []
    per_rec = max(1, n_parity // max(1, min(4, len(val_records))))
    for r in val_records[:4]:
        p = BEATS / f"{r}.npz"
        if not p.exists():
            continue
        d = np.load(p)
        X, P = d["X"], d["p"]
        n = len(X)
        if n < 2 * RR_HALF + 10:
            continue
        S = d["S"] if "S" in d.files else np.zeros(n, np.float32)
        R = d["R"] if "R" in d.files else np.full((n, 3), 1.0, np.float32)
        full = np.array([s for s, _ in beat_list(r)], dtype=np.int64)
        sig = np.fromfile(CATALOG / "f32" / f"{r}.f32", dtype=np.float32)
        picks = np.linspace(int(0.15 * n), int(0.85 * n), num=per_rec).astype(int)
        for i in picks:
            i = int(np.clip(i, 0, n - 1))
            z = None
            if extra_dim:
                if kind == "rr":
                    z = ((R[i] - np.asarray(extra["center"], np.float32))
                         / np.asarray(extra["std"], np.float32))
                elif kind == "log_scale":
                    z = np.array([(S[i] - extra["center"]) / extra["std"]], np.float32)
                else:  # log_scale_record
                    med = float(np.median(S))
                    z = np.array([(S[i] - med) / (float(S.std()) or 1.0)], np.float32)
            with torch.no_grad():
                xb = torch.from_numpy(X[i:i + 1])
                if z is None:
                    logits = model(xb)[0].numpy()
                else:
                    logits = model(xb, torch.from_numpy(np.asarray(z)[None]))[0].numpy()
            row = {"raw": cut(sig, int(P[i])).astype(np.float32).tolist(),
                   "logits": logits.astype(np.float32).tolist()}
            if kind == "rr":
                j = int(np.searchsorted(full, int(P[i])))
                # One peak beyond the median window at each end: the interval
                # *into* the first peak of the window needs the peak before it,
                # or that interval is NaN inside the slice and the median
                # silently loses a value Python used.
                j = int(np.clip(j, RR_HALF + 1, len(full) - RR_HALF - 2))
                row["rr"] = {"peaks": full[j - RR_HALF - 1:j + RR_HALF + 2].tolist(),
                             "index": RR_HALF + 1,
                             "z": z.astype(np.float32).tolist()}
            elif extra_dim:
                row["extra"] = float(z[0])
                if kind == "log_scale_record":
                    med = float(np.median(S))
                    row["record"] = {"name": r, "center": med,
                                     "std": float(S.std()) or 1.0}
            parity.append(row)

    doc = {
        "version": 2,
        "window": 250, "fs": 250, "pre": 100,
        "classes": AAMI_CLASSES,
        "norm": {"method": "median-q90-core", "core": [-50, 100],
                 "quantile": 0.9, "floor": 0.01},
        "extra": extra if extra_dim else None,
        "extra_dim": extra_dim,
        "blocks": blocks,
        "head": head,
        "training": {
            "best_epoch": ck.get("epoch"),
            "val_accuracy": ck.get("metrics", {}).get("accuracy"),
            "val_macro_f1": ck.get("metrics", {}).get("macro_f1"),
            "train_records": ck["args"].get("train_records"),
        },
        "parity": parity,
    }
    Path(out_path).parent.mkdir(parents=True, exist_ok=True)
    Path(out_path).write_text(json.dumps(doc), encoding="utf-8")
    size = Path(out_path).stat().st_size
    print(f"wrote {out_path}  ({size/1024:.0f} KB, {len(parity)} parity windows)")
    return doc


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--checkpoint", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--parity", type=int, default=8)
    args = ap.parse_args()
    export(args.checkpoint, args.out, args.parity)


if __name__ == "__main__":
    main()
