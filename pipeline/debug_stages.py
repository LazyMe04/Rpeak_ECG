"""Dump the same stages as the TS debug script, for direct comparison.

Usage: python -I debug_stages.py p00000_s00 20000
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from config import CATALOG  # noqa: E402
from detect import bandpass, derivative, integrate_square  # noqa: E402


def main() -> None:
    record = sys.argv[1] if len(sys.argv) > 1 else "p00000_s00"
    n = int(sys.argv[2]) if len(sys.argv) > 2 else 20000

    sig = np.fromfile(CATALOG / "f32" / f"{record}.f32", dtype=np.float32)[:n].astype(np.float64)
    band = bandpass(sig, 250)
    der = derivative(band)
    integ = integrate_square(band, 250)

    out = {
        "record": record,
        "n": n,
        "band": band[:3000].tolist(),
        "deriv": der[:3000].tolist(),
        "integ": integ[:3000].tolist(),
        "integStats": {
            "min": float(integ.min()),
            "max": float(integ.max()),
            "mean": float(integ.mean()),
        },
    }
    (CATALOG / "debug_py.json").write_text(json.dumps(out))
    print(f"band  mean={band.mean():.6f} std={band.std():.6f}")
    print(f"deriv std={der.std():.6f}")
    print(f"integ min={integ.min():.3e} max={integ.max():.3e} mean={integ.mean():.3e}")


if __name__ == "__main__":
    main()
