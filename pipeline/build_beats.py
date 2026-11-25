"""G5 dataset: cut beat windows from icentia11k and pack them into shards.

A beat window is fixed-length, centred on the annotation sample, scaled so the
network sees amplitudes in a comparable range across patients. Nothing here
learns anything; it is the deterministic half of G5, and the half the app must
also be able to reproduce at a different sample rate (see `beatwindow` below).

Design decisions and their evidence are in docs/classifier.md. The two that
shape this file:

  * **Centred on the R peak, asymmetric.** The QRS is not centred in the beat:
    a 200 ms window before R and 400 ms after holds P, QRS and T at 250 Hz,
    while a symmetric window spends half its length on the flat segment after
    T. Windows are `[-0.4 s, +0.6 s]` around the annotation sample and are
    padded with the edge value when a beat falls near a record boundary.
  * **Per-window normalisation, median-anchored.** Each window is centred on
    the median of its own QRS-bearing region and divided by that region's
    robust spread, rather than z-scored per record: a chest strap's gain drifts,
    and a global z-score drags every window toward the segment mean. See
    `normalise` for why the spread is a 90th percentile and not the MAD.

Output is one `.npz` per record with `X` (n, 250) float32, `S` (n,) float32
holding `log(scale)` before normalisation, `R` (n, 3) float32 holding the
timing ratios (`rr_ratios`), `y` (n,) int8 and `p` (n,) int32 sample positions,
plus a JSON sidecar recording the filter and normalisation parameters. Shards
are written per record so a training run can hold out whole patients.

Usage:
  python -I build_beats.py --records p00002_s00 p00002_s01
  python -I build_beats.py --all --json ../data/catalog/g5/beats.json
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from config import AAMI_CLASSES, BEATS, CATALOG, FS, RAW  # noqa: E402

# Window geometry, in seconds relative to the annotated R sample.
PRE_S = 0.4
POST_S = 0.6
WIN = int(round((PRE_S + POST_S) * FS))  # 250 samples at 250 Hz
PRE = int(round(PRE_S * FS))  # 100

# No band-pass on the network input. The display chain's 0.5 Hz high-pass is
# deliberately not used here (it leaves the T-wave undershoot described in
# docs/analysis.md), and a 0.5-40 Hz Butterworth would have to be reproduced
# sample-for-sample by the app's inference path. The network sees the raw chest
# lead; baseline wander is handled by the window normalisation below and by
# augmentation during training, which is cheaper to keep honest than a filter.

# RR features: 25 beats each side for the local median, and intervals outside
# [200 ms, 3 s] are not a beat pair (noise) or not a rhythm (a pause).
RR_HALF = 25
MIN_RR = 0.2 * FS
MAX_RR = 3.0 * FS
RR_MIN, RR_MAX = 0.3, 3.0  # clamp on the stored ratio, not on the interval
RR_NAMES = ("pre_ratio", "post_ratio", "sum_ratio")

LABELS = {c: i for i, c in enumerate(AAMI_CLASSES)}  # N,S,V,Q -> 0,1,2,3


def cut(sig: np.ndarray, sample: int) -> np.ndarray:
    """Cut one window, padding with the edge value at record boundaries."""
    start = sample - PRE
    end = start + WIN
    if start < 0:
        pad = -start
        seg = np.concatenate([np.full(pad, sig[0], dtype=sig.dtype), sig[:end]])
    elif end > len(sig):
        pad = end - len(sig)
        seg = np.concatenate([sig[start:], np.full(pad, sig[-1], dtype=sig.dtype)])
    else:
        seg = sig[start:end]
    return np.asarray(seg, dtype=np.float32)


def normalise(seg: np.ndarray) -> tuple[np.ndarray, float]:
    """Centre on the QRS-region median and scale by its robust spread.

    Returns the normalised window and `log(scale)`, the amplitude the
    normalisation divides away. That second value is the point: unusable
    stretches are noisier and therefore larger, and dividing by their own spread
    deletes the one cue that says "this window is noise". Measured on the
    held-out records, log(scale) alone separates Q from N at AUC 0.615, so it
    travels with the window as an extra input (see docs/classifier.md).

    Not a per-record z-score: a chest strap's gain drifts, and a global z-score
    drags every window toward the segment mean. Not a plain MAD either -- that
    is what this started as, and it is degenerate on this data. The signal is
    quantised, so a window whose core sits on a flat baseline has more than
    half its samples at exactly the median; the MAD is then 0, the 1e-6 floor
    divides by it, and the window arrives at the network with an amplitude of
    10^5-10^6. Measured on 3,000 beats per record, the MAD is zero for 2.4% of
    windows in one record and 66% in another. The 90th percentile of the same
    deviations is zero for none of them, so it is used instead, with a floor at
    1% of the window peak for the pathological flat window.
    """
    core = seg[PRE - 50:PRE + 100]  # -0.2 s .. +0.4 s around R
    med = float(np.median(core))
    dev = np.abs(core - med)
    scale = float(np.quantile(dev, 0.9))
    scale = max(scale, 0.01 * float(np.abs(seg).max()), 1e-6)
    return ((seg - med) / scale).astype(np.float32), float(np.log(scale))


def rr_ratios(samples: np.ndarray) -> np.ndarray:
    """Timing ratios per beat, (n, 3) float32: pre, post, sum.

    A 250-sample window holds one second, which at a normal rate does not
    contain either neighbouring R peak -- so the network cannot see that a beat
    arrived early, which is the defining property of a supraventricular ectopic.
    These three ratios carry exactly that, from the beat positions alone:

      pre_ratio   RR(i-1, i) / median RR of the surrounding beats -- prematurity
      post_ratio  RR(i, i+1) / median RR                        -- the pause
      sum_ratio   (RR(i-1,i) + RR(i,i+1)) / (2 * median)         -- net timing

    Ratios, not raw samples: a raw RR would let the network identify the patient
    by heart rate instead of the rhythm. The median is over 25 beats each side
    and excludes the two intervals that touch beat i, so a run of ectopics
    cannot drag its own baseline toward itself.

    Non-finite (record edges, implausible RR) is filled with 1.0 -- "no
    evidence" -- and the rest is clamped to [0.3, 3.0], which keeps a missed
    detection from handing the network a ratio of 8. Measured on the held-out
    patients: pre_ratio alone separates S from N at AUC 0.930 and V from N at
    0.985, with detector peaks instead of annotations still 0.90-1.00
    (`probe_rr.py`). This is what the shard stores and what the app recomputes.
    """
    n = len(samples)
    rr = np.full(n, np.nan, dtype=np.float64)
    rr[1:] = np.diff(samples).astype(np.float64)
    rr[(rr < MIN_RR) | (rr > MAX_RR)] = np.nan

    pre = np.full(n, np.nan)
    post = np.full(n, np.nan)
    for i in range(n):
        lo = max(0, i - RR_HALF)
        hi = min(n, i + RR_HALF + 1)
        near = rr[lo:hi]
        # Drop the two intervals under test (and beat i's own slot) from the
        # baseline.
        keep = np.ones(hi - lo, dtype=bool)
        for k, idx in enumerate(range(lo, hi)):
            if idx in (i - 1, i, i + 1):
                keep[k] = False
        med = np.nanmedian(near[keep]) if keep.any() else np.nan
        if not np.isfinite(med) or med <= 0:
            continue
        pre[i] = rr[i] / med
        if i + 1 < n:
            post[i] = rr[i + 1] / med

    out = np.full((n, 3), np.nan, dtype=np.float64)
    out[:, 0] = pre
    out[:, 1] = post
    ok = np.isfinite(pre) & np.isfinite(post)
    out[ok, 2] = (pre[ok] + post[ok]) / 2.0
    out = np.clip(out, RR_MIN, RR_MAX)
    out[~np.isfinite(out)] = 1.0
    return out.astype(np.float32)


def shard_path(record: str) -> Path:
    return BEATS / f"{record}.npz"


def beat_list(record: str) -> list[tuple[int, str]]:
    """Read beat annotations for one record.

    Prefers the raw `.atr` through wfdb, which is the source of truth and
    exists for every downloaded record. Falls back to the catalog's
    `ann.json` for records whose raw files are not on disk (the app's
    pre-built subset).
    """
    atr = RAW
    matches = list(atr.rglob(f"{record}.atr"))
    if matches:
        import wfdb
        ann = wfdb.rdann(str(matches[0].with_suffix("")), "atr")
        return [(int(s), str(c)) for s, c in zip(ann.sample, ann.symbol)
                if c in LABELS]

    ann_path = CATALOG / "segments" / f"{record}.ann.json"
    if not ann_path.exists():
        raise FileNotFoundError(f"no .atr or ann.json for {record}")
    ann = json.loads(ann_path.read_text(encoding="utf-8"))
    return [(int(b["sample"]), str(b["symbol"])) for b in ann["beats"]
            if b["symbol"] in LABELS]


def build_record(record: str, fs: int = FS) -> dict:
    """Cut every annotated beat in one record into a normalised window."""
    f32 = CATALOG / "f32" / f"{record}.f32"
    if not f32.exists():
        raise FileNotFoundError(f"no f32 export for {record}: {f32}")
    sig = np.fromfile(f32, dtype=np.float32)

    beats = beat_list(record)
    samples = np.array([s for s, _ in beats], dtype=np.int64)
    ratios = rr_ratios(samples) if len(beats) else np.zeros((0, 3), np.float32)

    X = np.empty((len(beats), WIN), dtype=np.float32)
    S = np.empty(len(beats), dtype=np.float32)
    R = np.empty((len(beats), 3), dtype=np.float32)
    y = np.empty(len(beats), dtype=np.int8)
    p = np.empty(len(beats), dtype=np.int32)
    kept = 0
    for i, (s, sym) in enumerate(beats):
        if s >= len(sig):
            continue
        win, log_scale = normalise(cut(sig, s))
        X[kept] = win
        S[kept] = log_scale
        R[kept] = ratios[i]
        y[kept] = LABELS[sym]
        p[kept] = s
        kept += 1

    X, S, R, y, p = X[:kept], S[:kept], R[:kept], y[:kept], p[:kept]
    out = shard_path(record)
    BEATS.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(out, X=X, S=S, R=R, y=y, p=p)

    counts = {c: int((y == LABELS[c]).sum()) for c in AAMI_CLASSES}
    meta = {
        "record": record,
        "fs": fs,
        "window": WIN,
        "pre_samples": PRE,
        "n": kept,
        "counts": counts,
        "log_scale": {"mean": float(S.mean()) if kept else 0.0,
                      "sd": float(S.std()) if kept else 0.0},
        "rr": {"names": list(RR_NAMES),
               "mean": [float(v) for v in R.mean(axis=0)] if kept else [1.0] * 3,
               "sd": [float(v) for v in R.std(axis=0)] if kept else [0.0] * 3},
        "shard": str(out.relative_to(CATALOG.parent)).replace("\\", "/"),
    }
    return meta


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--records", nargs="*", default=[])
    ap.add_argument("--records-file", default="",
                    help="one record per line; blank lines and CR are ignored")
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--json", default="")
    args = ap.parse_args()

    records: list[str] = [r.strip() for r in args.records if r.strip()]
    if args.records_file:
        text = Path(args.records_file).read_text(encoding="utf-8")
        records += [ln.strip() for ln in text.splitlines() if ln.strip()]
    if args.all:
        records = sorted(p.stem for p in (CATALOG / "f32").glob("*.f32"))
    if not records:
        raise SystemExit("give --records ... , --records-file ..., or --all")

    metas = []
    for i, r in enumerate(records, 1):
        try:
            m = build_record(r)
            metas.append(m)
            print(f"[{i:3}/{len(records)}] {r}  n={m['n']:6d}  "
                  f"N={m['counts']['N']:6d} S={m['counts']['S']:5d} "
                  f"V={m['counts']['V']:5d} Q={m['counts']['Q']:6d}")
        except Exception as e:  # noqa: BLE001
            print(f"[{i:3}/{len(records)}] {r} FAILED: {e}")

    total = {c: sum(m["counts"][c] for m in metas) for c in AAMI_CLASSES}
    n = sum(total.values())
    print(f"\n=== {len(metas)} records, {n} windows ===")
    for c in AAMI_CLASSES:
        print(f"  {c}: {total[c]:7d}  ({100*total[c]/max(n,1):5.2f}%)")

    if args.json:
        Path(args.json).parent.mkdir(parents=True, exist_ok=True)
        Path(args.json).write_text(json.dumps({
            "window": WIN, "pre_samples": PRE, "fs": FS,
            "labels": AAMI_CLASSES, "totals": total, "records": metas,
        }, indent=1), encoding="utf-8")
        print(f"wrote {args.json}")


if __name__ == "__main__":
    main()
