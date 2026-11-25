/**
 * Delineator test: timing error against a synthetic golden, then plausibility
 * on a real segment.
 *
 * Part 1 is the measurement that matters. `data/catalog/g4/synth.json` carries
 * a signal built from five Gaussians per beat, and the boundary truth for that
 * signal measured numerically at the same threshold convention the delineator
 * uses (10% of the steepest QRS slope for the QRS edges, 5% of the wave's own
 * excursion for P and T). So the errors below are implementation errors against
 * a stated definition, not claims of clinical accuracy.
 *
 * Part 2 runs the same code on p00000_s00 with its reference annotations and
 * checks only that the intervals land in physiological ranges. There is no
 * boundary ground truth in icentia11k, so this cannot be scored — it is there
 * to catch a delineator that returns nonsense on a real chest lead while
 * passing the clean synthetic.
 *
 * Usage: npm run test:delineate
 */

import { readFileSync } from "node:fs";

import { delineateSegment, intervals } from "../src/lib/ecg/delineate";

const CAT = "D:/Rpeak-Desktop/data/catalog";
const G4 = `${CAT}/g4`;

function readF32(file: string): Float32Array {
  const buf = readFileSync(file);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return new Float32Array(ab);
}

let failures = 0;
function check(name: string, ok: boolean, detail: string): void {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name.padEnd(34)} ${detail}`);
}

interface Truth {
  r: number;
  p_on: number;
  p_off: number;
  qrs_on: number;
  qrs_off: number;
  t_on: number;
  t_off: number;
  t_peak: number;
}

/** Median, 90th percentile and max of |errors|, plus the signed bias. */
function summarize(errs: number[]) {
  const abs = errs.map(Math.abs).sort((a, b) => a - b);
  const q = (p: number) => abs[Math.min(abs.length - 1, Math.floor(p * abs.length))]!;
  const mean = errs.reduce((a, b) => a + b, 0) / errs.length;
  return { median: q(0.5), p90: q(0.9), max: abs[abs.length - 1]!, bias: mean };
}

const fmt = (v: number) => `${v.toFixed(1).padStart(5)} ms`;

// ---- Part 1: synthetic golden -------------------------------------------
const golden = JSON.parse(readFileSync(`${G4}/synth.json`, "utf8")) as {
  fs: number;
  n: number;
  signal: string;
  beats: Truth[];
};
const fs = golden.fs;
const sig = readF32(`${G4}/${golden.signal}`);
const ms = (samples: number) => (1000 * samples) / fs;

console.log(`\nsynthetic (${golden.beats.length} beats, ${golden.n} samples @ ${fs} Hz)`);

const peaks = golden.beats.map((b) => b.r);
const { beats, rr } = delineateSegment(sig, peaks, fs);
const nulls = beats.filter((b) => b === null).length;
check("every beat delineated", nulls === 0, `${nulls} null of ${beats.length}`);
check(
  "P wave found",
  beats.every((b) => b !== null && !b.pMissing),
  `${beats.filter((b) => b?.pMissing).length} missing`,
);

const fields = [
  ["P onset", "p_on", (b: NonNullable<(typeof beats)[number]>) => b.pOn],
  ["P offset", "p_off", (b: NonNullable<(typeof beats)[number]>) => b.pOff],
  ["QRS onset", "qrs_on", (b: NonNullable<(typeof beats)[number]>) => b.qrsOn],
  ["QRS offset", "qrs_off", (b: NonNullable<(typeof beats)[number]>) => b.qrsOff],
  ["T onset", "t_on", (b: NonNullable<(typeof beats)[number]>) => b.tOn],
  ["T peak", "t_peak", (b: NonNullable<(typeof beats)[number]>) => b.tPeak],
  ["T offset", "t_off", (b: NonNullable<(typeof beats)[number]>) => b.tOff],
] as const;

for (const [label, key, get] of fields) {
  const errs: number[] = [];
  for (let i = 0; i < beats.length; i++) {
    const b = beats[i];
    if (!b) continue;
    const got = get(b);
    if (got === null) continue;
    errs.push(ms(got - (golden.beats[i]![key] as number)));
  }
  const s = summarize(errs);
  check(
    label,
    s.median <= 6 && s.p90 <= 12 && s.max <= 30,
    `median ${fmt(s.median)}  p90 ${fmt(s.p90)}  max ${fmt(s.max)}  bias ${fmt(s.bias)}`,
  );
}

// Ordering is a structural invariant, and a violation is a bug regardless of
// how close each individual boundary is to the truth.
let orderBad = 0;
for (const b of beats) {
  if (!b || b.pOn === null || b.pOff === null) continue;
  const ok =
    b.pOn < b.pPeak! &&
    b.pPeak! < b.pOff &&
    b.pOff <= b.qrsOn &&
    b.qrsOn < b.r &&
    b.r < b.qrsOff &&
    b.qrsOff < b.tOn &&
    b.tOn <= b.tPeak &&
    b.tPeak < b.tOff;
  if (!ok) orderBad++;
}
check("P < QRS < R < QRS < T ordering", orderBad === 0, `${orderBad} violations`);

// The intervals the UI prints, checked against the golden's own truth.
const got = beats.map((b, i) => (b ? intervals(b, fs, rr[i]!) : null));
const truthIntervals = golden.beats.map((t) => ({
  pr: ms(t.qrs_on - t.p_on),
  qrs: ms(t.qrs_off - t.qrs_on),
  qt: ms(t.t_off - t.qrs_on),
}));
const med = (xs: number[]) => summarize(xs).median;
for (const [label, key, gotKey] of [
  ["PR", "pr", "prMs"],
  ["QRS", "qrs", "qrsMs"],
  ["QT", "qt", "qtMs"],
] as const) {
  const errs = truthIntervals.map((t, i) => {
    const g = got[i]?.[gotKey];
    return g === null || g === undefined ? NaN : g - t[key];
  });
  const finite = errs.filter((v) => Number.isFinite(v));
  const s = summarize(finite);
  check(
    `${label} interval error`,
    s.median <= 8 && s.max <= 35,
    `median ${fmt(s.median)}  max ${fmt(s.max)}  bias ${fmt(s.bias)}`,
  );
}

const qtc = got.map((g) => g?.qtcBazettMs ?? NaN).filter((v) => Number.isFinite(v));
check(
  "QTc Bazett computed",
  qtc.length === got.length && qtc.every((v) => v > 100 && v < 800),
  `median ${med(qtc).toFixed(0)} ms over ${qtc.length} beats`,
);

// ---- Part 2: a real segment ---------------------------------------------
const REC = "p00000_s00";
const realSig = readF32(`${CAT}/f32/${REC}.f32`);
const ann = JSON.parse(readFileSync(`${CAT}/segments/${REC}.ann.json`, "utf8")) as {
  fs: number;
  beats: { sample: number; symbol: string }[];
};
const annPeaks = ann.beats.filter((b) => "NSVQ".includes(b.symbol)).map((b) => b.sample);

console.log(`\nreal segment ${REC} (${annPeaks.length} reference beats)`);
const t0 = performance.now();
const real = delineateSegment(realSig, annPeaks, ann.fs);
const elapsed = performance.now() - t0;
const realBeats = real.beats.filter((b) => b !== null);
const realIv = real.beats.map((b, i) => (b ? intervals(b, ann.fs, real.rr[i]!) : null));

const col = (pick: (v: NonNullable<(typeof realIv)[number]>) => number | null) =>
  realIv.map((v) => (v ? pick(v) : null)).filter((v): v is number => v !== null);

const pr = col((v) => v.prMs);
const qrs = col((v) => v.qrsMs);
const qt = col((v) => v.qtMs);
const pMissing = real.beats.filter((b) => b?.pMissing).length;

console.log(
  `  ${realBeats.length} delineated, ${elapsed.toFixed(0)} ms, ` +
    `P missing ${((100 * pMissing) / real.beats.length).toFixed(1)}%`,
);
console.log(
  `  median PR ${med(pr).toFixed(0)} ms, QRS ${med(qrs).toFixed(0)} ms, ` +
    `QT ${med(qt).toFixed(0)} ms`,
);

check(
  "PR in physiological range",
  med(pr) > 100 && med(pr) < 260,
  `median ${med(pr).toFixed(0)} ms`,
);
check(
  "QRS in physiological range",
  med(qrs) > 50 && med(qrs) < 160,
  `median ${med(qrs).toFixed(0)} ms`,
);
check(
  "QT in physiological range",
  med(qt) > 280 && med(qt) < 520,
  `median ${med(qt).toFixed(0)} ms`,
);
check(
  "P wave found on most beats",
  pMissing / real.beats.length < 0.4,
  `${((100 * pMissing) / real.beats.length).toFixed(1)}% missing`,
);

console.log("");
if (failures) {
  console.log(`${failures} check(s) failed`);
  process.exit(1);
}
console.log("delineator matches the synthetic golden and reads the real segment sensibly");
