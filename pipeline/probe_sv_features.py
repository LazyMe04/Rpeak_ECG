"""Before retraining: is there an input that separates the errors S and V make?

G10 and `probe_sv_boundary.py` both said the same thing: the remaining S and V
errors are not a threshold problem, so the only way left is another input. But
"another input" is a 15-minute retrain plus docs, and G8 spent that on
`log(scale)` only for the ablation to show the network ignores it. So this
script does the cheap half first: measure candidate cues on the beats the model
gets *wrong*, and refuse to propose a retrain for a cue that cannot move them.

Two questions, because they are different:

  * `S vs N` -- can the cue tell a true S from a normal beat at all? That is
    what `probe_rr.py` asked of the three timing ratios, and it is how G9
    justified its retrain.
  * `TP vs FP among predicted S` -- *the* question for precision. A cue can
    separate the classes and still be useless here, because the model has
    already looked at the same evidence and still called these beats S. This is
    the check G8 skipped.

AUC is reported pooled and *within patient*. The within-patient number is the
one that matters: the N -> Q and S results both showed that a cue which only
separates at pooled level is really the patients' priors, and a per-recording
prior is not something a 1-s window can carry.

Candidates, all computed from beat positions or the window the shard already
stores, so each is reimplementable in TypeScript:

  pre/post/sum    the three ratios already in the model -- the control
  rr_sd           local RR dispersion. A patient in sinus rhythm is regular;
                  ectopy and AFib are not, and the model sees none of this.
  rr_ms           baseline RR in milliseconds. The ratios are scale-free by
                  design, so "0.8 of baseline" is 560 ms at 70 bpm and 440 ms
                  at 90, and a PAC needs a pause to be measurable at all.
  early_ms        (1 - pre_ratio) * rr_ms -- how many milliseconds early.
  prev_pre        pre_ratio of beat i-1 -- bigeminy, where every second beat
                  is early, is invisible in beat i alone.
  next_pre        pre_ratio of beat i+1.
  pause           post_ratio == 1.0 and pre_ratio < 1 -- ectopic with no pause.

Usage:
  python -I probe_sv_features.py
  python -I probe_sv_features.py --checkpoint ../data/models/beatcnn.pt
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from config import AAMI_CLASSES, FS  # noqa: E402
from probe_q_boundary import load_model, logits_for  # noqa: E402
from train_cnn import extra_matrix, load_shards, standardise  # noqa: E402

S = AAMI_CLASSES.index("S")
V = AAMI_CLASSES.index("V")
N = AAMI_CLASSES.index("N")
RR_HALF = 25
MIN_RR = 0.2 * FS
MAX_RR = 3.0 * FS


def auc(score: np.ndarray, pos: np.ndarray) -> float:
    """Rank AUC with ties at half credit. Returns NaN for a single-class set."""
    if pos.all() or (~pos).all():
        return float("nan")
    order = np.argsort(score, kind="mergesort")
    ranks = np.empty(len(score), dtype=np.float64)
    ranks[order] = np.arange(1, len(score) + 1)
    # Average ranks over ties, so a feature with few distinct values is scored
    # honestly rather than by an arbitrary order within the tie.
    s_sorted = score[order]
    i = 0
    while i < len(s_sorted):
        j = i
        while j + 1 < len(s_sorted) and s_sorted[j + 1] == s_sorted[i]:
            j += 1
        if j > i:
            ranks[order[i:j + 1]] = (i + j + 2) / 2.0
        i = j + 1
    n1 = int(pos.sum())
    n0 = len(pos) - n1
    return float((ranks[pos].sum() - n1 * (n1 + 1) / 2.0) / (n1 * n0))


def features(peaks: np.ndarray, y: np.ndarray) -> dict[str, np.ndarray]:
    """Per-beat timing features for one record, from its beat positions."""
    n = len(peaks)
    rr = np.full(n, np.nan)
    rr[1:] = np.diff(peaks).astype(np.float64)
    rr[(rr < MIN_RR) | (rr > MAX_RR)] = np.nan

    pre = np.full(n, np.nan)
    post = np.full(n, np.nan)
    med = np.full(n, np.nan)
    sd = np.full(n, np.nan)
    for i in range(n):
        lo, hi = max(0, i - RR_HALF), min(n, i + RR_HALF + 1)
        near = rr[lo:hi]
        keep = np.ones(hi - lo, dtype=bool)
        for k, idx in enumerate(range(lo, hi)):
            if idx in (i - 1, i, i + 1):
                keep[k] = False
        v = near[keep]
        v = v[np.isfinite(v)]
        if not len(v):
            continue
        m = float(np.median(v))
        if m <= 0:
            continue
        med[i] = m
        sd[i] = float(np.std(v) / m)
        pre[i] = rr[i] / m
        if i + 1 < n:
            post[i] = rr[i + 1] / m

    def fill(a):
        return np.where(np.isfinite(a), a, 1.0)

    pre_f, post_f = fill(pre), fill(post)
    prev_pre = np.full(n, 1.0)
    prev_pre[1:] = pre_f[:-1]
    next_pre = np.full(n, 1.0)
    next_pre[:-1] = pre_f[1:]
    med_f = np.where(np.isfinite(med), med, np.nanmedian(med) if np.isfinite(med).any() else 800.0)
    return {
        "pre": pre_f,
        "post": post_f,
        "sum": (pre_f + post_f) / 2.0,
        "rr_sd": fill(sd),
        "rr_ms": med_f / FS * 1000.0,
        "early_ms": (1.0 - pre_f) * med_f / FS * 1000.0,
        "prev_pre": prev_pre,
        "next_pre": next_pre,
        "pause": (pre_f < 0.95).astype(np.float64),
    }


def report(name: str, score: np.ndarray, pos: np.ndarray,
           p: np.ndarray, notes: list[str]) -> None:
    a_pooled = auc(score, pos)
    per = [auc(score[p == pt], pos[p == pt]) for pt in np.unique(p)]
    per = [x for x in per if np.isfinite(x)]
    # A pooled AUC that disappears within patients is the prior, not a cue.
    within = float(np.mean(per)) if per else float("nan")
    notes.append(f"  {name:<10} pooled {a_pooled:>5.3f}  within-patient "
                 f"{within:>5.3f}  ({len(per)} patients)")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--checkpoint", default="../data/models/beatcnn.pt")
    ap.add_argument("--val-records", nargs="*", default=None)
    args = ap.parse_args()

    records = args.val_records
    if not records:
        side = Path(args.checkpoint).with_suffix("")
        records = json.loads(
            (side.parent / (side.name + ".train.json")).read_text())["val_records"]

    model, extra, kind = load_model(args.checkpoint)
    sh = load_shards(records)
    E = standardise(extra_matrix(sh, kind), extra, sh.rec)
    Z = logits_for(model, sh.X, E)
    pred = Z.argmax(1)
    y, p = sh.y, sh.p
    m = sh.rec
    names = sh.names

    # Beat positions are not in `Shards`: `load_shards` overwrites the shard's
    # `p` (sample index) with the patient id, because the split needs patients.
    # The timing features need the positions, so read them from the shards.
    from config import BEATS  # noqa: E402

    per_rec = {}
    for ri, rec in enumerate(names):
        msk = m == ri
        pos = np.load(BEATS / f"{rec}.npz")["p"].astype(np.int64)
        if len(pos) != int(msk.sum()):
            raise SystemExit(f"{rec}: {len(pos)} positions for {int(msk.sum())} rows")
        per_rec[rec] = features(pos, y[msk])

    # ---- question 1: can any cue tell a true S from an N? -------------------
    print("AUC, S vs N (true labels, all windows):")
    notes: list[str] = []
    sel = (y == S) | (y == N)
    for name in per_rec[names[0]]:
        col = np.concatenate([per_rec[r][name] for r in names])
        report(name, col[sel], (y[sel] == S), p[sel], notes)
    print("\n".join(notes))

    # ---- question 2: among the model's S calls, does a cue find the TPs? ----
    print("\nAUC, true S vs not, restricted to windows the model called S "
          "(the precision question):")
    notes = []
    sel = pred == S
    for name in per_rec[names[0]]:
        col = np.concatenate([per_rec[r][name] for r in names])
        report(name, col[sel], (y[sel] == S), p[sel], notes)
    print("\n".join(notes))

    # ---- the same for V, since the two errors are entangled ----------------
    print("\nAUC, V vs the S calls, restricted to windows the model called S "
          "(where V -> S lives):")
    notes = []
    mid = np.concatenate([per_rec[r]["pre"] for r in names])
    for name in per_rec[names[0]]:
        col = np.concatenate([per_rec[r][name] for r in names])
        report(name, col[sel], (y[sel] == V), p[sel], notes)
    print("\n".join(notes))


    # ---- how much is any per-recording correction worth, at most? ----------
    # The S and V false positives concentrate in a few recordings, and every
    # rule tried so far fails out of fold. Before proposing another idea, take
    # the upper bound: correct each record with its *true* class frequencies,
    # which no deployed method could know. If even that buys little, no
    # per-recording estimator is worth building.
    K = len(AAMI_CLASSES)
    Zo = Z.copy()
    for r in np.unique(sh.rec):
        msk = sh.rec == r
        cnt = np.bincount(y[msk], minlength=K).astype(np.float64)
        Zo[msk] = Z[msk] + np.log(np.maximum(cnt, 1.0) / cnt.sum())
    from train_cnn import metrics_from_pred  # noqa: E402
    base = metrics_from_pred(y, pred)
    orc = metrics_from_pred(y, Zo.argmax(1))
    print("\nper-recording prior: upper bound (true class frequencies as the prior):")
    print(f"  argmax          acc {base['accuracy']:.4f}  mF1 {base['macro_f1']:.4f}")
    print(f"  oracle prior    acc {orc['accuracy']:.4f}  mF1 {orc['macro_f1']:.4f}"
          f"  ({orc['macro_f1'] - base['macro_f1']:+.4f})")
    for c in AAMI_CLASSES:
        print(f"    {c}: f1 {base['per_class'][c]['f1']:.3f} -> "
              f"{orc['per_class'][c]['f1']:.3f}")
    print("  (no deployed method can know these frequencies; this is a ceiling)")

    # ---- how much of the error is reachable at all? ------------------------
    print("\nwhere the S false positives come from:")
    for pt in np.unique(p):
        msk = p == pt
        wrong = msk & (pred == S) & (y != S)
        if wrong.sum():
            n = int(((pred == S) & msk & (y == N)).sum())
            v = int(((pred == S) & msk & (y == V)).sum())
            print(f"  p{pt:05d}: {int(wrong.sum()):>5} S false positives "
                  f"({n:,} from N, {v:,} from V)")


if __name__ == "__main__":
    main()
