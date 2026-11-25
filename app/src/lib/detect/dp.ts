/**
 * The dynamic-programming selection passes, ported from probe_dp3.py and
 * probe_dp4.py.
 *
 * Every candidate is a state pair (take / skip). `take[i]` is the best score
 * of a sequence ending with candidate i as a beat, and `back[i]` remembers
 * which earlier beat it followed. Two constraints shape the transitions:
 *
 *  - a hard T-wave rule: a pair 160-450 ms apart cannot both be beats when the
 *    later one is clearly flatter. A T wave follows its QRS at a fixed lag and
 *    is always flatter, which holds at any rate and any irregularity, so this
 *    is a mechanism rather than a tuned threshold.
 *  - an RR term whose strength is scaled by local regularity `reg(i)`. On
 *    sinus rhythm it is strong; in AFib it fades to nothing and the decision
 *    falls back on morphology alone.
 *
 * The traceback deserves a note. When a take state has no predecessor the
 * chain restarted there, but beats before it are still encoded in `skip[]`.
 * Stepping back one index and re-evaluating (rather than stopping) is what
 * recovers the earlier beats; stopping collapsed p00010_s01 to 15 detections.
 */

import { clip, interp, median, medianFilterNearest } from "./math";

/** np.searchsorted(cand, v) with side="left". */
function searchsorted(cand: ArrayLike<number>, v: number): number {
  let lo = 0;
  let hi = cand.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((cand[mid] as number) < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

interface Budget {
  tLo: number;
  tHi: number;
  rrMin: number;
  rrMax: number;
}

function bounds(fs: number): Budget {
  return {
    tLo: Math.trunc(0.16 * fs),
    tHi: Math.trunc(0.45 * fs),
    rrMin: Math.trunc(0.25 * fs),
    rrMax: Math.trunc(2.5 * fs),
  };
}

/** Shared traceback over the take/skip lattice. */
function traceback(
  cand: ArrayLike<number>,
  take: Float64Array,
  skip: Float64Array,
  back: Int32Array,
): Int32Array {
  const sel: number[] = [];
  let i = cand.length - 1;
  if (i < 0) return new Int32Array(0);
  let stateTake = Number.isFinite(take[i]) && take[i] >= skip[i];
  while (i >= 0) {
    if (stateTake) {
      sel.push(cand[i] as number);
      const j = back[i];
      if (j >= 0) {
        i = j;
        continue;
      }
      i -= 1;
    } else {
      i -= 1;
    }
    if (i < 0) break;
    stateTake = Number.isFinite(take[i]) && take[i] >= skip[i];
  }
  sel.sort((a, b) => a - b);
  return Int32Array.from(sel);
}

/**
 * probe_dp3.select: hard T-wave rule plus a cost on *long* intervals only.
 * `slopeFrac = 1e9` disables the T-wave rule (nothing is flatter than
 * 1e9 * slope), which is how `weakSequence` gets an unfiltered first pass.
 */
export function selectHard(
  cand: ArrayLike<number>,
  gain: ArrayLike<number>,
  slopeZ: ArrayLike<number>,
  fs = 250,
  slopeFrac = 0.6,
  longCost = 0.5,
  refRrS = 0.8,
): Int32Array {
  const n = cand.length;
  if (n === 0) return new Int32Array(0);
  const b = bounds(fs);
  const refRr = refRrS * fs;

  const skip = new Float64Array(n);
  const take = new Float64Array(n).fill(-Infinity);
  const back = new Int32Array(n).fill(-1);

  for (let i = 0; i < n; i++) {
    skip[i] = Math.max(i > 0 ? skip[i - 1] : 0, i > 0 ? take[i - 1] : -Infinity);
    const lo = searchsorted(cand, (cand[i] as number) - b.rrMax);
    const hi = searchsorted(cand, (cand[i] as number) - b.rrMin);
    let best = lo > 0 ? skip[lo - 1] : 0;
    let bestJ = -1;
    for (let j = lo; j < hi; j++) {
      if (!Number.isFinite(take[j])) continue;
      const dt = (cand[i] as number) - (cand[j] as number);
      if (b.tLo <= dt && dt <= b.tHi && (slopeZ[i] as number) < slopeFrac * (slopeZ[j] as number)) {
        continue;
      }
      let v = take[j];
      if (dt > refRr) v -= longCost * Math.log(dt / refRr);
      if (v > best) {
        best = v;
        bestJ = j;
      }
    }
    take[i] = (gain[i] as number) + best;
    back[i] = bestJ;
  }
  return traceback(cand, take, skip, back);
}

/**
 * probe_dp4.weak_sequence: a first pass used only to measure the rhythm. The
 * T-wave rule is disabled and there is no long-interval cost, so this is
 * close to "take everything the gain likes"; it exists so `localRegularity`
 * has a beat sequence to measure.
 */
export function weakSequence(
  cand: ArrayLike<number>,
  gain: ArrayLike<number>,
  fs = 250,
): Int32Array {
  const zeros = new Float64Array(cand.length);
  return selectHard(cand, gain, zeros, fs, 1e9, 0);
}

/** probe_dp4.local_regularity: 1 - normalised local RR spread, mapped onto candidates. */
export function localRegularity(
  cand: ArrayLike<number>,
  weak: ArrayLike<number>,
  fs = 250,
  winS = 120,
): Float64Array {
  const n = cand.length;
  if (weak.length < 20) return new Float64Array(n).fill(1);

  const nr = weak.length - 1;
  const rr = new Float64Array(nr);
  const centres = new Float64Array(nr);
  for (let i = 0; i < nr; i++) {
    rr[i] = clip(((weak[i + 1] as number) - (weak[i] as number)) / fs, 0.25, 2.5);
    centres[i] = 0.5 * ((weak[i] as number) + (weak[i + 1] as number));
  }

  let k = Math.max(3, Math.trunc(winS / 8));
  if (k % 2 === 0) k += 1;

  const med = medianFilterNearest(rr, k);
  const dev = new Float64Array(nr);
  for (let i = 0; i < nr; i++) dev[i] = Math.abs(rr[i] - med[i]) / Math.max(med[i], 1e-9);
  const spread = medianFilterNearest(dev, k);

  const reg = new Float64Array(nr);
  for (let i = 0; i < nr; i++) reg[i] = clip(1 - spread[i] / 0.3, 0, 1);

  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = interp(cand[i] as number, centres, reg);
  return out;
}

/** probe_dp3.ref_rr_from: median RR of the first pass, or 0.8 s. */
export function refRrFrom(cand: ArrayLike<number>, weak: ArrayLike<number>, fs = 250): number {
  void cand;
  if (weak.length < 20) return 0.8;
  const vals: number[] = [];
  for (let i = 1; i < weak.length; i++) {
    const v = ((weak[i] as number) - (weak[i - 1] as number)) / fs;
    if (v > 0.25 && v < 2.5) vals.push(v);
  }
  if (vals.length < 10) return 0.8;
  return median(vals);
}

/**
 * probe_dp4.select_adaptive: the shipped second pass. The RR weight is scaled
 * per candidate by `reg`, and the reference RR is floored at 1 sample so a
 * degenerate estimate cannot blow up the log.
 */
export function selectAdaptive(
  cand: ArrayLike<number>,
  gain: ArrayLike<number>,
  slopeZ: ArrayLike<number>,
  reg: ArrayLike<number>,
  fs = 250,
  slopeFrac = 0.6,
  rrPenalty = 2.0,
  refRrS = 0.8,
): Int32Array {
  const n = cand.length;
  if (n === 0) return new Int32Array(0);
  const b = bounds(fs);
  const refRr = refRrS * fs;

  const skip = new Float64Array(n);
  const take = new Float64Array(n).fill(-Infinity);
  const back = new Int32Array(n).fill(-1);

  for (let i = 0; i < n; i++) {
    skip[i] = Math.max(i > 0 ? skip[i - 1] : 0, i > 0 ? take[i - 1] : -Infinity);
    const lo = searchsorted(cand, (cand[i] as number) - b.rrMax);
    const hi = searchsorted(cand, (cand[i] as number) - b.rrMin);
    let best = lo > 0 ? skip[lo - 1] : 0;
    let bestJ = -1;
    const rI = reg[i] as number;
    const refI = Math.max(refRr, 1);
    for (let j = lo; j < hi; j++) {
      if (!Number.isFinite(take[j])) continue;
      const dt = (cand[i] as number) - (cand[j] as number);
      if (b.tLo <= dt && dt <= b.tHi && (slopeZ[i] as number) < slopeFrac * (slopeZ[j] as number)) {
        continue;
      }
      let v = take[j];
      v -= rrPenalty * rI * Math.abs(Math.log(Math.max(dt, 1) / refI));
      if (v > best) {
        best = v;
        bestJ = j;
      }
    }
    take[i] = (gain[i] as number) + best;
    back[i] = bestJ;
  }
  return traceback(cand, take, skip, back);
}
