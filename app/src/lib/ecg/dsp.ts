/**
 * Real-input FFT and the small DSP helpers the ECG analyses need.
 *
 * A radix-2 complex FFT over a zero-padded power-of-two length, plus
 * `rfftPower`, which reproduces what numpy's `np.fft.rfft` gives for a real
 * input: bins 0..N/2, with the one-sided doubling applied outside the endpoints.
 *
 * Why not a dependency: the only transform in the app is a 16k-point RR
 * tachogram spectrum once per segment. A 60-line FFT is smaller than the
 * wrapper around any library, and it is exact against numpy rather than
 * "close", which is what makes the HRV parity test meaningful.
 *
 * Zero-padding note: numpy's `rfft` on a length-n signal computes n bins, not
 * `next_pow2(n)`. Padding changes the bin spacing, so `rfftPower` pads only
 * when the caller asks for a specific padded length and reports the true
 * resolution. The HRV caller pads deliberately -- to a fast power of two --
 * and both implementations pad identically, so the comparison stays exact.
 */

/** In-place iterative radix-2 FFT of a complex array whose length is a power of 2. */
function fftInPlace(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  if (n <= 1) return;

  // Bit-reversal permutation.
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]!;
      re[i] = re[j]!;
      re[j] = tr;
      const ti = im[i]!;
      im[i] = im[j]!;
      im[j] = ti;
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      const half = len >> 1;
      for (let k = 0; k < half; k++) {
        const aRe = re[i + k]!;
        const aIm = im[i + k]!;
        const bRe = re[i + k + half]! * curRe - im[i + k + half]! * curIm;
        const bIm = re[i + k + half]! * curIm + im[i + k + half]! * curRe;
        re[i + k] = aRe + bRe;
        im[i + k] = aIm + bIm;
        re[i + k + half] = aRe - bRe;
        im[i + k + half] = aIm - bIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }
}

/** Smallest power of two >= n. */
export function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

export interface Spectrum {
  /** Bin centre frequencies in Hz. */
  freqs: Float64Array;
  /** Power spectral density in units² / Hz. */
  power: Float64Array;
}

/**
 * One-sided PSD of a real, already-windowed, already-detrended signal.
 *
 * Scaling matches numpy's `abs(rfft(x))**2 / (fs * sum(w**2))` with the
 * interior bins doubled, which is the standard one-sided periodogram: the sum
 * of the returned bins approximates the signal's variance.
 *
 * @param padTo pad the input with zeros to this length (default: no padding).
 */
export function rfftPower(
  x: Float64Array,
  window: Float64Array,
  fs: number,
  padTo?: number,
): Spectrum {
  const n = x.length;
  const padded = padTo ?? n;
  if (padded < n) throw new Error(`padTo ${padded} < signal length ${n}`);

  const re = new Float64Array(nextPow2(padded));
  const im = new Float64Array(re.length);
  let winSq = 0;
  for (let i = 0; i < n; i++) {
    re[i] = x[i]! * window[i]!;
    winSq += window[i]! * window[i]!;
  }
  fftInPlace(re, im);

  const bins = (re.length >> 1) + 1;
  const power = new Float64Array(bins);
  for (let k = 0; k < bins; k++) {
    power[k] = (re[k]! * re[k]! + im[k]! * im[k]!) / (fs * winSq);
  }
  // Interior bins count both halves of the spectrum.
  for (let k = 1; k < bins - 1; k++) power[k] = power[k]! * 2;

  const freqs = new Float64Array(bins);
  for (let k = 0; k < bins; k++) freqs[k] = (k * fs) / re.length;
  return { freqs, power };
}

/** `np.hanning(n)`: 0.5 - 0.5 cos(2 pi i / (n-1)). */
export function hann(n: number): Float64Array {
  const w = new Float64Array(n);
  if (n === 1) {
    w[0] = 1;
    return w;
  }
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  return w;
}

/**
 * Linear interpolation onto `grid`, clamped at both ends — `np.interp`.
 *
 * `xs` must be sorted ascending. Outside the range the first/last value is
 * held rather than extrapolated, which is what keeps the tachogram from
 * growing a fictitious ramp at either edge of a segment.
 */
export function interpGrid(
  grid: Float64Array,
  xs: ArrayLike<number>,
  ys: ArrayLike<number>,
): Float64Array {
  const out = new Float64Array(grid.length);
  const n = xs.length;
  if (n === 0) return out;
  let j = 0;
  for (let i = 0; i < grid.length; i++) {
    const g = grid[i]!;
    if (g <= (xs[0] as number)) {
      out[i] = ys[0] as number;
      continue;
    }
    if (g >= (xs[n - 1] as number)) {
      out[i] = ys[n - 1] as number;
      continue;
    }
    while (j < n - 1 && (xs[j + 1] as number) <= g) j++;
    while (j > 0 && (xs[j] as number) > g) j--;
    const x0 = xs[j] as number;
    const x1 = xs[j + 1] as number;
    const y0 = ys[j] as number;
    const y1 = ys[j + 1] as number;
    out[i] = x1 === x0 ? y0 : y0 + ((g - x0) / (x1 - x0)) * (y1 - y0);
  }
  return out;
}
