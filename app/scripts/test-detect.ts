/**
 * Stage-by-stage parity check against the Python reference.
 *
 * The goldens come from pipeline/parity_golden.py, which dumps every
 * intermediate for four records: the 24-bit ADC output, the two detector peak
 * streams, the fused candidates, the morphology/amplitude/slope features, the
 * weak pass, the regularity curve, the reference RR and the final beats.
 *
 * Comparing only Se/PPV would let two compensating bugs cancel out. Here each
 * stage is checked on its own, so a failure names the stage that drifted.
 *
 * Usage: npm run test:detect
 */

import fs from "node:fs";

import { detectV4 } from "../src/lib/detect/detectV4";
import { adcParams, gqrsDetect, toDigital24 } from "../src/lib/detect/gqrs";
import { runTwomax } from "../src/lib/detect/twomax";
import { CATALOG as DATA, requireDataset } from "./lib/dataset";

if (!requireDataset("test:detect")) process.exit(0);

const GOLDEN = `${DATA}/golden`;

interface Meta {
  record: string;
  fs: number;
  prefix: number;
  n: number;
  ref_rr: number;
  adc_gain: number;
  adc_baseline: number;
  arrays: Record<string, number>;
  ref: number[];
}

function readF64(file: string): Float64Array {
  const buf = fs.readFileSync(file);
  // Copy into a fresh ArrayBuffer so the view is guaranteed 8-byte aligned.
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return new Float64Array(ab);
}

function readF32(file: string): Float32Array {
  const buf = fs.readFileSync(file);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return new Float32Array(ab);
}

let failures = 0;

function check(name: string, ok: boolean, detail: string): void {
  const tag = ok ? "ok  " : "FAIL";
  if (!ok) failures++;
  console.log(`  ${tag} ${name.padEnd(26)} ${detail}`);
}

function intDiff(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let bad = 0;
  let first = -1;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (i >= a.length || i >= b.length || a[i] !== b[i]) {
      bad++;
      if (first < 0) first = i;
    }
  }
  return bad === 0 ? 0 : first * 1e6 + bad; // encode first + count for the message
}

function maxDiff(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = Math.min(a.length, b.length);
  let m = a.length === b.length ? 0 : Infinity;
  for (let i = 0; i < n; i++) {
    const d = Math.abs((a[i] as number) - (b[i] as number));
    if (d > m) m = d;
  }
  return m;
}

function maxRelDiff(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = Math.min(a.length, b.length);
  let m = a.length === b.length ? 0 : Infinity;
  for (let i = 0; i < n; i++) {
    const av = a[i] as number;
    const bv = b[i] as number;
    const d = Math.abs(av - bv) / Math.max(1e-12, Math.abs(bv));
    if (d > m) m = d;
  }
  return m;
}

function describeInt(diff: number): string {
  if (diff === 0) return "exact";
  const bad = Math.round(diff % 1e6);
  const first = Math.floor(diff / 1e6);
  return `first mismatch at ${first}, ${bad} differing`;
}

const records = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const list = records.length ? records : ["p00001_s00", "p00006_s01", "p00010_s01", "p00000_s00"];

for (const rec of list) {
  const meta: Meta = JSON.parse(fs.readFileSync(`${GOLDEN}/${rec}.json`, "utf8"));
  const sig = readF32(`${DATA}/f32/${rec}.f32`);

  console.log(`\n${rec}  n=${meta.n}  fs=${meta.fs}`);

  const { gain, baseline } = adcParams(sig);
  check(
    "adc gain/baseline",
    Math.abs(gain - meta.adc_gain) < 1e-6 * Math.abs(meta.adc_gain) &&
      baseline === meta.adc_baseline,
    `gain ${gain.toFixed(3)} (ref ${meta.adc_gain.toFixed(3)}), ` +
      `baseline ${baseline} (ref ${meta.adc_baseline})`,
  );

  const d = toDigital24(sig);
  const dRef = readF64(`${GOLDEN}/${rec}.d_sig.f64`);
  const dDiff = maxDiff(d.subarray(0, dRef.length), dRef);
  check("24-bit digital prefix", dDiff === 0, `max |diff| = ${dDiff}`);

  const tG = performance.now();
  const gq = gqrsDetect(sig, meta.fs);
  const tGq = performance.now() - tG;
  const gqRef = readF64(`${GOLDEN}/${rec}.gqrs_pk.f64`);
  const gqDiff = intDiff(gq, gqRef);
  check(
    "gqrs peaks",
    gqDiff === 0,
    `${describeInt(gqDiff)} (${gq.length} peaks, ${tGq.toFixed(0)} ms)`,
  );

  const tT = performance.now();
  const tm = runTwomax(sig, meta.fs);
  const tTm = performance.now() - tT;
  const tmRef = readF64(`${GOLDEN}/${rec}.twomax_pk.f64`);
  const tmDiff = intDiff(tm, tmRef);
  check(
    "two-max peaks",
    tmDiff === 0,
    `${describeInt(tmDiff)} (${tm.length} peaks, ${tTm.toFixed(0)} ms)`,
  );

  const tD = performance.now();
  const res = detectV4(sig, { fs: meta.fs });
  const tDet = performance.now() - tD;

  const candRef = readF64(`${GOLDEN}/${rec}.cand.f64`);
  const candDiff = intDiff(res.cand, candRef);
  check("fused candidates", candDiff === 0, `${describeInt(candDiff)} (${res.cand.length})`);

  const corrRef = readF64(`${GOLDEN}/${rec}.corr.f64`);
  const mdCorr = maxDiff(res.corr, corrRef);
  const mrCorr = maxRelDiff(res.corr, corrRef);
  check(
    "morphology corr",
    mrCorr < 2e-6,
    `max abs ${mdCorr.toExponential(2)}, max rel ${mrCorr.toExponential(2)}`,
  );

  const ampRef = readF64(`${GOLDEN}/${rec}.amp_z.f64`);
  const slopeRef = readF64(`${GOLDEN}/${rec}.slope_z.f64`);
  const gainRef = readF64(`${GOLDEN}/${rec}.gain.f64`);
  const mdGain = maxDiff(res.gain, gainRef);
  check(
    "amp/slope/gain",
    maxDiff(res.ampZ, ampRef) < 1e-9 && maxDiff(res.slopeZ, slopeRef) < 1e-9,
    `ampZ ${maxDiff(res.ampZ, ampRef).toExponential(2)}, ` +
      `slopeZ ${maxDiff(res.slopeZ, slopeRef).toExponential(2)}, gain ${mdGain.toExponential(2)}`,
  );

  const weakRef = readF64(`${GOLDEN}/${rec}.weak.f64`);
  const weakDiff = intDiff(res.weak, weakRef);
  check("weak pass", weakDiff === 0, describeInt(weakDiff));

  const regRef = readF64(`${GOLDEN}/${rec}.reg.f64`);
  check(
    "regularity curve",
    maxDiff(res.reg, regRef) < 1e-9,
    `max |diff| = ${maxDiff(res.reg, regRef).toExponential(2)}`,
  );

  check(
    "reference RR",
    Math.abs(res.refRr - meta.ref_rr) < 1e-9,
    `${res.refRr.toFixed(6)} (ref ${meta.ref_rr.toFixed(6)})`,
  );

  const outRef = readF64(`${GOLDEN}/${rec}.out.f64`);
  const outDiff = intDiff(res.peaks, outRef);
  check(
    "final peaks",
    outDiff === 0,
    `${describeInt(outDiff)} (${res.peaks.length} peaks, ${tDet.toFixed(0)} ms total)`,
  );
}

console.log("");
if (failures) {
  console.log(`${failures} check(s) failed`);
  process.exit(1);
}
console.log("all stages match the Python reference");
