"""Compare candidate generators on raw recall.

The current generator (10-25 Hz energy envelope) has an 88-96% recall ceiling on
several records, and probe_ceiling.py showed the missed beats have ordinary
amplitude, so the ceiling is the generator's own selectivity, not the signal.

Alternatives tested, all followed by the same wideband snap and scoring:
  A  env10-25   current: energy envelope of a 10-25 Hz band   (baseline)
  B  abs-wide   peaks of |0.5-40 Hz| directly
  C  qrs-band   energy of the Pan-Tompkins 5-15 Hz band
  D  union(A,C)
  E  gradient   peaks of |d/dt of 0.5-40 Hz|, the classic QRS-ramp detector

Recall is measured against the annotations before any correlation filtering,
because that is the number the downstream stages inherit.

Usage:
  python -I probe_cand2.py [record ...]
"""
from __future__ import annotations

import json
import sys

import numpy as np
from scipy import signal as sps
from scipy.ndimage import percentile_filter

sys.path.insert(0, "D:/Rpeak-Desktop/pipeline")
from config import CATALOG  # noqa: E402
from detect import load  # noqa: E402
from detect4 import band, envelope  # noqa: E402

FS = 250


def recall_of(cand, ref, fs) -> float:
    tol = int(0.05 * fs)
    c = np.sort(np.unique(cand))
    hit, j = 0, 0
    for r in ref:
        while j < len(c) and c[j] < r - tol:
            j += 1
        if j < len(c) and c[j] <= r + tol:
            hit += 1
            j += 1
    return 100 * hit / max(len(ref), 1)


def snap_all(cand, wide, fs, half_ms=70.0):
    half = int(half_ms / 1000 * fs)
    out = []
    for c in cand:
        lo = max(0, int(c) - half)
        hi = min(len(wide) - 1, int(c) + half)
        out.append(lo + int(np.argmax(np.abs(wide[lo:hi + 1]))))
    return np.unique(np.array(out, dtype=int))


def rolling_peak(mag, fs, thr_frac, refr_ms=200.0):
    n = int(10.0 * fs) | 1
    scale = percentile_filter(mag, percentile=99, size=n, mode="nearest")
    pk, _ = sps.find_peaks(mag, height=thr_frac * scale,
                           distance=max(1, int(refr_ms / 1000 * fs)))
    return pk


def main() -> None:
    args = [a for a in sys.argv[1:] if not a.startswith("-")]
    index = json.loads((CATALOG / "f32" / "index.json").read_text())
    recs = args or ["p00000_s00", "p00006_s00", "p00004_s01", "p00010_s00",
                    "p00010_s01", "p00002_s01"]

    data = {}
    for r in recs:
        sig, ref, fs, _ = load(r)
        wide = band(sig, 0.5, 40.0, fs)
        narrow = band(sig, 10, 25, fs)
        qrsb = band(sig, 5.0, 15.0, fs)
        integ_n, win_n = envelope(narrow, fs)
        integ_q, win_q = envelope(qrsb, fs)
        grad = np.abs(np.gradient(wide))
        data[r] = dict(ref=ref, fs=fs, wide=wide, integ_n=integ_n,
                       delay_n=(win_n - 1) // 2, integ_q=integ_q,
                       delay_q=(win_q - 1) // 2, grad=grad)
        print(f"loaded {r}", file=sys.stderr)

    print(f"{'gen':26} " + " ".join(f"{r:>12}" for r in recs) +
          f" {'mean':>7} {'ncand':>8} {'auc':>7}")

    def report(name, make):
        vals, tot = [], 0
        for r in recs:
            d = data[r]
            raw = make(d)
            tot += len(raw)
            vals.append(recall_of(raw, d["ref"], d["fs"]))
        print(f"{name:26} " + " ".join(f"{v:12.2f}" for v in vals) +
              f" {np.mean(vals):7.2f} {tot:8d}")
        return vals

    def a(d, k=0.08):
        c, _ = sps.find_peaks(d["integ_n"], height=k * percentile_filter(
            d["integ_n"], 99, size=int(10 * d["fs"]) | 1, mode="nearest"),
            distance=int(0.2 * d["fs"]))
        return snap_all(np.maximum(0, c - d["delay_n"]), d["wide"], d["fs"])

    def b(d, k=0.25):
        return snap_all(rolling_peak(np.abs(d["wide"]), d["fs"], k),
                        d["wide"], d["fs"])

    def c(d, k=0.08):
        c0, _ = sps.find_peaks(d["integ_q"], height=k * percentile_filter(
            d["integ_q"], 99, size=int(10 * d["fs"]) | 1, mode="nearest"),
            distance=int(0.2 * d["fs"]))
        return snap_all(np.maximum(0, c0 - d["delay_q"]), d["wide"], d["fs"])

    def dd(d):
        return np.unique(np.concatenate([a(d), c(d)]))

    def e(d, k=0.25):
        return snap_all(rolling_peak(d["grad"], d["fs"], k), d["wide"], d["fs"])

    def eb(d, k=0.18):
        return np.unique(np.concatenate([a(d), b(d, k)]))

    for k in (0.25, 0.15, 0.08):
        report(f"B abs-wide k={k}", lambda d, k=k: b(d, k))
    for k in (0.25, 0.15, 0.08):
        report(f"E gradient  k={k}", lambda d, k=k: e(d, k))
    report("A env10-25 k=0.08 (baseline)", a)
    report("C qrsband5-15 k=0.08", c)
    report("D union(A,C)", dd)
    report("F union(A,B k=0.15)", lambda d: eb(d, 0.15))


if __name__ == "__main__":
    main()
