/**
 * The evaluation metric, ported from detect4.score_weighted.
 *
 * This is not a fixed 50 ms window. Each detection is matched against the
 * nearest of three reference beats, and the tolerance for a reference beat is
 * derived from its own RR interval: `clip(0.5 * rr, 50 ms, 150 ms)`. On a fast
 * rhythm a 50 ms window would miss beats that are anatomically correct; on a
 * slow one 150 ms would credit detections that are visibly off the apex.
 * Matching is one-to-one: a reference beat can be claimed once.
 */

export interface Score {
  tp: number;
  fp: number;
  fn: number;
  se: number;
  ppv: number;
  f1: number;
}

function searchsorted(a: ArrayLike<number>, v: number): number {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((a[mid] as number) < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function scoreWeighted(ref: ArrayLike<number>, det: ArrayLike<number>, fs = 250): Score {
  const nref = ref.length;

  // rr[j-1] is the interval ending at reference beat j.
  const rr = new Float64Array(nref > 1 ? nref - 1 : 1);
  if (nref > 1) {
    for (let i = 0; i < nref - 1; i++) rr[i] = (ref[i + 1] as number) - (ref[i] as number);
  } else {
    rr[0] = fs;
  }

  const used = new Uint8Array(nref);
  let tp = 0;
  for (let k = 0; k < det.length; k++) {
    const d = det[k] as number;
    const pos = searchsorted(ref, d);
    let best = -1;
    let bestOff = Infinity;
    for (let j = pos - 1; j <= pos + 1; j++) {
      if (j < 0 || j >= nref || used[j]) continue;
      const base = j > 0 && j - 1 <= rr.length - 1 ? rr[j - 1] : fs;
      const w = Math.max(0.05 * fs, Math.min(0.15 * fs, 0.5 * base));
      const off = Math.abs((ref[j] as number) - d);
      if (off <= w && off < bestOff) {
        best = j;
        bestOff = off;
      }
    }
    if (best >= 0) {
      used[best] = 1;
      tp++;
    }
  }

  let missed = 0;
  for (let i = 0; i < nref; i++) if (!used[i]) missed++;

  const fp = det.length - tp;
  const fn = missed;
  const se = (100 * tp) / Math.max(nref, 1);
  const ppv = (100 * tp) / Math.max(det.length, 1);
  return {
    tp,
    fp,
    fn,
    se,
    ppv,
    f1: (2 * se * ppv) / Math.max(se + ppv, 1e-9),
  };
}
