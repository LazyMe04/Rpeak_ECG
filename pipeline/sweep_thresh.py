"""Sweep decision threshold and the short-RR T-wave rejection rule.

Loads each record once, computes the detector's final scored candidate list
once, then re-applies selection cheaply. This avoids the earlier mistake in
sweep_template.py, which re-ran the whole pipeline per setting and re-derived
the template differently from detect5.detect.

Usage:
  python -I sweep_thresh.py                 # all records, default grid
  python -I sweep_thresh.py p00010_s01      # one record, verbose
"""
from __future__ import annotations

from pathlib import Path

import json
import sys

import numpy as np
from scipy import signal as sps
from scipy.ndimage import percentile_filter

sys.path.insert(0, str(Path(__file__).resolve().parent))
from config import CATALOG  # noqa: E402
from detect import load  # noqa: E402
from detect4 import band, envelope, pearson_window, score_weighted  # noqa: E402
from detect5 import build_template_from, select_beats  # noqa: E402


def scored_candidates(rec: str, half_ms: float = 90.0,
                      k_env: float = 0.08) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Return (cand, scores, ref) exactly as detect() leaves them after its
    second refinement pass, but stopping before thresholding so the threshold
    can be varied for free."""
    sig, ref, fs, _ = load(rec)
    wide = band(sig, 0.5, 40.0, fs)
    narrow = band(sig, 10, 25, fs)
    integ, win = envelope(narrow, fs)
    delay = (win - 1) // 2

    n = int(10.0 * fs) | 1
    scale = percentile_filter(integ, percentile=99, size=n, mode="nearest")
    cand, _ = sps.find_peaks(integ, height=k_env * scale,
                             distance=int(0.3 * fs))
    cand = np.maximum(0, cand - delay)

    half = int(0.07 * fs)
    snapped = []
    for c in cand:
        lo, hi = max(0, c - half), min(len(wide) - 1, c + half)
        snapped.append(lo + int(np.argmax(np.abs(wide[lo:hi + 1]))))
    cand = np.unique(np.array(snapped, dtype=int))

    tmpl = build_template_from(wide, cand, fs, half_ms=half_ms)
    if tmpl is None:
        return cand, np.zeros(len(cand)), ref
    s = np.abs(pearson_window(wide, tmpl, cand))

    out = select_beats(cand, s, fs, thresh=0.25)
    if len(out) > 20:
        t2 = build_template_from(wide, out, fs, half_ms=half_ms)
        if t2 is not None:
            s = np.abs(pearson_window(wide, t2, cand))
    return cand, s, ref


def drop_short_rr(peaks: np.ndarray, scores: np.ndarray, fs: int,
                  frac: float = 0.55) -> np.ndarray:
    """Remove the weaker beat of any pair closer than frac * local median RR.

    A T wave sits 0.25-0.40 s after its QRS. At rest that is well inside the
    refractory window, but at 100+ bpm it is not, so a fixed refractory cannot
    catch it. Comparing each interval with the local median RR instead makes the
    rule heart-rate independent, and keeping the higher correlation score picks
    the QRS over the T wave because the QRS matches the learned template better.
    """
    if len(peaks) < 3:
        return peaks
    sc = dict(zip(peaks.tolist(), scores.tolist()))
    keep = list(peaks)
    changed = True
    while changed:
        changed = False
        rr = np.diff(keep)
        if len(rr) < 2:
            break
        med = float(np.median(rr))
        cut = max(0.3 * fs, frac * med)
        out = []
        i = 0
        while i < len(keep):
            if i + 1 < len(keep) and keep[i + 1] - keep[i] < cut:
                # keep the better-scoring of the two
                if sc.get(keep[i], 0.0) >= sc.get(keep[i + 1], 0.0):
                    out.append(keep[i])
                    i += 2
                else:
                    out.append(keep[i + 1])
                    i += 2
                changed = True
            else:
                out.append(keep[i])
                i += 1
        keep = out
    return np.array(keep, dtype=int)


def main() -> None:
    args = [a for a in sys.argv[1:] if not a.startswith("-")]
    index = json.loads((CATALOG / "f32" / "index.json").read_text())
    recs = args or [s["record"] for s in index]
    verbose = bool(args)

    cache = {}
    for r in recs:
        cache[r] = scored_candidates(r)
        print(f"loaded {r}", file=sys.stderr)

    grid = [(t, d) for t in (0.15, 0.20, 0.25, 0.30, 0.35, 0.45, 0.55)
            for d in (0.0, 0.50, 0.55, 0.60)]
    grid_summary = []
    for th, frac in grid:
        ses, ppvs, f1s, tot = [], [], [], {"tp": 0, "fp": 0, "fn": 0}
        for r in recs:
            cand, s, ref = cache[r]
            fs = 250
            out = select_beats(cand, s, fs, thresh=th)
            if frac > 0:
                out = drop_short_rr(out, s[np.searchsorted(cand, out)], fs, frac)
            sc = score_weighted(ref, out, fs)
            ses.append(sc["se"])
            ppvs.append(sc["ppv"])
            for k in tot:
                tot[k] += sc[k]
        se = 100 * tot["tp"] / max(tot["tp"] + tot["fn"], 1)
        ppv = 100 * tot["tp"] / max(tot["tp"] + tot["fp"], 1)
        f1 = 2 * se * ppv / max(se + ppv, 1e-9)
        grid_summary.append((se, ppv, f1, th, frac, np.median(ses),
                             np.median(ppvs), min(ses)))
        print(f"th={th:.2f} drop<{frac:.2f}RR  Se={se:6.2f} PPV={ppv:6.2f} "
              f"F1={f1:6.2f} | medSe={np.median(ses):6.2f} "
              f"minSe={min(ses):6.2f} medPPV={np.median(ppvs):6.2f}")

    best = max(grid_summary, key=lambda g: g[0] + g[1])
    print(f"\nbest by Se+PPV: th={best[3]:.2f} drop<{best[4]:.2f}RR "
          f"Se={best[0]:.2f} PPV={best[1]:.2f} F1={best[2]:.2f}")

    if verbose:
        for th, frac in [(0.25, 0.0), (0.25, 0.55), (0.35, 0.55)]:
            print(f"\n--- per record: th={th} drop={frac} ---")
            for r in recs:
                cand, s, ref = cache[r]
                out = select_beats(cand, s, 250, thresh=th)
                if frac > 0:
                    out = drop_short_rr(out, s[np.searchsorted(cand, out)], 250, frac)
                sc = score_weighted(ref, out, 250)
                print(f"  {r:14} ref={len(ref):5d} det={len(out):5d} "
                      f"Se={sc['se']:6.2f} PPV={sc['ppv']:6.2f}")


if __name__ == "__main__":
    main()
