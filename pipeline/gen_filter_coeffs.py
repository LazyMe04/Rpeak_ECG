"""Single source of truth for filter coefficients.

Generates second-order sections (SOS) with scipy and writes them to JSON, so
that the Python reference and the TypeScript runtime apply bit-identical
filtering. Any divergence between the two would invalidate the offline
evaluation.

Usage: python -I gen_filter_coeffs.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
from scipy import signal as sps

sys.path.insert(0, str(Path(__file__).resolve().parent))
from config import FS  # noqa: E402

OUT = Path(r"D:\Rpeak-Desktop\app\src\lib\filterCoeffs.json")


def sos_to_json(sos: np.ndarray) -> list[dict]:
    return [
        {"b0": float(s[0]), "b1": float(s[1]), "b2": float(s[2]),
         "a0": float(s[3]), "a1": float(s[4]), "a2": float(s[5])}
        for s in sos
    ]


def main() -> None:
    specs = {
        # Detection path: QRS energy only.
        "qrs": dict(kind="bandpass", lo=5.0, hi=15.0, order=2),
        # Wideband path: morphology, amplitudes, interval measurement.
        "wide": dict(kind="bandpass", lo=0.5, hi=40.0, order=2),
        # Delineation path: low-pass only. The 0.5 Hz high-pass in `wide` is
        # right for display but wrong for boundaries — it leaves a long
        # undershoot after every T wave (amplitude ~ sigma/tau of the wave),
        # which is larger than the 5%-of-excursion threshold the T offset uses.
        # Baseline removal for delineation is done per wave instead, by a line
        # through the two isoelectric anchors either side of the search window.
        "delineate": dict(kind="lowpass", hi=40.0, order=2),
        # Separate mains notch, applied before the wide lowpass.
        "notch50": dict(kind="notch", f0=50.0, q=30.0),
        "notch60": dict(kind="notch", f0=60.0, q=30.0),
    }

    out: dict[str, dict] = {"fs": FS}
    for name, s in specs.items():
        if s["kind"] == "bandpass":
            sos = sps.butter(s["order"], [s["lo"], s["hi"]], btype="band",
                             fs=FS, output="sos")
        elif s["kind"] == "lowpass":
            sos = sps.butter(s["order"], s["hi"], btype="low",
                             fs=FS, output="sos")
        elif s["kind"] == "notch":
            b, a = sps.iirnotch(s["f0"], s["q"], fs=FS)
            sos = np.hstack([b, a]).reshape(1, 6)
        else:
            raise ValueError(s["kind"])
        out[name] = sos_to_json(sos)
        # Report the realised response so it can be sanity-checked.
        w, h = sps.sosfreqz(sos, worN=4096, fs=FS)
        db = 20 * np.log10(np.abs(h) + 1e-12)
        if s["kind"] == "bandpass":
            lo, hi = s["lo"], s["hi"]
            passband = db[(w >= lo) & (w <= hi)]
            print(f"{name:8} passband {passband.min():6.2f}..{passband.max():5.2f} dB  "
                  f"|H(50Hz)|={np.abs(h[np.argmin(np.abs(w-50))]):.4f}")

    # second-order band 8-20 Hz in transfer-function form, and its derivative
    # operator; the two-max detector runs both through filtfilt(padtype="odd"),
    # which needs the b, a polynomial pair and lfilter's steady state at the
    # first padded sample. Stored here so the port cannot drift from scipy.
    b2m, a2m = sps.butter(2, [8.0 / (FS / 2), 20.0 / (FS / 2)], btype="band")
    z2m = sps.lfilter_zi(b2m, a2m)
    out["twomax"] = {"b": [float(v) for v in b2m],
                     "a": [float(v) for v in a2m],
                     "zi": [float(v) for v in z2m]}
    bd = [1.0, 2.0, 0.0, -2.0, -1.0]
    out["twomaxDeriv"] = {"b": bd, "a": [1.0],
                          "zi": [float(v) for v in sps.lfilter_zi(bd, [1.0])]}
    print(f"{'twomax':8} b={np.round(b2m, 6).tolist()} "
          f"a={np.round(a2m, 6).tolist()}")

    OUT.write_text(json.dumps(out, indent=1))
    print(f"\nwrote {OUT}  ({OUT.stat().st_size} bytes)  fs={FS}")


if __name__ == "__main__":
    main()
