"""Error taxonomy for the detector.

Classifies every false positive and false negative so that tuning targets the
dominant failure mode instead of guessing from plots.

Categories:
  FP-near    detection within 2x tolerance of a TP -> double detection
  FP-far     detection with no reference beat nearby -> noise
  FN-early   missed beat whose previous RR is short -> refractory/merge issue
  FN-late    missed beat whose previous RR is long -> low amplitude
  FN-normal  missed beat with ordinary RR -> threshold too high

Usage: python -I error_taxonomy.py [--record NAME] [--all]
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from config import CATALOG  # noqa: E402
from detect import bandpass, load, refine  # noqa: E402
from detect2 import detect  # noqa: E402


def match_lists(ref: np.ndarray, det: np.ndarray, tol: int):
    """Return (tp_pairs, fn_ref_indices, fp_det_indices)."""
    used = np.zeros(len(ref), dtype=bool)
    tp_ref, tp_det = [], []
    j = 0
    for di, d in enumerate(det):
        while j < len(ref) and ref[j] < d - tol:
            j += 1
        k = j
        while k < len(ref) and ref[k] <= d + tol:
            if not used[k]:
                used[k] = True
                tp_ref.append(k)
                tp_det.append(di)
                break
            k += 1
    fn = np.where(~used)[0]
    fp = np.setdiff1d(np.arange(len(det)), np.array(tp_det, dtype=int))
    return np.array(tp_ref, dtype=int), np.array(tp_det, dtype=int), fn, fp


def analyse(record: str, fs: int = 250, tol_ms: float = 50) -> dict:
    sig, ref, fs, _ = load(record)
    det, _ = detect(sig, fs)
    det = refine(det, bandpass(sig, fs, 0.5, 40.0), fs)
    tol = int(tol_ms / 1000 * fs)

    tp_ref, tp_det, fn, fp = match_lists(ref, det, tol)
    rr_ref = np.diff(ref)
    med_rr = float(np.median(rr_ref)) if len(rr_ref) else fs

    # classify FPs
    fp_near = fp_far = 0
    near_dists = []
    for i in fp:
        d = det[i]
        k = np.searchsorted(ref, d)
        cand = [ref[k - 1] if k > 0 else None, ref[k] if k < len(ref) else None]
        cand = [c for c in cand if c is not None]
        dist = min(abs(int(c) - int(d)) for c in cand)
        near_dists.append(dist)
        if dist < 2 * tol:
            fp_near += 1
        else:
            fp_far += 1

    # classify FNs
    fn_early = fn_late = fn_norm = 0
    for i in fn:
        prev_gap = ref[i] - ref[i - 1] if i > 0 else med_rr
        if prev_gap < 0.7 * med_rr:
            fn_early += 1
        elif prev_gap > 1.35 * med_rr:
            fn_late += 1
        else:
            fn_norm += 1

    return {
        "record": record,
        "n_ref": len(ref),
        "n_det": len(det),
        "tp": len(tp_ref),
        "fp": len(fp),
        "fn": len(fn),
        "se": round(100 * len(tp_ref) / max(len(ref), 1), 2),
        "ppv": round(100 * len(tp_ref) / max(len(det), 1), 2),
        "fp_near": fp_near,
        "fp_far": fp_far,
        "fn_early": fn_early,
        "fn_late": fn_late,
        "fn_norm": fn_norm,
        "med_rr_s": round(med_rr / fs, 3),
        "med_fp_dist_ms": round(1000 * float(np.median(near_dists)) / fs, 1) if near_dists else 0,
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--record")
    ap.add_argument("--all", action="store_true")
    args = ap.parse_args()

    index = json.loads((CATALOG / "f32" / "index.json").read_text())
    recs = [args.record] if args.record else [s["record"] for s in index] if args.all else []

    print(f"{'record':14} {'Se':>6} {'PPV':>6} {'fp':>5} {'fp~':>5} {'fpX':>4} "
          f"{'fn':>5} {'fn<':>4} {'fn>':>4} {'fn=':>4} {'medRR':>6}")
    print("-" * 82)
    rows = []
    for r in recs:
        try:
            o = analyse(r)
            rows.append(o)
            print(f"{o['record']:14} {o['se']:6.2f} {o['ppv']:6.2f} {o['fp']:5d} "
                  f"{o['fp_near']:5d} {o['fp_far']:4d} {o['fn']:5d} {o['fn_early']:4d} "
                  f"{o['fn_late']:4d} {o['fn_norm']:4d} {o['med_rr_s']:6.3f}")
        except Exception as e:  # noqa: BLE001
            print(f"{r:14} FAILED {e}")

    if rows:
        tot = {k: sum(x[k] for x in rows) for k in ("tp", "fp", "fn", "fp_near",
                                                    "fp_far", "fn_early", "fn_late", "fn_norm")}
        print("\n=== totals ===")
        print(f"tp={tot['tp']}  fp={tot['fp']} (near={tot['fp_near']} far={tot['fp_far']})")
        print(f"fn={tot['fn']} (early={tot['fn_early']} late={tot['fn_late']} normal={tot['fn_norm']})")
        (CATALOG / "error_taxonomy.json").write_text(json.dumps(rows, indent=1))


if __name__ == "__main__":
    main()
