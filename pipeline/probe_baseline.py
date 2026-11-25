"""Baseline: what do established detectors score on this dataset?

Before spending more effort on hand-built decision logic, measure the ceiling
with two well-tested implementations that ship in wfdb: gqrs (a Pan-Tompkins
variant tuned for ambulatory data) and xqrs (a template-matching detector with
searchback). If they also stop around 95-97%, the ceiling belongs to the
annotations rather than to the algorithm, and chasing 99% is the wrong goal.

Usage:
  python -I probe_baseline.py [record ...]
"""
from __future__ import annotations

import json
import sys
import warnings

import numpy as np

sys.path.insert(0, "D:/Rpeak-Desktop/pipeline")
from config import CATALOG  # noqa: E402
from detect import load  # noqa: E402
from detect4 import band, score_weighted  # noqa: E402

warnings.filterwarnings("ignore")

FS = 250


def run_gqrs(sig):
    # `import wfdb` alone does not bind the lazy `processing` submodule in a
    # fresh interpreter; it must be imported explicitly.
    from wfdb import processing
    return np.asarray(processing.gqrs_detect(sig.astype(np.float64),
                                             fs=FS, adc_gain=1.0,
                                             adc_zero=0), dtype=int)


def run_xqrs(sig, fs):
    from wfdb import processing
    xq = processing.XQRS(sig=sig.astype(np.float64), fs=fs)
    xq.detect(verbose=False)
    return np.asarray(xq.qrs_inds, dtype=int)


def run_twomax(sig, fs):
    """Classic two-moving-average detector from the ecgdetectors package.

    Kept here so the comparison does not depend on an uninstalled package.
    """
    from scipy import signal as sps
    b, a = sps.butter(2, [8.0 / (fs / 2), 20.0 / (fs / 2)], btype="band")
    s = sps.filtfilt(b, a, sig, padtype="odd")
    d = np.abs(sps.filtfilt([1, 2, 0, -2, -1], [1], s, padtype="odd"))
    ma = int(0.12 * fs)
    integ = np.convolve(d, np.ones(ma) / ma, mode="same")
    pk, _ = sps.find_peaks(integ, distance=int(0.25 * fs),
                           height=0.3 * float(np.percentile(integ, 99)))
    return np.asarray(pk, dtype=int)


def main() -> None:
    args = [a for a in sys.argv[1:] if not a.startswith("-")]
    index = json.loads((CATALOG / "f32" / "index.json").read_text())
    recs = args or [s["record"] for s in index]

    print(f"{'record':14} {'nref':>6} | {'gqrs Se':>8} {'gqrs PPV':>9} | "
          f"{'xqrs Se':>8} {'xqrs PPV':>9} | {'2ma Se':>7} {'2ma PPV':>8}")
    agg = {"gqrs": [], "xqrs": [], "2ma": []}
    for rec in recs:
        sig, ref, fs, _ = load(rec)
        wide = band(sig, 0.5, 40.0, fs)
        row = {}
        for name, fn in (("gqrs", lambda: run_gqrs(sig)),
                         ("xqrs", lambda: run_xqrs(sig, fs)),
                         ("2ma", lambda: run_twomax(sig, fs))):
            try:
                pk = fn()
                # Snap onto the wideband R deflection, as every detector must
                # if the reference fiducial is the peak rather than the onset.
                snapped = []
                for p in pk:
                    lo = max(0, int(p) - int(0.05 * fs))
                    hi = min(len(wide) - 1, int(p) + int(0.05 * fs))
                    snapped.append(lo + int(np.argmax(np.abs(wide[lo:hi + 1]))))
                row[name] = score_weighted(ref, np.array(snapped), fs)
            except Exception as e:  # noqa: BLE001
                row[name] = {"se": 0.0, "ppv": 0.0, "err": str(e)[:40]}
            agg[name].append(row[name])
        print(f"{rec:14} {len(ref):6d} | "
              f"{row['gqrs']['se']:8.2f} {row['gqrs']['ppv']:9.2f} | "
              f"{row['xqrs']['se']:8.2f} {row['xqrs']['ppv']:9.2f} | "
              f"{row['2ma']['se']:7.2f} {row['2ma']['ppv']:8.2f}")
        print(f"   done {rec}", file=sys.stderr)

    print()
    for name in ("gqrs", "xqrs", "2ma"):
        se = [r["se"] for r in agg[name]]
        pp = [r["ppv"] for r in agg[name]]
        print(f"{name:6} mean Se={np.mean(se):6.2f} min={min(se):6.2f} "
              f"medianPPV={np.median(pp):6.2f} minPPV={min(pp):6.2f}")


if __name__ == "__main__":
    main()
