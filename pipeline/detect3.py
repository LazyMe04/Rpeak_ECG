"""Detector v3: high-frequency QRS emphasis.

Evidence from feature_probe.py on this very dataset:
  QRS / T-wave high-frequency-to-low-frequency energy ratio = 5.9x .. 26x
  QRS / T-wave max slope                                    = 5x   .. 15x
  QRS / T-wave width at half max                            = 1.3x .. 1.7x

So spectral emphasis separates the two classes far better than any duration or
amplitude rule. v3 therefore emphasises high frequencies before integrating,
which suppresses T waves physically instead of trying to reject them with rules.

Pipeline:
  bandpass 10-25 Hz        (QRS band, deliberately above the T-wave band)
  -> derivative            (further emphasises sharp transitions)
  -> square
  -> 120 ms moving average (local energy estimate)
  -> group-delay compensation
  -> windowed threshold from the feature's own quantiles (median + k*spread)

The wideband 0.5-40 Hz chain is used only afterwards, to refine each detection
onto the true R deflection.

Usage:
  python -I detect3.py --record p00000_s00 --plot
  python -I detect3.py --all
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
from scipy import signal as sps
from scipy.ndimage import percentile_filter

sys.path.insert(0, str(Path(__file__).resolve().parent))
from config import CATALOG  # noqa: E402
from detect import load, plot, score  # noqa: E402

FS = 250


def band(x: np.ndarray, lo: float, hi: float, fs: int = FS, order: int = 2) -> np.ndarray:
    sos = sps.butter(order, [lo, hi], btype="band", fs=fs, output="sos")
    return sps.sosfilt(sos, x)


def energy(x: np.ndarray, fs: int, integ_ms: float) -> np.ndarray:
    d = np.zeros_like(x)
    d[4:] = (2 * x[4:] + x[3:-1] - x[1:-3] - 2 * x[:-4]) / 8.0
    sq = d * d
    n = max(2, int(round(fs * integ_ms / 1000)))
    return np.convolve(sq, np.ones(n) / n, mode="full")[: len(sq)], n


def detect(
    sig: np.ndarray,
    fs: int = FS,
    lo: float = 10.0,
    hi: float = 25.0,
    integ_ms: float = 120.0,
    window_s: float = 10.0,
    k: float = 0.35,
    refractory_ms: float = 200.0,
) -> tuple[np.ndarray, dict]:
    x = band(sig, lo, hi, fs)
    integ, win = energy(x, fs, integ_ms)
    delay = (win - 1) // 2

    # Scale estimate: a high quantile over a sliding window, NOT the median.
    # A median of the window sits on the noise floor because only a few percent
    # of samples belong to QRS complexes, which would make the threshold ~0.
    n = max(3, int(round(window_s * fs)) | 1)
    spread = percentile_filter(integ, percentile=99, size=n, mode="nearest")
    thr = k * spread
    dbg = {"integ": integ, "thr": thr, "band": x, "scale": spread}

    cand, _ = sps.find_peaks(integ, height=thr,
                             distance=max(1, int(refractory_ms / 1000 * fs)))
    return np.maximum(0, cand - delay), dbg


def refine_wide(sig: np.ndarray, peaks: np.ndarray, fs: int = FS,
                window_ms: float = 60.0) -> np.ndarray:
    """Snap onto the largest |deflection| of the wideband chain nearby."""
    wide = band(sig, 0.5, 40.0, fs)
    half = int(window_ms / 1000 * fs)
    out = []
    for p in peaks:
        lo, hi = max(0, p - half), min(len(wide) - 1, p + half)
        out.append(lo + int(np.argmax(np.abs(wide[lo:hi + 1]))))
    return np.array(out, dtype=int)


def e(t: float, s: float = 0.5) -> float:
    """Duration-weighted tolerance: +-50 ms base, +-15% of RR for fast rhythms."""
    return max(0.05 * FS, min(0.15 * FS, 0.5 * t))


def score_weighted(ref: np.ndarray, det: np.ndarray, fs: int = FS) -> dict:
    """AAMI-style matching with an extended window at short RR."""
    rr = np.diff(ref) if len(ref) > 1 else np.array([fs])
    used = np.zeros(len(ref), dtype=bool)
    tp = 0
    for d in det:
        k = int(np.searchsorted(ref, d))
        best, best_off = None, None
        for j in (k - 1, k, k + 1):
            if 0 <= j < len(ref) and not used[j]:
                w = e(float(rr[j - 1]) if 0 < j < len(rr) + 1 else fs / 1.0, fs)
                off = abs(int(ref[j]) - int(d))
                if off <= w and (best is None or off < best_off):
                    best, best_off = j, off
        if best is not None:
            used[best] = True
            tp += 1
    fp = len(det) - tp
    fn = int((~used).sum())
    se = 100 * tp / max(len(ref), 1)
    ppv = 100 * tp / max(len(det), 1)
    f1 = 2 * se * ppv / max(se + ppv, 1e-9)
    return {"tp": tp, "fp": fp, "fn": fn, "se": round(se, 2),
            "ppv": round(ppv, 2), "f1": round(f1, 2)}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--record")
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--plot", action="store_true")
    ap.add_argument("--start", type=float, default=300.0)
    ap.add_argument("--k", type=float, default=0.35)
    ap.add_argument("--window", type=float, default=10.0)
    ap.add_argument("--lo", type=float, default=10.0)
    ap.add_argument("--hi", type=float, default=25.0)
    args = ap.parse_args()

    index = json.loads((CATALOG / "f32" / "index.json").read_text())
    records = ([args.record] if args.record
               else [s["record"] for s in index] if args.all
               else [s["record"] for s in index[:4]])

    rows = []
    print(f"{'record':14} {'ref':>6} {'det':>6} {'Se':>7} {'PPV':>7} {'F1':>7}")
    print("-" * 56)
    for rec in records:
        sig, ref, fs, _ = load(rec)
        peaks, dbg = detect(sig, fs, args.lo, args.hi, window_s=args.window, k=args.k)
        refined = refine_wide(sig, peaks, fs)
        sc = score_weighted(ref, refined, fs)
        rows.append({"record": rec, "n_ref": len(ref), "n_det": len(refined), **sc})
        print(f"{rec:14} {len(ref):6d} {len(refined):6d} {sc['se']:7.2f} "
              f"{sc['ppv']:7.2f} {sc['f1']:7.2f}")
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
        (CATALOG / "detect3_result.json").write_text(json.dumps(rows, indent=1))


if __name__ == "__main__":
    main()
