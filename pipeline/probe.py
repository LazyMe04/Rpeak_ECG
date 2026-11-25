"""G1 probe: inspect the raw .dat bytes and annotation internals directly.

Usage: python -I probe.py <segment_stem>
"""
from __future__ import annotations

import sys
from collections import Counter
from pathlib import Path

import numpy as np
import wfdb


def main(stem: str) -> None:
    p = Path(stem)
    dat = Path(str(p) + ".dat")

    # 1. Raw bytes, read independently of wfdb
    buf = np.fromfile(dat, dtype="<i2")
    print(f"dat bytes       : {dat.stat().st_size}")
    print(f"int16 count     : {len(buf)}")
    print(f"int16 range     : [{buf.min()}, {buf.max()}]  mean={buf.mean():.2f} std={buf.std():.2f}")
    print(f"first 12        : {buf[:12].tolist()}")
    print(f"percentiles     : 0.1%={np.percentile(buf,0.1):.0f} 50%={np.percentile(buf,50):.0f} "
          f"99.9%={np.percentile(buf,99.9):.0f}")

    # 2. wfdb's digital read for comparison
    d = wfdb.rdrecord(str(p), physical=False).d_signal[:, 0]
    print(f"wfdb d_signal   : [{d.min()}, {d.max()}] dtype={d.dtype}")
    print(f"matches raw file: {bool(np.array_equal(buf[:len(d)], d))}")

    # 3. Annotations
    ann = wfdb.rdann(str(p), "atr")
    print(f"\nann.sample len  : {len(ann.sample)}")
    print(f"ann.symbol set  : {Counter(ann.symbol).most_common()}")
    print(f"ann.aux_note set: {Counter(ann.aux_note).most_common()}")
    print(f"first 10 samples: {ann.sample[:10].tolist()}")
    print(f"first 10 symbols: {ann.symbol[:10]}")
    print(f"first 10 aux    : {[a for a in ann.aux_note[:10]]}")

    # 4. Beat-only RR stats (exclude rhythm markers)
    beat_mask = np.array([s in "NSVQ" for s in ann.symbol])
    bs = ann.sample[beat_mask]
    rr = np.diff(bs)
    print(f"\nbeat count      : {len(bs)}")
    print(f"RR (samples)    : median={np.median(rr):.0f} -> {60*250/np.median(rr):.1f} bpm")
    print(f"RR p1/p99       : {np.percentile(rr,1):.0f} / {np.percentile(rr,99):.0f}")
    print(f"implied HR      : {60*250/np.median(rr):.1f} bpm  total beats/min={len(bs)/(len(buf)/250/60):.1f}")

    # 5. Check whether + markers coincide with beat samples
    plus_mask = np.array([s == "+" for s in ann.symbol])
    if plus_mask.any():
        print(f"plus samples    : {ann.sample[plus_mask][:12].tolist()}")
        print(f"plus aux        : {[a for a, m in zip(ann.aux_note, plus_mask) if m][:6]}")

    # 6. Gain round-trip check
    rec = wfdb.rdrecord(str(p))
    recon = rec.p_signal[:, 0] * rec.adc_gain[0] + rec.baseline[0]
    print(f"roundtrip maxerr: {np.abs(recon - d).max():.4f} ADC units")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    main(sys.argv[1])
