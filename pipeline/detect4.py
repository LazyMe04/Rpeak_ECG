"""Detector v4: energy pre-selection + adaptive template matched filter.

Why v4: v3 (high-frequency energy only) reached 97.8% median recall but PPV
suffered badly on noisy patients, because energy alone cannot tell a QRS from a
sharp artefact. The standard remedy for ambulatory ECG is a matched filter: the
patient's own QRS morphology is learned from high-confidence beats and then
correlated against the whole recording.

Stages
  1. wideband 0.5-40 Hz
  2. envelope     : 10-25 Hz energy, permissive threshold -> candidates
  3. template     : median of aligned ±100 ms windows around the N most
                    confident, RR-consistent candidates
  4. matched filter: normalised cross-correlation against that template
  5. decision     : a beat needs both a local envelope peak and a correlation
                    peak above a threshold derived from the correlation's own
                    distribution; refractory spacing enforced

The template is built from the first ~60 s in the app, so this remains causal
and streaming-friendly.

Usage:
  python -I detect4.py --record p00006_s01 --plot
  python -I detect4.py --all
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
from scipy import signal as sps
from scipy.ndimage import percentile_filter, uniform_filter1d

sys.path.insert(0, str(Path(__file__).resolve().parent))
from config import CATALOG  # noqa: E402
from detect import load, plot  # noqa: E402

FS = 250


def band(x: np.ndarray, lo: float, hi: float, fs: int = FS, order: int = 2) -> np.ndarray:
    sos = sps.butter(order, [lo, hi], btype="band", fs=fs, output="sos")
    return sps.sosfilt(sos, x)


def envelope(x: np.ndarray, fs: int, integ_ms: float = 120.0) -> tuple[np.ndarray, int]:
    d = np.zeros_like(x)
    d[4:] = (2 * x[4:] + x[3:-1] - x[1:-3] - 2 * x[:-4]) / 8.0
    sq = d * d
    n = max(2, int(round(fs * integ_ms / 1000)))
    return np.convolve(sq, np.ones(n) / n, mode="full")[: len(sq)], n


def normalised_xcorr(x: np.ndarray, tmpl: np.ndarray) -> np.ndarray:
    """Sliding normalised cross-correlation (Pearson), computed with FFT.

    Returns a value in [-1, 1] at every sample, comparable across patients and
    independent of local signal amplitude.

    The denominator is sqrt(var_local) * sqrt(sum(t^2)), which requires the
    local variance over the *same* window length as the template. An earlier
    version divided by the wrong normaliser and returned unbounded values in the
    range 1-7, so no fixed decision threshold could work.
    """
    m = len(tmpl)
    t = tmpl - tmpl.mean()
    tnorm = np.sqrt(float((t * t).sum())) + 1e-12

    c = sps.fftconvolve(x, t[::-1], mode="same")
    ones = np.ones(m)
    local_mean = sps.fftconvolve(x, ones, mode="same") / m
    local_sq = sps.fftconvolve(x * x, ones, mode="same") / m
    local_var = np.maximum(local_sq - local_mean * local_mean, 1e-12)
    # Pearson: numerator is sum((w - mean_w) * t), denominator is
    # sqrt(sum((w - mean_w)^2)) * sqrt(sum(t^2)) = sqrt(m * var_w) * |t|.
    return c / (np.sqrt(m * local_var) * tnorm)


def pearson_window(x: np.ndarray, tmpl: np.ndarray, idx: np.ndarray) -> np.ndarray:
    """Exact Pearson correlation of each window against the template.

    Used for scoring a modest number of candidates, where the FFT approximation's
    edge effects would otherwise distort the result.
    """
    m = len(tmpl)
    t = tmpl - tmpl.mean()
    tn = np.sqrt(float((t * t).sum())) + 1e-12
    half = m // 2
    out = np.zeros(len(idx))
    for k, i in enumerate(idx):
        lo, hi = i - half, i - half + m
        if lo < 0 or hi > len(x):
            out[k] = 0.0
            continue
        w = x[lo:hi]
        wc = w - w.mean()
        wn = np.sqrt(float((wc * wc).sum())) + 1e-12
        out[k] = float((wc * t).sum() / (wn * tn))
    return out


def build_template(
    wide: np.ndarray,
    cand: np.ndarray,
    env_amp: np.ndarray,
    fs: int,
    half_ms: float = 100.0,
    n_seeds: int = 40,
) -> tuple[np.ndarray, np.ndarray]:
    """Median of aligned windows around the most confident, regular candidates."""
    half = int(half_ms / 1000 * fs)

    # Keep candidates that are high on the envelope and RR-consistent.
    order = np.argsort(env_amp)[::-1]
    strong = np.sort(cand[order[: max(10, len(order) // 20)]])
    if len(strong) < 5:
        strong = np.sort(cand[order[: min(len(order), 20)]])

    seeds = []
    for i in range(1, len(strong)):
        rr = strong[i] - strong[i - 1]
        if 0.4 * fs < rr < 1.6 * fs:
            seeds.append(strong[i])
    seeds = np.array(seeds[:n_seeds], dtype=int)
    if len(seeds) < 3:
        seeds = strong[: max(3, min(len(strong), n_seeds))]

    seeds = seeds[(seeds > half) & (seeds < len(wide) - half)]
    if len(seeds) == 0:
        return np.zeros(2 * half + 1), seeds

    stack = np.stack([wide[s - half: s + half + 1] for s in seeds])
    tmpl = np.median(stack, axis=0)
    tmpl = tmpl - tmpl.mean()
    # Orient the template so the dominant deflection is positive; correlation
    # sign then carries no meaning and we can search both polarities.
    if np.abs(tmpl.min()) > np.abs(tmpl.max()):
        tmpl = -tmpl
    return tmpl, seeds


def detect(
    sig: np.ndarray,
    fs: int = FS,
    k_env: float = 0.15,
    k_corr: float = 0.35,
    refractory_ms: float = 200.0,
    window_s: float = 10.0,
    use_corr: bool = True,
) -> tuple[np.ndarray, dict]:
    wide = band(sig, 0.5, 40.0, fs)
    narrow = band(sig, 10, 25, fs)
    integ, win = envelope(narrow, fs)
    delay = (win - 1) // 2

    n = max(3, int(round(window_s * fs)) | 1)
    scale = percentile_filter(integ, percentile=99, size=n, mode="nearest")
    thr_env = k_env * scale
    cand, _ = sps.find_peaks(integ, height=thr_env,
                             distance=max(1, int(refractory_ms / 1000 * fs)))
    cand = np.maximum(0, cand - delay)

    dbg = {"integ": integ, "thr": np.full_like(integ, 0.0), "band": narrow,
           "cand": cand}

    if not use_corr or len(cand) < 10:
        return cand, dbg

    env_amp = integ[np.minimum(cand + delay, len(integ) - 1)]
    tmpl, seeds = build_template(wide, cand, env_amp, fs)
    if len(tmpl) < 10:
        return cand, dbg

    corr = normalised_xcorr(wide, tmpl)
    acorr = np.abs(corr)

    # Template length is 2*half+1 samples (201 at 250 Hz). Any FFT convolution
    # index is therefore ambiguous by half a template width, so correlation is
    # only trustworthy in the interior. Build the correlation peak set first and
    # then require agreement with the envelope, rather than taking a union:
    # a union let thousands of correlation ripples through as detections.

    q99 = float(np.percentile(acorr, 99.5))
    thr_corr = max(k_corr, 0.5 * q99)

    pcorr, _ = sps.find_peaks(acorr, height=thr_corr,
                              distance=max(1, int(refractory_ms / 1000 * fs)))

    # Intersection: keep an envelope candidate only when a correlation peak of
    # the same polarity agrees within one QRS width. Envelope-only detections
    # are dropped entirely, which is what removes the artefact storm.
    tol = int(0.06 * fs)
    if len(pcorr):
        j = np.searchsorted(pcorr, cand)
        ok = np.zeros(len(cand), dtype=bool)
        for k, c in enumerate(cand):
            lo, hi = max(0, j[k] - 2), min(len(pcorr), j[k] + 2)
            if hi > lo and np.min(np.abs(pcorr[lo:hi] - c)) <= tol:
                ok[k] = True
        cand = cand[ok]

    dbg.update({"corr": corr, "tmpl": tmpl, "thr_corr": thr_corr,
                "seeds": seeds, "pcorr": pcorr})
    return cand, dbg


def refine_wide(wide: np.ndarray, peaks: np.ndarray, fs: int = FS,
                window_ms: float = 40.0) -> np.ndarray:
    half = int(window_ms / 1000 * fs)
    out = []
    for p in peaks:
        lo, hi = max(0, p - half), min(len(wide) - 1, p + half)
        out.append(lo + int(np.argmax(np.abs(wide[lo:hi + 1]))))
    return np.array(out, dtype=int)


def score_weighted(ref: np.ndarray, det: np.ndarray, fs: int = FS) -> dict:
    rr = np.diff(ref) if len(ref) > 1 else np.array([fs])
    used = np.zeros(len(ref), dtype=bool)
    tp = 0
    for d in det:
        k = int(np.searchsorted(ref, d))
        best, best_off = None, None
        for j in (k - 1, k, k + 1):
            if 0 <= j < len(ref) and not used[j]:
                base = float(rr[j - 1]) if 0 < j <= len(rr) else fs
                w = max(0.05 * fs, min(0.15 * fs, 0.5 * base))
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
    return {"tp": tp, "fp": fp, "fn": fn, "se": round(se, 2),
            "ppv": round(ppv, 2), "f1": round(2 * se * ppv / max(se + ppv, 1e-9), 2)}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--record")
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--plot", action="store_true")
    ap.add_argument("--start", type=float, default=300.0)
    ap.add_argument("--k-env", type=float, default=0.15)
    ap.add_argument("--k-corr", type=float, default=0.35)
    ap.add_argument("--no-corr", action="store_true")
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
        peaks, dbg = detect(sig, fs, args.k_env, args.k_corr,
                            use_corr=not args.no_corr)
        wide = band(sig, 0.5, 40.0, fs)
        refined = refine_wide(wide, peaks, fs)
        sc = score_weighted(ref, refined, fs)
        rows.append({"record": rec, "n_ref": len(ref), "n_det": len(refined), **sc})
        print(f"{rec:14} {len(ref):6d} {len(refined):6d} {sc['se']:7.2f} "
              f"{sc['ppv']:7.2f} {sc['f1']:7.2f}")
        if args.plot:
            print(f"   plot -> {plot(rec, sig, ref, refined, dbg, fs, args.start)}")

    if rows:
        tot = {k: sum(r[k] for r in rows) for k in ("tp", "fp", "fn")}
        se = 100 * tot["tp"] / max(tot["tp"] + tot["fn"], 1)
        ppv = 100 * tot["tp"] / max(tot["tp"] + tot["fp"], 1)
        print(f"\nOVERALL  Se={se:.2f}  PPV={ppv:.2f}  "
              f"F1={2*se*ppv/max(se+ppv,1e-9):.2f}")
        ses = sorted(r["se"] for r in rows)
        print(f"median Se={ses[len(ses)//2]:.2f}  worst={ses[0]:.2f}  "
              f"segments<95: {sum(1 for r in rows if r['se'] < 95)}/{len(rows)}")
        (CATALOG / "detect4_result.json").write_text(json.dumps(rows, indent=1))


if __name__ == "__main__":
    main()
