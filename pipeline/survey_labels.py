"""Cheap label survey over icentia11k, without downloading any signal.

Only the `.hea` and `.atr` sidecars (~55 KB together) are fetched per segment;
the 2.1 MB `.dat` is not. That is enough to answer the question G5 needs
answering before any training run: where do the S and V beats actually live?

Usage:
  python -I survey_labels.py --patients 60 --segments 2
  python -I survey_labels.py --patients 400 --segments 4 --json ../data/catalog/g5_survey.json

Notes:
  * keeps a per-segment cache under .cache/g5_survey so a re-run is free
  * polite concurrency (default 6 threads); the mirror is a public S3 bucket
"""
from __future__ import annotations

import argparse
import collections
import json
import sys
import tempfile
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from config import CACHE, S3_BASE  # noqa: E402

survey_cache = CACHE / "g5_survey"


def patient_dir(pid: int) -> str:
    return f"p{pid // 10000:02d}/p{pid:05d}"


def get(url: str, dest: Path) -> bytes | None:
    if dest.exists():
        return dest.read_bytes()
    tmp = dest.with_suffix(dest.suffix + ".part")
    for attempt in range(3):
        try:
            with urllib.request.urlopen(url, timeout=60) as r:
                data = r.read()
            tmp.write_bytes(data)
            if dest.exists():
                dest.unlink()
            tmp.replace(dest)
            return data
        except (urllib.error.URLError, TimeoutError, OSError):
            tmp.unlink(missing_ok=True)
            if attempt == 2:
                return None
    return None


def count_segment(pid: int, seg: int) -> tuple[str, dict | None]:
    """Fetch hea+atr for one segment and return its symbol counts."""
    stem = f"p{pid:05d}_s{seg:02d}"
    out = survey_cache / patient_dir(pid)
    out.mkdir(parents=True, exist_ok=True)
    if get(f"{S3_BASE}/{patient_dir(pid)}/{stem}.hea", out / f"{stem}.hea") is None:
        return stem, None
    if get(f"{S3_BASE}/{patient_dir(pid)}/{stem}.atr", out / f"{stem}.atr") is None:
        return stem, None
    try:
        import wfdb  # imported lazily so the fetch phase can fail independently
        ann = wfdb.rdann(str(out / stem), "atr")
    except Exception:
        return stem, None
    counts = collections.Counter(s for s in ann.symbol if s in "NSVQ")
    return stem, {"counts": {k: int(counts.get(k, 0)) for k in "NSVQ"},
                  "n": int(sum(counts.values()))}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--patients", type=int, default=60)
    ap.add_argument("--segments", type=int, default=2)
    ap.add_argument("--start", type=int, default=0)
    ap.add_argument("--stride", type=int, default=1)
    ap.add_argument("--workers", type=int, default=6)
    ap.add_argument("--json", default="")
    args = ap.parse_args()

    survey_cache.mkdir(parents=True, exist_ok=True)
    jobs = [(args.start + i * args.stride, s)
            for i in range(args.patients) for s in range(args.segments)]

    results: dict[str, dict] = {}
    done = 0
    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        futures = {ex.submit(count_segment, *j): j for j in jobs}
        for fut in as_completed(futures):
            stem, res = fut.result()
            done += 1
            if res:
                results[stem] = res
            print(f"\r[{done:4}/{len(jobs)}] {stem}  ", end="", file=sys.stderr, flush=True)
    print(file=sys.stderr)

    by_patient = collections.defaultdict(collections.Counter)
    for stem, res in results.items():
        pid = int(stem[1:6])
        by_patient[pid].update(res["counts"])

    print(f"{'patient':>8} {'N':>7} {'S':>6} {'V':>6} {'Q':>7}  {'S%':>5} {'V%':>5}")
    for pid in sorted(by_patient):
        c = by_patient[pid]
        tot = max(sum(c.values()), 1)
        print(f"{pid:>8} {c['N']:>7} {c['S']:>6} {c['V']:>6} {c['Q']:>7}  "
              f"{100*c['S']/tot:>5.2f} {100*c['V']/tot:>5.2f}")

    tot = collections.Counter()
    for c in by_patient.values():
        tot.update(c)
    n_pat = len(by_patient)
    allbeats = max(sum(tot.values()), 1)
    print(f"\n=== {n_pat} patients, {len(results)} segments, {allbeats} beats ===")
    for k in "NSVQ":
        print(f"  {k}: {tot[k]:8d}  ({100*tot[k]/allbeats:5.2f}%)")
    print(f"  patients with S >= 50 : {sum(1 for c in by_patient.values() if c['S'] >= 50)}")
    print(f"  patients with V >= 50 : {sum(1 for c in by_patient.values() if c['V'] >= 50)}")
    print(f"  patients with S >= 20 : {sum(1 for c in by_patient.values() if c['S'] >= 20)}")
    print(f"  patients with V >= 20 : {sum(1 for c in by_patient.values() if c['V'] >= 20)}")

    if args.json:
        Path(args.json).write_text(json.dumps({
            "generated": "survey",
            "patients": n_pat,
            "segments": len(results),
            "totals": dict(tot),
            "per_patient": {str(p): dict(c) for p, c in sorted(by_patient.items())},
            "per_segment": {k: v["counts"] for k, v in sorted(results.items())},
        }, indent=1), encoding="utf-8")
        print(f"\nwrote {args.json}")


if __name__ == "__main__":
    main()
