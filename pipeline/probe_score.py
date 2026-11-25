"""Compare candidate-scoring schemes for separating QRS from T waves.

The matched filter on 0.5-40 Hz correlates a QRS-shaped template against every
envelope candidate. On segments where the T wave is tall this admits T waves:
after a 0.5-40 Hz bandpass a T wave is a smooth bump, but it still correlates
0.4-0.7 with a QRS template because both share the same low-frequency content.

Each scheme below re-scores the SAME candidate set, so differences are purely
from the feature, not from candidate generation.

  A  wide      Pearson on 0.5-40 Hz                       (baseline)
  B  narrow    Pearson on 8-30 Hz       (T wave has little energy here)
  C  product   wide * narrow
  D  slope     normalised max |d/dt| in +-40 ms, 0..1 scaled
  E  wide*slope
  F  wide*narrow*slope

Usage:
  python -I probe_score.py [record ...]
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
from detect4 import band, envelope, pearson_window, score_weighted  # noqa: E402
from detect5 import build_template_from, select_beats  # noqa: E402

FS = 250


def candidates(rec: str):
    sig, ref, fs, _ = load(rec)
    wide = band(sig, 0.5, 40.0, fs)
    narrow = band(sig, 10, 25, fs)
    integ, win = envelope(narrow, fs)
    delay = (win - 1) // 2
    n = int(10.0 * fs) | 1
    scale = percentile_filter(integ, percentile=99, size=n, mode="nearest")
    cand, _ = sps.find_peaks(integ, height=0.08 * scale, distance=int(0.3 * fs))
    cand = np.maximum(0, cand - delay)
    half = int(0.07 * fs)
    snapped = []
    for c in cand:
        lo, hi = max(0, c - half), min(len(wide) - 1, c + half)
        snapped.append(lo + int(np.argmax(np.abs(wide[lo:hi + 1]))))
    cand = np.unique(np.array(snapped, dtype=int))
    return sig, ref, fs, wide, cand


def features(sig, wide, cand, fs):
    band8_30 = band(sig, 8.0, 30.0, fs)
    tmpl_w = build_template_from(wide, cand, fs, half_ms=90.0)
    tmpl_n = build_template_from(band8_30, cand, fs, half_ms=90.0)
    if tmpl_w is None or tmpl_n is None:
        z = np.zeros(len(cand))
        return {"wide": z, "narrow": z, "product": z, "slope": z,
                "wide*slope": z, "wide*narrow*slope": z}
    sw = np.abs(pearson_window(wide, tmpl_w, cand))
    sn = np.abs(pearson_window(band8_30, tmpl_n, cand))

    # Slope: max |derivative| in +-40 ms, expressed relative to the segment's
    # typical QRS slope so the feature is amplitude- and patient-independent.
    d = np.abs(np.gradient(wide))
    half = int(0.04 * fs)
    slope = np.zeros(len(cand))
    for k, c in enumerate(cand):
        lo, hi = max(0, c - half), min(len(d) - 1, c + half)
        slope[k] = float(d[lo:hi + 1].max())
    q = float(np.percentile(slope, 90)) + 1e-12
    sl = np.clip(slope / q, 0.0, 1.5) / 1.5

    return {"wide": sw, "narrow": sn, "product": sw * sn, "slope": sl,
            "wide*slope": sw * sl, "wide*narrow*slope": sw * sn * sl}


def main() -> None:
    args = [a for a in sys.argv[1:] if not a.startswith("-")]
    index = json.loads((CATALOG / "f32" / "index.json").read_text())
    recs = args or [s["record"] for s in index]

    data = {}
    for r in recs:
        sig, ref, fs, wide, cand = candidates(r)
        data[r] = (ref, cand, features(sig, wide, cand, fs))
        print(f"loaded {r}", file=sys.stderr)

    keys = ["wide", "narrow", "product", "slope", "wide*slope",
            "wide*narrow*slope"]
    for th in (0.20, 0.30, 0.40):
        print(f"\n===== threshold {th:.2f} =====")
        print(f"{'scheme':22} {'Se':>7} {'PPV':>7} {'F1':>7} "
              f"{'medSe':>7} {'minSe':>7} {'medPPV':>7}")
        for k in keys:
            ses, ppvs, tot = [], [], {"tp": 0, "fp": 0, "fn": 0}
            for r in recs:
                ref, cand, feats = data[r]
                out = select_beats(cand, feats[k], FS, thresh=th)
                sc = score_weighted(ref, out, FS)
                ses.append(sc["se"])
                ppvs.append(sc["ppv"])
                for m in tot:
                    tot[m] += sc[m]
            se = 100 * tot["tp"] / max(tot["tp"] + tot["fn"], 1)
            ppv = 100 * tot["tp"] / max(tot["tp"] + tot["fp"], 1)
            f1 = 2 * se * ppv / max(se + ppv, 1e-9)
            print(f"{k:22} {se:7.2f} {ppv:7.2f} {f1:7.2f} "
                  f"{np.median(ses):7.2f} {min(ses):7.2f} {np.median(ppvs):7.2f}")


if __name__ == "__main__":
    main()
