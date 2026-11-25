/**
 * HRV parity test: TypeScript vs the Python reference.
 *
 * Compares the whole result, not just the headline numbers: every time-domain
 * statistic, the four band powers, the resampled tachogram sample by sample,
 * and the PSD bin by bin. A single sign error in the FFT or an off-by-one in
 * the tachogram resampling changes the band sums by percent, but can leave
 * mean RR and SDNN untouched — so both domains are checked.
 *
 * Usage: npm run test:hrv
 */

import fs from "node:fs";

import { computeHrv } from "../src/lib/ecg/hrv";

const DATA = "D:/Rpeak-Desktop/data/catalog/g4";

interface Freq {
  vlf: number;
  lf: number;
  hf: number;
  total: number;
  lf_hf: number | null;
  lf_nu: number | null;
  hf_nu: number | null;
}
interface HrvRef {
  ok: boolean;
  n_peaks: number;
  n_intervals: number;
  gated: number;
  duration_s: number;
  mean_rr_ms: number;
  min_rr_ms: number;
  max_rr_ms: number;
  sdnn_ms: number;
  rmssd_ms: number;
  pnn50: number;
  pnn20: number;
  heart_rate_bpm: number;
  rr_cv: number;
  irregular_frac: number;
  freq: Freq;
  freq_info: { n_resampled: number; n_fft: number; resolution_hz: number };
}

function readF64(file: string): Float64Array {
  const buf = fs.readFileSync(file);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return new Float64Array(ab);
}

/** Peaks dumped by pipeline/hrv_reference.py as float64 sample indices. */
function readI64(file: string): Int32Array {
  const f = readF64(file);
  const out = new Int32Array(f.length);
  for (let i = 0; i < f.length; i++) out[i] = f[i]!;
  return out;
}

let failures = 0;
function check(name: string, ok: boolean, detail: string): void {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name.padEnd(30)} ${detail}`);
}

function relDiff(a: number, b: number): number {
  return Math.abs(a - b) / Math.max(1e-12, Math.abs(b));
}

function maxRel(a: Float64Array, b: Float64Array): number {
  if (a.length !== b.length) return Infinity;
  let m = 0;
  for (let i = 0; i < a.length; i++) {
    const d = relDiff(a[i]!, b[i]!);
    if (d > m) m = d;
  }
  return m;
}

/**
 * Max |(a - shift) - b| relative to the scale of `b`.
 *
 * Needed for the plotted tachogram, which is the reference's zero-mean series
 * with the mean added back: a per-sample relative error is meaningless on a
 * series that crosses zero, so the whole series' scale is the denominator.
 */
function maxRelShifted(a: Float64Array, b: Float64Array, shift: number): number {
  if (a.length !== b.length) return Infinity;
  let scale = 0;
  for (const v of b) scale = Math.max(scale, Math.abs(v));
  scale = Math.max(scale, 1e-9);
  let m = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i]! - shift - b[i]!) / scale;
    if (d > m) m = d;
  }
  return m;
}

function close(name: string, got: number, want: number, tol: number): void {
  const d = relDiff(got, want);
  check(
    name,
    d < tol,
    `${got.toPrecision(8)} (ref ${want.toPrecision(8)}, rel ${d.toExponential(1)})`,
  );
}

const records = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const list = records.length ? records : ["p00000_s00", "p00010_s01", "p00006_s01"];

for (const rec of list) {
  const ref: { from: { annotations: HrvRef; detector: HrvRef } } = JSON.parse(
    fs.readFileSync(`${DATA}/${rec}.hrv.json`, "utf8"),
  );
  console.log(`\n${rec}`);

  for (const which of ["annotations", "detector"] as const) {
    const r = ref.from[which];
    const suffix = which === "annotations" ? "ann" : "det";
    const peaks = readI64(`${DATA}/${rec}.hrv.${suffix}_peaks.f64`);
    const got = computeHrv(peaks, 250);
    console.log(` ${which}`);

    check(
      "counts",
      got.nIntervals === r.n_intervals && got.gated === r.gated,
      `${got.nIntervals} intervals, ${got.gated} gated (ref ${r.n_intervals}/${r.gated})`,
    );
    close("mean RR", got.meanRrMs, r.mean_rr_ms, 1e-12);
    close("min/max RR", got.minRrMs, r.min_rr_ms, 1e-12);
    close("max RR", got.maxRrMs, r.max_rr_ms, 1e-12);
    close("SDNN", got.sdnnMs, r.sdnn_ms, 1e-12);
    close("RMSSD", got.rmssdMs, r.rmssd_ms, 1e-12);
    close("pNN50", got.pnn50, r.pnn50, 1e-12);
    close("pNN20", got.pnn20, r.pnn20, 1e-12);
    close("heart rate", got.heartRateBpm, r.heart_rate_bpm, 1e-12);
    close("RR CV", got.rrCv, r.rr_cv, 1e-12);
    close("irregular fraction", got.irregularFrac, r.irregular_frac, 1e-12);

    const f = got.freq!;
    check("frequency block present", f !== null, f ? "" : "missing");
    if (!f) continue;
    close("VLF power", f.vlf, r.freq.vlf, 1e-10);
    close("LF power", f.lf, r.freq.lf, 1e-10);
    close("HF power", f.hf, r.freq.hf, 1e-10);
    close("total power", f.total, r.freq.total, 1e-10);
    close("LF/HF", f.lfHf ?? 0, r.freq.lf_hf ?? 0, 1e-10);
    close("LF n.u.", f.lfNu ?? 0, r.freq.lf_nu ?? 0, 1e-10);
    close("HF n.u.", f.hfNu ?? 0, r.freq.hf_nu ?? 0, 1e-10);

    const eRef = readF64(`${DATA}/${rec}.hrv.${suffix}.epochs.f64`);
    const gRef = readF64(`${DATA}/${rec}.hrv.${suffix}.grid.f64`);
    const pRef = readF64(`${DATA}/${rec}.hrv.${suffix}.power.f64`);
    const fRef = readF64(`${DATA}/${rec}.hrv.${suffix}.freqs.f64`);

    const tg = got.tachogram!;
    check("tachogram length", tg.t.length === gRef.length, `${tg.t.length} (ref ${gRef.length})`);
    const gd = maxRel(tg.t, gRef);
    check("tachogram time axis", gd < 1e-12, `max rel ${gd.toExponential(1)}`);
    // `epochs` is the mean-removed series the transform was taken on, which is
    // what the Python reference dumps; the plotted `tachogram` is the same
    // series with the mean added back, so compare both against the reference.
    const ed = maxRel(got.epochs!, eRef);
    check("transform input (epochs)", ed < 1e-9, `max rel ${ed.toExponential(1)}`);
    const td = maxRelShifted(tg.rr, eRef, got.epochsMeanMs);
    check("tachogram in ms", td < 1e-9, `max rel ${td.toExponential(1)}`);

    const sp = got.spectrum!;
    // The plotted spectrum stops at 0.5 Hz; the reference dumps the full PSD,
    // so compare the plotted slice against the reference's matching prefix.
    const fd = maxRel(sp.f, fRef.subarray(0, sp.f.length));
    check(
      "spectrum frequency axis",
      sp.f.length <= fRef.length && fd < 1e-12,
      `max rel ${fd.toExponential(1)}`,
    );
    // The plotted spectrum is dB of the raw PSD; compare it in linear units to
    // avoid a dB floor hiding a relative error.
    const lin = new Float64Array(sp.p.length);
    for (let i = 0; i < sp.p.length; i++) lin[i] = Math.pow(10, sp.p[i]! / 10);
    const pd = maxRel(lin, pRef.subarray(0, lin.length));
    check("spectrum power", pd < 1e-9, `max rel ${pd.toExponential(1)}`);
  }
}

console.log("");
if (failures) {
  console.log(`${failures} check(s) failed`);
  process.exit(1);
}
console.log("all HRV statistics match the Python reference");
