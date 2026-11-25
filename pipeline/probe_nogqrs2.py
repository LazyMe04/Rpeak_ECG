"""Why does replacing gqrs with all local maxima destroy precision?

probe_unionrecall.py measured 98.67% candidate recall for 2ma+|wide| maxima and
probe_nogqrs.py then scored only 92.1 / 59.3 end to end. The recall number was
real; the precision collapse is new and is a normalisation artefact, not a data
problem.

Cause: `features()` z-scores amp and slope against percentiles of the candidate
set. gqrs contributes ~6k candidates per segment, so those percentiles described
*plausible beat locations*. All local maxima contribute ~24k, three quarters of
which are baseline ripple and T waves, so the 98th percentile now describes
noise and a genuine QRS no longer scores high. The same happens to `corr`,
whose K-means clusters are diluted by noise shapes.

That is a design flaw exposed by the experiment, and it has a clean fix: make
the normalisation reference absolute rather than set-relative, using the
record's own robust QRS scale. This probe tests that fix with a small, portable
candidate filter and absolute normalisation, since both must exist before the
detector can be ported.

Usage:
  python -I probe_nogqrs2.py [record ...]
"""
from __future__ import annotations

import json
import sys
import warnings

import numpy as np
from scipy import signal as sps
from scipy.ndimage import median_filter, percentile_filter

sys.path.insert(0, "D:/Rpeak-Desktop/pipeline")
from config import CATALOG  # noqa: E402
from detect import load  # noqa: E402
from detect4 import band, score_weighted  # noqa: E402
from probe_baseline import run_twomax  # noqa: E402
from probe_dp3 import ref_rr_from  # noqa: E402
from probe_dp4 import local_regularity, select_adaptive, weak_sequence  # noqa: E402
from probe_fuse import merge, snap  # noqa: E402
from probe_ktmpl import kmeans, windows  # noqa: E402

warnings.filterwarnings("ignore")
FS = 250


def qrs_scale(aw: np.ndarray, fs: int) -> float:
    """Robust QRS amplitude for the record.

    A high percentile of |wide| is dominated by the largest complexes; the
    median of the *local maxima* is a better central estimate of how tall a
    typical QRS is, and it barely moves when noise spikes are present.
    """
    pk, _ = sps.find_peaks(aw, distance=int(0.25 * fs))
    if len(pk) < 20:
        return float(np.percentile(aw, 99)) + 1e-12
    return float(np.median(aw[pk])) + 1e-12


def candidates_gated(sig, wide, fs, min_dist_ms=120.0, k_amp=0.45,
                     k_slope=0.30):
    """Local maxima of |wide| that clear absolute amp and slope floors.

    Floors are fractions of the record's own robust QRS scale, not of the
    candidate set, so adding noise peaks does not move them.
    """
    aw = np.abs(wide)
    g = np.abs(np.gradient(wide))
    a_scale = qrs_scale(aw, fs)
    hs = int(0.04 * fs)
    g_at, _ = sps.find_peaks(g, distance=int(0.25 * fs))
    g_scale = float(np.median(g[g_at])) + 1e-12 if len(g_at) > 20 else \
        float(np.percentile(g, 99)) + 1e-12

    pk, _ = sps.find_peaks(aw, distance=int(min_dist_ms / 1000 * fs))
    keep = []
    for p in pk:
        lo, hi = max(0, p - hs), min(len(g) - 1, p + hs)
        if aw[p] < k_amp * a_scale:
            continue
        if g[lo:hi + 1].max() < k_slope * g_scale:
            continue
        keep.append(int(p))
    return np.array(keep, dtype=int)


def features_abs(wide, cand, fs):
    """Candidate features with absolute (not set-relative) normalisation."""
    aw = np.abs(wide)
    g = np.abs(np.gradient(wide))
    a_scale = qrs_scale(aw, fs)
    g_at, _ = sps.find_peaks(g, distance=int(0.25 * fs))
    g_scale = float(np.median(g[g_at])) + 1e-12 if len(g_at) > 20 else \
        float(np.percentile(g, 99)) + 1e-12

    hs, ha = int(0.04 * fs), int(0.06 * fs)
    amp = np.array([aw[max(0, c - ha): c + ha + 1].max() for c in cand])
    slope = np.array([g[max(0, c - hs): c + hs + 1].max() for c in cand])
    amp_n = np.clip(amp / a_scale, 0.0, 2.0)
    slope_n = np.clip(slope / g_scale, 0.0, 2.0)

    half = int(0.12 * fs)
    w, ok = windows(wide, cand, half)
    corr = np.zeros(len(cand))
    if ok.sum() > 50:
        ww = w[ok]
        n_sub = min(len(ww), 6000)
        sub = ww[np.linspace(0, len(ww) - 1, n_sub).astype(int)]
        cent, _ = kmeans(sub, 8)
        sim = np.abs(ww @ cent.T)
        d = np.abs(np.gradient(cent, axis=1))
        mid = slice(max(0, half - hs), half + hs + 1)
        cs = d[:, mid].mean(axis=1)
        use = cs >= np.percentile(cs, 50)
        if not use.any():
            use = np.ones(cent.shape[0], dtype=bool)
        corr[ok] = sim[:, use].max(axis=1)
    return corr, amp_n, slope_n


def run(rec, w_amp=0.5, w_corr=1.0, w_slope=1.5, slope_frac=0.6,
        rr_penalty=2.0, reg_win_s=120.0, k_amp=0.45, k_slope=0.30):
    sig, ref, fs, _ = load(rec)
    wide = band(sig, 0.5, 40.0, fs)
    tol = int(0.05 * fs)
    cand = merge([
        snap(run_twomax(sig, fs), wide, fs),
        snap(candidates_gated(sig, wide, fs, k_amp=k_amp, k_slope=k_slope),
             wide, fs),
    ], tol)
    if len(cand) < 10:
        return cand, ref, fs
    corr, amp_n, slope_n = features_abs(wide, cand, fs)
    gain = w_amp * amp_n + w_corr * corr + w_slope * slope_n
    weak = weak_sequence(cand, gain, fs)
    reg = local_regularity(cand, weak, fs, reg_win_s)
    ref_rr = ref_rr_from(cand, weak, fs)
    out = select_adaptive(cand, gain, slope_n, reg, fs, slope_frac,
                          rr_penalty=rr_penalty, ref_rr_s=ref_rr)
    return out, ref, fs


def main() -> None:
    args = [a for a in sys.argv[1:] if not a.startswith("-")]
    index = json.loads((CATALOG / "f32" / "index.json").read_text())
    recs = args or [s["record"] for s in index]

    print(f"{'record':14} {'ref':>6} {'det':>6} {'Se':>7} {'PPV':>7} {'F1':>7}")
    ses, ppvs, tot = [], [], {"tp": 0, "fp": 0, "fn": 0}
    for rec in recs:
        out, ref, fs = run(rec)
        sc = score_weighted(ref, out, fs)
        ses.append(sc["se"])
        ppvs.append(sc["ppv"])
        for m in tot:
            tot[m] += sc[m]
        print(f"{rec:14} {len(ref):6d} {len(out):6d} {sc['se']:7.2f} "
              f"{sc['ppv']:7.2f} {sc['f1']:7.2f}")
        print(f"   done {rec}", file=sys.stderr)

    se = 100 * tot["tp"] / max(tot["tp"] + tot["fn"], 1)
    ppv = 100 * tot["tp"] / max(tot["tp"] + tot["fp"], 1)
    print(f"\nOVERALL Se={se:.2f} PPV={ppv:.2f} "
          f"F1={2*se*ppv/max(se+ppv,1e-9):.2f}")
    print(f"median Se={np.median(ses):.2f} minSe={min(ses):.2f} "
          f"median PPV={np.median(ppvs):.2f} minPPV={min(ppvs):.2f}")
    print(f"segments<95 Se: {sum(1 for s in ses if s < 95)}/{len(ses)}  "
          f"<95 PPV: {sum(1 for p in ppvs if p < 95)}/{len(ppvs)}")


if __name__ == "__main__":
    main()
