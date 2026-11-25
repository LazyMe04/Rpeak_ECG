/**
 * Heart-rate variability: time domain, frequency domain, and the rhythm
 * summary the report prints.
 *
 * Published definitions, applied literally:
 *
 *   SDNN    standard deviation of normal-to-normal RR intervals (ddof = 1)
 *   RMSSD   root mean square of successive RR differences
 *   pNN50   fraction of successive differences above 50 ms (pNN20 likewise)
 *   LF/HF   ratio of the 0.04-0.15 Hz to the 0.15-0.40 Hz band power
 *
 * What is deliberately *not* done, and why:
 *
 *  - No artefact correction beyond a physiological gate. Kubios-style
 *    correction interpolates over ectopics; that inflates every statistic
 *    above and makes the number depend on the correction parameters rather
 *    than on the rhythm. Intervals outside 300-2000 ms are dropped and the
 *    count of dropped intervals is reported, so a reader can see how much of
 *    the record was gated away.
 *  - The frequency analysis is a periodogram of the interpolated tachogram,
 *    not a Lomb-Scargle estimate. The tachogram is resampled at 4 Hz, which is
 *    the conventional sampling rate and comfortably above the 0.4 Hz band of
 *    interest; Lomb-Scargle would avoid the resampling but gives a different
 *    normalisation, and the Shaffer/Pentland review of sensible HRV practice
 *    treats either as acceptable as long as it is stated.
 *  - VLF is reported but not interpreted. A 70-minute segment gives ~16 VLF
 *    cycles, which is enough to measure but not enough to trust.
 */

import { hann, interpGrid, rfftPower } from "./dsp";

/** Tachogram resampling rate. 4 Hz is the conventional choice. */
export const HRV_FS = 4.0;

/** Bands in Hz, as published (Task Force 1996; Shaffer & Ginsberg 2017). */
export const HRV_BANDS = {
  vlf: [0.003, 0.04],
  lf: [0.04, 0.15],
  hf: [0.15, 0.4],
} as const;

/** Intervals outside this range are a detection error or a pause, not a beat. */
export const RR_MIN_S = 0.3;
export const RR_MAX_S = 2.0;

export interface BandPower {
  vlf: number;
  lf: number;
  hf: number;
  total: number;
  lfHf: number | null;
  /** Normalised units: LF / (LF + HF) and HF / (LF + HF). */
  lfNu: number | null;
  hfNu: number | null;
}

export interface HrvResult {
  ok: boolean;
  reason?: string;
  nPeaks: number;
  nIntervals: number;
  /** Intervals dropped by the physiological gate. */
  gated: number;
  durationS: number;
  meanRrMs: number;
  minRrMs: number;
  maxRrMs: number;
  sdnnMs: number;
  rmssdMs: number;
  pnn50: number;
  pnn20: number;
  heartRateBpm: number;
  /** Coefficient of variation of RR, a scale-free irregularity measure. */
  rrCv: number;
  /** Fraction of RR intervals differing from their neighbour by > 12.5%. */
  irregularFrac: number;
  freq: BandPower | null;
  freqInfo: { nResampled: number; nFft: number; resolutionHz: number | null } | null;
  /** Resampled RR tachogram in ms, for the plot. Empty when freq is null. */
  tachogram: { t: Float64Array; rr: Float64Array } | null;
  /**
   * The mean-removed tachogram the transform was taken on.
   *
   * Kept separately from `tachogram` because the two answer different
   * questions: the plot wants milliseconds (a negative RR is meaningless), the
   * FFT wants a zero-mean series. `scripts/test-hrv.ts` compares this array
   * against the Python reference's `epochs`, sample by sample.
   */
  epochs: Float64Array | null;
  /**
   * The mean removed from the resampled series before the transform.
   *
   * Not `meanRrMs`: that is the mean of the gated intervals, while this is the
   * mean of the 4 Hz resampling grid, and the two differ by a millisecond or
   * two. Adding the wrong one back shifts the plotted tachogram.
   */
  epochsMeanMs: number;
  /** One-sided PSD of the tachogram, dB. Empty when freq is null. */
  spectrum: { f: Float64Array; p: Float64Array } | null;
}

function bandSum(freqs: Float64Array, power: Float64Array, lo: number, hi: number): number {
  let s = 0;
  for (let i = 0; i < freqs.length; i++) {
    const f = freqs[i]!;
    if (f >= lo && f < hi) s += power[i]!;
  }
  return s;
}

function emptyResult(reason: string): HrvResult {
  return {
    ok: false,
    reason,
    nPeaks: 0,
    nIntervals: 0,
    gated: 0,
    durationS: 0,
    meanRrMs: 0,
    minRrMs: 0,
    maxRrMs: 0,
    sdnnMs: 0,
    rmssdMs: 0,
    pnn50: 0,
    pnn20: 0,
    heartRateBpm: 0,
    rrCv: 0,
    irregularFrac: 0,
    freq: null,
    freqInfo: null,
    tachogram: null,
    epochs: null,
    epochsMeanMs: 0,
    spectrum: null,
  };
}

/**
 * Fresh-trace HRV over a peak list.
 *
 * `peaks` may be detector output or reference annotations; both are sample
 * indices at `fs`. The result is identical for identical input, which is what
 * `scripts/test-hrv.ts` relies on.
 */
export function computeHrv(peaks: ArrayLike<number>, fs = 250): HrvResult {
  const n = peaks.length;
  if (n < 4) return emptyResult("fewer than 4 peaks");

  // Intervals, with the midpoint of each one kept so the gate below cannot
  // shift the tachogram's x axis.
  const rrS = new Float64Array(n - 1);
  const mids = new Float64Array(n - 1);
  for (let i = 0; i < n - 1; i++) {
    const a = peaks[i] as number;
    const b = peaks[i + 1] as number;
    rrS[i] = (b - a) / fs;
    mids[i] = (a + b) / 2 / fs;
  }

  const keep: number[] = [];
  for (let i = 0; i < rrS.length; i++) {
    if (rrS[i]! > RR_MIN_S && rrS[i]! < RR_MAX_S) keep.push(i);
  }
  if (keep.length < 4) return emptyResult("fewer than 4 valid intervals");

  const k = keep.length;
  const rrMs = new Float64Array(k);
  const tMid = new Float64Array(k);
  for (let j = 0; j < k; j++) {
    rrMs[j] = rrS[keep[j]!]! * 1000;
    tMid[j] = mids[keep[j]!]!;
  }

  let sum = 0;
  let minRr = Infinity;
  let maxRr = -Infinity;
  for (const v of rrMs) {
    sum += v;
    if (v < minRr) minRr = v;
    if (v > maxRr) maxRr = v;
  }
  const meanRr = sum / k;

  let varSum = 0;
  for (const v of rrMs) varSum += (v - meanRr) ** 2;
  const sdnn = Math.sqrt(varSum / Math.max(k - 1, 1));

  let sqDiff = 0;
  let over50 = 0;
  let over20 = 0;
  let irregular = 0;
  for (let i = 1; i < k; i++) {
    const d = rrMs[i]! - rrMs[i - 1]!;
    sqDiff += d * d;
    if (Math.abs(d) > 50) over50++;
    if (Math.abs(d) > 20) over20++;
    // > 12.5% change over one beat: the conventional "irregular" threshold.
    if (Math.abs(d) > 0.125 * Math.min(rrMs[i]!, rrMs[i - 1]!)) irregular++;
  }
  const nDiff = Math.max(k - 1, 1);

  const result: HrvResult = {
    ok: true,
    nPeaks: n,
    nIntervals: k,
    gated: n - 1 - k,
    durationS: ((peaks[n - 1] as number) - (peaks[0] as number)) / fs,
    meanRrMs: meanRr,
    minRrMs: minRr,
    maxRrMs: maxRr,
    sdnnMs: sdnn,
    rmssdMs: Math.sqrt(sqDiff / nDiff),
    pnn50: over50 / nDiff,
    pnn20: over20 / nDiff,
    heartRateBpm: 60000 / meanRr,
    rrCv: sdnn / meanRr,
    irregularFrac: irregular / nDiff,
    freq: null,
    freqInfo: null,
    tachogram: null,
    epochs: null,
    epochsMeanMs: 0,
    spectrum: null,
  };

  // ---- frequency domain --------------------------------------------------
  // Needs a long enough stretch to resolve 0.04 Hz: the bin spacing is
  // HRV_FS / n, so 30 s is the absolute floor and a handful of cycles in each
  // band is what makes the numbers meaningful.
  const span = tMid[k - 1]! - tMid[0]!;
  if (k < 20 || span <= 30) return result;

  const nGrid = Math.max(1, Math.ceil(span * HRV_FS));
  const grid = new Float64Array(nGrid);
  for (let i = 0; i < nGrid; i++) grid[i] = tMid[0]! + i / HRV_FS;

  const interp = interpGrid(grid, tMid, rrMs);
  // Keep the millisecond series for the plot; the transform below takes the
  // mean-removed copy. `epochs` is what the parity test compares.
  const tacho = interp.slice();
  let mean = 0;
  for (const v of interp) mean += v;
  mean /= interp.length;
  for (let i = 0; i < interp.length; i++) interp[i] = interp[i]! - mean;

  const win = hann(interp.length);
  const { freqs, power } = rfftPower(interp, win, HRV_FS);

  const vlf = bandSum(freqs, power, HRV_BANDS.vlf[0], HRV_BANDS.vlf[1]);
  const lf = bandSum(freqs, power, HRV_BANDS.lf[0], HRV_BANDS.lf[1]);
  const hf = bandSum(freqs, power, HRV_BANDS.hf[0], HRV_BANDS.hf[1]);
  const total = bandSum(freqs, power, 0.003, 0.4);
  const denom = lf + hf;
  const lfHf = hf > 1e-12 ? lf / hf : null;

  result.freq = {
    vlf,
    lf,
    hf,
    total,
    lfHf,
    lfNu: denom > 1e-12 ? (100 * lf) / denom : null,
    hfNu: denom > 1e-12 ? (100 * hf) / denom : null,
  };
  result.freqInfo = {
    nResampled: interp.length,
    nFft: 2 * (freqs.length - 1),
    resolutionHz: freqs.length > 1 ? freqs[1]! - freqs[0]! : null,
  };
  result.tachogram = { t: grid, rr: tacho };
  result.epochs = interp;
  result.epochsMeanMs = mean;

  // Plot only the band the analysis is about; the periodogram is dominated by
  // VLF power and a full-range dB plot hides LF and HF under it.
  const lo = 0;
  const hi = Math.min(freqs.length, Math.ceil(0.5 / (freqs[1]! - freqs[0]!)));
  const f = freqs.slice(lo, hi);
  const p = new Float64Array(hi - lo);
  for (let i = lo; i < hi; i++) p[i - lo] = 10 * Math.log10(Math.max(power[i]!, 1e-20));
  result.spectrum = { f, p };

  return result;
}
