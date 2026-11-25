/**
 * G5 parity: the TypeScript forward pass against the PyTorch logits that
 * `pipeline/cnn_export.py` wrote alongside the weights.
 *
 * This is the test that makes a hand-written inference path defensible. The two
 * implementations share no code, so agreeing on 8 windows to 1e-4 means the
 * weight layout, the BatchNorm folding, the padding, the pooling truncation and
 * the normalisation all agree. A shape check would not catch any of those.
 *
 * Usage:
 *   npx tsx scripts/test-cnn.ts
 *   npx tsx scripts/test-cnn.ts --model ../data/models/beatcnn.json
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  CLASSES,
  forward,
  logitsForWindow,
  normaliseWindow,
  cutWindow,
  extraFromScale,
  rrFeatures,
  softmax,
  standardiseExtra,
} from "../src/lib/ecg/cnn";
import type { CnnDoc } from "../src/lib/ecg/cnn";
import { MODELS } from "./lib/dataset";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

// The model is trained on the dataset, so it is not in the repository either:
// a fresh clone has no `data/models/beatcnn.json` until `pipeline/` rebuilds
// it. Skipping rather than failing keeps the commit hook usable there; the
// so a missing file prints SKIPPED and exits 0.
const MODEL = arg("--model", resolve(MODELS, "beatcnn.json"));
const TOL = Number(arg("--tol", "2e-4"));

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name.padEnd(42)} ${detail}`);
}

function main() {
  if (!existsSync(MODEL)) {
    console.log(`SKIPPED test:cnn: no model at ${MODEL}`);
    console.log(`        rebuild it with pipeline/, or pass --model.`);
    return;
  }
  console.log(`model ${MODEL}`);
  const doc = JSON.parse(readFileSync(MODEL, "utf8")) as CnnDoc;

  check("version is 2", doc.version === 2, String(doc.version));
  check("window is 250 samples", doc.window === 250, String(doc.window));
  check("four classes in AAMI order", doc.classes.join("") === "NSVQ", doc.classes.join(""));
  // Pinned to the shipped architecture on purpose: a change to the network
  // should force a conscious edit here, not pass because the check derives
  // whatever the file happens to say.
  check("three conv blocks", doc.blocks.length === 3, String(doc.blocks.length));
  check("two dense layers", doc.head.length === 2, String(doc.head.length));
  const kind = doc.extra?.kind ?? "none";
  const extraDim = kind === "rr" ? 3 : kind === "none" ? 0 : 1;
  check(
    "extra input kind is known",
    ["rr", "log_scale", "log_scale_record", "none"].includes(kind),
    kind,
  );

  const w0 = doc.blocks[0]!.conv.w;
  check("block 0 has 1 input channel", w0[0]!.length === 1, String(w0[0]!.length));
  check("block 0 kernel is 5 wide", w0[0]![0]!.length === 5, String(w0[0]![0]!.length));
  check(
    `head input is 32 + ${extraDim}`,
    doc.head[0]!.w[0]!.length === 32 + extraDim,
    String(doc.head[0]!.w[0]!.length),
  );

  const parity = doc.parity ?? [];
  check("parity windows present", parity.length > 0, `${parity.length} windows`);
  if (parity.length === 0) {
    console.log("\nno parity windows in the model file; export with cnn_export.py");
    process.exit(1);
  }

  let worst = 0;
  let worstAt = -1;
  let worstZ = 0;
  let agree = 0;
  for (let i = 0; i < parity.length; i++) {
    const row = parity[i]!;
    const raw = Float32Array.from(row.raw);
    // Build the extras the way the app does, from the document and the raw
    // inputs -- never from a value the exporter already standardised.
    let extra: number | number[] | undefined;
    if (row.rr) {
      // The app's own ratio computation, over the real peak sequence.
      const R = rrFeatures(Float64Array.from(row.rr.peaks), doc.fs);
      const z = standardiseExtra(doc, R.subarray(row.rr.index * 3, row.rr.index * 3 + 3))!;
      for (let c = 0; c < z.length; c++) {
        worstZ = Math.max(worstZ, Math.abs(z[c]! - row.rr.z[c]!));
      }
      extra = z;
    } else if (row.record) {
      const { scale } = normaliseWindow(raw, doc.pre);
      extra = extraFromScale(doc, scale, row.record.center, row.record.std);
    } else if (row.extra !== undefined) {
      const { scale } = normaliseWindow(raw, doc.pre);
      extra = extraFromScale(doc, scale);
    }
    const got = logitsForWindow(doc, raw, extra);
    let d = 0;
    for (let c = 0; c < row.logits.length; c++) d = Math.max(d, Math.abs(got[c]! - row.logits[c]!));
    if (d > worst) {
      worst = d;
      worstAt = i;
    }
    const ref = row.logits.indexOf(Math.max(...row.logits));
    const mine = Array.from(got).indexOf(Math.max(...got));
    if (ref === mine) agree++;
    const p = softmax(got);
    console.log(
      `  w${String(i).padStart(2)} first argmax ${CLASSES[ref]} (${row.logits[ref]!.toFixed(3)}) ` +
        `mine ${CLASSES[mine]} (${got[mine]!.toFixed(3)})  ` +
        `worst |dlogit| ${d.toExponential(2)}  p=${(p[mine]! * 100).toFixed(1)}%` +
        (row.record ? `  ${row.record.name}` : ""),
    );
  }

  check("every window agrees on argmax", agree === parity.length, `${agree}/${parity.length}`);
  check(
    `logits match torch within ${TOL}`,
    worst <= TOL,
    `worst ${worst.toExponential(2)} at w${worstAt}`,
  );
  if (kind === "rr") {
    check(
      "rrFeatures matches the exporter's ratios",
      worstZ <= 1e-5,
      `worst |dz| ${worstZ.toExponential(2)}`,
    );
  }

  // Normalisation is the other half of the contract. Re-deriving it here on a
  // synthetic window catches a change to either side.
  const sig = new Float32Array(1000);
  for (let i = 0; i < sig.length; i++) sig[i] = Math.sin(i / 20) + (i % 7) * 0.01;
  const raw = cutWindow(sig, 500, doc.window, doc.pre);
  check("cut window length", raw.length === doc.window, String(raw.length));
  check("cut window is centred on the peak", raw[doc.pre] === sig[500], String(raw[doc.pre]));
  const norm = normaliseWindow(raw, doc.pre);
  check("normalised window keeps its length", norm.x.length === doc.window, String(norm.x.length));
  check("normalisation reports a positive scale", norm.scale > 0, norm.scale.toExponential(2));
  // The window is centred on the core median and divided by the core's
  // 90th-percentile absolute deviation, so after normalisation that median is
  // 0 and that quantile is 1. Checking the MAD instead would pass for the old
  // (degenerate on quantised baselines) definition.
  const coreVals = Array.from(norm.x.subarray(doc.pre - 50, doc.pre + 100));
  const core = [...coreVals].sort((a, b) => a - b);
  const n = core.length;
  const med = (core[(n - 1) >> 1]! + core[n >> 1]!) / 2;
  check("core median is 0 after normalisation", Math.abs(med) < 1e-4, med.toFixed(6));
  const dev = coreVals.map((v) => Math.abs(v - med)).sort((a, b) => a - b);
  const pos = (n - 1) * 0.9;
  const lo = Math.floor(pos);
  const q90 = dev[lo]! + (dev[Math.min(n - 1, lo + 1)]! - dev[lo]!) * (pos - lo);
  check("core q90 deviation is 1 after normalisation", Math.abs(q90 - 1) < 1e-3, q90.toFixed(6));

  // The regression that motivated this: a flat core used to divide by the
  // 1e-6 floor and hand the network a window with amplitude ~10^5.
  const flat = new Float32Array(doc.window);
  flat.fill(0.2);
  flat[doc.pre] = 0.9;
  const flatNorm = normaliseWindow(flat, doc.pre);
  let flatPeak = 0;
  for (const v of flatNorm.x) flatPeak = Math.max(flatPeak, Math.abs(v));
  check("a near-flat window stays bounded", flatPeak <= 100, flatPeak.toFixed(1));

  // The log(scale) input must actually be wired to the head, not merely
  // accepted and ignored: shifting it by one standard deviation has to move the
  // logits. A dropped column would pass every check above. Both forwards use
  // the same normalised window, so only the extra input differs.
  const w0raw = Float32Array.from(parity[0]!.raw);
  const w0norm = normaliseWindow(w0raw, doc.pre).x;
  if (extraDim) {
    const base = extraDim === 3 ? [0, 0, 0] : 0;
    const shifted = extraDim === 3 ? [1, 1, 1] : 1;
    const atZero = forward(doc, w0norm, base);
    const atOne = forward(doc, w0norm, shifted);
    let moved = 0;
    for (let c = 0; c < atZero.length; c++)
      moved = Math.max(moved, Math.abs(atZero[c]! - atOne[c]!));
    check("the extra inputs reach the logits", moved > 1e-3, moved.toExponential(2));
  }

  // The ratio helper is the part of the rr model that lives only in TypeScript
  // at inference, so its edge rules are pinned: a beat with no neighbours gets
  // the neutral 1.0, and an implausible interval cannot produce a ratio outside
  // [0.3, 3]. The values themselves are checked against the exporter above.
  // Beat i owns entries 3i, 3i+1, 3i+2.
  const steady = [0, 250, 500, 750, 1000, 1250];
  const R = rrFeatures(Float64Array.from(steady), doc.fs);
  check(
    "a steady rhythm scores 1.0/1.0/1.0",
    R[9] === 1 && R[10] === 1 && R[11] === 1,
    `${R[9]!.toFixed(3)}/${R[10]!.toFixed(3)}/${R[11]!.toFixed(3)}`,
  );
  check(
    "the first beat has no previous interval",
    R[0] === 1 && R[2] === 1,
    `${R[0]!.toFixed(3)}/${R[2]!.toFixed(3)}`,
  );
  const jumpy = [0, 250, 500, 560, 810, 1060];
  const J = rrFeatures(Float64Array.from(jumpy), doc.fs);
  check("a premature beat scores below 1", J[9]! < 1, J[9]!.toFixed(3));
  const wild = [0, 250, 500, 30000, 30250];
  const W = rrFeatures(Float64Array.from(wild), doc.fs);
  check("an implausible interval is neutralised", W[9] === 1, W[9]!.toFixed(3));

  const edge = cutWindow(sig, 2, doc.window, doc.pre);
  check(
    "window at the left edge pads with the first sample",
    edge[0] === sig[0],
    `${edge[0]} vs ${sig[0]}`,
  );

  console.log(`\n${failures === 0 ? "PASS" : `${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
