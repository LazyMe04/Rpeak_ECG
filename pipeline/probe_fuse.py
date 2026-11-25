"""Ensemble fusion: combine complementary detectors, then clean up by RR.

probe_baseline.py measured the three reference implementations on the same
annotations and found they fail on *different* records:

  gqrs   mean Se 93.88, but Se 0 on p00000_s00 and 87 on p00010_s01
  xqrs   mean Se 82.46, but Se 0.8 on p00003_s00 and 10.5 on p00009_s01
  2ma    mean Se 98.84, but PPV 81-87 on the noisy records

That pattern is the textbook argument for an ensemble: each detector's failure
mode is a different regime (flat baseline, bursty artefact, tall T waves), so
the union of their detections has far higher recall than any one alone, and a
consensus score over the union restores precision.

Fusion rules
  1. candidates  union of gqrs, 2ma and all local maxima of |0.5-40 Hz|,
                 snapped onto the wideband R deflection and deduplicated
  2. score       weighted vote: how many detectors proposed this peak, plus the
                 peak's correlation with the record's QRS template clusters
  3. decision    keep candidates above a vote/score floor, then enforce RR
                 regularity by removing the weaker member of any pair that is
                 closer than half the local median RR

Usage:
  python -I probe_fuse.py [record ...]
  python -I probe_fuse.py --mode vote|score|both
"""
from __future__ import annotations

from pathlib import Path

import json
import sys
import warnings

import numpy as np
from scipy import signal as sps

sys.path.insert(0, str(Path(__file__).resolve().parent))
from config import CATALOG  # noqa: E402
from detect import load  # noqa: E402
from detect4 import band, score_weighted  # noqa: E402
from probe_baseline import run_gqrs, run_twomax  # noqa: E402
from probe_ktmpl import all_local_maxima, windows  # noqa: E402
from probe_ktmpl import kmeans  # noqa: E402

warnings.filterwarnings("ignore")
FS = 250


def snap(pk, wide, fs, half_ms=50.0):
    half = int(half_ms / 1000 * fs)
    out = []
    for p in np.asarray(pk, dtype=int):
        lo = max(0, p - half)
        hi = min(len(wide) - 1, p + half)
        out.append(lo + int(np.argmax(np.abs(wide[lo:hi + 1]))))
    return np.array(out, dtype=int)


def merge(pk_list, tol):
    """Union with tolerance: peaks within `tol` of an already-kept peak are
    counted as the same event, which is what makes the vote meaningful."""
    allpk = np.sort(np.concatenate(pk_list)) if pk_list else np.array([], int)
    if len(allpk) == 0:
        return np.array([], int)
    keep = [allpk[0]]
    for p in allpk[1:]:
        if p - keep[-1] > tol:
            keep.append(p)
    return np.array(keep, dtype=int)


def votes_for(cand, pk, tol):
    """How many source detectors proposed a peak at each candidate."""
    v = np.zeros(len(cand), dtype=int)
    for i, c in enumerate(cand):
        for arr in pk:
            j = np.searchsorted(arr, c)
            lo, hi = max(0, j - 1), min(len(arr), j + 1)
            if hi > lo and np.min(np.abs(arr[lo:hi] - c)) <= tol:
                v[i] += 1
    return v


def qrs_score(wide, cand, k=8, half_ms=120.0, fs=FS, kmeans_init="rng"):
    half = int(half_ms / 1000 * fs)
    w, ok = windows(wide, cand, half)
    if ok.sum() < 20:
        return np.zeros(len(cand)), ok
    ww = w[ok]
    n_sub = min(len(ww), 6000)
    sub = ww[np.linspace(0, len(ww) - 1, n_sub).astype(int)]
    cent, _ = kmeans(sub, k, init=kmeans_init)
    sim = np.abs(ww @ cent.T)
    d = np.abs(np.gradient(cent, axis=1))
    mid = slice(max(0, half - int(0.04 * fs)), half + int(0.04 * fs) + 1)
    cs = d[:, mid].mean(axis=1)
    keep = cs >= np.percentile(cs, 50)
    if not keep.any():
        keep = np.ones(k, dtype=bool)
    s = np.zeros(len(cand))
    s[ok] = sim[:, keep].max(axis=1)
    return s, ok


def rr_clean(peaks, strength, fs, frac=0.5, floor_ms=220.0):
    """Remove the weaker of any pair closer than max(floor, frac*median RR)."""
    if len(peaks) < 3:
        return peaks
    st = dict(zip(peaks.tolist(), strength.tolist()))
    keep = list(peaks.tolist())
    for _ in range(6):
        rr = np.diff(keep)
        if len(rr) < 2:
            break
        cut = max(floor_ms / 1000 * fs, frac * float(np.median(rr)))
        out, changed, i = [], False, 0
        while i < len(keep):
            if i + 1 < len(keep) and keep[i + 1] - keep[i] < cut:
                changed = True
                out.append(keep[i] if st.get(keep[i], 0) >= st.get(keep[i + 1], 0)
                           else keep[i + 1])
                i += 2
            else:
                out.append(keep[i])
                i += 1
        keep = out
        if not changed:
            break
    return np.array(keep, dtype=int)


def run(rec, mode="both", vote_floor=1, score_floor=0.75, rr_frac=0.5):
    sig, ref, fs, _ = load(rec)
    wide = band(sig, 0.5, 40.0, fs)
    tol = int(0.05 * fs)

    pk_g = snap(run_gqrs(sig), wide, fs)
    pk_m = snap(run_twomax(sig, fs), wide, fs)
    pk_l = snap(all_local_maxima(np.abs(wide), int(0.12 * fs)), wide, fs)
    srcs = [pk_g, pk_m]

    cand = merge([pk_g, pk_m], tol)
    if len(cand) < 10:
        return np.array([], int), ref, fs

    v = votes_for(cand, srcs, tol)
    sc, _ = qrs_score(wide, cand)
    amp = np.abs(wide[cand])
    amp_n = amp / (float(np.percentile(amp, 95)) + 1e-12)

    if mode == "vote":
        strength = v + 0.25 * amp_n
        keep = v >= vote_floor
    elif mode == "score":
        strength = sc + 0.1 * v
        keep = sc >= score_floor
    else:
        strength = v + sc + 0.25 * amp_n
        keep = (v >= vote_floor) & (sc >= score_floor)

    if keep.sum() < 10:
        keep = v >= vote_floor
    cand_k = cand[keep]
    strength_k = strength[keep]
    out = rr_clean(cand_k, strength_k, fs, frac=rr_frac)
    return out, ref, fs


def main() -> None:
    mode, vote_floor, score_floor, rr_frac = "both", 1, 0.75, 0.5
    a = sys.argv[1:]
    for flag in ("--mode", "--vote", "--score", "--rr"):
        if flag in a:
            i = a.index(flag)
            v = a[i + 1]
            a = a[:i] + a[i + 2:]
            if flag == "--mode":
                mode = v
            elif flag == "--vote":
                vote_floor = int(v)
            elif flag == "--score":
                score_floor = float(v)
            elif flag == "--rr":
                rr_frac = float(v)
    args = [x for x in a if not x.startswith("-")]
    index = json.loads((CATALOG / "f32" / "index.json").read_text())
    recs = args or [s["record"] for s in index]

    print(f"mode={mode} vote>={vote_floor} score>={score_floor} rr={rr_frac}")
    print(f"{'record':14} {'ref':>6} {'det':>6} {'Se':>7} {'PPV':>7} {'F1':>7}")
    ses, ppvs, tot = [], [], {"tp": 0, "fp": 0, "fn": 0}
    for rec in recs:
        out, ref, fs = run(rec, mode, vote_floor, score_floor, rr_frac)
        s = score_weighted(ref, out, fs)
        ses.append(s["se"])
        ppvs.append(s["ppv"])
        for m in tot:
            tot[m] += s[m]
        print(f"{rec:14} {len(ref):6d} {len(out):6d} {s['se']:7.2f} "
              f"{s['ppv']:7.2f} {s['f1']:7.2f}")
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
