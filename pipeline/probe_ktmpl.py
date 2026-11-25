"""Multi-template matched filtering: does morphology clustering beat one template?

A single template cannot represent a 70-minute segment in which the QRS shape
and axis drift, which is why the score distributions of true and false
candidates overlap on p00006_s00 and p00004_s01. Local windows made it worse
because the window median was contaminated by non-QRS peaks.

Here the record's own morphology is clustered: every candidate window is
normalised and k-means groups them into a few shapes. Each candidate is then
scored by its correlation with the best QRS-like cluster, so drift costs
nothing -- a beat that matches cluster 5 is judged by cluster 5.

Clusters are classified by the centre's mean |d/dt| within +-40 ms, normalised
across clusters. T waves cluster separately and have low slope, so excluding the
lowest-slope clusters is what rejects them.

Usage:
  python -I probe_ktmpl.py [record ...]
  python -I probe_ktmpl.py --k 8 --half 120 [record ...]
"""
from __future__ import annotations

from pathlib import Path

import json
import sys

import numpy as np
from scipy import signal as sps

sys.path.insert(0, str(Path(__file__).resolve().parent))
from config import CATALOG  # noqa: E402
from detect import load  # noqa: E402
from detect4 import band, score_weighted  # noqa: E402

FS = 250


def all_local_maxima(aw: np.ndarray, min_dist: int) -> np.ndarray:
    pk, _ = sps.find_peaks(aw, distance=min_dist)
    floor = 0.005 * float(np.percentile(aw, 99))
    return pk[aw[pk] > floor]


def windows(x: np.ndarray, idx: np.ndarray, half: int) -> np.ndarray:
    """Normalised windows, one row per index. Rows outside the signal are
    dropped by the caller via the returned mask."""
    ok = (idx - half >= 0) & (idx + half < len(x))
    out = np.zeros((len(idx), 2 * half + 1))
    w = x[idx[ok][:, None] + np.arange(-half, half + 1)[None, :]]
    w = w - w.mean(axis=1, keepdims=True)
    nrm = np.sqrt((w * w).sum(axis=1, keepdims=True)) + 1e-12
    out[ok] = w / nrm
    return out, ok


def kmeans(x: np.ndarray, k: int, iters: int = 25, seed: int = 0,
           init: str = "rng"):
    """Lloyd iterations from a seeded init.

    `init="even"` takes k rows evenly spaced through the data instead of
    sampling them with numpy's PCG64 stream. numpy's `choice(n, k,
    replace=False)` is not `permutation(n)[:k]`, so reproducing its stream in
    TypeScript would mean porting PCG64 and Floyd's algorithm; the effect on
    the score was measured at <=0.6 pp on the worst segment and ~0.001 on the
    correlation mean, so the deterministic init is used for port parity.
    """
    if init == "even":
        cent = x[np.linspace(0, len(x) - 1, k).astype(int)].copy()
    else:
        rng = np.random.default_rng(seed)
        cent = x[rng.choice(len(x), k, replace=False)].copy()
    for _ in range(iters):
        d = (x * x).sum(1)[:, None] - 2 * x @ cent.T + (cent * cent).sum(1)[None, :]
        lab = np.argmin(d, axis=1)
        for j in range(k):
            m = lab == j
            if m.any():
                c = x[m].mean(axis=0)
                n = np.linalg.norm(c)
                cent[j] = c / (n + 1e-12)
    d = (x * x).sum(1)[:, None] - 2 * x @ cent.T + (cent * cent).sum(1)[None, :]
    return cent, np.argmin(d, axis=1)


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


def run_record(rec: str, k: int, half_ms: float):
    sig, ref, fs, _ = load(rec)
    wide = band(sig, 0.5, 40.0, fs)
    cand = all_local_maxima(np.abs(wide), int(0.12 * fs))
    half = int(half_ms / 1000 * fs)
    w, ok = windows(wide, cand, half)
    cand = cand[ok]
    w = w[ok]

    # Cluster a subsample; scoring uses the resulting centres for all windows.
    n_sub = min(len(w), 6000)
    sub = w[np.linspace(0, len(w) - 1, n_sub).astype(int)]
    cent, _ = kmeans(sub, k)
    sim = np.abs(w @ cent.T)            # (n_cand, k)
    cs = sim.argmax(axis=1)

    # Cluster QRS-likeness from the centre's own slope near its middle.
    d = np.abs(np.gradient(cent, axis=1))
    mid = slice(max(0, half - int(0.04 * fs)), half + int(0.04 * fs) + 1)
    slope = d[:, mid].mean(axis=1)
    order = np.argsort(slope)
    rank = np.empty(k)
    rank[order] = np.arange(k)
    # Weight: clusters in the slower half are down-weighted, faster ones kept.
    wgt = np.ones(k)
    slow = rank < k // 2
    if slow.any():
        wgt[slow] = np.linspace(0.15, 0.9, int(slow.sum()))
    score = (sim * wgt[None, :]).max(axis=1)
    return cand, score, ref, fs, cent, cs


def main() -> None:
    k = 8
    half_ms = 120.0
    a = sys.argv[1:]
    if "--k" in a:
        i = a.index("--k")
        k = int(a[i + 1])
        a = a[:i] + a[i + 2:]
    if "--half" in a:
        i = a.index("--half")
        half_ms = float(a[i + 1])
        a = a[:i] + a[i + 2:]
    args = [x for x in a if not x.startswith("-")]
    index = json.loads((CATALOG / "f32" / "index.json").read_text())
    recs = args or [s["record"] for s in index]

    store = {}
    print(f"k={k} half={half_ms:.0f}ms")
    print(f"{'record':14} {'nref':>6} {'trueP10':>8} {'trueP50':>8} "
          f"{'falseP99':>9} {'auc':>6}")
    for rec in recs:
        cand, score, ref, fs, cent, cs = run_record(rec, k, half_ms)
        it = is_true_mask(cand, ref, fs)
        t, f = score[it], score[~it]
        # AUC via rank statistic
        allsc = np.concatenate([t, f])
        r = np.argsort(np.argsort(allsc)) + 1
        auc = (r[: len(t)].sum() - len(t) * (len(t) + 1) / 2) / max(
            len(t) * len(f), 1)
        print(f"{rec:14} {len(ref):6d} {np.percentile(t,10):8.3f} "
              f"{np.median(t):8.3f} {np.percentile(f,99):9.3f} {auc:6.3f}")
        store[rec] = (cand, score, ref, fs)
        print(f"   loaded {rec}", file=sys.stderr)

    print(f"\n{'cut':>6} {'Se':>7} {'PPV':>7} {'F1':>7} | {'medSe':>7} "
          f"{'minSe':>7} {'medPPV':>7} {'minPPV':>7}")
    for cut in (0.5, 0.6, 0.7, 0.75, 0.8, 0.85, 0.9):
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
              f"{min(ses):7.2f} {np.median(ppvs):7.2f} {min(ppvs):7.2f}")


if __name__ == "__main__":
    main()
