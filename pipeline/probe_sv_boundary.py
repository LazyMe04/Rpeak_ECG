"""Is S's precision a decision-boundary problem, or a per-recording prior?

`docs/classifier.md` says S is now limited by precision (0.487) rather than
recall: the RR ratios fixed the missing context and left many normal beats
called S. G10 ran exactly this argument for N -> Q and the verdict was "the
cell moves, the score does not transfer". This script asks the same question of
S, and of the V -> S cell beside it, with the same three-stage test:

  1. pooled sweep -- best constant, scored on all six held-out patients;
  2. out-of-fold -- tune on five, score the sixth, rotate, so a rule that only
     helps the patients it was tuned on is visible as such;
  3. per patient -- where the gain comes from, which is what told us the N -> Q
     result was really a per-recording prior.

Two rules, because S has two different failure shapes:

  * `s_margin` -- S has no single competitor, it competes with every other
    class. So the rule is a margin: a window called S whose S logit beats the
    best other logit by less than `t` is handed to its best other class. This is
    what "S precision" asks for literally.
  * `vs` -- the V <-> S cell (V -> S 3,218, V -> N 77). A symmetric bias on the
    two classes moves that boundary alone.

Neither rule retrains anything; both act on the same logits.

Usage:
  python -I probe_sv_boundary.py
  python -I probe_sv_boundary.py --out ../data/models/beatcnn.svbias.json
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from config import AAMI_CLASSES  # noqa: E402
from probe_q_boundary import load_model, logits_for  # noqa: E402
from train_cnn import (extra_matrix, load_shards, metrics_from_pred,  # noqa: E402
                       standardise)

S = AAMI_CLASSES.index("S")
V = AAMI_CLASSES.index("V")


def margin(Z: np.ndarray, cls: int) -> np.ndarray:
    """How far `cls` leads the runner-up: positive means it wins."""
    other = np.delete(Z, cls, axis=1).max(1)
    return Z[:, cls] - other


def demote(Z: np.ndarray, cls: int, t: float) -> np.ndarray:
    """Give every weak `cls` call to its best other class."""
    pred = Z.argmax(1)
    weak = (pred == cls) & (margin(Z, cls) < t)
    if weak.any():
        pred[weak] = np.delete(Z, cls, axis=1).argmax(1)[weak]
    return pred


def bias_pred(Z: np.ndarray, b: np.ndarray) -> np.ndarray:
    return (Z + b).argmax(1)


def best_threshold(Z, y, cls, grid):
    best, best_f1 = 0.0, -1.0
    for t in grid:
        f1 = metrics_from_pred(y, demote(Z, cls, t))["macro_f1"]
        if f1 > best_f1:
            best, best_f1 = t, f1
    return best, best_f1


def best_vs_bias(Z, y, grid):
    best, best_f1 = 0.0, -1.0
    for v in grid:
        b = np.zeros(len(AAMI_CLASSES))
        b[V], b[S] = v, -v
        f1 = metrics_from_pred(y, bias_pred(Z, b))["macro_f1"]
        if f1 > best_f1:
            best, best_f1 = v, f1
    return best, best_f1


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--checkpoint", default="../data/models/beatcnn.pt")
    ap.add_argument("--val-records", nargs="*", default=None)
    ap.add_argument("--grid", type=float, nargs="*",
                    default=[0.0, 0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 2.0, 2.5, 3.0])
    ap.add_argument("--v-grid", type=float, nargs="*",
                    default=[-2.0, -1.5, -1.0, -0.75, -0.5, -0.25, 0.0,
                             0.25, 0.5, 0.75, 1.0, 1.5, 2.0])
    ap.add_argument("--out", default="")
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
    y, p = sh.y, sh.p
    patients = sorted(set(p.tolist()))

    real = metrics_from_pred(y, Z.argmax(1))
    print(f"pooled argmax: acc {real['accuracy']:.4f}  macro-F1 "
          f"{real['macro_f1']:.4f}  S se {real['per_class']['S']['se']:.3f} "
          f"ppv {real['per_class']['S']['ppv']:.3f}\n")

    # ---- pooled sweep, both rules ----------------------------------------
    print("pooled sweep, rule = s_margin (weak S calls handed to their runner-up):")
    print(f"{'t':>5} {'acc':>7} {'macroF1':>8} {'S se':>6} {'S ppv':>6} {'S f1':>6} "
          f"{'V f1':>6} {'S calls':>8}")
    sweep_s = []
    for t in args.grid:
        ev = metrics_from_pred(y, demote(Z, S, t))
        n_s = int((demote(Z, S, t) == S).sum())
        print(f"{t:>5.2f} {ev['accuracy']:>7.4f} {ev['macro_f1']:>8.4f} "
              f"{ev['per_class']['S']['se']:>6.3f} {ev['per_class']['S']['ppv']:>6.3f} "
              f"{ev['per_class']['S']['f1']:>6.3f} {ev['per_class']['V']['f1']:>6.3f} "
              f"{n_s:>8}")
        sweep_s.append({"t": t, "accuracy": ev["accuracy"],
                        "macro_f1": ev["macro_f1"], "s_calls": n_s,
                        "per_class": {c: ev["per_class"][c] for c in AAMI_CLASSES}})

    print("\npooled sweep, rule = vs (V up, S down, equally):")
    print(f"{'bias':>6} {'acc':>7} {'macroF1':>8} {'S f1':>6} {'V f1':>6} "
          f"{'V->S':>6} {'S->V':>6}")
    sweep_v = []
    for v in args.v_grid:
        b = np.zeros(len(AAMI_CLASSES))
        b[V], b[S] = v, -v
        ev = metrics_from_pred(y, bias_pred(Z, b))
        print(f"{v:>6.2f} {ev['accuracy']:>7.4f} {ev['macro_f1']:>8.4f} "
              f"{ev['per_class']['S']['f1']:>6.3f} {ev['per_class']['V']['f1']:>6.3f} "
              f"{ev['confusion'][2][1]:>6} {ev['confusion'][1][2]:>6}")
        sweep_v.append({"bias": v, "accuracy": ev["accuracy"],
                        "macro_f1": ev["macro_f1"],
                        "v_to_s": ev["confusion"][2][1],
                        "s_to_v": ev["confusion"][1][2],
                        "per_class": {c: ev["per_class"][c] for c in AAMI_CLASSES}})

    # ---- out of fold ------------------------------------------------------
    # Tuned on some patients and scored on others is the only way to tell a
    # boundary correction from a per-recording prior, which is what decided
    # G10. Argmax, best t, best v -- all scored on the patient held out.
    oof = {"argmax": [], "s_margin": [], "vs": []}
    picks = []
    for pt in patients:
        train = p != pt
        test = ~train
        t, _ = best_threshold(Z[train], y[train], S, args.grid)
        v, _ = best_vs_bias(Z[train], y[train], args.v_grid)
        picks.append({"patient": int(pt), "t": t, "v": v})
        for name, pred in (("argmax", Z[test].argmax(1)),
                           ("s_margin", demote(Z[test], S, t)),
                           ("vs", bias_pred(Z[test], np.eye(len(AAMI_CLASSES))[V] * v
                                            + np.eye(len(AAMI_CLASSES))[S] * -v))):
            oof[name].append(metrics_from_pred(y[test], pred))

    print("\nout of fold (tune on five patients, score the sixth, rotate):")
    print(f"{'rule':>9} {'acc':>7} {'macroF1':>8}   spread over the six folds")
    oof_rows = {}
    for name, evs in oof.items():
        f1s = [e["macro_f1"] for e in evs]
        accs = [e["accuracy"] for e in evs]
        print(f"{name:>9} {np.mean(accs):>7.4f} {np.mean(f1s):>8.4f}   "
              f"{min(f1s):.3f} - {max(f1s):.3f}")
        oof_rows[name] = {"accuracy": float(np.mean(accs)),
                          "macro_f1": float(np.mean(f1s)),
                          "folds": [float(x) for x in f1s]}
    for name in ("s_margin", "vs"):
        gain = oof_rows[name]["macro_f1"] - oof_rows["argmax"]["macro_f1"]
        print(f"          {name} minus argmax: {gain:+.4f}")

    # ---- per patient ------------------------------------------------------
    # The G10 lesson: a rule that helps only the patients it was tuned on is a
    # prior, not a rule. Show where the pooled gain actually comes from.
    print("\nper patient, at the pooled best constants:")
    t_best = max(sweep_s, key=lambda r: r["macro_f1"])["t"]
    v_best = max(sweep_v, key=lambda r: r["macro_f1"])["bias"]
    print(f"  t = {t_best:.2f}, v = {v_best:.2f}")
    print(f"{'pt':>5} {'S sup':>6} {'S pred':>7} {'f1 argmax':>10} "
          f"{'f1 margin':>10} {'f1 vs':>8}  {'S calls at t':>12}")
    per_patient = []
    for pt in patients:
        msk = p == pt
        base = metrics_from_pred(y[msk], Z[msk].argmax(1))
        sm = metrics_from_pred(y[msk], demote(Z[msk], S, t_best))
        b = np.zeros(len(AAMI_CLASSES))
        b[V], b[S] = v_best, -v_best
        vs = metrics_from_pred(y[msk], bias_pred(Z[msk], b))
        row = {"patient": int(pt),
               "s_support": int((y[msk] == S).sum()),
               "s_pred": int((Z[msk].argmax(1) == S).sum()),
               "s_pred_margin": int((demote(Z[msk], S, t_best) == S).sum()),
               "f1_argmax": base["macro_f1"],
               "f1_s_margin": sm["macro_f1"],
               "f1_vs": vs["macro_f1"]}
        per_patient.append(row)
        print(f"{pt:>5} {row['s_support']:>6} {row['s_pred']:>7} "
              f"{row['f1_argmax']:>10.4f} {row['f1_s_margin']:>10.4f} "
              f"{row['f1_vs']:>8.4f}  {row['s_pred_margin']:>12}")

    if args.out:
        out = {
            "checkpoint": str(Path(args.checkpoint).resolve()),
            "grid": args.grid,
            "v_grid": args.v_grid,
            "real": {"accuracy": real["accuracy"], "macro_f1": real["macro_f1"],
                     "per_class": {c: real["per_class"][c] for c in AAMI_CLASSES}},
            "pooled_sweep_s_margin": sweep_s,
            "pooled_sweep_vs": sweep_v,
            "out_of_fold": oof_rows,
            "best": {"t": t_best, "v": v_best},
            "per_patient": per_patient,
        }
        Path(args.out).write_text(json.dumps(out, indent=1))
        print(f"\nwrote {args.out}")


if __name__ == "__main__":
    main()
