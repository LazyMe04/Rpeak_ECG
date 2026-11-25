"""Diff the Python and TypeScript preprocessing stages numerically."""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from config import CATALOG  # noqa: E402


def main() -> None:
    py = json.loads((CATALOG / "debug_py.json").read_text())
    ts = json.loads((CATALOG / "debug_ts.json").read_text())

    for stage in ("band", "deriv", "integ"):
        a = np.array(py[stage], dtype=np.float64)
        b = np.array(ts[stage], dtype=np.float64)
        m = min(len(a), len(b))
        a, b = a[:m], b[:m]
        err = np.abs(a - b)
        rel = err.max() / max(np.abs(a).max(), 1e-12)
        print(f"{stage:6} py[max]={np.abs(a).max():.6e} ts[max]={np.abs(b).max():.6e} "
              f"maxdiff={err.max():.3e} rel={rel:.2e} corr={np.corrcoef(a,b)[0,1]:.6f}")
        if rel > 1e-6:
            # find the first divergence
            idx = int(np.argmax(err > 1e-9 * max(np.abs(a).max(), 1e-12)))
            print(f"       first divergence at sample {idx}: py={a[idx]:.9f} ts={b[idx]:.9f}")
            print(f"       py[0:6]={a[:6].round(9).tolist()}")
            print(f"       ts[0:6]={b[:6].round(9).tolist()}")

    print("\npython integStats:", py["integStats"])
    print("ts     integStats:", ts["integStats"])
    print(f"\npython peaks in prefix: {len(py.get('peaks', []))}")
    print(f"ts     peaks in prefix: {len(ts.get('peaks', []))}")


if __name__ == "__main__":
    main()
