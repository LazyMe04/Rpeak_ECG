/**
 * Small numeric helpers that reproduce the exact numpy/scipy semantics the
 * Python reference relies on. Where the choice of algorithm is not obvious
 * (percentile interpolation, plateau handling in find_peaks, even-length
 * median) the behaviour was probed against the installed numpy rather than
 * assumed.
 */

/** np.percentile(x, q), default linear interpolation. */
export function percentile(values: ArrayLike<number>, q: number): number {
  const n = values.length;
  if (n === 0) return Number.NaN;
  const a = new Float64Array(n);
  for (let i = 0; i < n; i++) a[i] = values[i] as number;
  a.sort();
  const idx = (q / 100) * (n - 1);
  const lo = Math.floor(idx);
  const hi = Math.min(lo + 1, n - 1);
  const frac = idx - lo;
  return a[lo] + frac * (a[hi] - a[lo]);
}

/** np.median: mean of the two middle values for an even length. */
export function median(values: ArrayLike<number>): number {
  const n = values.length;
  if (n === 0) return Number.NaN;
  const a = new Float64Array(n);
  for (let i = 0; i < n; i++) a[i] = values[i] as number;
  a.sort();
  const mid = n >> 1;
  return n % 2 === 1 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

/** np.gradient(x) for a 1-D array, default edge_order=1. */
export function gradient(x: ArrayLike<number>): Float64Array {
  const n = x.length;
  const out = new Float64Array(n);
  if (n === 0) return out;
  if (n === 1) {
    out[0] = 0;
    return out;
  }
  out[0] = (x[1] as number) - (x[0] as number);
  for (let i = 1; i < n - 1; i++) {
    out[i] = ((x[i + 1] as number) - (x[i - 1] as number)) / 2;
  }
  out[n - 1] = (x[n - 1] as number) - (x[n - 2] as number);
  return out;
}

/**
 * np.interp(x, xp, fp) for scalar x: linear inside, clamped outside.
 * `xp` must be non-decreasing.
 */
export function interp(x: number, xp: ArrayLike<number>, fp: ArrayLike<number>): number {
  const n = xp.length;
  if (n === 0) return Number.NaN;
  if (n === 1) return fp[0] as number;
  if (x <= (xp[0] as number)) return fp[0] as number;
  if (x >= (xp[n - 1] as number)) return fp[n - 1] as number;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if ((xp[mid] as number) <= x) lo = mid;
    else hi = mid;
  }
  const x0 = xp[lo] as number;
  const x1 = xp[hi] as number;
  const f0 = fp[lo] as number;
  const f1 = fp[hi] as number;
  if (x1 === x0) return f0;
  return f0 + ((x - x0) / (x1 - x0)) * (f1 - f0);
}

/**
 * scipy.ndimage.median_filter(x, size=k, mode="nearest") for odd k.
 * "nearest" repeats the edge value, which is the same as clamping the window
 * indices into range.
 */
export function medianFilterNearest(x: ArrayLike<number>, size: number): Float64Array {
  const n = x.length;
  const out = new Float64Array(n);
  const half = size >> 1;
  const window = new Float64Array(size);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < size; j++) {
      const idx = Math.min(n - 1, Math.max(0, i - half + j));
      window[j] = x[idx] as number;
    }
    out[i] = median(window);
  }
  return out;
}

/**
 * np.round: round half to even, unlike Math.round which rounds half up.
 * The ADC in wfdb uses np.round, so this is not cosmetic.
 */
export function roundHalfEven(v: number): number {
  const f = Math.floor(v);
  const diff = v - f;
  if (diff > 0.5) return f + 1;
  if (diff < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

/** np.clip for scalars. */
export function clip(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * scipy.signal.find_peaks with an optional `height` and `distance`.
 *
 * Peaks are local maxima; a plateau of equal values counts once, reported at
 * its midpoint. `distance` is resolved greedily from the highest peak down,
 * which is what scipy's `_select_by_peak_distance` does.
 */
export function findPeaks(x: ArrayLike<number>, height?: number, distance?: number): Int32Array {
  const n = x.length;
  const peaks: number[] = [];
  let i = 1;
  while (i < n - 1) {
    if ((x[i] as number) > (x[i - 1] as number)) {
      let ahead = i + 1;
      while (ahead < n - 1 && x[ahead] === x[i]) ahead++;
      if ((x[i] as number) > (x[ahead] as number)) {
        // Report the middle of the plateau, as scipy does.
        peaks.push((i + ahead - 1) >> 1);
        i = ahead;
      } else {
        i = ahead;
      }
    } else {
      i++;
    }
  }

  let kept = peaks;
  if (height !== undefined) {
    kept = kept.filter((p) => (x[p] as number) >= height);
  }
  if (distance !== undefined && distance >= 1 && kept.length > 1) {
    // Stable sort by descending priority (peak height), then keep a peak only
    // when no already-kept peak is within `distance`.
    const order = kept
      .map((p, k) => ({ p, k, h: x[p] as number }))
      .sort((a, b) => b.h - a.h || a.k - b.k);
    const keep: number[] = [];
    for (const o of order) {
      let ok = true;
      for (const q of keep) {
        if (Math.abs(q - o.p) < distance) {
          ok = false;
          break;
        }
      }
      if (ok) keep.push(o.p);
    }
    keep.sort((a, b) => a - b);
    kept = keep;
  }
  return Int32Array.from(kept);
}

/** argmax over a slice, first maximum wins (np.argmax), relative to `lo`. */
export function argmaxSlice(x: ArrayLike<number>, lo: number, hi: number): number {
  let best = lo;
  let bestV = x[lo] as number;
  for (let i = lo + 1; i <= hi; i++) {
    const v = x[i] as number;
    if (v > bestV) {
      bestV = v;
      best = i;
    }
  }
  return best;
}

/** argmax of the absolute value over [lo, hi], first maximum wins. */
export function argmaxAbsSlice(x: ArrayLike<number>, lo: number, hi: number): number {
  let best = lo;
  let bestV = Math.abs(x[lo] as number);
  for (let i = lo + 1; i <= hi; i++) {
    const v = Math.abs(x[i] as number);
    if (v > bestV) {
      bestV = v;
      best = i;
    }
  }
  return best;
}
