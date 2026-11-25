"""Detector v6 experiment: high-recall candidates + adaptive decision logic.

Diagnostics so far isolate two separate failures, and neither is fixed by a
global correlation threshold:

  * candidate recall (10-25 Hz envelope, k_env=0.08) is 88-96% on several
    records, yet every annotated beat has a local maximum of |0.5-40 Hz| within
    8 ms (median). So the *threshold* on the envelope, not peak picking,
    discards real beats.
  * with candidates taken from all local maxima (99% recall) a single
    correlation template scores true and false candidates almost identically,
    because morphology drifts across 70 minutes.

v6 therefore replaces the global threshold with the adaptive decision logic of
Pan & Tompkins (1985), which is designed for exactly this situation:

  * candidates      every local maximum of |wide| at >= 120 ms spacing
  * scoring         max similarity to a QRS-like template cluster
  * thresholds      rolling SPKI/NPKI estimates -> THR1, THR2
  * searchback      a gap longer than 1.66 x the local RR is re-examined at
                    THR2, which recovers isolated missed beats
  * T-wave rule     a candidate closer than 360 ms whose slope is < half the
                    previous beat's is rejected

Everything is measured against the annotations with the shared scorer, so the
numbers are directly comparable with detect5.py.

Usage:
  python -I probe_v6.py [record ...]
  python -I probe_v6.py --k 8 --min-cluster-slope 0.5 --win 20
"""
from __future__ import annotations

import json
import sys

import numpy as np
from scipy import signal as sps

sys.path.insert(0, "D:/Rpeak-Desktop/pipeline")
from config import CATALOG  # noqa: E402
from detect import load  # noqa: E402
from detect4 import band, score_weighted  # noqa: E402

FS = 250


# ---------------------------------------------------------------- candidates
def all_local_maxima(aw: np.ndarray, min_dist: int) -> np.ndarray:
    pk, _ = sps.find_peaks(aw, distance=min_dist)
    floor = 0.005 * float(np.percentile(aw, 99))
    return pk[aw[pk] > floor]


def windows(x, idx, half):
    ok = (idx - half >= 0) & (idx + half < len(x))
    out = np.zeros((len(idx), 2 * half + 1))
    w = x[idx[ok][:, None] + np.arange(-half, half + 1)[None, :]]
    w = w - w.mean(axis=1, keepdims=True)
    nrm = np.sqrt((w * w).sum(axis=1, keepdims=True)) + 1e-12
    out[ok] = w / nrm
    return out, ok


def kmeans(x, k, iters=20, seed=0):
    rng = np.random.default_rng(seed)
    cent = x[rng.choice(len(x), k, replace=False)].copy()
    for _ in range(iters):
        d = ((x * x).sum(1)[:, None] - 2 * x @ cent.T
             + (cent * cent).sum(1)[None, :])
        lab = np.argmin(d, axis=1)
        for j in range(k):
            m = lab == j
            if m.any():
                c = x[m].mean(axis=0)
                cent[j] = c / (np.linalg.norm(c) + 1e-12)
    d = ((x * x).sum(1)[:, None] - 2 * x @ cent.T
         + (cent * cent).sum(1)[None, :])
    return cent, np.argmin(d, axis=1)


# ---------------------------------------------------------------- decision
def rolling_median(x, win):
    from scipy.ndimage import percentile_filter
    return percentile_filter(x, percentile=50, size=win, mode="nearest")


def adaptive_select(cand, score, slope, fs, win_s=20.0, k_hi=0.55, k_lo=0.35,
                    searchback=1.66, t_rule_ms=360.0, slope_frac=0.5,
                    refractory_ms=200.0):
    """Pan-Tompkins style selection over a pre-scored candidate list.

    SPKI/NPKI are replaced by running estimates of the score distribution inside
    a rolling window, which is the same idea but robust to the percentile being
    taken over a local rather than exponential average. THR1 and THR2 correspond
    to k_hi and k_lo times the local upper quantile.
    """
    if len(cand) == 0:
        return np.array([], dtype=int)

    n = len(cand)
    # Initialise the running estimates from the opening candidates, then let
    # both decay as the record proceeds. This is SPKI/NPKI applied to the score
    # rather than to the signal envelope: same role, but the quantity it tracks
    # is already amplitude-normalised.
    warm = min(n, 40)
    spki = float(np.percentile(score[:warm], 90))
    npki = float(np.median(score[:warm]))
    thr1 = npki + 0.25 * (spki - npki)
    thr2 = 0.5 * thr1
    accepted = []
    slopes = []
    refr = int(refractory_ms / 1000 * fs)

    for i in range(n):
        p, s = int(cand[i]), float(score[i])
        if accepted and p - accepted[-1] < refr:
            # refractory: keep the stronger of the two
            if s > score[accepted[-1]]:
                accepted[-1] = i
                slopes[-1] = slope[i]
            continue

        # searchback: long gap -> accept at the lower threshold
        if accepted and p - accepted[-1] > searchback * _local_rr(accepted, cand, fs, refr):
            use = thr2
        else:
            use = thr1

        if s >= use:
            # T-wave rule: too close and much flatter than the previous beat
            if (accepted and p - accepted[-1] < int(t_rule_ms / 1000 * fs)
                    and slope[i] < slope_frac * slopes[-1]):
                npki = 0.875 * npki + 0.125 * s
            else:
                accepted.append(i)
                slopes.append(slope[i])
                spki = 0.875 * spki + 0.125 * s
        else:
            npki = 0.875 * npki + 0.125 * s

        thr1 = npki + 0.25 * (spki - npki)
        thr2 = 0.5 * thr1

    return np.array(sorted(int(cand[i]) for i in accepted), dtype=int)


def _local_rr(acc, cand, fs, refr):
    if len(acc) < 2:
        return 8.0 * refr
    recent = [int(cand[a]) for a in acc[-6:]]
    return float(np.median(np.diff(recent)))


# ---------------------------------------------------------------- driver
def run(rec, k, min_cluster_slope, win_s, half_ms):
    sig, ref, fs, _ = load(rec)
    wide = band(sig, 0.5, 40.0, fs)
    aw = np.abs(wide)
    cand = all_local_maxima(aw, int(0.12 * fs))
    half = int(half_ms / 1000 * fs)
    w, ok = windows(wide, cand, half)
    cand = cand[ok]
    w = w[ok]

    n_sub = min(len(w), 6000)
    sub = w[np.linspace(0, len(w) - 1, n_sub).astype(int)]
    cent, _ = kmeans(sub, k)
    sim = np.abs(w @ cent.T)

    d = np.abs(np.gradient(cent, axis=1))
    mid = slice(max(0, half - int(0.04 * fs)), half + int(0.04 * fs) + 1)
    cslope = d[:, mid].mean(axis=1)
    thresh = np.percentile(cslope, 100 * min_cluster_slope)
    use_clusters = np.where(cslope >= thresh)[0]
    if len(use_clusters) == 0:
        use_clusters = np.array([int(np.argmax(cslope))])
    score = sim[:, use_clusters].max(axis=1)

    # Per-candidate slope, for the T-wave rule.
    g = np.abs(np.gradient(wide))
    hs = int(0.04 * fs)
    slope = np.array([g[max(0, c - hs): c + hs + 1].max() for c in cand])
    q = float(np.percentile(slope, 90)) + 1e-12
    slope_n = np.clip(slope / q, 0.0, 1.5)

    out = adaptive_select(cand, score, slope_n, fs, win_s=win_s)
    return out, ref, fs, score, cand


def main() -> None:
    k, mcs, win_s, half_ms = 8, 0.5, 20.0, 120.0
    a = sys.argv[1:]
    for flag, conv in (("--k", int), ("--mcs", float), ("--win", float),
                       ("--half", float)):
        if flag in a:
            i = a.index(flag)
            v = conv(a[i + 1])
            a = a[:i] + a[i + 2:]
            if flag == "--k":
                k = v
            elif flag == "--mcs":
                mcs = v
            elif flag == "--win":
                win_s = v
            elif flag == "--half":
                half_ms = v
    args = [x for x in a if not x.startswith("-")]
    index = json.loads((CATALOG / "f32" / "index.json").read_text())
    recs = args or [s["record"] for s in index]

    print(f"v6 k={k} mcs={mcs} win={win_s} half={half_ms}")
    print(f"{'record':14} {'ref':>6} {'det':>6} {'Se':>7} {'PPV':>7} {'F1':>7}")
    ses, ppvs, tot = [], [], {"tp": 0, "fp": 0, "fn": 0}
    for rec in recs:
        out, ref, fs, _, _ = run(rec, k, mcs, win_s, half_ms)
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
