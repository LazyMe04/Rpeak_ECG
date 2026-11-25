"""Local vs global template: does morphology drift explain the score overlap?

probe_allmax.py showed candidate recall reaches ~99% but the correlation score
of true and false candidates overlaps heavily on several records (on
p00006_s00, false p99 = 0.953 while true p10 = 0.705). A single template
averaged over a 70-minute segment cannot represent morphology that drifts, so
beats far from the median shape score low and unrelated bumps score high.

This probe rebuilds the template inside sliding windows and rescoring only
within the same window, so each candidate is compared with the beats that
actually surround it. Reports the score distributions and the resulting
recall/precision curve.

Usage:
  python -I probe_local.py [record ...]
  python -I probe_local.py --win 300 [record ...]
"""
from __future__ import annotations

import json
import sys

import numpy as np
from scipy import signal as sps

sys.path.insert(0, "D:/Rpeak-Desktop/pipeline")
from config import CATALOG  # noqa: E402
from detect import load  # noqa: E402
from detect4 import band, pearson_window, score_weighted  # noqa: E402
from detect5 import build_template_from, detect  # noqa: E402

FS = 250


def all_local_maxima(aw: np.ndarray, min_dist: int) -> np.ndarray:
    pk, _ = sps.find_peaks(aw, distance=min_dist)
    floor = 0.005 * float(np.percentile(aw, 99))
    return pk[aw[pk] > floor]


def is_true_mask(cand: np.ndarray, ref: np.ndarray, fs: int) -> np.ndarray:
    tol = int(0.05 * fs)
    out = np.zeros(len(cand), dtype=bool)
    j = 0
    for k, c in enumerate(cand):
        while j < len(ref) and ref[j] < c - tol:
            j += 1
        if j < len(ref) and ref[j] <= c + tol:
            out[k] = True
    return out


def local_scores(sig, wide, cand, fs, win_s, half_ms, boot_peaks):
    """Score each candidate against a template built from candidates in its
    own time window. Windows overlap by 50% so a candidate is never scored
    against a template drawn only from one edge of its neighbourhood."""
    win = int(win_s * fs)
    step = max(1, win // 2)
    n = len(wide)
    scores = np.zeros(len(cand))
    for start in range(0, n, step):
        end = min(n, start + win)
        sel = (cand >= start) & (cand < end)
        if sel.sum() < 10:
            continue
        idx = np.where(sel)[0]
        # Bootstrap the template from the confidence-ranked subset of candidates
        # in this window, which is exactly what the full detector would use but
        # restricted to the local morphology.
        local_c = cand[idx]
        tmpl = build_template_from(wide, local_c, fs, half_ms=half_ms,
                                   max_beats=120)
        if tmpl is None:
            continue
        s = np.abs(pearson_window(wide, tmpl, local_c))
        # overlapping windows: keep the best score any window gave
        scores[idx] = np.maximum(scores[idx], s)
        if end >= n:
            break
    return scores


def main() -> None:
    win_s = 300.0
    half_ms = 110.0
    a = sys.argv[1:]
    if "--win" in a:
        i = a.index("--win")
        win_s = float(a[i + 1])
        a = a[:i] + a[i + 2:]
    if "--half" in a:
        i = a.index("--half")
        half_ms = float(a[i + 1])
        a = a[:i] + a[i + 2:]
    args = [x for x in a if not x.startswith("-")]
    index = json.loads((CATALOG / "f32" / "index.json").read_text())
    recs = args or [s["record"] for s in index]

    store = {}
    print(f"win={win_s:.0f}s half={half_ms:.0f}ms")
    print(f"{'record':14} {'nref':>6} {'trueP10':>8} {'trueP50':>8} "
          f"{'falseP99':>9} {'falseP999':>10}")
    for rec in recs:
        sig, ref, fs, _ = load(rec)
        wide = band(sig, 0.5, 40.0, fs)
        cand = all_local_maxima(np.abs(wide), int(0.12 * fs))
        sc = local_scores(sig, wide, cand, fs, win_s, half_ms, None)
        it = is_true_mask(cand, ref, fs)
        t, f = sc[it], sc[~it]
        print(f"{rec:14} {len(ref):6d} {np.percentile(t,10):8.3f} "
              f"{np.median(t):8.3f} {np.percentile(f,99):9.3f} "
              f"{np.percentile(f,99.9):10.3f}")
        store[rec] = (cand, sc, ref, fs)
        print(f"   loaded {rec}", file=sys.stderr)

    print(f"\n{'cut':>6} {'Se':>7} {'PPV':>7} {'F1':>7} | {'medSe':>7} "
          f"{'minSe':>7} {'medPPV':>7}")
    for cut in (0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.93):
        ses, ppvs, tot = [], [], {"tp": 0, "fp": 0, "fn": 0}
        for rec, (cand, sc, ref, fs) in store.items():
            refr = int(0.25 * fs)
            out, last = [], -10**9
            for p, s in zip(cand, sc):
                if s >= cut and p - last >= refr:
                    out.append(int(p))
                    last = int(p)
            sc_ = score_weighted(ref, np.array(out), fs)
            ses.append(sc_["se"])
            ppvs.append(sc_["ppv"])
            for m in tot:
                tot[m] += sc_[m]
        se = 100 * tot["tp"] / max(tot["tp"] + tot["fn"], 1)
        ppv = 100 * tot["tp"] / max(tot["tp"] + tot["fp"], 1)
        print(f"{cut:6.2f} {se:7.2f} {ppv:7.2f} "
              f"{2*se*ppv/max(se+ppv,1e-9):7.2f} | {np.median(ses):7.2f} "
              f"{min(ses):7.2f} {np.median(ppvs):7.2f}")


if __name__ == "__main__":
    main()
