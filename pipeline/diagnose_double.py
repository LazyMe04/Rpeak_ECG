"""Diagnose why one segment keeps producing double detections.

Prints, for a short window, the annotation positions, the detected positions
and the reconstructed RR series side by side.
"""
from __future__ import annotations

import sys

import numpy as np

sys.path.insert(0, "D:/Rpeak-Desktop/pipeline")
from detect import load  # noqa: E402
from detect5 import band, detect, refine_wide  # noqa: E402


def main() -> None:
    rec = sys.argv[1] if len(sys.argv) > 1 else "p00010_s01"
    sig, ref, fs, _ = load(rec)
    peaks, dbg = detect(sig, fs, 0.08, rr_penalty=0.08)
    wide = band(sig, 0.5, 40.0, fs)
    det = refine_wide(wide, peaks, fs)

    a, b = int(600 * fs), int(602 * fs)
    r = ref[(ref >= a) & (ref < b)]
    d = det[(det >= a) & (det < b)]
    print(f"{rec}  600-602 s")
    print("ref :", np.round((r - a) / fs, 3))
    print("det :", np.round((d - a) / fs, 3))
    print(f"\nref count={len(r)}  det count={len(d)}")

    # amplitudes and widths of the two populations
    for name, arr in (("ref", r), ("det", d)):
        if len(arr) < 2:
            continue
        half = int(0.06 * fs)
        amps = [float(np.ptp(sig[max(0, i - half): i + half])) for i in arr]
        print(f"{name}: ptp median={np.median(amps):.3f}  "
              f"ptp min={np.min(amps):.3f} max={np.max(amps):.3f}")

    # global: what fraction of detections are extra?
    print(f"\nwhole segment: ref={len(ref)}  det={len(det)}  "
          f"ratio={len(det)/len(ref):.3f}")

    # template shape
    if "tmpl" in dbg:
        t = dbg["tmpl"]
        print(f"template len={len(t)}  peak_pos={int(np.argmax(np.abs(t)))} "
              f"(centre={len(t)//2})")
        print(f"template: min={t.min():.3f} max={t.max():.3f}")


if __name__ == "__main__":
    main()
