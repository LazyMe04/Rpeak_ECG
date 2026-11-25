/**
 * Stage-by-stage comparison helper: dumps the TypeScript preprocessing stages
 * so they can be diffed against the Python reference.
 *
 * Usage: npx tsx scripts/debugStages.ts p00000_s00 20000
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { PanTompkinsDetector } from "../src/lib/panTompkins.ts";
import { makeQrsFilter } from "../src/lib/filters.ts";
import { CATALOG, REPO_ROOT } from "./lib/dataset";

const F32 = join(CATALOG, "f32");
// ROOT is still needed for the debug dump below, which sits beside the app.
const ROOT = REPO_ROOT;

const record = process.argv[2] ?? "p00000_s00";
const n = Number(process.argv[3] ?? 20000);

const buf = readFileSync(join(F32, `${record}.f32`));
const sig = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
const sub = sig.subarray(0, n);

const fs = 250;
const win = Math.round(0.15 * fs);

// Replicate the detector's stages exactly, using the shared coefficients.
const qrs = makeQrsFilter();
const band = new Float64Array(n);
const deriv = new Float64Array(n);
const sq = new Float64Array(n);
const integ = new Float64Array(n);

let x1 = 0,
  x2 = 0,
  x3 = 0,
  x4 = 0;
let sum = 0;
const ring = new Float64Array(win);
let pos = 0;

for (let i = 0; i < n; i++) {
  const x = qrs.process(sub[i] as number);
  band[i] = x;

  const d = (2 * x + x1 - x3 - 2 * x4) / 8;
  x4 = x3;
  x3 = x2;
  x2 = x1;
  x1 = x;
  deriv[i] = d;
  sq[i] = d * d;

  sum += sq[i] - ring[pos];
  ring[pos] = sq[i];
  pos = (pos + 1) % win;
  integ[i] = sum / win;
}

const det = new PanTompkinsDetector({ fs });
const peaks = det.push(sub);

writeFileSync(
  join(ROOT, "data/catalog/debug_ts.json"),
  JSON.stringify({
    record,
    n,
    band: Array.from(band.slice(0, 3000)),
    deriv: Array.from(deriv.slice(0, 3000)),
    integ: Array.from(integ.slice(0, 3000)),
    peaks: peaks.map((p) => p.index),
    levels: det.levels,
    integStats: {
      min: Math.min(...integ),
      max: Math.max(...integ),
      mean: integ.reduce((a, b) => a + b, 0) / n,
    },
  }),
);
console.log(`wrote debug_ts.json  peaks=${peaks.length}  levels=${JSON.stringify(det.levels)}`);
console.log(
  `integ  min=${Math.min(...integ).toExponential(3)} max=${Math.max(...integ).toExponential(3)}`,
);
