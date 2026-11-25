"""Faithful Pan-Tompkins with adaptive thresholds and searchback.

v6 failed because it applied the SPKI/NPKI thresholds to correlation scores,
which are already amplitude-normalised and therefore saturate near 1. The
threshold has to act on the integration envelope, which is where Pan & Tompkins
define it, because that is the quantity whose scale actually tracks signal
strength.

Stage-by-stage, exactly as the 1985 paper specifies:
  1. 5-15 Hz bandpass at order 2 (scipy SOS, shared with the app via
     gen_filter_coeffs.py)
  2. five-point derivative  d[n] = 2x[n]+x[n-1]-x[n-3]-2x[n-4]
  3. pointwise square
  4. 150 ms moving-window integration, group delay (N-1)/2 compensated
  5. SPKI / NPKI running estimates of the envelope peak, thresholds
       THR1 = NPKI + 0.25 (SPKI - NPKI)
       THR2 = 0.5  THR1
  6. searchback: if no beat for 1.66 x the running RR, re-scan the interval at
     THR2 and take its best peak
  7. T-wave rule: a peak < 360 ms after an accepted one whose envelope slope is
     < half the previous beat's is discarded

Usage:
  python -I probe_pt.py [record ...]
  python -I probe_pt.py --k1 0.25 --k2 0.5 --sb 1.66
"""
from __future__ import annotations

import json
import sys
import warnings

import numpy as np
from scipy import signal as sps

sys.path.insert(0, "D:/Rpeak-Desktop/pipeline")
from config import CATALOG  # noqa: E402
from detect import load  # noqa: E402
from detect4 import band, score_weighted  # noqa: E402

warnings.filterwarnings("ignore")
FS = 250


def integrate(x, fs, integ_ms=150.0):
    n = max(2, int(round(fs * integ_ms / 1000)))
    return np.convolve(x, np.ones(n) / n, mode="full")[: len(x)], n


def pan_tompkins(sig, fs=FS, k1=0.25, k2=0.5, searchback=1.66,
                 refractory_ms=200.0, t_rule_ms=360.0, slope_frac=0.5,
                 integ_ms=150.0, band_lo=5.0, band_hi=15.0):
    x = band(sig, band_lo, band_hi, fs)
    d = np.zeros_like(x)
    d[4:] = (2 * x[4:] + x[3:-1] - x[1:-3] - 2 * x[:-4]) / 8.0
    sq = d * d
    integ, n = integrate(sq, fs, integ_ms)
    delay = (n - 1) // 2
    # Slide the envelope back so peaks line up with the QRS.
    integ = np.concatenate([integ[delay:], np.zeros(delay)])

    refr = int(refractory_ms / 1000 * fs)
    t_win = int(t_rule_ms / 1000 * fs)

    # Local peaks of the envelope, generously low, then the adaptive logic picks.
    floor = 0.02 * float(np.percentile(integ, 99))
    pk, _ = sps.find_peaks(integ, height=floor, distance=max(1, refr // 3))

    if len(pk) < 5:
        return pk

    # Initialise from the first couple of seconds.
    warm = pk[: max(5, min(40, len(pk)))]
    spki = float(np.percentile(integ[warm], 90))
    npki = float(np.median(integ[warm]))
    thr1 = npki + k1 * (spki - npki)
    thr2 = k2 * thr1

    accepted: list[int] = []
    beat_slope: list[float] = []
    last_rr = 8.0 * refr

    for i, p in enumerate(pk):
        p = int(p)
        v = float(integ[p])

        if accepted and p - accepted[-1] < refr:
            if v > integ[accepted[-1]]:
                accepted[-1] = p
                beat_slope[-1] = v
            continue

        # searchback: the gap has grown well beyond the running RR
        long_gap = accepted and (p - accepted[-1]) > searchback * last_rr
        use = thr2 if long_gap else thr1

        if v >= use:
            if (accepted and p - accepted[-1] < t_win
                    and v < slope_frac * beat_slope[-1]):
                npki = 0.875 * npki + 0.125 * v
            else:
                if accepted:
                    rr = p - accepted[-1]
                    last_rr = 0.75 * last_rr + 0.25 * rr
                accepted.append(p)
                beat_slope.append(v)
                spki = 0.875 * spki + 0.125 * v
        else:
            npki = 0.875 * npki + 0.125 * v

        thr1 = npki + k1 * (spki - npki)
        thr2 = k2 * thr1

    # Second pass: fill long gaps by taking the best peak in each gap at THR2.
    out = list(accepted)
    if searchback > 0 and len(out) >= 2:
        filled = [out[0]]
        for a, b in zip(out[:-1], out[1:]):
            gap = b - a
            if gap > searchback * float(np.median(np.diff(out)) or last_rr):
                lo, hi = a + refr, b - refr
                if hi > lo:
                    seg = integ[lo:hi]
                    j = int(np.argmax(seg))
                    if seg[j] >= thr2:
                        filled.append(lo + j)
            filled.append(b)
        out = filled

    return np.array(sorted(set(out)), dtype=int)


def main() -> None:
    k1, k2, sb = 0.25, 0.5, 1.66
    a = sys.argv[1:]
    for flag in ("--k1", "--k2", "--sb"):
        if flag in a:
            i = a.index(flag)
            v = float(a[i + 1])
            a = a[:i] + a[i + 2:]
            if flag == "--k1":
                k1 = v
            elif flag == "--k2":
                k2 = v
            else:
                sb = v
    args = [x for x in a if not x.startswith("-")]
    index = json.loads((CATALOG / "f32" / "index.json").read_text())
    recs = args or [s["record"] for s in index]

    print(f"PT k1={k1} k2={k2} searchback={sb}")
    print(f"{'record':14} {'ref':>6} {'det':>6} {'Se':>7} {'PPV':>7} {'F1':>7}")
    ses, ppvs, tot = [], [], {"tp": 0, "fp": 0, "fn": 0}
    for rec in recs:
        sig, ref, fs, _ = load(rec)
        wide = band(sig, 0.5, 40.0, fs)
        pk = pan_tompkins(sig, fs, k1=k1, k2=k2, searchback=sb)
        half = int(0.05 * fs)
        snapped = []
        for p in pk:
            lo = max(0, int(p) - half)
            hi = min(len(wide) - 1, int(p) + half)
            snapped.append(lo + int(np.argmax(np.abs(wide[lo:hi + 1]))))
        sc = score_weighted(ref, np.array(snapped), fs)
        ses.append(sc["se"])
        ppvs.append(sc["ppv"])
        for m in tot:
            tot[m] += sc[m]
        print(f"{rec:14} {len(ref):6d} {len(snapped):6d} {sc['se']:7.2f} "
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
