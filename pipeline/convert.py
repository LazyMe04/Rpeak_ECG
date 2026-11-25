"""G1 ETL: turn WFDB triples into the app's runtime format + build the catalog.

Key design decision: the WFDB `.dat` file is already raw little-endian int16 at
250 Hz, i.e. exactly what the replay engine wants. So we do NOT duplicate the
signal -- the ETL only emits sidecars and an index.

Outputs (all under data/catalog):
  segments/<record>.ann.json   beats (sample, symbol) + rhythm regions
  segments/<record>.meta.json  header, timing, per-segment signal statistics
  catalog.sqlite               queryable index for the app

Usage: python -I convert.py
"""
from __future__ import annotations

import json
import sqlite3
import sys
from pathlib import Path

import numpy as np
import wfdb

sys.path.insert(0, str(Path(__file__).resolve().parent))
from config import CATALOG, DATA, FS, RAW  # noqa: E402

SEG_OUT = CATALOG / "segments"

SCHEMA = """
CREATE TABLE IF NOT EXISTS segments (
    record       TEXT PRIMARY KEY,
    patient      INTEGER NOT NULL,
    segment      INTEGER NOT NULL,
    fs           INTEGER NOT NULL,
    n_samples    INTEGER NOT NULL,
    duration_s   REAL    NOT NULL,
    dat_path     TEXT    NOT NULL,
    dat_bytes    INTEGER NOT NULL,
    n_beats      INTEGER NOT NULL,
    n_N          INTEGER NOT NULL,
    n_S          INTEGER NOT NULL,
    n_V          INTEGER NOT NULL,
    n_Q          INTEGER NOT NULL,
    hr_mean      REAL,
    hr_min       REAL,
    hr_max       REAL,
    mv_mean      REAL,
    mv_std       REAL,
    amp_p001     REAL,
    amp_p999     REAL,
    quality      TEXT,
    rhythms      TEXT,
    ann_json     TEXT NOT NULL,
    meta_json    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_patient ON segments(patient);
CREATE INDEX IF NOT EXISTS idx_quality ON segments(quality);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
"""


def parse_rhythms(ann: wfdb.Annotation) -> list[dict]:
    """Rhythm regions are encoded as paired '(TAG' / ')' auxiliary notes."""
    out, open_tag, start = [], None, None
    for sym, note, samp in zip(ann.symbol, ann.aux_note, ann.sample):
        if sym != "+" or note is None:
            continue
        note = note.strip()
        if note.startswith("("):
            open_tag, start = note[1:], int(samp)
        elif note == ")" and open_tag is not None:
            out.append({"start": start, "end": int(samp), "type": open_tag})
            open_tag, start = None, None
    return out


def classify_quality(sig: np.ndarray, n_beats: int) -> str:
    """Coarse signal-quality label used to filter segments in the UI.

    Deliberately conservative: this only flags obviously unusable segments.
    """
    dur_min = len(sig) / FS / 60
    rate = n_beats / max(dur_min, 1e-9)
    std = float(sig.std())
    ptp = float(np.percentile(np.abs(sig), 99.9))
    if std < 0.02:
        return "flat"
    if not (25 <= rate <= 220):
        return "implausible-hr"
    if ptp > 5.0:
        return "saturated"
    if std < 0.06:
        return "low-amplitude"
    return "ok"


def convert(stem: Path) -> dict:
    rec = wfdb.rdrecord(str(stem))
    ann = wfdb.rdann(str(stem), "atr")
    sig = rec.p_signal[:, 0].astype(np.float64)

    mask = np.array([s in "NSVQ" for s in ann.symbol])
    beat_samples = ann.sample[mask]
    beat_symbols = np.asarray(ann.symbol, dtype="<U1")[mask]

    rr = np.diff(beat_samples)
    hr = 60.0 * rec.fs / rr if len(rr) else np.array([0.0])

    counts = {k: int((beat_symbols == k).sum()) for k in "NSVQ"}
    rhythms = parse_rhythms(ann)
    dur_s = rec.sig_len / rec.fs
    quality = classify_quality(sig, len(beat_samples))

    dat = Path(str(stem) + ".dat")
    ann_json = SEG_OUT / f"{stem.name}.ann.json"
    meta_json = SEG_OUT / f"{stem.name}.meta.json"

    ann_json.write_text(json.dumps({
        "record": stem.name,
        "fs": rec.fs,
        "beats": [{"sample": int(s), "symbol": str(c)}
                  for s, c in zip(beat_samples, beat_symbols)],
        "rhythms": rhythms,
    }), encoding="utf-8")

    meta_json.write_text(json.dumps({
        "record": stem.name,
        "patient": int(stem.name[1:6]),
        "segment": int(stem.name[-2:]),
        "fs": rec.fs,
        "n_samples": rec.sig_len,
        "duration_s": round(dur_s, 3),
        "adc_gain": float(rec.adc_gain[0]),
        "baseline": float(rec.baseline[0]),
        "units": rec.units[0],
        "lead": rec.sig_name[0],
        "signal_stats": {
            "mean_mv": round(float(sig.mean()), 4),
            "std_mv": round(float(sig.std()), 4),
            "p001_mv": round(float(np.percentile(sig, 0.1)), 4),
            "p999_mv": round(float(np.percentile(sig, 99.9)), 4),
            "min_mv": round(float(sig.min()), 4),
            "max_mv": round(float(sig.max()), 4),
        },
        "quality": quality,
    }), encoding="utf-8")

    return {
        "record": stem.name,
        "patient": int(stem.name[1:6]),
        "segment": int(stem.name[-2:]),
        "fs": int(rec.fs),
        "n_samples": int(rec.sig_len),
        "duration_s": round(dur_s, 3),
        "dat_path": str(dat.relative_to(DATA)).replace("\\", "/"),
        "dat_bytes": dat.stat().st_size,
        "n_beats": int(len(beat_samples)),
        **{f"n_{k}": v for k, v in counts.items()},
        "hr_mean": round(float(hr.mean()), 2),
        "hr_min": round(float(hr.min()), 2),
        "hr_max": round(float(hr.max()), 2),
        "mv_mean": round(float(sig.mean()), 4),
        "mv_std": round(float(sig.std()), 4),
        "amp_p001": round(float(np.percentile(sig, 0.1)), 4),
        "amp_p999": round(float(np.percentile(sig, 99.9)), 4),
        "quality": quality,
        "rhythms": ";".join(f"{r['type']}:{round((r['end']-r['start'])/rec.fs/60,1)}"
                            for r in rhythms),
        "ann_json": str(ann_json.relative_to(DATA)).replace("\\", "/"),
        "meta_json": str(meta_json.relative_to(DATA)).replace("\\", "/"),
    }


def main() -> None:
    SEG_OUT.mkdir(parents=True, exist_ok=True)
    CATALOG.mkdir(parents=True, exist_ok=True)

    db_path = CATALOG / "catalog.sqlite"
    con = sqlite3.connect(db_path)
    con.executescript(SCHEMA)

    stems = sorted(RAW.rglob("*.hea"))
    print(f"converting {len(stems)} segments -> {db_path}")

    rows = []
    for i, h in enumerate(stems, 1):
        try:
            row = convert(h.with_suffix(""))
            rows.append(row)
            con.execute(
                "INSERT OR REPLACE INTO segments VALUES (" +
                ",".join("?" * 24) + ")", list(row.values()))
            con.commit()
            print(f"[{i:3}/{len(stems)}] {row['record']}  {row['quality']:14} "
                  f"beats={row['n_beats']:6d} N={row['n_N']:6d} S={row['n_S']:4d} "
                  f"V={row['n_V']:4d} Q={row['n_Q']:6d}")
        except Exception as e:  # noqa: BLE001
            print(f"[{i:3}/{len(stems)}] {h.stem} FAILED: {e}")

    con.execute("INSERT OR REPLACE INTO meta VALUES ('schema_version','1')")
    con.execute("INSERT OR REPLACE INTO meta VALUES ('fs',?)", (str(FS),))
    con.commit()

    cur = con.execute(
        "SELECT COUNT(*), SUM(n_beats), SUM(n_N), SUM(n_S), SUM(n_V), SUM(n_Q), "
        "SUM(duration_s) FROM segments")
    n, beats, nN, nS, nV, nQ, dur = cur.fetchone()
    print(f"\n=== catalog totals ===")
    print(f"segments : {n}")
    print(f"hours    : {dur/3600:.1f}")
    print(f"beats    : {beats}")
    for k, v in zip("NSVQ", (nN, nS, nV, nQ)):
        print(f"  {k}      : {v or 0:8d}  ({100*(v or 0)/max(beats,1):6.2f}%)")

    q = con.execute("SELECT quality, COUNT(*) FROM segments GROUP BY quality").fetchall()
    print(f"quality  : {dict(q)}")
    print(f"db size  : {db_path.stat().st_size/1024:.0f} KB")
    con.close()


if __name__ == "__main__":
    main()
