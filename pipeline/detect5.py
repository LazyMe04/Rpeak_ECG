"""Detector v5: two-pass offline detection with dynamic-programming beat selection.

Why v5 exploits offline processing: the desktop app replays a recorded segment,
so the entire signal is available. A live monitor must decide beat by beat with
causal state; an offline analyser can instead choose the best *sequence* of
beats globally. That is a fundamentally stronger position, and it is the main
reason a replay-based app can beat a streaming reference implementation.

Stages
  1. permissive candidate generation
       wideband 0.5-40 Hz, high-frequency 10-25 Hz energy envelope,
       low quantile threshold -> many candidates, high recall
  2. per-candidate scoring
       normalised cross-correlation against a template learned from the
       segment's own high-confidence beats
  3. global sequence selection (Viterbi / DP)
       choose the subset of candidates that maximises total score minus an
       RR-consistency penalty. This removes artefact clusters and T waves in
       one step, because both break RR regularity.

Usage:
  python -I detect5.py --record p00000_s00 --plot
  python -I detect5.py --all
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
from scipy import signal as sps
from scipy.ndimage import percentile_filter

sys.path.insert(0, str(Path(__file__).resolve().parent))
from config import CATALOG  # noqa: E402
from detect import load, plot  # noqa: E402
from detect4 import (band, build_template, envelope, normalised_xcorr,
                     pearson_window, score_weighted)  # noqa: E402

FS = 250


def build_template_from(
    wide: np.ndarray,
    beats: np.ndarray,
    fs: int,
    half_ms: float = 90.0,
    max_beats: int = 200,
) -> np.ndarray | None:
    """Median template from a known set of accepted beats."""
    half = int(half_ms / 1000 * fs)
    b = np.asarray(beats)
    b = b[(b > half) & (b < len(wide) - half)]
    if len(b) < 10:
        return None
    if len(b) > max_beats:
        b = b[np.linspace(0, len(b) - 1, max_beats).astype(int)]
    stack = np.stack([wide[i - half: i + half + 1] for i in b])
    tmpl = np.median(stack, axis=0)
    tmpl = tmpl - tmpl.mean()
    if np.abs(tmpl.min()) > np.abs(tmpl.max()):
        tmpl = -tmpl
    return tmpl


def select_beats(
    pc: np.ndarray,
    scores: np.ndarray,
    fs: int,
    thresh: float = 0.25,
    refractory_ms: float = 250.0,
    adaptive: bool = False,
) -> np.ndarray:
    """Threshold candidates by correlation score, then enforce refractory spacing.

    Why not dynamic programming: a DP over candidates was tried and removed. It
    needed an RR-regularity objective that the optimiser could satisfy by
    inventing or dropping beats, and it repeatedly halved recall through
    traceback mistakes. On this dataset a plain threshold plus non-maximum
    suppression reaches equivalent quality with far less machinery.

    `adaptive` is off by default: an Otsu-style valley search was found to pick
    the wrong valley when one class dominates (clean segments are ~99% true
    beats), which silently raised the cut and destroyed recall.
    """
    if len(pc) == 0:
        return np.array([], dtype=int)

    cut = thresh
    if adaptive and len(scores) > 50:
        hist, edges = np.histogram(scores, bins=40, range=(0.0, 1.0))
        centres = 0.5 * (edges[:-1] + edges[1:])
        inner = np.where((centres > 0.15) & (centres < 0.95))[0]
        if len(inner) > 3:
            h = hist[inner].astype(float)
            h = h / max(h.sum(), 1)
            mode_lo = inner[int(np.argmax(h[: len(h) // 2 + 1]))]
            mode_hi = inner[len(h) // 2 + int(np.argmax(h[len(h) // 2:]))]
            if mode_hi > mode_lo + 2:
                span = h[mode_lo: mode_hi + 1]
                cut = max(thresh, float(centres[mode_lo + int(np.argmin(span))]))

    keep = pc[scores >= cut]
    if len(keep) == 0:
        n = max(1, min(len(pc), len(pc) // 20))
        top = np.argsort(scores)[::-1][:n]
        keep = np.sort(pc[top])

    refr = int(refractory_ms / 1000 * fs)
    sc = {int(p): float(s) for p, s in zip(pc, scores)}
    out: list[int] = []
    for p in keep:
        if not out or p - out[-1] >= refr:
            out.append(int(p))
        elif sc[int(p)] > sc[out[-1]]:
            out[-1] = int(p)
    return np.array(out, dtype=int)


def select_sequence(
    cand: np.ndarray,
    scores: np.ndarray,
    fs: int,
    rr_min_s: float = 0.26,
    rr_max_s: float = 2.2,
    rr_penalty: float = 0.9,
    base_bonus: float = 1.0,
) -> np.ndarray:
    """Pick the best set of candidates with a two-state DP.

    States per candidate i:
      skip[i] : best total value considering candidates 0..i with i skipped
      take[i] : best total value considering candidates 0..i with i selected

    Transitions:
      skip[i] = max(skip[i-1], take[i-1])
      take[i] = base_bonus + scores[i] + max(
                    skip[lo-1],                          # restart a new chain
                    max over j in RR window of take[j] - rr_penalty * rel(rr, ref)
                )

    The `skip` state is what makes this correct. An earlier version traced back
    from a single best endpoint, which silently discarded every beat outside
    that one chain and cut recall in half.
    """
    n = len(cand)
    if n == 0:
        return np.array([], dtype=int)

    rr_min = rr_min_s * fs
    rr_max = rr_max_s * fs

    skip = np.zeros(n)
    take = np.full(n, -np.inf)
    back = np.full(n, -2, dtype=int)   # >=0: previous selected index
    restart = np.full(n, -1, dtype=int)  # index to resume from after a restart

    for i in range(n):
        prev_skip = skip[i - 1] if i > 0 else 0.0
        prev_take = take[i - 1] if i > 0 else -np.inf
        skip[i] = max(prev_skip, prev_take)

        lo = int(np.searchsorted(cand, cand[i] - rr_max))
        hi = int(np.searchsorted(cand, cand[i] - rr_min))

        best_val = skip[lo - 1] if lo > 0 else 0.0
        best_from = -2
        for j in range(lo, hi):
            if not np.isfinite(take[j]):
                continue
            rr = cand[i] - cand[j]
            ref_rr = rr
            if back[j] >= 0:
                ref_rr = cand[j] - cand[back[j]]
            rel = abs(rr - ref_rr) / max(ref_rr, 1.0)
            gain = take[j] - rr_penalty * rel
            if gain > best_val:
                best_val = gain
                best_from = j

        take[i] = base_bonus + scores[i] + best_val
        back[i] = best_from
        restart[i] = lo - 1

    # Traceback over both states. When a chain restarts we resume at the last
    # index before the RR window in whichever state is better there, instead of
    # stopping -- stopping silently discarded all earlier beats.
    selected = []
    i = n - 1
    state_take = take[i] >= skip[i]
    while i >= 0:
        if state_take:
            selected.append(int(cand[i]))
            j = back[i]
            if j >= 0:
                i = j
                state_take = True
            else:
                i = restart[i]
                if i < 0:
                    break
                state_take = np.isfinite(take[i]) and take[i] >= skip[i]
        else:
            i -= 1
            if i < 0:
                break
            state_take = np.isfinite(take[i]) and take[i] >= skip[i]

    return np.array(sorted(selected), dtype=int)


def detect(
    sig: np.ndarray,
    fs: int = FS,
    k_env: float = 0.08,
    refractory_ms: float = 300.0,
    window_s: float = 10.0,
    thresh: float = 0.55,
    rr_penalty: float = 0.9,
    base_bonus: float = 1.0,
    use_dp: bool = True,
) -> tuple[np.ndarray, dict]:
    wide = band(sig, 0.5, 40.0, fs)
    narrow = band(sig, 10, 25, fs)
    integ, win = envelope(narrow, fs)
    delay = (win - 1) // 2

    n = max(3, int(round(window_s * fs)) | 1)
    scale = percentile_filter(integ, percentile=99, size=n, mode="nearest")
    thr_env = k_env * scale

    cand, _ = sps.find_peaks(integ, height=thr_env,
                             distance=max(1, int(refractory_ms / 1000 * fs)))
    cand = np.maximum(0, cand - delay)

    dbg = {"integ": integ, "thr": np.full_like(integ, 0.0), "band": narrow}

    if len(cand) < 10:
        return cand, dbg

    # Snap candidates onto the wideband R deflection before learning the
    # template. Envelope peaks lag the QRS by the integration window, so using
    # them directly produced a template whose main deflection sat off-centre,
    # which in turn made the matched filter score the post-QRS wave as highly as
    # the QRS itself - the source of the doubled beat counts.
    half_snap = int(0.07 * fs)
    snapped = []
    for c in cand:
        lo, hi = max(0, c - half_snap), min(len(wide) - 1, c + half_snap)
        snapped.append(lo + int(np.argmax(np.abs(wide[lo:hi + 1]))))
    cand = np.unique(np.array(snapped, dtype=int))

    env_amp = integ[np.minimum(cand + delay, len(integ) - 1)]

    tmpl = build_template_from(wide, cand, fs)
    if tmpl is None:
        return cand, dbg

    # Score every snapped candidate with an exact Pearson correlation against
    # the template. The candidate SET stays as generated by the envelope
    # (which has high recall); correlation only acts as a filter. Replacing the
    # candidate set with correlation peaks was tried and lost recall, because a
    # correlation peak can sit between two adjacent waves.
    scores = pearson_window(wide, tmpl, cand)
    scores = np.abs(scores)

    if use_dp:
        out = select_beats(cand, scores, fs, thresh=thresh)
        if len(out) > 20:
            t2 = build_template_from(wide, out, fs)
            if t2 is not None:
                s2 = np.abs(pearson_window(wide, t2, cand))
                out = select_beats(cand, s2, fs, thresh=thresh)
                scores = s2
                tmpl = t2
    else:
        out = cand

    dbg.update({"tmpl": tmpl, "cand": cand, "pcorr": cand, "scores": scores})
    return out, dbg


def refine_wide(wide: np.ndarray, peaks: np.ndarray, fs: int = FS,
                window_ms: float = 40.0) -> np.ndarray:
    half = int(window_ms / 1000 * fs)
    out = []
    for p in peaks:
        lo, hi = max(0, p - half), min(len(wide) - 1, p + half)
        out.append(lo + int(np.argmax(np.abs(wide[lo:hi + 1]))))
    return np.array(out, dtype=int)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--record")
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--plot", action="store_true")
    ap.add_argument("--start", type=float, default=300.0)
    ap.add_argument("--k-env", type=float, default=0.08)
    ap.add_argument("--thresh", type=float, default=0.55)
    ap.add_argument("--penalty", type=float, default=0.9)
    ap.add_argument("--no-dp", action="store_true")
    args = ap.parse_args()

    index = json.loads((CATALOG / "f32" / "index.json").read_text())
    records = ([args.record] if args.record
               else [s["record"] for s in index] if args.all
               else [s["record"] for s in index[:4]])

    rows = []
    print(f"{'record':14} {'ref':>6} {'det':>6} {'Se':>7} {'PPV':>7} {'F1':>7}")
    print("-" * 56)
    for rec in records:
        sig, ref, fs, _ = load(rec)
        peaks, dbg = detect(sig, fs, args.k_env, thresh=args.thresh,
                            rr_penalty=args.penalty, use_dp=not args.no_dp)
        wide = band(sig, 0.5, 40.0, fs)
        refined = refine_wide(wide, peaks, fs)
        sc = score_weighted(ref, refined, fs)
        rows.append({"record": rec, "n_ref": len(ref), "n_det": len(refined), **sc})
        print(f"{rec:14} {len(ref):6d} {len(refined):6d} {sc['se']:7.2f} "
              f"{sc['ppv']:7.2f} {sc['f1']:7.2f}")
        if args.plot:
            print(f"   plot -> {plot(rec, sig, ref, refined, dbg, fs, args.start)}")

    if rows:
        tot = {k: sum(r[k] for r in rows) for k in ("tp", "fp", "fn")}
        se = 100 * tot["tp"] / max(tot["tp"] + tot["fn"], 1)
        ppv = 100 * tot["tp"] / max(tot["tp"] + tot["fp"], 1)
        print(f"\nOVERALL  Se={se:.2f}  PPV={ppv:.2f}  "
              f"F1={2*se*ppv/max(se+ppv,1e-9):.2f}")
        ses = sorted(r["se"] for r in rows)
        ppvs = sorted(r["ppv"] for r in rows)
        print(f"median Se={ses[len(ses)//2]:.2f}  worst Se={ses[0]:.2f}  "
              f"median PPV={ppvs[len(ppvs)//2]:.2f}  worst PPV={ppvs[0]:.2f}")
        print(f"segments<95 Se: {sum(1 for r in rows if r['se'] < 95)}/{len(rows)}  "
              f"<95 PPV: {sum(1 for r in rows if r['ppv'] < 95)}/{len(rows)}")
        (CATALOG / "detect5_result.json").write_text(json.dumps(rows, indent=1))


if __name__ == "__main__":
    main()
