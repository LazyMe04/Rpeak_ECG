"""G5 training: fit the beat CNN and export weights for the app.

Split is by **patient**, never by window. A recording is 70 minutes of one
person's heart; adjacent beats in the same segment are near-duplicates, so a
window-level split would put near-identical beats in train and test and report
a score that measures memorisation. `--holdout-patients` names the patients
whose segments never enter training.

Class handling, in order of the evidence:
  * S and V are 0.5-1% of beats (survey of 451k beats: S 0.56%, V 1.01%), so a
    plain CE loss predicts N everywhere and still scores 97% accuracy. The loss
    is class-weighted by the inverse square root of frequency (a common middle
    ground: full inverse frequency over-corrects and inflates false positives).
  * Each window also carries `log(scale)`, the amplitude the normaliser divides
    away, as one extra head input (standardised by the training mean and sd and
    stored in the checkpoint so the app can apply the same transform).
    Augmentation deliberately does not touch it: the network is told the
    pre-augmentation amplitude, which is what the app measures at inference.
  * Augmentation is limited to what a chest strap actually does: gain drift,
    baseline wander, and a small time shift. No stretching: it would manufacture
    heart rates the patient never had.

`--out` writes two things: a `.pt` checkpoint for resuming and a `.json` with
the weights in the app's inference layout. The JSON is the artefact the app
loads; `export` in `cnn_export.py` produces it.

Usage:
  python -I train_cnn.py --train-records a b c --val-records d --out ../data/models/beatcnn
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path
from typing import Iterator

import numpy as np
import torch
import torch.nn as nn

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_beats import RR_NAMES  # noqa: E402
from cnn_model import BeatCNN, count_params  # noqa: E402
from config import AAMI_CLASSES, BEATS, MODELS  # noqa: E402

SEED = 20261119


def seed_everything(seed: int = SEED) -> None:
    np.random.seed(seed)
    torch.manual_seed(seed)


def log(msg: str) -> None:
    """Print unbuffered.

    Redirected to a file, Python block-buffers stdout, so a run that is clearly
    progressing shows nothing for minutes -- which looks exactly like a hang.
    """
    print(msg, flush=True)


class Shards:
    """Windows from several records, concatenated, with their provenance.

    `rec` indexes `names` so a per-record transform can be applied without
    re-reading the shards. The split is still by patient (`p`); `rec` is for
    within-record statistics, not for splitting.

    `S` is `log(scale)` (n,) and `R` the timing ratios (n, 3). Which of them
    reaches the head is decided by the checkpoint's `extra.kind`, so one loader
    serves every model this project has trained.
    """

    def __init__(self, X, S, R, y, p, rec, names) -> None:
        self.X, self.S, self.R, self.y, self.p, self.rec, self.names = (
            X, S, R, y, p, rec, names)

    def __len__(self) -> int:
        return len(self.y)

    def subset(self, m: np.ndarray) -> "Shards":
        return Shards(self.X[m], self.S[m], self.R[m], self.y[m], self.p[m],
                      self.rec[m], self.names)


def load_shards(records: list[str]) -> Shards:
    Xs, Ss, Rs, ys, ps, rs = [], [], [], [], [], []
    for i, r in enumerate(records):
        p = BEATS / f"{r}.npz"
        if not p.exists():
            raise FileNotFoundError(f"missing shard {p}; run build_beats.py --records {r}")
        d = np.load(p)
        Xs.append(d["X"])
        if "S" not in d.files:  # shard built before log(scale) was recorded
            raise FileNotFoundError(f"shard {p} has no log(scale); rebuild with build_beats.py")
        Ss.append(d["S"].astype(np.float32))
        if "R" in d.files:
            Rs.append(d["R"].astype(np.float32))
        else:  # pre-G9 shard: no timing ratios, and the rr mode will refuse it
            Rs.append(np.full((len(d["y"]), 3), np.nan, dtype=np.float32))
        ys.append(d["y"].astype(np.int64))
        ps.append(np.full(len(d["y"]), int(r[1:6]), dtype=np.int32))
        rs.append(np.full(len(d["y"]), i, dtype=np.int32))
    if not Xs:
        raise SystemExit("no records given")
    return Shards(np.concatenate(Xs), np.concatenate(Ss), np.concatenate(Rs),
                  np.concatenate(ys), np.concatenate(ps), np.concatenate(rs),
                  list(records))


def extra_matrix(sh: Shards, kind: str) -> np.ndarray:
    """The head's extra inputs for a given checkpoint kind, unstandardised."""
    if kind == "rr":
        if not np.isfinite(sh.R).all():
            raise SystemExit("shards have no RR features; rebuild with build_beats.py")
        return sh.R
    return sh.S[:, None]


def standardise(E: np.ndarray, extra: dict | None,
                rec: np.ndarray | None = None) -> np.ndarray:
    """Apply the checkpoint's transform to the extra inputs; identity if none.

    Three forms, and which one is used is a property of the checkpoint:
      * `rr`               -- three timing ratios, each centred and scaled by
        one global pair of constants from training. Ratios are already
        patient-invariant (they are relative), so there is nothing per-record
        to remove;
      * `log_scale`        -- one global centre and spread, taken from training;
      * `log_scale_record` -- centred and scaled within each record. The cue is
        relative to a patient's own signal quality, and a global transform
        hands the network an absolute amplitude whose between-patient offset it
        cannot know for a patient it has never seen.
    """
    kind = (extra or {}).get("kind")
    if kind in ("rr", "log_scale"):
        center = np.asarray(extra["center"], dtype=np.float32)
        std = np.asarray(extra["std"], dtype=np.float32)
        return ((E - center) / std).astype(np.float32)
    if kind == "log_scale_record":
        if rec is None:
            raise ValueError("log_scale_record needs the record index")
        out = np.empty_like(E)
        for r in np.unique(rec):
            m = rec == r
            v = E[m, 0]
            med = float(np.median(v))
            sd = float(v.std()) or 1.0
            out[m, 0] = (v - med) / sd
        return out.astype(np.float32)
    return E


def augment_batch(xb: np.ndarray, rng: np.random.Generator) -> np.ndarray:
    """Chest-strap-shaped augmentation for a whole batch at once.

    Vectorised deliberately: the per-window Python version measured 138 us per
    window, which is 72 s per epoch on 522k windows -- more than the forward
    and backward pass combined -- because with `num_workers=0` it runs serial
    on the training thread. Every parameter below is drawn per window, exactly
    as the scalar version did; only the loop over windows is gone.

    Nothing here changes the morphology: gain is a few percent, the shift is
    within the annotation's own jitter (+-20 ms), and there is no time
    stretching, which would invent heart rates the patient never had.
    """
    n, L = xb.shape
    t = np.arange(L, dtype=np.float32) / 250.0

    # Slow baseline wander, the dominant chest-strap artefact.
    f = rng.uniform(0.05, 0.5, size=(n, 1)).astype(np.float32)
    ph = rng.uniform(0.0, 2 * np.pi, size=(n, 1)).astype(np.float32)
    amp = rng.uniform(-0.6, 0.6, size=(n, 1)).astype(np.float32)
    x = xb + amp * np.sin(2 * np.pi * f * t + ph)

    # Gain drift, then time shift by up to 5 samples, repeating the edge value
    # (np.roll followed by filling the wrap-around, as the scalar version did).
    x = x * rng.uniform(0.92, 1.08, size=(n, 1)).astype(np.float32)
    s = rng.integers(-5, 6, size=n)
    if np.any(s):
        src = np.clip(np.arange(L)[None, :] - s[:, None], 0, L - 1)
        x = np.take_along_axis(x, src, axis=1)

    x = x + rng.normal(0.0, 0.05, size=x.shape).astype(np.float32)
    return x


def iter_batches(X: np.ndarray, S: np.ndarray, y: np.ndarray, batch: int,
                 rng: np.random.Generator, augment: bool) -> Iterator[
                     tuple[torch.Tensor, torch.Tensor, torch.Tensor]]:
    """Shuffled batches, augmented, skipping the ragged tail like drop_last."""
    order = rng.permutation(len(y))
    for i in range(0, len(order) - batch + 1, batch):
        j = order[i:i + batch]
        xb = X[j]
        if augment:
            xb = augment_batch(xb, rng)
        yield (torch.from_numpy(xb), torch.from_numpy(S[j]),
               torch.from_numpy(y[j]))


@torch.no_grad()
def evaluate(model: nn.Module, X: np.ndarray, S: np.ndarray, y: np.ndarray,
             batch: int = 512) -> dict:
    model.eval()
    preds = []
    for i in range(0, len(X), batch):
        xb = torch.from_numpy(X[i:i + batch].astype(np.float32))
        sb = torch.from_numpy(S[i:i + batch].astype(np.float32))
        preds.append(model(xb, sb).argmax(1).numpy())
    return metrics_from_pred(y, np.concatenate(preds))


def metrics_from_pred(y: np.ndarray, pred: np.ndarray) -> dict:
    """Accuracy, per-class Se/PPV/F1 and the confusion matrix for fixed labels.

    Split out from `evaluate` so anything that changes the *decision* rather than
    the forward pass -- a per-class logit bias, for instance -- reports its
    numbers through exactly this code and not a copy of it.
    """
    k = len(AAMI_CLASSES)
    cm = np.zeros((k, k), dtype=np.int64)
    for t, p in zip(y, pred):
        cm[t, p] += 1

    per_class = {}
    for c, name in enumerate(AAMI_CLASSES):
        tp = cm[c, c]
        fn = cm[c].sum() - tp
        fp = cm[:, c].sum() - tp
        se = tp / max(tp + fn, 1)
        ppv = tp / max(tp + fp, 1)
        f1 = 2 * se * ppv / max(se + ppv, 1e-9)
        per_class[name] = {"support": int(cm[c].sum()), "se": float(se),
                           "ppv": float(ppv), "f1": float(f1)}
    acc = float(np.trace(cm) / max(cm.sum(), 1))
    macro_f1 = float(np.mean([v["f1"] for v in per_class.values()]))
    return {"accuracy": acc, "macro_f1": macro_f1, "per_class": per_class,
            "confusion": cm.tolist()}


def class_weights(y: np.ndarray, k: int) -> torch.Tensor:
    freq = np.bincount(y, minlength=k).astype(np.float64)
    freq = np.maximum(freq, 1.0)
    w = 1.0 / np.sqrt(freq)
    w = w / w.mean()
    return torch.tensor(w, dtype=torch.float32)


def cap_per_class(X: np.ndarray, S: np.ndarray, y: np.ndarray, cap: int,
                  rng: np.random.Generator) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Randomly drop windows from any class with more than `cap` of them.

    The network has 7,060 parameters and the corpus has 522k windows, 65% of
    them normal beats from the same 24 people. The 400,000th N window teaches
    nothing the first 60,000 did not, but it *does* make an epoch 2,042 steps of
    which two thirds are N -- which is why the first runs sat near the uniform
    loss for a whole epoch and still predicted N for every validation beat.
    Capping makes one pass a meaningful number of gradient steps for S and V,
    and the class weights then do the rest.
    """
    if cap <= 0:
        return X, S, y
    keep = []
    for c in range(int(y.max()) + 1):
        idx = np.flatnonzero(y == c)
        if len(idx) > cap:
            idx = rng.choice(idx, size=cap, replace=False)
        keep.append(idx)
    idx = np.sort(np.concatenate(keep))
    return X[idx], S[idx], y[idx]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--train-records", nargs="+", required=True)
    ap.add_argument("--val-records", nargs="+", required=True)
    ap.add_argument("--out", default=str(MODELS / "beatcnn"))
    ap.add_argument("--epochs", type=int, default=30)
    ap.add_argument("--batch", type=int, default=256)
    ap.add_argument("--lr", type=float, default=2e-3)
    ap.add_argument("--width", type=int, default=16, help="unused; kept for old checkpoints")
    ap.add_argument("--dropout", type=float, default=0.3)
    ap.add_argument("--patience", type=int, default=8)
    ap.add_argument("--cap-per-class", type=int, default=60000,
                    help="randomly drop windows from classes larger than this; 0 keeps all")
    ap.add_argument("--log-every", type=int, default=200,
                    help="print running train loss every N steps; 0 disables")
    ap.add_argument("--extra-mode", default="record",
                    choices=["record", "global", "none", "rr"],
                    help="what the head's extra inputs are: the three timing "
                         "ratios ('rr'), log(scale) standardised within each "
                         "record ('record') or by training-wide statistics "
                         "('global'), or nothing ('none', the control)")
    args = ap.parse_args()

    seed_everything()
    torch.set_num_threads(max(1, torch.get_num_threads()))

    tr = load_shards(args.train_records)
    va = load_shards(args.val_records)
    overlap = set(tr.p.tolist()) & set(va.p.tolist())
    if overlap:
        raise SystemExit(f"patient overlap between train and val: {sorted(overlap)}")

    # The app must reproduce this transform exactly, so it is stored in the
    # checkpoint and written into the model JSON rather than left to convention.
    if args.extra_mode == "rr":
        Rtr = extra_matrix(tr, "rr")
        extra = {"kind": "rr", "names": list(RR_NAMES),
                 "center": [float(v) for v in Rtr.mean(axis=0)],
                 "std": [float(v) or 1.0 for v in Rtr.std(axis=0)]}
    elif args.extra_mode == "global":
        extra = {"kind": "log_scale", "center": float(tr.S.mean()),
                 "std": float(tr.S.std()) or 1.0}
    elif args.extra_mode == "record":
        extra = {"kind": "log_scale_record"}
    else:
        extra = {"kind": "none"}
    Etr = standardise(extra_matrix(tr, extra["kind"]), extra, tr.rec)
    Eva = standardise(extra_matrix(va, extra["kind"]), extra, va.rec)
    Xtr, Xva, ytr, yva = tr.X, va.X, tr.y, va.y
    ptr, pva = tr.p, va.p

    before = np.bincount(ytr, minlength=len(AAMI_CLASSES)).tolist()
    Xtr, Etr, ytr = cap_per_class(Xtr, Etr, ytr, args.cap_per_class,
                                  np.random.default_rng(SEED))
    after = np.bincount(ytr, minlength=len(AAMI_CLASSES)).tolist()

    log(f"train {len(ytr):6d} windows from {len(set(ptr.tolist()))} patients "
        f"{sorted(set(ptr.tolist()))}")
    log(f"val   {len(yva):6d} windows from {len(set(pva.tolist()))} patients "
        f"{sorted(set(pva.tolist()))}")
    log(f"train class counts {after}"
        + (f"  (capped from {before})" if after != before else ""))

    k = len(AAMI_CLASSES)
    extra_dim = 0 if extra["kind"] == "none" else Etr.shape[1]
    model = BeatCNN(n_classes=k, dropout=args.dropout, extra_dim=extra_dim)
    log(f"model: {count_params(model)} parameters "
        f"(+ {extra_dim} extra head input(s), {extra['kind']})")

    cw = class_weights(ytr, k)
    log(f"class weights {cw.tolist()}")
    crit = nn.CrossEntropyLoss(weight=cw)
    opt = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=1e-4)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=args.epochs)

    rng = np.random.default_rng(SEED)

    best_f1, best_state, best_epoch, stale = -1.0, None, -1, 0
    hist = []
    t0 = time.time()
    for ep in range(1, args.epochs + 1):
        model.train()
        tot, n = 0.0, 0
        win, winn = 0.0, 0
        step = 0
        for xb, sb, yb in iter_batches(Xtr, Etr, ytr, args.batch, rng, augment=True):
            opt.zero_grad()
            loss = crit(model(xb, sb), yb)
            loss.backward()
            opt.step()
            b = float(loss.detach())
            tot += b * len(yb)
            n += len(yb)
            win += b * len(yb)
            winn += len(yb)
            step += 1
            if args.log_every and step % args.log_every == 0:
                log(f"  ep {ep:3d} step {step:5d}  loss {win/winn:.4f}  "
                    f"lr {sched.get_last_lr()[0]:.1e}")
                win, winn = 0.0, 0
        sched.step()
        t_train = time.time() - t0
        ev = evaluate(model, Xva, Eva, yva)
        hist.append({"epoch": ep, "loss": tot / max(n, 1),
                     "val_acc": ev["accuracy"], "val_macro_f1": ev["macro_f1"],
                     "eval_seconds": round(time.time() - t0 - t_train, 1)})
        log(f"ep {ep:3d}  loss {tot/max(n,1):.4f}  val acc {ev['accuracy']:.4f}  "
            f"macroF1 {ev['macro_f1']:.4f}  "
            f"({time.time()-t0:.0f}s)  "
            + "  ".join(f"{c}:{v['f1']:.3f}" for c, v in ev["per_class"].items()))
        if ev["macro_f1"] > best_f1:
            best_f1 = ev["macro_f1"]
            best_epoch = ep
            stale = 0
            best_state = {kk: v.detach().clone() for kk, v in model.state_dict().items()}
        else:
            stale += 1
            if stale >= args.patience:
                log(f"early stop at epoch {ep} (no macro-F1 gain for {args.patience})")
                break

    assert best_state is not None
    model.load_state_dict(best_state)
    final = evaluate(model, Xva, Eva, yva)
    log(f"\n=== best epoch {best_epoch}/{ep}  "
        f"({time.time()-t0:.1f}s) ===")
    log(f"accuracy {final['accuracy']:.4f}   macro-F1 {final['macro_f1']:.4f}")
    log(f"{'class':6} {'support':>8} {'Se':>7} {'PPV':>7} {'F1':>7}")
    for c, v in final["per_class"].items():
        log(f"{c:6} {v['support']:>8} {v['se']*100:>6.2f}% {v['ppv']*100:>6.2f}% "
            f"{v['f1']*100:>6.2f}%")
    log("confusion (rows=true N,S,V,Q):")
    for row in final["confusion"]:
        log("  " + " ".join(f"{v:6d}" for v in row))

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    extra = dict(extra)
    torch.save({"state": best_state, "args": vars(args), "epoch": best_epoch,
                "history": hist, "metrics": final, "extra": extra}, str(out) + ".pt")
    log(f"\nwrote {out}.pt")

    (Path(str(out) + ".train.json")).write_text(json.dumps({
        "train_records": args.train_records,
        "val_records": args.val_records,
        "train_patients": sorted(set(ptr.tolist())),
        "val_patients": sorted(set(pva.tolist())),
        "n_train": int(len(ytr)), "n_val": int(len(yva)),
        "class_counts_train": np.bincount(ytr, minlength=k).tolist(),
        "class_counts_val": np.bincount(yva, minlength=k).tolist(),
        "class_weights": cw.tolist(),
        "extra": extra,
        "params": {"trained": int(count_params(model))},
        "best_epoch": best_epoch, "epochs_run": ep,
        "history": hist, "metrics": final,
        "hparams": {"width": args.width, "dropout": args.dropout,
                    "lr": args.lr, "batch": args.batch, "epochs": args.epochs},
        "seed": SEED,
    }, indent=1), encoding="utf-8")
    log(f"wrote {out}.train.json")


if __name__ == "__main__":
    main()
