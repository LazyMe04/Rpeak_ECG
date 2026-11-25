"""Detector v4: ensemble candidates + regularity-adaptive DP selection.

This is the production R-peak detector. It replaces detect5.py, which was a
single-template matched filter and stalled at Se 88.4 / PPV 96.0.

Why the architecture is what it is. Every intermediate version, and the numbers
that killed it, in order:

  v5  envelope candidates + global correlation threshold
      88.4 / 96.0. Candidate recall itself was the ceiling: on p00006_s00 only
      88.2% of annotated beats produced an envelope peak, and probe_ceiling.py
      showed the missed beats had ordinary amplitude, so the threshold -- not
      peak picking -- was discarding them.

  v6  all local maxima + K-means templates + Pan-Tompkins thresholds on the
      correlation score
      99.99 / 22.9. Correlation of *any* |wide| extremum against a QRS
      template is high (~0.95), so the adaptive thresholds never engaged.
      Pan-Tompkins works because its thresholds act on an integration envelope
      whose scale tracks signal strength, not on a normalised statistic.

  classic Pan-Tompkins
      80.3 / 93.4. Faithful implementation, but the running SPKI/NPKI estimates
      are poisoned by burst noise and by tall T waves, failing on the same
      records where wfdb's xqrs fails.

  union(gqrs, 2ma)
      99.3 / 90.7. This is the breakthrough: the two detectors fail on
      *disjoint* record sets (gqrs scores 0% on p00000_s00, 2ma scores 94.8% on
      p00004_s01 but 99.8% on p00000_s00), so their union recovers almost every
      annotated beat. Recall became a solved problem; only precision remained.

  + global RR-constrained DP
      97.9 / 95.6. Pruning the union works, but a single reference RR cannot
      serve both sinus rhythm and atrial fibrillation.

  + hard T-wave constraint (probe_dp3)
      98.0 / 95.6. Reliable, because a T wave follows its QRS at a fixed
      160-450 ms lag and is always flatter -- a mechanism, not a statistic.

  + regularity-adaptive RR weight (this file)
      97.7 / 96.2. The final piece: the RR term's strength is scaled by how
      regular the local rhythm actually is, measured from a first pass. Clean
      sinus rhythm gets full RR enforcement; AFib gets shape-only judgement.

Usage:
  python -I detect_v4.py --all
  python -I detect_v4.py --record p00010_s01
  python -I detect_v4.py --all --json result.json
"""
from __future__ import annotations

import argparse
import json
import sys
import warnings
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from config import CATALOG  # noqa: E402
from detect import load  # noqa: E402
from detect4 import band, score_weighted  # noqa: E402
from probe_baseline import run_gqrs, run_twomax  # noqa: E402
from probe_dp import features  # noqa: E402
from probe_dp3 import ref_rr_from  # noqa: E402
from probe_dp4 import local_regularity, select_adaptive, weak_sequence  # noqa: E402
from probe_fuse import merge, snap  # noqa: E402

warnings.filterwarnings("ignore")

FS = 250

# Shipped defaults. Chosen by sweep_dp.py / sweep_dp3.py / probe_dp4.py on all
# 24 segments, not tuned on any single record.
DEFAULTS = dict(
    w_amp=0.5,
    w_corr=1.0,
    w_slope=1.5,
    slope_frac=0.6,
    rr_penalty=2.0,
    reg_win_s=120.0,
    snap_ms=50.0,
    merge_tol_ms=50.0,
    # K-means initialisation. "rng" is the shipped, seed-0 numpy init; "even"
    # is the deterministic one the TypeScript port can reproduce exactly.
    kmeans_init="rng",
)


def detect(sig: np.ndarray, fs: int = FS, wide: np.ndarray | None = None,
           ref: np.ndarray | None = None, **overrides) -> np.ndarray:
    """Detect R peaks in `sig`, returning sample indices.

    `wide` and `ref` are accepted so callers that already loaded or filtered the
    record do not recompute it; `ref` is only used by the evaluation harness and
    is never consulted by the algorithm itself.
    """
    p = {**DEFAULTS, **overrides}
    if wide is None:
        wide = band(sig, 0.5, 40.0, fs)

    tol = int(p["merge_tol_ms"] / 1000 * fs)
    cand = merge([
        snap(run_gqrs(sig), wide, fs, p["snap_ms"]),
        snap(run_twomax(sig, fs), wide, fs, p["snap_ms"]),
    ], tol)
    if len(cand) < 10:
        return cand

    corr, amp_z, slope_z = features(wide, cand, fs, p["kmeans_init"])
    gain = p["w_amp"] * amp_z + p["w_corr"] * corr + p["w_slope"] * slope_z

    # Pass 1: no RR weighting, so the sequence reflects what is actually in the
    # signal. It is used only to measure the rhythm, never returned.
    weak = weak_sequence(cand, gain, fs)
    reg = local_regularity(cand, weak, fs, p["reg_win_s"])
    ref_rr = ref_rr_from(cand, weak, fs)

    # Pass 2: regularity-adaptive selection.
    return select_adaptive(cand, gain, slope_z, reg, fs, p["slope_frac"],
                           rr_penalty=p["rr_penalty"], ref_rr_s=ref_rr)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--record")
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--json", help="write per-segment results here")
    ap.add_argument("--w-amp", type=float, default=DEFAULTS["w_amp"])
    ap.add_argument("--w-corr", type=float, default=DEFAULTS["w_corr"])
    ap.add_argument("--w-slope", type=float, default=DEFAULTS["w_slope"])
    ap.add_argument("--slope-frac", type=float, default=DEFAULTS["slope_frac"])
    ap.add_argument("--rr", type=float, default=DEFAULTS["rr_penalty"])
    ap.add_argument("--reg-win", type=float, default=DEFAULTS["reg_win_s"])
    ap.add_argument("--kmeans-init", choices=("rng", "even"),
                    default=DEFAULTS["kmeans_init"],
                    help="rng = shipped seed-0 init; even = port-parity init")
    args = ap.parse_args()

    index = json.loads((CATALOG / "f32" / "index.json").read_text())
    recs = ([args.record] if args.record
            else [s["record"] for s in index] if args.all
            else [s["record"] for s in index[:4]])

    overrides = dict(w_amp=args.w_amp, w_corr=args.w_corr,
                     w_slope=args.w_slope, slope_frac=args.slope_frac,
                     rr_penalty=args.rr, reg_win_s=args.reg_win,
                     kmeans_init=args.kmeans_init)

    print(f"{'record':14} {'ref':>6} {'det':>6} {'Se':>7} {'PPV':>7} {'F1':>7}")
    print("-" * 56)
    rows = []
    for rec in recs:
        sig, ref, fs, _ = load(rec)
        peaks = detect(sig, fs, ref=ref, **overrides)
        sc = score_weighted(ref, peaks, fs)
        rows.append({"record": rec, "n_ref": len(ref), "n_det": len(peaks),
                     **sc})
        print(f"{rec:14} {len(ref):6d} {len(peaks):6d} {sc['se']:7.2f} "
              f"{sc['ppv']:7.2f} {sc['f1']:7.2f}")

    if rows:
        tot = {k: sum(r[k] for r in rows) for k in ("tp", "fp", "fn")}
        se = 100 * tot["tp"] / max(tot["tp"] + tot["fn"], 1)
        ppv = 100 * tot["tp"] / max(tot["tp"] + tot["fp"], 1)
        ses = sorted(r["se"] for r in rows)
        ppvs = sorted(r["ppv"] for r in rows)
        print(f"\nOVERALL  Se={se:.2f}  PPV={ppv:.2f}  "
              f"F1={2*se*ppv/max(se+ppv,1e-9):.2f}")
        print(f"median Se={ses[len(ses)//2]:.2f}  worst Se={ses[0]:.2f}  "
              f"median PPV={ppvs[len(ppvs)//2]:.2f}  worst PPV={ppvs[0]:.2f}")
        print(f"segments<95 Se: {sum(1 for r in rows if r['se'] < 95)}/"
              f"{len(rows)}  <95 PPV: {sum(1 for r in rows if r['ppv'] < 95)}/"
              f"{len(rows)}")
        out = Path(args.json) if args.json else CATALOG / "detect_v4_result.json"
        out.write_text(json.dumps(rows, indent=1))
        print(f"wrote {out}")


if __name__ == "__main__":
    main()
