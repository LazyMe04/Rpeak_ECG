"""Download the icentia11k segments G5 trains on, chosen by label density.

`survey_labels.py` counts annotation symbols without downloading any signal.
This script takes that survey, ranks patients by how much S and V they carry,
picks the top `--patients`, and fetches only those patients' segments, then
exports them to the float32 form `build_beats.py` reads.

Why not reuse `download.py --patients N`: that walks patient ids in order, and
patient id has nothing to do with rhythm content. In the survey, S ranged from
0 to 7,977 beats per patient; the first 40 ids happen to contain almost none.
Selecting by measured label density is the difference between a classifier that
can learn S and one that sees a handful of examples.

Usage:
  python -I g5_fetch.py --top 30 --segments 4
  python -I g5_fetch.py --top 30 --dry-run
"""
from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from config import CATALOG, RAW, S3_BASE, free_gb  # noqa: E402

SURVEY = CATALOG / "g5_survey.json"
SIZES = {"hea": None, "dat": 2_097_154, "atr": None}


def patient_dir(pid: int) -> str:
    return f"p{pid // 10000:02d}/p{pid:05d}"


def fetch(url: str, dest: Path, expect: int | None, tries: int = 3) -> bool:
    if dest.exists() and (expect is None or dest.stat().st_size == expect):
        return False
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    for attempt in range(tries):
        try:
            with urllib.request.urlopen(url, timeout=90) as r, open(tmp, "wb") as f:
                declared = r.headers.get("Content-Length")
                while chunk := r.read(1 << 20):
                    f.write(chunk)
            got = tmp.stat().st_size
            if expect is not None and got != expect:
                raise IOError(f"size {got} != {expect}")
            if declared is not None and got != int(declared):
                raise IOError(f"truncated {got} != {declared}")
            tmp.replace(dest)
            return True
        except (urllib.error.URLError, TimeoutError, IOError, OSError):
            tmp.unlink(missing_ok=True)
            if attempt == tries - 1:
                return False
            time.sleep(2 * (attempt + 1))
    return False


def select(top: int) -> list[int]:
    if not SURVEY.exists():
        raise SystemExit(f"no survey at {SURVEY}; run survey_labels.py first")
    d = json.loads(SURVEY.read_text(encoding="utf-8"))
    pp = {int(k): v for k, v in d["per_patient"].items()}
    # Score rewards the scarce classes but caps them, so one patient with 8,000
    # supraventricular beats does not crowd out ten with 500 each. The cap is
    # the point of the exercise: the network needs variety, not a single source.
    def score(c: dict) -> float:
        return min(c["S"], 3000) + min(c["V"], 3000) + 0.1 * (c["S"] + c["V"])

    ranked = sorted(pp.items(), key=lambda kv: -score(kv[1]))
    return [p for p, _ in ranked[:top]]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--top", type=int, default=30)
    ap.add_argument("--segments", type=int, default=4)
    ap.add_argument("--workers", type=int, default=6)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    pids = select(args.top)
    d = json.loads(SURVEY.read_text(encoding="utf-8"))
    pp = {int(k): v for k, v in d["per_patient"].items()}
    tot = {k: sum(pp[p][k] for p in pids) for k in "NSVQ"}
    n = max(sum(tot.values()), 1)
    print(f"selected {len(pids)} patients: {pids}")
    print("surveyed beats: " + "  ".join(
        f"{k}={tot[k]} ({100*tot[k]/n:.2f}%)" for k in "NSVQ"))
    need_mb = len(pids) * args.segments * 2.1
    print(f"to download: {len(pids)*args.segments} segments, ~{need_mb:.0f} MB; "
          f"free {free_gb():.1f} GB")
    if args.dry_run:
        return

    jobs = [(p, s) for p in pids for s in range(args.segments)]
    done = fetched = 0
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        futs = {}
        for pid, s in jobs:
            rel = patient_dir(pid)
            stem = f"p{pid:05d}_s{s:02d}"
            out = RAW / rel
            for ext in ("hea", "dat", "atr"):
                futs[ex.submit(fetch, f"{S3_BASE}/{rel}/{stem}.{ext}",
                               out / f"{stem}.{ext}", SIZES[ext])] = stem
        for fut in as_completed(futs):
            done += 1
            if fut.result():
                fetched += 1
            if done % 10 == 0 or done == len(futs):
                print(f"\r[{done:4}/{len(futs)}] files  fetched={fetched}  "
                      f"{time.time()-t0:.0f}s  free={free_gb():.1f}GB  ",
                      end="", file=sys.stderr, flush=True)
    print(file=sys.stderr)
    dt = time.time() - t0
    print(f"downloaded {fetched} new files in {dt:.0f}s; free {free_gb():.1f} GB")
    print("next: python -I export_f32.py   (exports every raw record present, "
          "skipping existing f32)")


if __name__ == "__main__":
    main()
