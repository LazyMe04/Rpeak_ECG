/**
 * PQRST delineation: where each wave starts, peaks and ends, and the clinical
 * intervals derived from them (PR, QRS, QT, corrected QT).
 *
 * Approach, and why this one:
 *
 *  1. Work on a 40 Hz low-pass trace. Not the display band-pass: its 0.5 Hz
 *     high-pass leaves an undershoot after every T wave of order
 *     amplitude * sigma / tau, which is larger than the thresholds used below,
 *     so every outward walk would run to its search limit. Baseline removal is
 *     done per wave instead (point 4), which is also more faithful: a moving
 *     average would flatten the T wave itself.
 *  2. Smooth with a ~20 ms box. Every threshold here is small compared with
 *     sample-to-sample noise; an unsmoothed threshold crossing fires on noise.
 *  3. QRS edges by *slope*, P and T edges by *amplitude*.
 *     The QRS is a burst of slope that dwarfs everything around it, and a
 *     slope threshold is blind to the local baseline offset — which on a chest
 *     strap recording can be a tenth of the R amplitude between the PR segment
 *     and the ST segment, far above any small amplitude threshold. The P and T
 *     are the opposite: their slopes are a few percent of the R's, so a slope
 *     threshold would sit in the noise, while their excursions from their own
 *     baseline are large. A wave's derivative is zero at its peak, so the slope
 *     walk starts from the steepest sample, not from the apex.
 *  4. Give each wave its own baseline: a line through the two isoelectric
 *     stretches either side of its search window — the PR and ST segments for
 *     the QRS, the ST segment and the next isoelectric stretch for the T, the
 *     two ends of the PR window for the P. A constant baseline cannot follow
 *     the residual wander that a 40 Hz low-pass leaves in.
 *
 * Boundaries are conventions, not instants: a Gaussian-shaped wave never truly
 * reaches the baseline. The fractions below are named constants, and
 * pipeline/delineate_reference.py measures the synthetic fixture's truth with
 * the same ones, so `npm run test:delineate` checks that the code implements
 * its own definition — not that the definition is clinically correct, which no
 * boundary-free dataset (this one included) can settle.
 *
 * All boundaries are sample indices into the input array.
 */

import { makeDelineateFilter } from "../filters";

/** QRS edge: fraction of the steepest sample in the QRS window. */
const QRS_SLOPE_FRAC = 0.1;
/** P and T boundary: fraction of the wave's own excursion from its baseline. */
const SLOW_FRAC = 0.05;
/** A P wave smaller than this fraction of the R is not called a P wave. */
const P_MIN_FRAC = 0.04;
/** A T wave smaller than this fraction of the R is treated as flat. */
const T_MIN_FRAC = 0.03;
/** Outward walks tolerate this many consecutive samples below threshold. */
const RUN = 3;

export interface Delineation {
  /** R apex, as given. */
  r: number;
  /** QRS onset/offset: the union of the Q, R and S extents. */
  qrsOn: number;
  qrsOff: number;
  pOn: number | null;
  pPeak: number | null;
  pOff: number | null;
  tOn: number;
  tPeak: number;
  tOff: number;
  /** Amplitudes relative to the beat's own baseline, on the smoothed trace. */
  rAmp: number;
  pAmp: number | null;
  tAmp: number;
  /** True when no P wave was found, which is a finding, not a failure. */
  pMissing: boolean;
}

export interface Interval {
  prMs: number | null;
  qrsMs: number;
  qtMs: number;
  qtcBazettMs: number;
  qtcFridericiaMs: number;
  /** QT corrected for heart rate by the Hodges formula. */
  qtcHodgesMs: number;
}

type BaseFn = (i: number) => number;

const clampIdx = (v: number, n: number) => Math.max(0, Math.min(n - 1, Math.round(v)));

/** A line through (a, va) and (b, vb), sampled at any index. */
function lineBase(a: number, b: number, va: number, vb: number): BaseFn {
  const k = b === a ? 0 : (vb - va) / (b - a);
  return (i) => va + k * (i - a);
}

/**
 * Centered moving average, clamped at the edges. `w` must be odd.
 *
 * A running sum keeps this O(n) for a million-sample segment; the naive form
 * is O(n*w) and this runs on every record open.
 */
function boxSmooth(x: Float64Array, w: number): Float64Array {
  if (w <= 1) return x;
  const n = x.length;
  const half = (w - 1) >> 1;
  const out = new Float64Array(n);
  let acc = 0;
  for (let i = -half; i <= half; i++) acc += x[clampIdx(i, n)]!;
  const inv = 1 / w;
  for (let i = 0; i < n; i++) {
    out[i] = acc * inv;
    acc += x[clampIdx(i + half + 1, n)]! - x[clampIdx(i - half, n)]!;
  }
  return out;
}

/** Median of x[lo..hi] inclusive, by insertion sort over a small copy. */
function medianOf(x: Float64Array, lo: number, hi: number): number {
  const a: number[] = [];
  for (let i = Math.max(0, lo); i <= Math.min(x.length - 1, hi); i++) a.push(x[i]!);
  if (a.length === 0) return 0;
  a.sort((p, q) => p - q);
  const m = a.length >> 1;
  return a.length % 2 ? a[m]! : (a[m - 1]! + a[m]!) / 2;
}

/** Index of the largest |x[i] - base(i)| in [lo, hi]; polarity-agnostic. */
function extremeAbsOf(x: Float64Array, base: BaseFn, lo: number, hi: number): number {
  let best = lo;
  let bestV = -Infinity;
  for (let i = lo; i <= hi; i++) {
    const v = Math.abs(x[i]! - base(i));
    if (v > bestV) {
      bestV = v;
      best = i;
    }
  }
  return best;
}

/**
 * Walk from a wave's extremum toward `limit` and return the last sample that is
 * still above the threshold.
 *
 * Stopping on the first below-threshold sample would end the walk on a noise
 * dip in the middle of the wave, so `RUN` consecutive samples are required.
 */
function walkEdge(
  x: Float64Array,
  base: BaseFn,
  from: number,
  limit: number,
  thresh: number,
  step: number,
): number {
  let lastAbove = from;
  let run = 0;
  for (let i = from; step > 0 ? i <= limit : i >= limit; i += step) {
    if (Math.abs(x[i]! - base(i)) > thresh) {
      lastAbove = i;
      run = 0;
    } else if (++run >= RUN) {
      break;
    }
  }
  return lastAbove;
}

/** Half-sample centred |dx/dt|. */
const slopeAt = (x: Float64Array, i: number) => Math.abs(x[i + 1]! - x[i - 1]!) * 0.5;

/** Index of the steepest sample in [lo, hi]. */
function steepest(x: Float64Array, lo: number, hi: number): number {
  let best = lo;
  let bestV = -Infinity;
  for (let i = lo; i <= hi; i++) {
    const v = slopeAt(x, i);
    if (v > bestV) {
      bestV = v;
      best = i;
    }
  }
  return best;
}

/**
 * Slope-based walk, for QRS edges.
 *
 * Starts at the steepest sample and runs outward. The `RUN` tolerance is what
 * lets it step over the zero crossing between the Q and the R: the slope there
 * is near zero for a sample or two, but the Q's own upstroke is above the
 * threshold, so the walk carries on to the Q's onset.
 */
function walkSlope(
  x: Float64Array,
  from: number,
  limit: number,
  thresh: number,
  step: number,
): number {
  let lastAbove = from;
  let run = 0;
  for (let i = from; step > 0 ? i <= limit : i >= limit; i += step) {
    if (slopeAt(x, i) > thresh) {
      lastAbove = i;
      run = 0;
    } else if (++run >= RUN) {
      break;
    }
  }
  return lastAbove;
}

/**
 * R-R in seconds at each beat, from the peaks themselves. Contraction protects
 * a degenerate interval: a 0-length RR would collapse every search window.
 */
function localRr(peaks: ArrayLike<number>, i: number, fs: number): number {
  const n = peaks.length;
  const prev = i > 0 ? (peaks[i] as number) - (peaks[i - 1] as number) : Infinity;
  const next = i < n - 1 ? (peaks[i + 1] as number) - (peaks[i] as number) : Infinity;
  const v = Math.min(prev, next) / fs;
  return Number.isFinite(v) && v > 0.2 ? v : 0.8;
}

/**
 * Delineate one beat of an already smoothed low-pass trace.
 *
 * `x` must be the smoothed 40 Hz trace (see `delineateSegment`); passing the
 * raw signal would work but would put every threshold into the noise.
 */
export function delineateBeat(
  x: Float64Array,
  raw: Float64Array,
  r: number,
  fs: number,
  rrS: number,
  prevTOff: number | null = null,
): Delineation | null {
  const n = x.length;
  const rIdx = clampIdx(r, n);

  // ---- QRS --------------------------------------------------------------
  // The search spans +/-80 ms, which holds a QRS up to 160 ms wide with the R
  // anywhere inside it. A flat stretch has no QRS to read.
  const half = Math.round(0.08 * fs);
  const qLo = Math.max(1, rIdx - half);
  const sHi = Math.min(n - 2, rIdx + half);

  let lo = Infinity;
  let hi = -Infinity;
  for (let i = qLo; i <= sHi; i++) {
    const v = x[i]!;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (hi - lo < 1e-6) return null;

  // The slope walk runs on the unsmoothed trace: the QRS slope is so much
  // larger than any noise that smoothing only blurs its onset, which showed up
  // as a constant 8 ms early QRS onset against the golden.
  const leftPeak = steepest(raw, qLo, rIdx);
  const rightPeak = steepest(raw, rIdx, sHi);
  const peakSlope = Math.max(slopeAt(raw, leftPeak), slopeAt(raw, rightPeak));
  const slopeThresh = QRS_SLOPE_FRAC * peakSlope;
  const qrsOnC = Math.max(0, Math.min(walkSlope(raw, leftPeak, qLo, slopeThresh, -1), rIdx));
  const qrsOffC = Math.min(n - 1, Math.max(walkSlope(raw, rightPeak, sHi, slopeThresh, +1), rIdx));

  // The isoelectric level for amplitudes is the PR segment, now that its far
  // end is known: the 50 ms before the QRS onset, excluding the last 8 ms.
  const prLo = Math.max(1, qrsOnC - Math.round(0.05 * fs));
  const prHi = Math.max(prLo, qrsOnC - Math.round(0.008 * fs));
  const baseQ = medianOf(x, prLo, prHi);
  const rAmp = x[rIdx]! - baseQ;
  const rExc = Math.abs(rAmp);

  // ---- T wave -----------------------------------------------------------
  // 40 ms of ST segment before the search, then a rate-dependent window: at
  // high rates 0.6 RR keeps the window from running into the next P wave.
  const tStart = Math.min(n - 2, qrsOffC + Math.round(0.04 * fs));
  const tEnd = Math.min(n - 2, qrsOffC + Math.round(Math.max(0.25, Math.min(0.5, 0.6 * rrS)) * fs));
  const tGap = Math.max(1, Math.round(0.02 * fs));
  const baseT = lineBase(
    tStart,
    Math.max(tStart, tEnd - tGap),
    medianOf(x, tStart, Math.min(tEnd, tStart + tGap)),
    medianOf(x, Math.max(tStart, tEnd - tGap), tEnd),
  );

  let tOn = tStart;
  let tPeak = tStart;
  let tOff = tStart;
  let tAmp = 0;
  if (tEnd > tStart + 2) {
    // The T may be inverted, so the extremum is chosen by absolute size.
    tPeak = extremeAbsOf(x, baseT, tStart, tEnd);
    tAmp = x[tPeak]! - baseT(tPeak);
    if (Math.abs(tAmp) > T_MIN_FRAC * rExc) {
      const thresh = SLOW_FRAC * Math.abs(tAmp);
      tOn = walkEdge(x, baseT, tPeak, tStart, thresh, -1);
      tOff = walkEdge(x, baseT, tPeak, tEnd, thresh, +1);
    }
  }

  // ---- P wave -----------------------------------------------------------
  // The PR interval is at most ~300 ms, so the search runs back that far from
  // the QRS onset — but no further than the previous T wave's offset, because
  // above ~100 bpm the P merges into the preceding T and the search would then
  // measure the T instead. The baseline line runs between the two ends of the
  // window, both of which sit outside the P wave itself.
  const pHi = qrsOnC - Math.round(0.02 * fs);
  const floor = prevTOff === null ? 1 : prevTOff + Math.round(0.01 * fs);
  const pLo = Math.max(1, floor, qrsOnC - Math.round(0.3 * fs));
  let pOn: number | null = null;
  let pPeak: number | null = null;
  let pOff: number | null = null;
  let pAmp: number | null = null;
  let pMissing = true;
  if (pHi > pLo + 2) {
    const pGap = Math.max(1, Math.round(0.02 * fs));
    const baseP = lineBase(
      pLo,
      Math.max(pLo, pHi - pGap),
      medianOf(x, pLo, Math.min(pHi, pLo + pGap)),
      medianOf(x, Math.max(pLo, pHi - pGap), pHi),
    );
    const cand = extremeAbsOf(x, baseP, pLo + 1, pHi);
    const amp = x[cand]! - baseP(cand);
    if (Math.abs(amp) > P_MIN_FRAC * rExc) {
      const thresh = SLOW_FRAC * Math.abs(amp);
      const on = walkEdge(x, baseP, cand, pLo, thresh, -1);
      // A wave that never returns to baseline inside the window is not a P:
      // it is the fused tail of the previous T, and the onset would be a
      // fabricated 300 ms PR.
      if (on !== pLo) {
        pOn = on;
        pOff = walkEdge(x, baseP, cand, pHi, thresh, +1);
        pPeak = cand;
        pAmp = amp;
        pMissing = false;
      }
    }
  }

  return {
    r: rIdx,
    qrsOn: qrsOnC,
    qrsOff: qrsOffC,
    pOn,
    pPeak,
    pOff,
    tOn,
    tPeak,
    tOff,
    rAmp,
    pAmp,
    tAmp,
    pMissing,
  };
}

/** The intervals a clinician reads off a beat, in ms. */
export function intervals(d: Delineation, fs: number, rrS: number): Interval {
  const toMs = (samples: number) => (1000 * samples) / fs;
  const qrsMs = toMs(Math.max(1, d.qrsOff - d.qrsOn));
  const qtMs = toMs(Math.max(1, d.tOff - d.qrsOn));
  const prMs = d.pOn === null ? null : toMs(Math.max(1, d.qrsOn - d.pOn));
  const q = correctQt(qtMs, rrS);
  return {
    prMs,
    qrsMs,
    qtMs,
    qtcBazettMs: q.bazett,
    qtcFridericiaMs: q.fridericia,
    qtcHodgesMs: q.hodges,
  };
}

/**
 * Correct QT for rate.
 *
 * Three corrections are returned rather than one. Bazett is the number most
 * often quoted and the least reliable outside 60-100 bpm; Fridericia is better
 * at the extremes; Hodges is linear in rate and does not explode at short RR.
 * Showing all three makes it obvious when the choice matters.
 */
export function correctQt(
  qtMs: number,
  rrS: number,
): {
  bazett: number;
  fridericia: number;
  hodges: number;
} {
  const rr = Math.max(0.2, rrS);
  return {
    bazett: qtMs / Math.sqrt(rr),
    fridericia: qtMs / Math.cbrt(rr),
    hodges: qtMs + 1.75 * (60 / rr - 60),
  };
}

/**
 * Delineation for a whole segment, as flat arrays aligned with the peak list.
 *
 * Flat because the result crosses a worker boundary and is read per frame by
 * the canvas: ~7,000 objects would be copied as a graph, and 12 typed arrays
 * transfer in one shot. Missing values are -1 for indices and NaN for
 * milliseconds, which keeps every array indexable by beat.
 */
export interface DelinArrays {
  qrsOn: Int32Array;
  qrsOff: Int32Array;
  tOn: Int32Array;
  tPeak: Int32Array;
  tOff: Int32Array;
  pOn: Int32Array;
  pOff: Int32Array;
  pPeak: Int32Array;
  prMs: Float32Array;
  qrsMs: Float32Array;
  qtMs: Float32Array;
  qtcMs: Float32Array;
}

export interface DelinSummary {
  arrays: DelinArrays;
  /** Beats with no P wave found — a finding, not an error. */
  missingP: number;
  median: {
    prMs: number | null;
    qrsMs: number;
    qtMs: number;
    qtcMs: number;
  };
}

function median(xs: number[]): number {
  if (xs.length === 0) return Number.NaN;
  xs.sort((a, b) => a - b);
  const m = xs.length >> 1;
  return xs.length % 2 ? xs[m]! : (xs[m - 1]! + xs[m]!) / 2;
}

/** Flatten a delineation into arrays the worker can transfer and the UI index. */
export function summarizeDelineation(
  beats: (Delineation | null)[],
  rr: Float64Array,
  fs: number,
): DelinSummary {
  const n = beats.length;
  const arrays: DelinArrays = {
    qrsOn: new Int32Array(n),
    qrsOff: new Int32Array(n),
    tOn: new Int32Array(n),
    tPeak: new Int32Array(n),
    tOff: new Int32Array(n),
    pOn: new Int32Array(n),
    pOff: new Int32Array(n),
    pPeak: new Int32Array(n),
    prMs: new Float32Array(n),
    qrsMs: new Float32Array(n),
    qtMs: new Float32Array(n),
    qtcMs: new Float32Array(n),
  };

  const prs: number[] = [];
  const qrss: number[] = [];
  const qts: number[] = [];
  const qtcs: number[] = [];
  let missingP = 0;

  for (let i = 0; i < n; i++) {
    const b = beats[i];
    if (!b) {
      arrays.qrsOn[i] = arrays.qrsOff[i] = -1;
      arrays.tOn[i] = arrays.tPeak[i] = arrays.tOff[i] = -1;
      arrays.pOn[i] = arrays.pOff[i] = arrays.pPeak[i] = -1;
      arrays.prMs[i] = arrays.qrsMs[i] = arrays.qtMs[i] = arrays.qtcMs[i] = Number.NaN;
      missingP++;
      continue;
    }
    const iv = intervals(b, fs, rr[i] ?? 0.8);
    arrays.qrsOn[i] = b.qrsOn;
    arrays.qrsOff[i] = b.qrsOff;
    arrays.tOn[i] = b.tOn;
    arrays.tPeak[i] = b.tPeak;
    arrays.tOff[i] = b.tOff;
    arrays.pOn[i] = b.pOn ?? -1;
    arrays.pOff[i] = b.pOff ?? -1;
    arrays.pPeak[i] = b.pPeak ?? -1;
    arrays.prMs[i] = iv.prMs ?? Number.NaN;
    arrays.qrsMs[i] = iv.qrsMs;
    arrays.qtMs[i] = iv.qtMs;
    arrays.qtcMs[i] = iv.qtcBazettMs;
    if (b.pMissing) missingP++;
    else if (iv.prMs !== null) prs.push(iv.prMs);
    qrss.push(iv.qrsMs);
    qts.push(iv.qtMs);
    qtcs.push(iv.qtcBazettMs);
  }

  return {
    arrays,
    missingP,
    median: {
      prMs: prs.length ? median(prs) : null,
      qrsMs: median(qrss),
      qtMs: median(qts),
      qtcMs: median(qtcs),
    },
  };
}

/**
 * Delineate a whole segment.
 *
 * One filter pass, one smoothing pass, then ~7,000 constant-time beats. The
 * returned `trace` is the smoothed 40 Hz signal the boundaries were measured
 * on, so a caller that wants to draw them does not filter again.
 */
export function delineateSegment(
  sig: ArrayLike<number>,
  peaks: ArrayLike<number>,
  fs = 250,
): { trace: Float64Array; beats: (Delineation | null)[]; rr: Float64Array } {
  const lp = makeDelineateFilter().processAll(sig);
  const xs = boxSmooth(lp, 2 * Math.max(1, Math.round(0.01 * fs)) + 1);

  const beats: (Delineation | null)[] = [];
  const rr = new Float64Array(peaks.length);
  let prevTOff: number | null = null;
  for (let i = 0; i < peaks.length; i++) {
    rr[i] = localRr(peaks, i, fs);
    const d = delineateBeat(xs, lp, peaks[i] as number, fs, rr[i]!, prevTOff);
    beats.push(d);
    if (d) prevTOff = d.tOff;
  }
  return { trace: xs, beats, rr };
}
