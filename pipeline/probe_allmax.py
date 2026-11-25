"""Decouple candidate generation from the decision.

Every reference beat has a local maximum of |0.5-40 Hz| within 8 ms (median),
yet the amplitude threshold in the current generator rejects 4-13% of them. That
means the threshold, not peak detection, is the bottleneck: it is inherently
selective because a fixed fraction of a rolling percentile cannot know whether a
peak is a QRS or a T wave.

This probe removes the amplitude threshold entirely. Candidates are *all* local
maxima of |wide| at a physiological minimum spacing, and correlation against a
template does the deciding. The template is bootstrapped from a normal
high-confidence detection, so nothing downstream changes.

Reports recall/precision of the candidate+score pipeline at several
correlation thresholds, plus the score distribution of true vs false
candidates, which is what sets the achievable operating point.

Usage:
  python -I probe_allmax.py [record ...]
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
from detect4 import band, pearson_window, score_weighted  # noqa: E402
from detect5 import build_template_from  # noqa: E402

FS = 250


def all_local_maxima(aw: np.ndarray, min_dist: int) -> np.ndarray:
    """Local maxima of |wide| at least min_dist apart, above a trivial floor.

    The floor is 0.5% of the record's 99th percentile: it only removes
    quantisation noise and flat stretches, not small beats.
    """
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


def main() -> None:
    args = [a for a in sys.argv[1:] if not a.startswith("-")]
    index = json.loads((CATALOG / "f32" / "index.json").read_text())
    recs = args or [s["record"] for s in index]

    print(f"{'record':14} {'nref':>6} {'ncand':>7} {'recall':>7} "
          f"{'trueP10':>8} {'trueP50':>8} {'falseP99':>9} {'falseP999':>10}")
    store = {}
    for rec in recs:
        sig, ref, fs, _ = load(rec)
        wide = band(sig, 0.5, 40.0, fs)
        aw = np.abs(wide)

        # Bootstrap: a normal high-confidence detection supplies the template.
        from detect5 import detect as det
        seed, _ = det(sig, fs, 0.08, thresh=0.25)
        tmpl = build_template_from(wide, np.sort(seed), fs, half_ms=110.0)
        if tmpl is None:
            continue

        cand = all_local_maxima(aw, int(0.12 * fs))
        sc = np.abs(pearson_window(wide, tmpl, cand))
        it = is_true_mask(cand, ref, fs)

        t = sc[it]
        f = sc[~it]
        rec_recall = 100 * it.sum() / len(ref)
        print(f"{rec:14} {len(ref):6d} {len(cand):7d} {rec_recall:7.2f} "
              f"{np.percentile(t,10):8.3f} {np.median(t):8.3f} "
              f"{np.percentile(f,99):9.3f} {np.percentile(f,99.9):10.3f}")
        store[rec] = (cand, sc, ref, fs, t, f)
        print(f"   loaded {rec}", file=sys.stderr)

    print(f"\n{'cut':>6} {'Se':>7} {'PPV':>7} {'F1':>7} | {'medSe':>7} "
          f"{'minSe':>7} {'medPPV':>7}")
    for cut in (0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.85, 0.9):
        ses, ppvs, tot = [], [], {"tp": 0, "fp": 0, "fn": 0}
        for rec, (cand, sc, ref, fs, _, _) in store.items():
            keep = cand[sc >= cut]
            # enforce refractory by score
            refr = int(0.25 * fs)
            out, last = [], -10**9
            for p, s in sorted(zip(cand[sc >= cut], sc[sc >= cut])):
                if p - last >= refr:
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
