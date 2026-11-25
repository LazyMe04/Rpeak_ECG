/**
 * Offline evaluation of the TypeScript detector against icentia11k
 * annotations, plus a parity check against the Python reference.
 *
 * The metric is `score_weighted` (see src/lib/detect/score.ts): a per-beat
 * tolerance derived from the local RR interval, matched one-to-one. It is NOT
 * the fixed 50 ms window used by the previous milestone's evaluator, so the
 * numbers here are lower and correct.
 *
 * Parity is checked on the raw tp/fp/fn counts of every segment, not on the
 * rounded percentages. The reference is produced with the same deterministic
 * k-means initialisation the port uses:
 *
 *   python -I pipeline/detect_v4.py --all --kmeans-init even \
 *          --json data/catalog/detect_v4_even.json
 *
 * Usage:
 *   npm run eval
 *   npm run eval -- --limit 4
 *   npm run eval -- --record p00010_s01
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import { detectV4 } from "../src/lib/detect/detectV4";
import { scoreWeighted } from "../src/lib/detect/score";
import { CATALOG } from "./lib/dataset";

const F32 = join(CATALOG, "f32");
const SEG = join(CATALOG, "segments");

interface SegMeta {
  record: string;
  patient: number;
  segment: number;
  fs: number;
  n_samples: number;
  duration_s: number;
  quality: string;
}
interface AnnFile {
  record: string;
  fs: number;
  beats: { sample: number; symbol: string }[];
}
interface F32Index {
  record: string;
  fs: number;
  n: number;
  file: string;
}
interface RefRow {
  record: string;
  n_ref: number;
  n_det: number;
  tp: number;
  fp: number;
  fn: number;
  se: number;
  ppv: number;
  f1: number;
}

function readF32(file: string): Float32Array {
  const buf = readFileSync(file);
  // Copy into a fresh ArrayBuffer: Node's Buffer can sit at a byte offset that
  // is not 4-byte aligned, which a Float32Array view would reject.
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return new Float32Array(ab);
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
}

function main() {
  const args = process.argv.slice(2);
  const limitIdx = args.indexOf("--limit");
  const limit = limitIdx >= 0 ? Number(args[limitIdx + 1]) : Infinity;
  const recIdx = args.indexOf("--record");
  const onlyRecord = recIdx >= 0 ? args[recIdx + 1] : null;
  const refIdx = args.indexOf("--reference");
  const refPath = refIdx >= 0 ? args[refIdx + 1] : join(CATALOG, "detect_v4_even.json");

  const reference = new Map<string, RefRow>();
  if (existsSync(refPath)) {
    for (const r of JSON.parse(readFileSync(refPath, "utf8")) as RefRow[]) {
      reference.set(r.record, r);
    }
  } else {
    console.log(`(no reference at ${refPath}; parity column will be empty)`);
  }

  const index: F32Index[] = JSON.parse(readFileSync(join(F32, "index.json"), "utf8"));
  // Score only segments that have ground truth. `data/catalog/f32` also holds
  // the G5 training records, which were downloaded for the classifier and have
  // no exported annotations or metadata; including them would crash on the
  // first read rather than report anything.
  const withTruth = index.filter(
    (s) =>
      existsSync(join(F32, s.file)) &&
      existsSync(join(SEG, `${s.record}.meta.json`)) &&
      existsSync(join(SEG, `${s.record}.ann.json`)),
  );
  const skipped = index.length - withTruth.length;
  if (skipped > 0) {
    console.log(`${skipped} of ${index.length} f32 files have no annotations; skipped`);
  }

  const segs = withTruth.filter((s) => !onlyRecord || s.record === onlyRecord).slice(0, limit);

  console.log("record          ref    det      Se     PPV      F1   vs Python");
  console.log("-".repeat(70));

  const rows: (RefRow & { patient: number; quality: string; tMs: number })[] = [];
  let paritySegments = 0;
  let parityMismatch = 0;

  for (const s of segs) {
    const meta: SegMeta = JSON.parse(readFileSync(join(SEG, `${s.record}.meta.json`), "utf8"));
    const ann: AnnFile = JSON.parse(readFileSync(join(SEG, `${s.record}.ann.json`), "utf8"));
    const sig = readF32(join(F32, s.file));
    const ref = ann.beats
      .filter((b) => "NSVQ".includes(b.symbol))
      .map((b) => b.sample)
      .sort((a, b) => a - b);

    const t0 = performance.now();
    const { peaks } = detectV4(sig, { fs: s.fs });
    const tMs = performance.now() - t0;

    const sc = scoreWeighted(ref, peaks, s.fs);
    rows.push({
      record: s.record,
      n_ref: ref.length,
      n_det: peaks.length,
      ...sc,
      patient: meta.patient,
      quality: meta.quality,
      tMs,
    });

    let parity = "—";
    const refRow = reference.get(s.record);
    if (refRow) {
      paritySegments++;
      const same =
        refRow.tp === sc.tp &&
        refRow.fp === sc.fp &&
        refRow.fn === sc.fn &&
        refRow.n_det === peaks.length;
      if (same) parity = "exact";
      else {
        parityMismatch++;
        parity =
          `tp ${sc.tp - refRow.tp >= 0 ? "+" : ""}${sc.tp - refRow.tp} ` +
          `fp ${sc.fp - refRow.fp >= 0 ? "+" : ""}${sc.fp - refRow.fp} ` +
          `fn ${sc.fn - refRow.fn >= 0 ? "+" : ""}${sc.fn - refRow.fn}`;
      }
    }

    const flag = sc.f1 < 95 ? "  <-- check" : "";
    console.log(
      `${s.record.padEnd(14)} ${String(ref.length).padStart(6)} ` +
        `${String(peaks.length).padStart(6)} ${sc.se.toFixed(2).padStart(7)} ` +
        `${sc.ppv.toFixed(2).padStart(7)} ${sc.f1.toFixed(2).padStart(7)}   ${parity}${flag}`,
    );
  }

  // Per-patient aggregation: pool raw counts, not averages of percentages.
  const byPatient = new Map<number, { tp: number; fp: number; fn: number }>();
  for (const r of rows) {
    const cur = byPatient.get(r.patient) ?? { tp: 0, fp: 0, fn: 0 };
    cur.tp += r.tp;
    cur.fp += r.fp;
    cur.fn += r.fn;
    byPatient.set(r.patient, cur);
  }
  console.log("\n=== per patient (pooled) ===");
  const patientRows: { patient: number; se: number; ppv: number; f1: number }[] = [];
  for (const [pid, v] of [...byPatient.entries()].sort((a, b) => a[0] - b[0])) {
    const se = (100 * v.tp) / Math.max(v.tp + v.fn, 1);
    const ppv = (100 * v.tp) / Math.max(v.tp + v.fp, 1);
    const f1 = se + ppv > 0 ? (2 * se * ppv) / (se + ppv) : 0;
    patientRows.push({ patient: pid, se, ppv, f1 });
    console.log(
      `p${String(pid).padStart(5, "0")}   Se=${se.toFixed(2).padStart(6)}  ` +
        `PPV=${ppv.toFixed(2).padStart(6)}  F1=${f1.toFixed(2).padStart(6)}`,
    );
  }

  const tot = rows.reduce((a, r) => ({ tp: a.tp + r.tp, fp: a.fp + r.fp, fn: a.fn + r.fn }), {
    tp: 0,
    fp: 0,
    fn: 0,
  });
  const se = (100 * tot.tp) / Math.max(tot.tp + tot.fn, 1);
  const ppv = (100 * tot.tp) / Math.max(tot.tp + tot.fp, 1);
  const f1 = (2 * se * ppv) / Math.max(se + ppv, 1e-9);
  const ses = rows.map((r) => r.se);
  const ppvs = rows.map((r) => r.ppv);

  console.log("\n=== overall ===");
  console.log(`segments        : ${rows.length}`);
  console.log(`beats (ref)     : ${tot.tp + tot.fn}`);
  console.log(`micro  Se       : ${se.toFixed(2)}%`);
  console.log(`micro  PPV      : ${ppv.toFixed(2)}%`);
  console.log(`micro  F1       : ${f1.toFixed(2)}%`);
  console.log(`median Se       : ${median(ses).toFixed(2)}%`);
  console.log(`worst segment Se: ${Math.min(...ses).toFixed(2)}%`);
  console.log(`median PPV      : ${median(ppvs).toFixed(2)}%`);
  console.log(`worst segment PPV: ${Math.min(...ppvs).toFixed(2)}%`);
  console.log(`segments <95 Se : ${ses.filter((s) => s < 95).length}/${ses.length}`);
  console.log(`segments <95 PPV: ${ppvs.filter((p) => p < 95).length}/${ppvs.length}`);
  console.log(
    `parity vs Python: ${paritySegments - parityMismatch}/${paritySegments} segments ` +
      `with identical tp/fp/fn`,
  );
  console.log(`mean time       : ${median(rows.map((r) => r.tMs)).toFixed(0)} ms/segment`);

  // A partial run must not overwrite the full-run report.
  const full = !onlyRecord && limit === Infinity;
  const out = join(CATALOG, full ? "eval_result.json" : "eval_result.partial.json");
  writeFileSync(
    out,
    JSON.stringify(
      {
        generated: new Date().toISOString(),
        detector: "detect_v4 (TypeScript port)",
        match_rule: "score_weighted: clip(0.5*rr, 50ms, 150ms), one-to-one",
        parity: {
          reference: refPath,
          segments: paritySegments,
          exact: paritySegments - parityMismatch,
        },
        overall: { se, ppv, f1, segments: rows.length },
        segments: rows,
        patients: patientRows,
      },
      null,
      1,
    ),
  );
  console.log(`\nwrote ${out}`);

  if (parityMismatch > 0) process.exit(1);
}

main();
