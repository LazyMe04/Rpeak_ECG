"""Dump detect_v4 intermediates for a handful of records.

The TypeScript port is checked stage by stage against these files, not only on
the final Se/PPV: two different bugs can land on the same score, and a score
difference of 0.3 pp does not say which stage drifted. Every array is written
as little-endian float64 (exact for the integer streams, whose largest value on
a real segment is ~7e11, far inside 2^53).

Usage:
  python -I parity_golden.py [record ...]

Writes D:/Rpeak-Desktop/data/catalog/golden/<record>.json plus .f64 files.
"""
from __future__ import annotations

import json
import sys
import warnings
from pathlib import Path

import numpy as np
import wfdb
from scipy import signal as sps

sys.path.insert(0, str(Path(__file__).resolve().parent))
from config import CATALOG  # noqa: E402
from detect import load  # noqa: E402
from detect4 import band  # noqa: E402
from probe_baseline import run_twomax  # noqa: E402
from probe_dp import features  # noqa: E402
from probe_dp3 import ref_rr_from  # noqa: E402
from probe_dp4 import local_regularity, select_adaptive, weak_sequence  # noqa: E402
from probe_fuse import merge, snap  # noqa: E402

warnings.filterwarnings("ignore")
FS = 250
OUT = CATALOG / "golden"
PREFIX = 200_000          # samples of the long streams kept as a comparison target


def dump(rec: str) -> dict:
    sig, ref, fs, _ = load(rec)
    wide = band(sig, 0.5, 40.0, fs)

    # gqrs' own view of the signal: wfdb converts the float trace to 24-bit
    # integers before filtering, with gain and baseline derived from the whole
    # segment's min/max. The port has to reproduce that conversion exactly.
    wrec = wfdb.Record(p_signal=sig.reshape([-1, 1]), fmt=["24"])
    wrec.set_d_features(do_adc=True)
    d_sig = wrec.d_signal[:, 0].astype(np.float64)

    from wfdb import processing
    gqrs_pk = np.asarray(processing.gqrs_detect(sig.astype(np.float64), fs=FS,
                                               adc_gain=1.0, adc_zero=0),
                         dtype=int)
    twomax_pk = run_twomax(sig, fs)

    tol = int(0.050 * fs)
    cand = merge([snap(gqrs_pk, wide, fs), snap(twomax_pk, wide, fs)], tol)
    corr, amp_z, slope_z = features(wide, cand, fs, kmeans_init="even")
    gain = 0.5 * amp_z + 1.0 * corr + 1.5 * slope_z
    weak = weak_sequence(cand, gain, fs)
    reg = local_regularity(cand, weak, fs, 120.0)
    ref_rr = ref_rr_from(cand, weak, fs)
    out = select_adaptive(cand, gain, slope_z, reg, fs, 0.6,
                          rr_penalty=2.0, ref_rr_s=ref_rr)

    # twomax internals, recomputed with the same coefficients the port loads.
    b, a = sps.butter(2, [8.0 / (fs / 2), 20.0 / (fs / 2)], btype="band")
    s = sps.filtfilt(b, a, sig, padtype="odd")
    dd = np.abs(sps.filtfilt([1, 2, 0, -2, -1], [1], s, padtype="odd"))
    ma = int(0.12 * fs)
    integ = np.convolve(dd, np.ones(ma) / ma, mode="same")

    OUT.mkdir(parents=True, exist_ok=True)
    arrays = {
        "d_sig": d_sig[:PREFIX],
        "integ": integ[:PREFIX],
        "gqrs_pk": gqrs_pk.astype(np.float64),
        "twomax_pk": twomax_pk.astype(np.float64),
        "cand": cand.astype(np.float64),
        "corr": corr,
        "amp_z": amp_z,
        "slope_z": slope_z,
        "gain": gain,
        "weak": weak.astype(np.float64),
        "reg": reg,
        "out": out.astype(np.float64),
    }
    meta = {
        "record": rec,
        "fs": fs,
        "prefix": PREFIX,
        "n": len(sig),
        "ref_rr": float(ref_rr),
        "adc_gain": float(wrec.adc_gain[0]),
        "adc_baseline": float(wrec.baseline[0]),
        "arrays": {},
    }
    for name, arr in arrays.items():
        p = OUT / f"{rec}.{name}.f64"
        np.asarray(arr, dtype="<f8").tofile(str(p))
        meta["arrays"][name] = int(len(arr))

    # The reference annotations are the scoring input; keep them beside the
    # arrays so the check does not need the wider catalogue.
    meta["ref"] = [int(v) for v in ref]
    (OUT / f"{rec}.json").write_text(json.dumps(meta))

    total = sum((OUT / f"{rec}.{k}.f64").stat().st_size for k in arrays)
    print(f"{rec:14} n={len(sig):7d} cand={len(cand):5d} out={len(out):5d} "
          f"{total / 1e6:.2f} MB")
    return meta


def main() -> None:
    args = [x for x in sys.argv[1:] if not x.startswith("-")]
    recs = args or ["p00001_s00", "p00006_s01", "p00010_s01", "p00000_s00"]
    for rec in recs:
        dump(rec)
    print(f"\nwrote {OUT}")


if __name__ == "__main__":
    main()
