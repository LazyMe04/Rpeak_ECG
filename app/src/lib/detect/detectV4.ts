/**
 * detect_v4 in TypeScript: the shipped R-peak detector.
 *
 * Pipeline, unchanged from pipeline/detect_v4.py:
 *
 *   1. candidates = union(snap(gqrs), snap(two-max)) with a 50 ms tolerance
 *   2. features   = morphology correlation + z-scored amplitude and slope
 *   3. pass 1     = DP with no RR weighting, used only to measure the rhythm
 *   4. pass 2     = DP whose RR weight is scaled by local regularity
 *
 * The two detectors fail on disjoint patient sets, which is why the union has
 * much higher recall than either alone; the DP then restores precision.
 */

import { makeWideFilter } from "../filters";
import { features } from "./features";
import { merge, snap } from "./fuse";
import { gqrsDetect } from "./gqrs";
import { localRegularity, refRrFrom, selectAdaptive, weakSequence } from "./dp";
import { runTwomax } from "./twomax";

export interface DetectOptions {
  fs?: number;
  /** Precomputed 0.5-40 Hz trace, if the caller already has one. */
  wide?: ArrayLike<number>;
  wAmp?: number;
  wCorr?: number;
  wSlope?: number;
  slopeFrac?: number;
  rrPenalty?: number;
  regWinS?: number;
  snapMs?: number;
  mergeTolMs?: number;
}

export const DETECT_DEFAULTS = {
  wAmp: 0.5,
  wCorr: 1.0,
  wSlope: 1.5,
  slopeFrac: 0.6,
  rrPenalty: 2.0,
  regWinS: 120.0,
  snapMs: 50.0,
  mergeTolMs: 50.0,
} as const;

export interface DetectResult {
  /** Sorted detected R-peak sample indices. */
  peaks: Int32Array;
  /** Fused candidate set before selection. */
  cand: Int32Array;
  corr: Float64Array;
  ampZ: Float64Array;
  slopeZ: Float64Array;
  gain: Float64Array;
  weak: Int32Array;
  reg: Float64Array;
  refRr: number;
}

export function detectV4(sig: ArrayLike<number>, opts: DetectOptions = {}): DetectResult {
  const fs = opts.fs ?? 250;
  const p = { ...DETECT_DEFAULTS, ...opts };

  const wide = opts.wide ?? makeWideFilter().processAll(sig);

  const tol = Math.trunc((p.mergeTolMs / 1000) * fs);
  const gqrs = snap(gqrsDetect(sig, fs), wide, fs, p.snapMs);
  const twomax = snap(runTwomax(sig, fs), wide, fs, p.snapMs);
  const cand = merge([gqrs, twomax], tol);

  const empty = new Float64Array(0);
  if (cand.length < 10) {
    return {
      peaks: cand,
      cand,
      corr: empty,
      ampZ: empty,
      slopeZ: empty,
      gain: empty,
      weak: new Int32Array(0),
      reg: empty,
      refRr: 0.8,
    };
  }

  const { corr, ampZ, slopeZ } = features(wide, cand, fs);
  const n = cand.length;
  const gain = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    gain[i] = p.wAmp * ampZ[i] + p.wCorr * corr[i] + p.wSlope * slopeZ[i];
  }

  // Pass 1: no RR weighting. Used only to measure the rhythm, never returned.
  const weak = weakSequence(cand, gain, fs);
  const reg = localRegularity(cand, weak, fs, p.regWinS);
  const refRr = refRrFrom(cand, weak, fs);

  // Pass 2: regularity-adaptive selection.
  const peaks = selectAdaptive(cand, gain, slopeZ, reg, fs, p.slopeFrac, p.rrPenalty, refRr);

  return { peaks, cand, corr, ampZ, slopeZ, gain, weak, reg, refRr };
}
