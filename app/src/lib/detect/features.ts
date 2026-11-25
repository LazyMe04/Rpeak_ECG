/**
 * Candidate features, ported from probe_dp.features: the morphology
 * correlation plus z-scored local amplitude and local slope.
 *
 * The z-score is a robust 2nd..98th percentile stretch clipped to [0, 1.5],
 * not a standard deviation, because the amplitude distribution has a long
 * tail of artefacts that a mean and std would follow.
 */

import { clip, gradient, percentile } from "./math";
import { qrsScore } from "./fuse";

/** zscore(x, 2, 98): robust stretch clipped to [0, 1.5]. */
export function zscore(x: ArrayLike<number>, lo = 2, hi = 98): Float64Array {
  const n = x.length;
  const loV = percentile(x, lo);
  const hiV = percentile(x, hi);
  const denom = Math.max(hiV - loV, 1e-9);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = clip(((x[i] as number) - loV) / denom, 0, 1.5);
  }
  return out;
}

export interface Features {
  corr: Float64Array;
  ampZ: Float64Array;
  slopeZ: Float64Array;
}

export function features(wide: ArrayLike<number>, cand: ArrayLike<number>, fs = 250): Features {
  const { score: corr } = qrsScore(wide, cand, fs);

  const n = wide.length;
  const aw = new Float64Array(n);
  for (let i = 0; i < n; i++) aw[i] = Math.abs(wide[i] as number);

  const gRaw = gradient(wide);
  const g = new Float64Array(n);
  for (let i = 0; i < n; i++) g[i] = Math.abs(gRaw[i]);

  const hs = Math.trunc(0.04 * fs);
  const ha = Math.trunc(0.06 * fs);
  const m = cand.length;
  const amp = new Float64Array(m);
  const slope = new Float64Array(m);
  for (let i = 0; i < m; i++) {
    const c = cand[i] as number;

    const aLo = Math.max(0, c - ha);
    const aHi = Math.min(n - 1, c + ha);
    let amax = -Infinity;
    for (let j = aLo; j <= aHi; j++) if (aw[j] > amax) amax = aw[j];
    amp[i] = amax;

    const sLo = Math.max(0, c - hs);
    const sHi = Math.min(n - 1, c + hs);
    let smax = -Infinity;
    for (let j = sLo; j <= sHi; j++) if (g[j] > smax) smax = g[j];
    slope[i] = smax;
  }

  return { corr, ampZ: zscore(amp), slopeZ: zscore(slope) };
}
