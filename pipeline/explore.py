"""G1 survey: validate assumptions about one icentia11k segment.

Usage:  python -I explore.py <segment_path_without_extension>

Prints signal statistics, annotation composition and sampling-rate sanity.
Read-only: writes nothing.
"""
from __future__ import annotations

import sys
from collections import Counter
from pathlib import Path

import numpy as np
import wfdb


def main(stem: str) -> None:
    stem_p = Path(stem)
    rec = wfdb.rdrecord(str(stem_p))
    ann = wfdb.rdann(str(stem_p), "atr")

    sig = rec.p_signal[:, 0]                                   # physical units (mV)
    raw = wfdb.rdrecord(str(stem_p), physical=False).d_signal[:, 0]  # int16 ADC units

    print(f"record          : {rec.record_name}")
    print(f"fs              : {rec.fs} Hz")
    print(f"samples         : {rec.sig_len}  ({rec.sig_len / rec.fs / 60:.1f} min)")
    print(f"channel         : {rec.sig_name}  units={rec.units}")
    print(f"adc_gain        : {rec.adc_gain}")
    print(f"baseline        : {rec.baseline}")
    print(f"raw dtype/range : {raw.dtype} [{raw.min()}, {raw.max()}]")
    print(f"mV range        : [{sig.min():.3f}, {sig.max():.3f}]")
    print(f"mV std          : {sig.std():.3f}")
    print(f"percentiles mV  : 1%={np.percentile(sig,1):.3f} "
          f"50%={np.percentile(sig,50):.3f} 99%={np.percentile(sig,99):.3f}")

    # Noise / clipping indicators
    p999 = np.percentile(np.abs(sig), 99.9)
    print(f"p99.9 |mV|      : {p999:.3f}")
    rail = int(np.sum(np.abs(raw) >= 32760))
    print(f"samples at rail : {rail} ({100*rail/len(raw):.4f}%)")

    # Annotations
    sym = Counter(ann.symbol)
    total = len(ann.sample)
    print(f"\nbeats annotated : {total}")
    for s, c in sym.most_common():
        print(f"  {s!r:6} {c:7d}  {100*c/total:6.2f}%")

    beats = sum(c for s, c in sym.items() if s in "NSVQ")
    print(f"beats in NSVQ   : {beats}  ({beats/ (rec.sig_len/rec.fs/60):.1f} /min)")

    # Rhythm regions from aux_note
    if ann.aux_note:
        rhythms = Counter()
        for note in ann.aux_note:
            note = note.strip()
            if not note:
                continue
            tag = note.lstrip("(").split(" ")[0].strip(")")
            rhythms[tag] += 1
        print("\nrhythm regions  :", dict(rhythms))

    # Annotation index sanity
    print(f"\nfirst beat idx  : {ann.sample[0]}   last: {ann.sample[-1]}")
    print(f"in range        : {bool(ann.sample.max() < rec.sig_len)}")
    diffs = np.diff(ann.sample)
    diffs = diffs[diffs > 0]
    print(f"RR samples      : median={np.median(diffs):.0f} "
          f"({60000*np.median(diffs)/rec.fs/1000:.1f} bpm) "
          f"min={diffs.min()} max={diffs.max()}")

    # Spectral check for notch frequency
    from scipy import signal as sps

    f, pxx = sps.welch(sig - sig.mean(), fs=rec.fs, nperseg=4096)
    for band, lo, hi in (("50Hz", 49, 51), ("60Hz", 59, 61)):
        m = (f >= lo) & (f <= hi)
        print(f"PSD {band:5} mean : {pxx[m].mean():.4e}")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    main(sys.argv[1])
