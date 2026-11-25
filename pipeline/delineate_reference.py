"""Synthetic ECG goldens for the delineator parity test.

The app's P/QRS/T delineator has no ground truth in the dataset: icentia11k
labels beat *class*, not wave boundaries. So the delineator is scored against a
signal whose boundaries are known by construction — a sum of Gaussians, where
the P wave spans its ±3 sigma support, the QRS is the union of Q/R/S supports,
and the T wave is one wide Gaussian.

Run:
  python -I delineate_reference.py --json data/catalog/g4/synth.json
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from config import CATALOG  # noqa: E402
from hrv_reference import synth_ecg  # noqa: E402


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", type=Path, default=CATALOG / "g4" / "synth.json")
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--seconds", type=float, default=60.0)
    ap.add_argument("--rr", type=float, default=0.8)
    args = ap.parse_args()

    noisy, clean, truth, fs = synth_ecg(
        fs=250, seconds=args.seconds, rr_s=args.rr, seed=args.seed
    )
    args.json.parent.mkdir(parents=True, exist_ok=True)

    noisy.astype("<f4").tofile(args.json.with_suffix(".f32"))
    # The clean signal is what the truth was measured on. Keeping it lets a
    # reader recompute any boundary convention without regenerating the fixture.
    clean.astype("<f4").tofile(args.json.with_name(args.json.stem + ".clean.f32"))
    (args.json).write_text(
        json.dumps(
            {
                "fs": fs,
                "n": int(len(noisy)),
                "signal": args.json.with_suffix(".f32").name,
                "clean": args.json.with_name(args.json.stem + ".clean.f32").name,
                "beats": truth,
                "true_rr_s": args.rr,
                "seed": args.seed,
                "convention": {
                    "qrs": "10% of the steepest QRS slope",
                    "slow": "5% of the wave's own excursion from its local baseline",
                },
            },
            indent=1,
        ),
        encoding="utf-8",
    )
    print(f"{len(truth)} beats, {len(noisy)} samples -> {args.json}")


if __name__ == "__main__":
    main()
