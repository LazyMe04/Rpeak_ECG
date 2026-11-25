"""Why are true beats rejected by the correlation filter?

Prints the correlation score of true vs rejected candidates on the segment
where recall collapsed.
"""
from __future__ import annotations

import sys

import numpy as np

sys.path.insert(0, "D:/Rpeak-Desktop/pipeline")
from detect import load  # noqa: E402
from detect4 import band, build_template, envelope, pearson_window  # noqa: E402
from detect5 import detect  # noqa: E402


def main() -> None:
    rec = sys.argv[1] if len(sys.argv) > 1 else "p00000_s00"
    sig, ref, fs, _ = load(rec)
    peaks, dbg = detect(sig, fs, 0.08, thresh=0.30, use_dp=False)
    cand = dbg["cand"]
    scores = dbg["scores"]

    tol = int(0.05 * fs)
    is_true = np.zeros(len(cand), dtype=bool)
    j = 0
    for k, c in enumerate(cand):
        while j < len(ref) and ref[j] < c - tol:
            j += 1
        if j < len(ref) and abs(int(ref[j]) - int(c)) <= tol:
            is_true[k] = True

    t = scores[is_true]
    f = scores[~is_true]
    print(f"{rec}  cand={len(cand)}  true={is_true.sum()}  false={(~is_true).sum()}")
    print(f"  TRUE  min={t.min():.3f} p1={np.percentile(t,1):.3f} "
          f"p5={np.percentile(t,5):.3f} p10={np.percentile(t,10):.3f} "
          f"median={np.median(t):.3f}")
    print(f"  FALSE median={np.median(f):.3f} p90={np.percentile(f,90):.3f} "
          f"p99={np.percentile(f,99):.3f}")

    for cut in (0.2, 0.3, 0.4, 0.5):
        kept_true = int((t >= cut).sum())
        kept_false = int((f >= cut).sum())
        print(f"  cut={cut:.2f}  recall={100*kept_true/len(t):6.2f}%  "
              f"precision={100*kept_true/max(kept_true+kept_false,1):6.2f}%  "
              f"(fp={kept_false})")

    # template diagnostics
    t0 = dbg["tmpl"]
    print(f"\ntemplate len={len(t0)} centre={len(t0)//2} "
          f"argmax={int(np.argmax(np.abs(t0)))} min={t0.min():.3f} max={t0.max():.3f}")
    # how many candidates sit within one period of another
    d = np.diff(cand)
    print(f"cand spacing: median={np.median(d):.0f} p1={np.percentile(d,1):.0f} "
          f"min={d.min()}")


if __name__ == "__main__":
    main()
