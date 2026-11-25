"""Is the recall ceiling a signal limit or an algorithm limit?

For each reference beat, measure the local wideband peak-to-peak amplitude and
compare the distribution of beats the candidate stage finds against the ones it
misses. If missed beats are systematically tiny, the ceiling is what the
annotations assert but the signal does not show, and loosening the detector
would only add false positives.

Also reports reference RR-interval structure, because annotation pairs closer
than the physiological refractory period would cap PPV no matter what.

Usage:
  python -I probe_ceiling.py [record ...]
"""
from __future__ import annotations

import json
import sys

import numpy as np

sys.path.insert(0, "D:/Rpeak-Desktop/pipeline")
from config import CATALOG  # noqa: E402
from detect import load  # noqa: E402
from detect4 import band  # noqa: E402

FS = 250


def main() -> None:
    args = [a for a in sys.argv[1:] if not a.startswith("-")]
    index = json.loads((CATALOG / "f32" / "index.json").read_text())
    recs = args or ["p00000_s00", "p00006_s00", "p00004_s01", "p00010_s00",
                    "p00010_s01", "p00002_s01"]

    print(f"{'record':14} {'nref':>6} {'RR<200':>7} {'RR<260':>7} "
          f"{'amp%.2f'%0:>0}")
    for rec in recs:
        sig, ref, fs, _ = load(rec)
        wide = band(sig, 0.5, 40.0, fs)
        rr = np.diff(ref)
        short200 = int((rr < 0.2 * fs).sum())
        short260 = int((rr < 0.26 * fs).sum())

        half = int(0.06 * fs)
        amp = np.zeros(len(ref))
        for k, r in enumerate(ref):
            lo, hi = max(0, r - half), min(len(wide) - 1, r + half)
            amp[k] = np.ptp(wide[lo:hi + 1])

        med = float(np.median(amp))
        q = {
            "p1": np.percentile(amp, 1), "p5": np.percentile(amp, 5),
            "p10": np.percentile(amp, 10), "p25": np.percentile(amp, 25),
            "p50": med,
        }
        print(f"{rec:14} {len(ref):6d} {short200:7d} {short260:7d} "
              f"amp p1={q['p1']:.2f} p5={q['p5']:.2f} p10={q['p10']:.2f} "
              f"p25={q['p25']:.2f} p50={q['p50']:.2f}")

        # how many reference beats are below a fraction of the record's median
        for frac in (0.3, 0.5):
            n = int((amp < frac * med).sum())
            print(f"      beats with amp < {frac:.1f}*median: {n:5d} "
                  f"({100*n/len(ref):5.1f}%)")


if __name__ == "__main__":
    main()
