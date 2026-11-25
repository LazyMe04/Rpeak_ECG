"""G1 anomaly probe: why is class Q so frequent, and what does it look like?

Checks whether Q beats correlate with noise, amplitude collapse, or a
specific patient morphology. Read-only.

Usage: python -I probe_q.py [patient]
"""
from __future__ import annotations

import sys
from collections import Counter
from pathlib import Path

import numpy as np
import wfdb

sys.path.insert(0, str(Path(__file__).resolve().parent))
from config import FS, RAW  # noqa: E402


def analyse(stem: Path) -> None:
    rec = wfdb.rdrecord(str(stem))
    ann = wfdb.rdann(str(stem), "atr")
    sig = rec.p_signal[:, 0]

    mask = np.array([s in "NSVQ" for s in ann.symbol])
    samples = ann.sample[mask]
    symbols = np.array(ann.symbol, dtype="<U1")[mask]

    print(f"\n=== {stem.name} ===")
    print("symbol counts:", Counter(symbols).most_common())

    # Per-class RR statistics: Q beats that are extremely close to a previous
    # beat suggest double-annotation; very distant ones suggest noise dropouts.
    for cls in "NQSV":
        idx = samples[symbols == cls]
        if len(idx) < 2:
            continue
        rr = np.diff(idx)
        print(f"  {cls}: n={len(idx):6d} rr_med={np.median(rr):6.0f} "
              f"rr_p5={np.percentile(rr,5):6.0f} rr_p95={np.percentile(rr,95):6.0f}")

    # Amplitude of local QRS peak at each annotation, by class
    print("\n  local QRS amplitude (within +-40 samples) by class:")
    win = int(0.16 * FS)
    for cls in "NQSV":
        idx = samples[symbols == cls]
        if len(idx) < 5:
            continue
        idx = idx[(idx > win) & (idx < len(sig) - win)]
        amps = np.array([np.ptp(sig[i - win:i + win]) for i in idx[::max(1, len(idx)//400)]])
        print(f"    {cls}: n={len(idx):6d} ptp_med={np.median(amps):6.2f} mV "
              f"ptp_p10={np.percentile(amps,10):5.2f} ptp_p90={np.percentile(amps,90):5.2f}")

    # Are Q beats adjacent to noise bursts? Compare local RMS of high-freq content
    from scipy import signal as sps

    b, a = sps.butter(2, [40, 90], btype="band", fs=FS)
    hf = sps.filtfilt(b, a, sig)
    win = int(0.4 * FS)
    print("\n  local 40-90 Hz RMS (noise proxy) by class:")
    for cls in "NQSV":
        idx = samples[symbols == cls]
        if len(idx) < 5:
            continue
        idx = idx[(idx > win) & (idx < len(sig) - win)]
        idx = idx[:: max(1, len(idx) // 400)]
        rms = np.array([np.sqrt(np.mean(hf[i - win:i + win] ** 2)) for i in idx])
        print(f"    {cls}: n={len(idx):6d} hf_rms_med={np.median(rms)*1000:6.1f} uV")

    # Rhythm regions detail
    print("\n  rhythm region list:")
    open_tag, start_s = None, None
    for s, note, samp in zip(ann.symbol, ann.aux_note, ann.sample):
        if s != "+" or note is None:
            continue
        note = note.strip()
        if note.startswith("("):
            open_tag, start_s = note[1:], samp
        elif note == ")" and open_tag:
            dur = (samp - start_s) / FS / 60
            print(f"    {open_tag:6} {dur:7.1f} min")
            open_tag = None


def main() -> None:
    if len(sys.argv) > 1:
        pid = int(sys.argv[1])
        stems = sorted((RAW / f"p{pid//10000:02d}" / f"p{pid:05d}").glob("*.hea"))
    else:
        stems = sorted(RAW.rglob("*.hea"))
    for h in stems[:4]:
        analyse(h.with_suffix(""))


if __name__ == "__main__":
    main()
