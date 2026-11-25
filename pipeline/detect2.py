"""Detector v2: windowed robust threshold instead of a global EMA.

Why v2: a global exponential threshold (v1) reached 93% PPV but only 59% recall.
Ambulatory recordings drift in amplitude over 70 minutes, so a level learned
early in the segment either misses quiet stretches or floods on loud ones.

v2 uses a local threshold recomputed from the integration signal over a sliding
window:

    thr = median(integ) + k * (p90(integ) - median(integ))

Both statistics obey the signal, so no per-patient calibration is needed. T-wave
rejection then only has to handle the narrow case of a deflection that is both
too close and too small to be a beat.

Usage:
  python -I detect2.py --record p00000_s00 --plot
  python -I detect2.py --all
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
from scipy import signal as sps
from scipy.ndimage import median_filter, percentile_filter

sys.path.insert(0, str(Path(__file__).resolve().parent))
from config import CATALOG  # noqa: E402
from detect import bandpass, integrate_square, load, plot, score  # noqa: E402


def windowed_threshold(
    integ: np.ndarray,
    fs: int,
    window_s: float = 8.0,
    k: float = 0.45,
) -> np.ndarray:
    """Sliding median + k * robust spread, both computed over `window_s`."""
    n = int(round(window_s * fs)) | 1  # odd size for the filters
    med = median_filter(integ, size=n, mode="nearest")
    p90 = percentile_filter(integ, percentile=90, size=n, mode="nearest")
    return med + k * (p90 - med)


def detect(
    sig: np.ndarray,
    fs: int,
    window_s: float = 8.0,
    k: float = 0.45,
    refractory_ms: float = 200,
    integrate_ms: float = 150,
    t_reject: bool = True,
) -> tuple[np.ndarray, dict]:
    x = bandpass(sig, fs)
    integ = integrate_square(x, fs, integrate_ms)
    thr = windowed_threshold(integ, fs, window_s, k)

    refr = int(round(fs * refractory_ms / 1000))
    win = max(2, int(round(fs * integrate_ms / 1000)))
    delay = (win - 1) // 2

    # Local maxima above the threshold, enforced refractory spacing.
    cand, props = sps.find_peaks(integ, height=thr, distance=refr)
    cand = np.maximum(0, cand - delay)
    amps = integ[np.minimum(cand + delay, len(integ) - 1)]

    if not t_reject or len(cand) < 3:
        return cand, {"integ": integ, "thr": thr, "band": x}

    keep = np.ones(len(cand), dtype=bool)
    for i in range(1, len(cand)):
        if not keep[i - 1]:
            continue
        rr = cand[i] - cand[i - 1]
        prev_rr = cand[i - 1] - cand[i - 2] if i >= 2 else rr
        # T-wave: falls noticeably closer than the local RR and is much smaller.
        if rr < prev_rr * 0.62 and amps[i] < 0.45 * amps[i - 1]:
            keep[i] = False

    return cand[keep], {"integ": integ, "thr": thr, "band": x, "cand": cand}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--record")
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--plot", action="store_true")
    ap.add_argument("--start", type=float, default=300.0)
    ap.add_argument("--k", type=float, default=0.45)
    ap.add_argument("--window", type=float, default=8.0)
    args = ap.parse_args()

    index = json.loads((CATALOG / "f32" / "index.json").read_text())
    records = ([args.record] if args.record
               else [s["record"] for s in index] if args.all
               else [s["record"] for s in index[:4]])

    rows = []
    print(f"{'record':14} {'ref':>6} {'det':>6} {'Se':>7} {'PPV':>7} {'F1':>7} {'bpm':>6}")
    print("-" * 60)
    for rec in records:
        sig, ref, fs, meta = load(rec)
        peaks, dbg = detect(sig, fs, args.window, args.k)
        from detect import refine
        wide = bandpass(sig, fs, 0.5, 40.0)
        refined = refine(peaks, wide, fs)
        sc = score(ref, refined, int(0.05 * fs))
        rows.append({"record": rec, "n_ref": len(ref), "n_det": len(refined), **sc})
        bpm = len(ref) / (len(sig) / fs / 60)
        print(f"{rec:14} {len(ref):6d} {len(refined):6d} {sc['se']:7.2f} "
              f"{sc['ppv']:7.2f} {sc['f1']:7.2f} {bpm:6.1f}")
        if args.plot:
            p = plot(rec, sig, ref, refined, dbg, fs, args.start)
            print(f"   plot -> {p}")

    if rows:
        tot = {k: sum(r[k] for r in rows) for k in ("tp", "fp", "fn")}
        se = 100 * tot["tp"] / max(tot["tp"] + tot["fn"], 1)
        ppv = 100 * tot["tp"] / max(tot["tp"] + tot["fp"], 1)
        print(f"\nOVERALL  Se={se:.2f}  PPV={ppv:.2f}  "
              f"F1={2*se*ppv/max(se+ppv,1e-9):.2f}")
        ses = sorted(r["se"] for r in rows)
        print(f"median Se={ses[len(ses)//2]:.2f}  worst={ses[0]:.2f}  "
              f"segments<95: {sum(1 for r in rows if r['se'] < 95)}/{len(rows)}")
        (CATALOG / "detect2_result.json").write_text(json.dumps(rows, indent=1))


if __name__ == "__main__":
    main()
