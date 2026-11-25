"""G1 batch survey: label distribution + signal statistics across downloaded segments.

Writes: data/catalog/survey.json and data/catalog/survey.csv
Usage:  python -I survey.py
"""
from __future__ import annotations

import sys
from collections import Counter
from pathlib import Path

import numpy as np
import pandas as pd
import wfdb

sys.path.insert(0, str(Path(__file__).resolve().parent))
from config import CATALOG, FS, RAW  # noqa: E402


def iter_segments() -> list[Path]:
    return sorted(p.with_suffix("") for p in RAW.rglob("*.hea"))


def inspect(stem: Path) -> dict:
    rec = wfdb.rdrecord(str(stem))
    ann = wfdb.rdann(str(stem), "atr")
    sig = rec.p_signal[:, 0]

    sym = Counter(ann.symbol)
    beats = {k: v for k, v in sym.items() if k in "NSVQ"}
    n_beats = sum(beats.values())

    # rhythm regions encoded as paired "(TAG" ... ")" entries
    rhythms, open_tag = Counter(), None
    for s, note in zip(ann.symbol, ann.aux_note):
        if s != "+" or note is None:
            continue
        note = note.strip()
        if note.startswith("("):
            open_tag = note[1:]
        elif note == ")" and open_tag:
            rhythms[open_tag] += 1
            open_tag = None

    beat_samples = ann.sample[[s in "NSVQ" for s in ann.symbol]]
    rr = np.diff(beat_samples)
    rr = rr[rr > 0]

    return {
        "patient": int(stem.name[1:6]),
        "segment": int(stem.name[-2:]),
        "record": stem.name,
        "fs": rec.fs,
        "samples": rec.sig_len,
        "minutes": round(rec.sig_len / rec.fs / 60, 1),
        "n_beats": n_beats,
        "pct_N": round(100 * beats.get("N", 0) / max(n_beats, 1), 2),
        "pct_S": round(100 * beats.get("S", 0) / max(n_beats, 1), 2),
        "pct_V": round(100 * beats.get("V", 0) / max(n_beats, 1), 2),
        "pct_Q": round(100 * beats.get("Q", 0) / max(n_beats, 1), 2),
        "hr_mean": round(60 * FS / rr.mean(), 1) if len(rr) else 0,
        "hr_min": round(60 * FS / rr.max(), 1) if len(rr) else 0,
        "hr_max": round(60 * FS / rr.min(), 1) if len(rr) else 0,
        "rr_median": int(np.median(rr)) if len(rr) else 0,
        "rr_p1": int(np.percentile(rr, 1)) if len(rr) else 0,
        "rr_p99": int(np.percentile(rr, 99)) if len(rr) else 0,
        "mv_std": round(float(sig.std()), 4),
        "mv_p001": round(float(np.percentile(sig, 0.1)), 3),
        "mv_p999": round(float(np.percentile(sig, 99.9)), 3),
        "amp_ratio": round(float(np.percentile(np.abs(sig), 99.9) /
                                 max(np.std(sig), 1e-9)), 2),
        "n_rhythm_regions": sum(rhythms.values()),
        "rhythms": ";".join(f"{k}:{v}" for k, v in sorted(rhythms.items())),
    }


def main() -> None:
    rows = []
    segs = iter_segments()
    print(f"found {len(segs)} segments\n")
    for i, s in enumerate(segs, 1):
        try:
            rows.append(inspect(s))
            print(f"[{i:3}/{len(segs)}] {s.name} ok")
        except Exception as e:  # noqa: BLE001
            print(f"[{i:3}/{len(segs)}] {s.name} FAILED: {e}")

    df = pd.DataFrame(rows)
    CATALOG.mkdir(parents=True, exist_ok=True)
    df.to_csv(CATALOG / "survey.csv", index=False)
    df.to_json(CATALOG / "survey.json", orient="records", indent=1)

    print("\n=== per-patient totals ===")
    agg = df.groupby("patient").agg(
        segs=("record", "count"),
        minutes=("minutes", "sum"),
        beats=("n_beats", "sum"),
        N=("pct_N", "mean"), S=("pct_S", "mean"),
        V=("pct_V", "mean"), Q=("pct_Q", "mean"),
        hr=("hr_mean", "mean"), std=("mv_std", "mean"),
    ).round(2)
    print(agg.to_string())

    print("\n=== dataset totals ===")
    tot = df["n_beats"].sum()
    print(f"segments      : {len(df)}")
    print(f"minutes       : {df['minutes'].sum():.0f}")
    print(f"beats         : {tot}")
    for k in "NSVQ":
        c = int((df[f"pct_{k}"] / 100 * df["n_beats"]).sum())
        print(f"  class {k}     : {c:8d}  ({100*c/max(tot,1):6.2f}%)")
    print(f"patients w/ S : {(agg['S'] > 0).sum()}")
    print(f"patients w/ V : {(agg['V'] > 0).sum()}")
    print(f"std range     : {df['mv_std'].min():.3f} .. {df['mv_std'].max():.3f} mV")
    print(f"\nwrote {CATALOG/'survey.csv'}")


if __name__ == "__main__":
    main()
