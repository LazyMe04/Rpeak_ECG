"""G1 decisive test: are the icentia11k beat annotations complete?

If annotations only cover a subset of beats, using them as a gold standard for
R-peak detection yields falsely low PPV. We compare an independent detector
(wfdb's xqrs) against the annotation count.

Usage: python -I probe_completeness.py [n_segments]
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import wfdb
from wfdb import processing

sys.path.insert(0, str(Path(__file__).resolve().parent))
from config import FS, RAW  # noqa: E402


def match(ref: np.ndarray, test: np.ndarray, tol: int) -> tuple[int, int, int]:
    """Greedy nearest matching of test peaks to ref peaks within tol samples."""
    matched, used = 0, np.zeros(len(ref), dtype=bool)
    for t in test:
        lo = np.searchsorted(ref, t - tol)
        hi = np.searchsorted(ref, t + tol, side="right")
        for j in range(lo, hi):
            if not used[j]:
                used[j] = True
                matched += 1
                break
    return matched, len(test) - matched, len(ref) - int(used.sum())


def run(stem: Path) -> dict:
    rec = wfdb.rdrecord(str(stem))
    ann = wfdb.rdann(str(stem), "atr")
    sig = rec.p_signal[:, 0]

    beat_mask = np.array([s in "NSVQ" for s in ann.symbol])
    ref = ann.sample[beat_mask]

    det = processing.xqrs_detect(sig=sig, fs=rec.fs, verbose=False)

    tol = int(0.05 * rec.fs)  # 50 ms tolerance, standard for QRS matching
    tp, fp, fn = match(ref, det, tol)
    se = 100 * tp / max(len(ref), 1)
    ppv = 100 * tp / max(len(det), 1)

    # Fraction of annotated beats that are "isolated" (next annotated beat far away)
    rr = np.diff(ref)
    lonG_gaps = int((rr > 3 * FS).sum())

    return {
        "name": stem.name,
        "n_ann": len(ref),
        "n_xqrs": len(det),
        "tp": tp, "fp": fp, "fn": fn,
        "se": round(se, 2), "ppv": round(ppv, 2),
        "ratio": round(len(det) / max(len(ref), 1), 2),
        "long_gaps": lonG_gaps,
        "rate_ann": round(len(ref) / (len(sig) / FS / 60), 1),
        "rate_xqrs": round(len(det) / (len(sig) / FS / 60), 1),
    }


def main() -> None:
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 6
    stems = sorted(RAW.rglob("*.hea"))[:n]
    rows = []
    print(f"{'segment':14} {'ann':>6} {'xqrs':>6} {'ratio':>6} "
          f"{'Se%':>6} {'PPV%':>6} {'gap>3s':>7} {'bpm_ann':>8} {'bpm_xqrs':>8}")
    for h in stems:
        try:
            r = run(h.with_suffix(""))
            rows.append(r)
            print(f"{r['name']:14} {r['n_ann']:6d} {r['n_xqrs']:6d} {r['ratio']:6.2f} "
                  f"{r['se']:6.2f} {r['ppv']:6.2f} {r['long_gaps']:7d} "
                  f"{r['rate_ann']:8.1f} {r['rate_xqrs']:8.1f}")
        except Exception as e:  # noqa: BLE001
            print(f"{h.stem:14} FAILED: {e}")

    if rows:
        import pandas as pd

        df = pd.DataFrame(rows)
        print("\n=== summary ===")
        print(f"mean annotation/xqrs ratio : {df['ratio'].mean():.2f}")
        print(f"median ratio               : {df['ratio'].median():.2f}")
        print(f"xqrs finds MORE beats than annotations in "
              f"{int((df['ratio'] > 1.05).sum())}/{len(df)} segments")
        print(f"PPV of xqrs vs annotations : mean {df['ppv'].mean():.1f}%")
        print(f"Se  of xqrs vs annotations : mean {df['se'].mean():.1f}%")


if __name__ == "__main__":
    main()
