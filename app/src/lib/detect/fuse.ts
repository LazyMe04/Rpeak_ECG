/**
 * Candidate fusion and morphology scoring, ported from probe_fuse.py and
 * probe_ktmpl.py.
 *
 * `snap` moves each detector's peak onto the apex of the wideband deflection;
 * `merge` unions the two detector streams with a 50 ms tolerance. The QRS
 * score is a k-means morphology model: the record's own candidate windows are
 * clustered into eight shapes, and a candidate scores its best correlation
 * with any "QRS-like" cluster (clusters whose centre is not flat).
 *
 * The k-means initialisation is the deterministic even-spacing one. numpy's
 * seeded `choice(n, k, replace=False)` uses Floyd's algorithm over PCG64, and
 * reproducing that stream bit-for-bit in TypeScript would be a large surface
 * for no measurable gain: across seeds the correlation mean moved by ~0.001
 * and the worst segment's F1 by under 0.6 pp. The Python pipeline accepts
 * `kmeans_init="even"` for the same reason, so both sides run the same
 * algorithm (see pipeline/probe_ktmpl.py).
 */

import { argmaxAbsSlice, gradient, percentile } from "./math";

/** Snap each peak onto the largest |wide| sample within +-half samples. */
export function snap(
  peaks: ArrayLike<number>,
  wide: ArrayLike<number>,
  fs: number,
  halfMs = 50,
): Int32Array {
  const half = Math.trunc((halfMs / 1000) * fs);
  const out = new Int32Array(peaks.length);
  for (let i = 0; i < peaks.length; i++) {
    const p = peaks[i] as number;
    const lo = Math.max(0, p - half);
    const hi = Math.min(wide.length - 1, p + half);
    out[i] = argmaxAbsSlice(wide, lo, hi);
  }
  return out;
}

/** Union of sorted peak lists, keeping peaks more than `tol` apart. */
export function merge(lists: ArrayLike<number>[], tol: number): Int32Array {
  let total = 0;
  for (const l of lists) total += l.length;
  if (total === 0) return new Int32Array(0);
  const all = new Float64Array(total);
  let k = 0;
  for (const l of lists) for (let i = 0; i < l.length; i++) all[k++] = l[i] as number;
  all.sort();

  const keep: number[] = [];
  for (let i = 0; i < all.length; i++) {
    const p = all[i];
    if (keep.length === 0 || p - keep[keep.length - 1] > tol) keep.push(p);
  }
  return Int32Array.from(keep);
}

export interface Windows {
  /** Flattened rows, `dim` values per candidate; invalid rows stay zero. */
  w: Float64Array;
  ok: Uint8Array;
  dim: number;
}

/** Mean-subtracted, unit-norm windows around each candidate. */
export function windows(x: ArrayLike<number>, idx: ArrayLike<number>, half: number): Windows {
  const n = idx.length;
  const dim = 2 * half + 1;
  const w = new Float64Array(n * dim);
  const ok = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const c = idx[i] as number;
    if (c - half < 0 || c + half >= x.length) continue;
    ok[i] = 1;
    const base = i * dim;
    let mean = 0;
    for (let j = 0; j < dim; j++) {
      const v = x[c - half + j] as number;
      w[base + j] = v;
      mean += v;
    }
    mean /= dim;
    let ss = 0;
    for (let j = 0; j < dim; j++) {
      const v = w[base + j] - mean;
      w[base + j] = v;
      ss += v * v;
    }
    const nrm = Math.sqrt(ss) + 1e-12;
    for (let j = 0; j < dim; j++) w[base + j] /= nrm;
  }
  return { w, ok, dim };
}

/** k-means with Lloyd iterations, centres renormalised each step. */
export function kmeans(
  x: Float64Array,
  rows: number,
  dim: number,
  k: number,
  iters = 25,
): Float64Array {
  const cent = new Float64Array(k * dim);
  // Deterministic init: k rows evenly spaced through the data.
  for (let j = 0; j < k; j++) {
    const src = rows === 1 ? 0 : Math.trunc((j * (rows - 1)) / (k - 1 < 1 ? 1 : k - 1));
    for (let d = 0; d < dim; d++) cent[j * dim + d] = x[src * dim + d];
  }

  const xnorm = new Float64Array(rows);
  for (let i = 0; i < rows; i++) {
    let s = 0;
    for (let d = 0; d < dim; d++) {
      const v = x[i * dim + d];
      s += v * v;
    }
    xnorm[i] = s;
  }

  const lab = new Int32Array(rows);
  const dot = new Float64Array(k);
  const cnorm = new Float64Array(k);

  for (let it = 0; it < iters; it++) {
    for (let j = 0; j < k; j++) {
      let s = 0;
      for (let d = 0; d < dim; d++) {
        const v = cent[j * dim + d];
        s += v * v;
      }
      cnorm[j] = s;
    }
    for (let i = 0; i < rows; i++) {
      for (let j = 0; j < k; j++) {
        let s = 0;
        const ib = i * dim;
        const jb = j * dim;
        for (let d = 0; d < dim; d++) s += x[ib + d] * cent[jb + d];
        dot[j] = s;
      }
      let best = 0;
      let bestV = xnorm[i] - 2 * dot[0] + cnorm[0];
      for (let j = 1; j < k; j++) {
        const v = xnorm[i] - 2 * dot[j] + cnorm[j];
        if (v < bestV) {
          bestV = v;
          best = j;
        }
      }
      lab[i] = best;
    }
    for (let j = 0; j < k; j++) {
      const jb = j * dim;
      let count = 0;
      const acc = new Float64Array(dim);
      for (let i = 0; i < rows; i++) {
        if (lab[i] !== j) continue;
        count++;
        const ib = i * dim;
        for (let d = 0; d < dim; d++) acc[d] += x[ib + d];
      }
      if (count === 0) continue; // an empty cluster keeps its old centre
      let ss = 0;
      for (let d = 0; d < dim; d++) {
        acc[d] /= count;
        ss += acc[d] * acc[d];
      }
      const nrm = Math.sqrt(ss) + 1e-12;
      for (let d = 0; d < dim; d++) cent[jb + d] = acc[d] / nrm;
    }
  }
  return cent;
}

export interface QrsScore {
  score: Float64Array;
  ok: Uint8Array;
}

/**
 * Correlation of each candidate with the most QRS-like morphology cluster.
 * Clusters are ranked by the mean |d/dt| of their centre in +-40 ms; the flat
 * half is dropped, which is what rejects T waves.
 */
export function qrsScore(
  wide: ArrayLike<number>,
  cand: ArrayLike<number>,
  fs = 250,
  k = 8,
  halfMs = 120,
): QrsScore {
  const half = Math.trunc((halfMs / 1000) * fs);
  const dim = 2 * half + 1;
  const { w, ok } = windows(wide, cand, half);

  let nok = 0;
  for (let i = 0; i < ok.length; i++) nok += ok[i];

  const score = new Float64Array(cand.length);
  if (nok < 20) return { score, ok };

  // Pack the valid rows contiguously for k-means.
  const ww = new Float64Array(nok * dim);
  let r = 0;
  for (let i = 0; i < ok.length; i++) {
    if (!ok[i]) continue;
    ww.set(w.subarray(i * dim, i * dim + dim), r * dim);
    r++;
  }

  const nSub = Math.min(nok, 6000);
  const sub = new Float64Array(nSub * dim);
  for (let j = 0; j < nSub; j++) {
    const src = nSub === 1 ? 0 : Math.trunc((j * (nok - 1)) / (nSub - 1));
    sub.set(ww.subarray(src * dim, src * dim + dim), j * dim);
  }

  const cent = kmeans(sub, nSub, dim, k);

  // Cluster QRS-likeness from |d centre / dt| over +-40 ms.
  const dMid = Math.trunc(0.04 * fs);
  const midLo = Math.max(0, half - dMid);
  const midHi = half + dMid;
  const cs = new Float64Array(k);
  for (let j = 0; j < k; j++) {
    const row = cent.subarray(j * dim, j * dim + dim);
    const g = gradient(row);
    let s = 0;
    for (let d = midLo; d <= midHi; d++) s += Math.abs(g[d]);
    cs[j] = s / (midHi - midLo + 1);
  }

  const cut = percentile(cs, 50);
  const keep: number[] = [];
  for (let j = 0; j < k; j++) if (cs[j] >= cut) keep.push(j);
  if (keep.length === 0) for (let j = 0; j < k; j++) keep.push(j);

  // sim = |ww @ cent.T|; take the max over kept clusters per candidate.
  const sim = new Float64Array(nok * k);
  for (let i = 0; i < nok; i++) {
    const ib = i * dim;
    for (let j = 0; j < k; j++) {
      let s = 0;
      const jb = j * dim;
      for (let d = 0; d < dim; d++) s += ww[ib + d] * cent[jb + d];
      sim[i * k + j] = Math.abs(s);
    }
  }

  r = 0;
  for (let i = 0; i < cand.length; i++) {
    if (!ok[i]) continue;
    let best = -Infinity;
    for (const j of keep) {
      const v = sim[r * k + j];
      if (v > best) best = v;
    }
    score[i] = best;
    r++;
  }
  return { score, ok };
}
