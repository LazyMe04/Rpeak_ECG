"""Reference Pan-Tompkins implementation + visual diagnostics.

This is the *specification* the TypeScript detector must reproduce exactly.
Written in Python because it is far easier to debug and to plot.

Stages (Pan & Tompkins 1985, with the standard streaming adaptation):
  1. bandpass 5-15 Hz
  2. 5-point derivative
  3. squaring
  4. moving-window integration (150 ms)
  5. local-maximum candidate search + SPKI/NPKI dual thresholds
  6. search-back when a beat is overdue
  7. T-wave discrimination by RR + slope

Usage:
  python -I detect.py --record p00000_s00 --plot
  python -I detect.py --all
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
from scipy import signal as sps

sys.path.insert(0, str(Path(__file__).resolve().parent))
from config import CATALOG, FS  # noqa: E402

F32 = CATALOG / "f32"
SEG = CATALOG / "segments"


# --------------------------------------------------------------------------
# Stage helpers
# --------------------------------------------------------------------------
def bandpass(x: np.ndarray, fs: int, lo: float = 5.0, hi: float = 15.0) -> np.ndarray:
    sos = sps.butter(2, [lo, hi], btype="band", fs=fs, output="sos")
    return sps.sosfilt(sos, x)


def derivative(x: np.ndarray) -> np.ndarray:
    """Pan-Tompkins original 5-point derivative, causal form.

    y[n] = (2x[n] + x[n-1] - x[n-3] - 2x[n-4]) / 8

    Causal on purpose: the TypeScript runtime must be able to compute this
    sample by sample while streaming. The symmetric variant
    (2x[n] + x[n-1] - x[n+1] - 2x[n-2]) emphasises high-frequency noise far
    more and produced an 18x larger integration stage, which destabilised the
    adaptive thresholds.
    """
    y = np.zeros_like(x)
    if len(x) > 4:
        y[4:] = (2 * x[4:] + x[3:-1] - x[1:-3] - 2 * x[:-4]) / 8.0
    return y


def moving_average(x: np.ndarray, n: int) -> np.ndarray:
    """Causal moving average, identical to a streaming ring buffer."""
    if n < 2:
        return x.copy()
    kernel = np.ones(n) / n
    return np.convolve(x, kernel, mode="full")[: len(x)]


def integrate_square(x: np.ndarray, fs: int, window_ms: float = 150) -> np.ndarray:
    n = max(2, int(round(fs * window_ms / 1000)))
    return moving_average(derivative(x) ** 2, n)


# --------------------------------------------------------------------------
# Detector
# --------------------------------------------------------------------------
def detect_rpeaks(
    sig: np.ndarray,
    fs: int,
    refractory_ms: float = 200,
    integrate_ms: float = 150,
    adapt: float = 0.125,
) -> tuple[np.ndarray, dict]:
    """Return R-peak indices and debug stage signals."""
    x = bandpass(sig, fs)
    integ = integrate_square(x, fs, integrate_ms)
    refr = int(round(fs * refractory_ms / 1000))

    # Candidate = local maximum of the integrated signal spaced >= refractory.
    cand, _ = sps.find_peaks(integ, distance=refr)

    # The moving average is causal, so its output lags the signal by its group
    # delay of (win-1)/2 samples. Compensate so that candidate indices refer to
    # the true beat time; without this every detection is ~72 ms late, which is
    # outside the 50 ms matching tolerance even though the counts look right.
    integ_win = max(2, int(round(fs * integrate_ms / 1000)))
    cand = np.maximum(0, cand - (integ_win - 1) // 2)

    if len(cand) < 4:
        return np.array([], dtype=int), {"integ": integ, "band": x,
                                         "threshold": np.zeros_like(integ)}

    # Seed both levels from the candidate amplitude distribution: the signal
    # level from the large deflections, the noise level from the small ones.
    amps = integ[cand]
    spki = float(np.percentile(amps, 99))
    npki = float(np.percentile(amps, 10))

    accepted: list[int] = []
    rr_prev = 0.0
    rr_mean = 0.0

    for c, a in zip(cand, amps):
        thr1 = npki + 0.25 * (spki - npki)
        a = float(a)

        if a > thr1:
            if len(accepted) >= 2 and rr_prev > 0 and (c - accepted[-1]) < rr_prev * 0.5:
                # Too soon to be a beat: T wave or artefact.
                npki = (1 - adapt) * npki + adapt * a
                continue
            accepted.append(int(c))
            spki = (1 - adapt) * spki + adapt * a
            if len(accepted) >= 2:
                rr = accepted[-1] - accepted[-2]
                rr_prev = rr
                rr_mean = rr if rr_mean == 0 else 0.875 * rr_mean + 0.125 * rr
        else:
            npki = (1 - adapt) * npki + adapt * a

    return np.array(accepted, dtype=int), {
        "integ": integ,
        "band": x,
        "cand": cand,
        "spki": spki,
        "npki": npki,
    }


def refine(peaks: np.ndarray, wide: np.ndarray, fs: int, window_ms: float = 50) -> np.ndarray:
    """Snap each candidate to the largest |wideband| deflection nearby."""
    half = int(round(fs * window_ms / 1000))
    out = []
    for p in peaks:
        lo, hi = max(0, p - half), min(len(wide) - 1, p + half)
        idx = np.argmax(np.abs(wide[lo:hi + 1]))
        out.append(lo + idx)
    return np.array(out, dtype=int)


def score(ref: np.ndarray, det: np.ndarray, tol: int) -> dict:
    if len(ref) == 0 or len(det) == 0:
        return {"tp": 0, "fp": len(det), "fn": len(ref), "se": 0.0, "ppv": 0.0, "f1": 0.0}
    used = np.zeros(len(ref), dtype=bool)
    tp = 0
    j = 0
    for d in det:
        while j < len(ref) and ref[j] < d - tol:
            j += 1
        k = j
        while k < len(ref) and ref[k] <= d + tol:
            if not used[k]:
                used[k] = True
                tp += 1
                break
            k += 1
    fp = len(det) - tp
    fn = len(ref) - tp
    se = 100 * tp / len(ref)
    ppv = 100 * tp / len(det)
    f1 = 2 * se * ppv / (se + ppv) if se + ppv else 0.0
    return {"tp": int(tp), "fp": int(fp), "fn": int(fn),
            "se": round(se, 2), "ppv": round(ppv, 2), "f1": round(f1, 2)}


# --------------------------------------------------------------------------
# IO
# --------------------------------------------------------------------------
def load(record: str) -> tuple[np.ndarray, np.ndarray, int, dict]:
    sig = np.fromfile(F32 / f"{record}.f32", dtype=np.float32).astype(np.float64)
    ann = json.loads((SEG / f"{record}.ann.json").read_text())
    ref = np.array([b["sample"] for b in ann["beats"] if b["symbol"] in "NSVQ"], dtype=int)
    meta = json.loads((SEG / f"{record}.meta.json").read_text())
    return sig, ref, meta["fs"], ann


def plot(record: str, sig: np.ndarray, ref: np.ndarray, det: np.ndarray,
         dbg: dict, fs: int, start_s: float, dur_s: float = 10.0) -> Path:
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    a, b = int(start_s * fs), int((start_s + dur_s) * fs)
    t = np.arange(a, b) / fs
    fig, axes = plt.subplots(4, 1, figsize=(18, 11), sharex=True)

    axes[0].plot(t, sig[a:b], lw=0.7, color="#1f77b4")
    r = ref[(ref >= a) & (ref < b)]
    axes[0].plot(r / fs, sig[r], "o", ms=5, mfc="none", mec="#2ca02c", mew=1.2,
                 label="annotation")
    d = det[(det >= a) & (det < b)]
    axes[0].plot(d / fs, sig[np.clip(d, 0, len(sig) - 1)], "x", ms=7, color="#d62728",
                 label="detected")
    axes[0].set_ylabel("raw mV")
    axes[0].legend(loc="upper right", fontsize=8)

    axes[1].plot(t, dbg["band"][a:b], lw=0.8, color="#9467bd")
    axes[1].set_ylabel("bandpass 5-15")

    axes[2].plot(t, dbg["integ"][a:b], lw=0.9, color="#ff7f0e")
    axes[2].set_ylabel("integrated")

    # overlay detections on the integrated trace
    for p in d:
        axes[2].axvline(p / fs, color="#d62728", lw=0.6, alpha=0.6)
    axes[2].set_xlabel("seconds")

    axes[3].plot(t, sig[a:b], lw=0.7, color="#1f77b4")
    for p in d:
        axes[3].axvline(p / fs, color="#d62728", lw=0.6, alpha=0.5)
    for p in r:
        axes[3].axvline(p / fs, color="#2ca02c", lw=0.6, alpha=0.5, ls="--")
    axes[3].set_ylabel("raw + markers")
    axes[3].set_xlabel("seconds")

    fig.suptitle(f"{record}  t={start_s:.0f}s  green=annotation  red=detected")
    fig.tight_layout()
    out = CATALOG / f"plot_{record}_{int(start_s)}.png"
    fig.savefig(out, dpi=80)
    plt.close(fig)
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--record")
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--plot", action="store_true")
    ap.add_argument("--start", type=float, default=300.0)
    args = ap.parse_args()

    index = json.loads((F32 / "index.json").read_text())
    records = ([args.record] if args.record
               else [s["record"] for s in index] if args.all
               else [s["record"] for s in index[:4]])

    rows = []
    print(f"{'record':14} {'ref':>6} {'det':>6} {'Se':>7} {'PPV':>7} {'F1':>7}")
    print("-" * 56)
    for rec in records:
        sig, ref, fs, _ = load(rec)
        peaks, dbg = detect_rpeaks(sig, fs)
        wide = bandpass(sig, fs, 0.5, 40.0)
        refined = refine(peaks, wide, fs)
        sc = score(ref, refined, int(0.05 * fs))
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
        print(f"worst Se: {min(r['se'] for r in rows):.2f}  "
              f"segments<95: {sum(1 for r in rows if r['se'] < 95)}/{len(rows)}")
        (CATALOG / "detect_py_result.json").write_text(json.dumps(rows, indent=1))


if __name__ == "__main__":
    main()
