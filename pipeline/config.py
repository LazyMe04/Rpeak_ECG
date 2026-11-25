"""Central configuration. All paths are absolute and confined to ROOT.

ROOT is derived from this file's location, not hard-coded: `config.py` lives
in `<repo>/pipeline`, so the repository can be cloned anywhere. `RPEAK_ROOT`
overrides it for the case the layout does not imply -- a data directory on
another drive, which is what the packaged app's `RPEAK_DATA_DIR` does for the
same reason.
"""
from __future__ import annotations

import os
from pathlib import Path

# `pipeline/config.py` -> `<repo>`. Resolved, because every path below is
# built on it and a relative ROOT would make mkdir() depend on the cwd.
ROOT = Path(os.environ.get("RPEAK_ROOT") or Path(__file__).resolve().parent.parent)

DATA = ROOT / "data"
RAW = DATA / "raw"            # WFDB triples exactly as downloaded (.hea/.dat/.atr)
CATALOG = DATA / "catalog"    # sqlite + json derived indexes
BEATS = DATA / "beats"        # cut, normalised beat windows (.npz shards)
MODELS = DATA / "models"      # trained keras / tfjs artefacts
LOGS = ROOT / "logs"
CACHE = ROOT / ".cache"

for _p in (DATA, RAW, CATALOG, BEATS, MODELS, LOGS, CACHE):
    _p.mkdir(parents=True, exist_ok=True)

FS = 250                      # Hz, dataset-wide
SEGMENT_SAMPLES = 1_048_577   # 2**20 + 1
SEGMENT_SECONDS = SEGMENT_SAMPLES / FS  # ~4194 s

S3_BASE = "https://physionet-open.s3.amazonaws.com/icentia11k-continuous-ecg/1.0"

# Disk guard rails. D: has ~14.6 GB free; keep a hard floor.
MIN_FREE_GB = 3.0
DISK_WARN_GB = 6.0

# AAMI EC57 grouping for the 4 labels present in icentia11k.
# icentia11k has N, S, V, Q only -- no F (fusion) class.
AAMI_MAP = {"N": "N", "S": "S", "V": "V", "Q": "Q"}
AAMI_CLASSES = ["N", "S", "V", "Q"]

SEGMENT_BYTES = 2_097_154     # ~2.1 MB for the .dat file
BYTES_PER_PATIENT_MAX = 50 * SEGMENT_BYTES


def free_gb(path: Path = ROOT) -> float:
    import shutil

    return shutil.disk_usage(str(path)).free / 1024**3


def require_space(needed_gb: float, path: Path = ROOT) -> None:
    have = free_gb(path)
    if have < needed_gb + MIN_FREE_GB:
        raise SystemExit(
            f"Refusing to continue: need {needed_gb:.1f} GB but only {have:.1f} GB free "
            f"(floor {MIN_FREE_GB} GB). Free space or reduce scope."
        )
