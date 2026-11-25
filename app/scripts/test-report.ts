/**
 * Report and export test.
 *
 * The exports are the only part of G4 whose output leaves the app, so they get
 * checked against the data rather than eyeballed:
 *
 *   1. Beat rows agree with the peak list and the annotation classes.
 *   2. The JSON report's rate statistics match a direct computation from the
 *      rows, and its interval medians match a direct computation from the
 *      delineation arrays.
 *   3. The CSV parses back to the same rows — every row the same length, the
 *      header in the documented order, and numbers that round-trip to the
 *      precision printed.
 *   4. A sub-span report covers only beats inside the span, which is the whole
 *      point of recording a session rather than reporting the segment.
 *
 * Usage: npm run test:report
 */

import { readFileSync } from "node:fs";

import { delineateSegment, summarizeDelineation } from "../src/lib/ecg/delineate";
import {
  beatsToCsv,
  buildBeatRows,
  buildSessionReport,
  reportFilename,
  type BeatRow,
} from "../src/lib/ecg/report";
import type { AnnotationTrack } from "../src/lib/signal/annotations";
import type { Beat, BeatSymbol } from "../src/lib/signal/types";

const CAT = "D:/Rpeak-Desktop/data/catalog";
const RECORD = "p00000_s00";
const FS = 250;

let failures = 0;
function check(name: string, ok: boolean, detail: string): void {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name.padEnd(36)} ${detail}`);
}

function readF32(file: string): Float32Array {
  const buf = readFileSync(file);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return new Float32Array(ab);
}

/** Minimal AnnotationTrack stand-in: the report only reads `.beats`. */
function makeTrack(beats: Beat[]): AnnotationTrack {
  return { beats } as unknown as AnnotationTrack;
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

// ---- Load ---------------------------------------------------------------
const ann = JSON.parse(readFileSync(`${CAT}/segments/${RECORD}.ann.json`, "utf8")) as {
  beats: Beat[];
};
const track = makeTrack(ann.beats);
const peaks = Int32Array.from(ann.beats.map((b) => b.sample));

// The signal the delineation worker would have received. The app serves the
// same bytes from /data; this is the copy the pipeline wrote.
const sigPath = `${CAT}/f32/${RECORD}.f32`;
let sig: Float32Array;
try {
  sig = readF32(sigPath);
} catch {
  console.log(`  FAIL cannot read ${sigPath}`);
  process.exit(1);
}

const t0 = Date.now();
const { beats, rr } = delineateSegment(sig, peaks, FS);
const { arrays, missingP, median: med } = summarizeDelineation(beats, rr, FS);
const delinMs = Date.now() - t0;
console.log(
  `\n${RECORD}: ${peaks.length} beats, ${sig.length} samples, delineated in ${delinMs} ms\n`,
);
const delin = { peaks, arrays };

// ---- 1. Beat rows -------------------------------------------------------
const whole = { record: RECORD, fs: FS, fromS: 0, toS: sig.length / FS, startedAt: 0, endedAt: 1 };
const rows = buildBeatRows({ span: whole, peaks, track, delin });

check("row count equals peak count", rows.length === peaks.length, `${rows.length}`);
check(
  "rows are in peak order",
  rows.every((r, i) => r.sample === peaks[i]),
  "",
);
check(
  "symbols match the annotations",
  rows.every((r, i) => r.symbol === ann.beats[i]!.symbol),
  "",
);
check(
  "no NaN in the row table",
  rows.every((r) =>
    [r.rrMs, r.qrsMs, r.qtMs, r.qtcMs].every((v) => v === null || Number.isFinite(v)),
  ),
  "",
);
check("first row has no R-R", rows[0]!.rrMs === null, String(rows[0]!.rrMs));

// ---- 2. Report ----------------------------------------------------------
const report = buildSessionReport({
  span: whole,
  peaks,
  peakSource: "annotations",
  track,
  delin,
});

const directRr = rows.map((r) => r.rrMs).filter((v): v is number => v != null);
const directMean = directRr.reduce((a, b) => a + b, 0) / directRr.length;
check(
  "report mean R-R",
  report.rate != null && Math.abs(report.rate.meanRrMs - directMean) < 1e-9,
  `${report.rate?.meanRrMs.toFixed(4)} (direct ${directMean.toFixed(4)})`,
);
check(
  "report heart rate",
  report.rate != null && Math.abs(report.rate.heartRateBpm - 60000 / directMean) < 1e-9,
  `${report.rate?.heartRateBpm.toFixed(4)}`,
);

const directQrs = median(rows.map((r) => r.qrsMs).filter((v): v is number => v != null));
check(
  "report median QRS",
  report.intervals != null && Math.abs(report.intervals.qrsMs! - directQrs!) < 1e-6,
  `${report.intervals?.qrsMs} (direct ${directQrs})`,
);

// The delineation summary and the report must not disagree: both are the same
// statistic over the same beats, computed by different code paths.
check(
  "summary and report agree on QRS",
  Math.abs((med.qrsMs ?? 0) - (report.intervals?.qrsMs ?? 0)) < 1,
  `${med.qrsMs} vs ${report.intervals?.qrsMs}`,
);
check(
  "missing P counted consistently",
  report.intervals != null && report.intervals.missingP === missingP,
  `${report.intervals?.missingP} vs summary ${missingP}`,
);

const byClass = rows.reduce(
  (acc, r) => {
    if (r.symbol) acc[r.symbol]++;
    return acc;
  },
  { N: 0, S: 0, V: 0, Q: 0 } as Record<BeatSymbol, number>,
);
check(
  "class counts match the rows",
  report.beats.byClass != null &&
    (["N", "S", "V", "Q"] as BeatSymbol[]).every((s) => report.beats.byClass![s] === byClass[s]),
  `${JSON.stringify(report.beats.byClass)}`,
);
check(
  "class counts sum to the row count",
  report.beats.byClass != null &&
    (["N", "S", "V", "Q"] as BeatSymbol[]).reduce((a, s) => a + report.beats.byClass![s], 0) ===
      rows.length,
  `${rows.length}`,
);

// ---- 3. CSV round-trip --------------------------------------------------
const csv = beatsToCsv(rows);
const lines = csv.split("\n");
const header = lines[0]!;
check("CSV header", header === "time_s,sample,symbol,rr_ms,pr_ms,qrs_ms,qt_ms,qtc_ms", header);
check("CSV row count", lines.length === rows.length + 1, `${lines.length - 1} data rows`);
const widths = new Set(lines.map((l) => l.split(",").length));
check("CSV column count is uniform", widths.size === 1, `widths ${[...widths].join(", ")}`);

let mismatches = 0;
for (let i = 0; i < rows.length; i++) {
  const cells = lines[i + 1]!.split(",");
  const r = rows[i]!;
  const want: BeatRow = r;
  const num = (v: string | undefined) => (v === "" || v == null ? null : Number(v));
  if (Number(cells[1]) !== want.sample) mismatches++;
  if ((cells[2] || null) !== want.symbol) mismatches++;
  if (Math.abs((num(cells[3]) ?? 0) - (want.rrMs ?? 0)) > 0.051) mismatches++;
  if (Math.abs((num(cells[5]) ?? 0) - (want.qrsMs ?? 0)) > 0.051) mismatches++;
  if (Math.abs((num(cells[6]) ?? 0) - (want.qtMs ?? 0)) > 0.051) mismatches++;
}
check("CSV parses back to the rows", mismatches === 0, `${mismatches} mismatched cells`);

// A PR that was not measured must be empty, not 0 or NaN: a reader plotting
// the column would otherwise see a floor at zero that is not a measurement.
const unmeasuredPr = rows.filter((r) => r.prMs == null).length;
const emptyPrCells = lines.slice(1).filter((l) => l.split(",")[4] === "").length;
check(
  "unmeasured PR is an empty cell",
  unmeasuredPr === emptyPrCells,
  `${emptyPrCells} empty of ${unmeasuredPr} unmeasured`,
);
check("no literal NaN in the CSV", !csv.includes("NaN") && !csv.includes("undefined"), "");

// ---- 4. Sub-span --------------------------------------------------------
const sub = { ...whole, fromS: 600, toS: 900 };
const subRows = buildBeatRows({ span: sub, peaks, track, delin });
const subReport = buildSessionReport({
  span: sub,
  peaks,
  peakSource: "annotations",
  track,
  delin,
});
check(
  "sub-span rows fall inside the span",
  subRows.every((r) => r.sample >= 600 * FS && r.sample <= 900 * FS),
  `${subRows.length} rows`,
);
check(
  "sub-span is shorter than the whole",
  subRows.length > 0 && subRows.length < rows.length,
  `${subRows.length} of ${rows.length}`,
);
check(
  "sub-span duration",
  Math.abs(subReport.span.durationS - 300) < 1e-9,
  `${subReport.span.durationS}`,
);
const subMean = (() => {
  const v = subRows.map((r) => r.rrMs).filter((x): x is number => x != null);
  return v.reduce((a, b) => a + b, 0) / v.length;
})();
check(
  "sub-span mean R-R is over its own beats",
  Math.abs(subReport.rate!.meanRrMs - subMean) < 1e-9,
  `${subReport.rate!.meanRrMs.toFixed(4)}`,
);

// ---- 5. Filenames -------------------------------------------------------
check(
  "filename is filesystem-safe",
  // eslint-disable-next-line no-control-regex
  !/[<>:"/\\|?*\u0000-\u001f]/.test(reportFilename(report, "csv")),
  reportFilename(report, "csv"),
);

console.log("");
if (failures > 0) {
  console.log(`${failures} check(s) failed`);
  process.exit(1);
}
console.log("session report and exports match the data they describe");
