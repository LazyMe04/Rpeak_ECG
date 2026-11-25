/**
 * Beat classification: a hand-written forward pass over the weights that
 * `pipeline/cnn_export.py` wrote.
 *
 * Why not ONNX Runtime Web. The project is a readable rebuild; an inference
 * engine is a multi-megabyte third-party bundle with its own WASM loading and
 * its own failure modes, for a network of 7,076 stored parameters. The forward pass
 * below is ~120 lines, has no dependencies, and is verified against PyTorch
 * logits by `scripts/test-cnn.ts` on windows the network did not train on.
 *
 * The window geometry here must match `pipeline/build_beats.py` exactly:
 * 250 samples, 0.4 s before the R sample, centred and scaled by the robust
 * spread of `[-0.2 s, +0.4 s]` around R. The scale that division removes is not
 * discarded — it is standardised and fed to the dense head as an extra input
 * (see `extra` on `CnnDoc`). The shipped model instead feeds the head three
 * timing ratios computed from the surrounding peaks (`rrFeatures`), because a
 * beat's prematurity is invisible inside its own second of signal. Drifting
 * from any of that does not throw; it silently degrades accuracy, which is why
 * the parity test pins the numbers rather than checking shapes.
 */

export const CLASSES = ["N", "S", "V", "Q"] as const;
export type BeatClass = (typeof CLASSES)[number];

export interface ConvBlock {
  conv: { w: number[][][]; b: number[] };
  act: "relu" | null;
  pool: number;
}

export interface DenseLayer {
  w: number[][];
  b: number[];
  act: "relu" | null;
}

export interface CnnDoc {
  version: number;
  window: number;
  fs: number;
  pre: number;
  classes: string[];
  norm: { method: string; core: [number, number]; quantile: number; floor: number };
  /**
   * How to build the head's extra inputs. Present on version 2 models; absent
   * on version 1, whose head has no extra columns.
   *
   *   `rr`               -- the three timing ratios from `rrFeatures`, each
   *                         standardised by `center[i]` and `std[i]`. This is
   *                         the information a 1 s window cannot hold: whether
   *                         the beat arrived early, which is what makes an
   *                         ectopic an ectopic.
   *   `log_scale`        -- z = (log(scale) - center) / std, with the centre and
   *                         spread the training set gave.
   *   `log_scale_record` -- z from the centre and spread of the segment being
   *                         classified, computed in `recordExtra`.
   *
   * `center`/`std` are a scalar for the log(scale) kinds and an array for `rr`;
   * `names` labels the columns.
   */
  extra?: {
    kind: string;
    names?: string[];
    center?: number | number[];
    std?: number | number[];
  } | null;
  blocks: ConvBlock[];
  head: DenseLayer[];
  training?: Record<string, unknown>;
  /**
   * Windows the exporter scored in PyTorch. `raw` is the window before
   * normalisation, so re-running it through `logitsForWindow` checks the whole
   * chain — normalisation, log(scale), weight transfer, pooling — not just the
   * forward pass on an input someone else prepared.
   *
   * For the `rr` model the row also carries 51 peak positions around the beat
   * and the standardised values Python computed, so the test can call the
   * app's own `rrFeatures` on a real peak sequence and compare.
   */
  parity?: ParityRow[];
}

export interface ParityRow {
  raw: number[];
  logits: number[];
  extra?: number;
  record?: { name: string; center: number; std: number };
  rr?: { peaks: number[]; index: number; z: number[] };
}

/**
 * Conv1d ("same" padding, stride 1) → activation → max pool.
 *
 * Weights arrive as nested arrays from JSON and are flattened once by
 * `prepare()`. The inner loop is over the kernel taps, not over the output
 * position, so every tap walks `x` and `y` forward in memory: reading the
 * nested arrays directly cost 4.85 ms per beat, which is 34 s for a segment.
 * This layout is the whole difference; the arithmetic is unchanged.
 */
interface PreparedBlock {
  w: Float32Array; // [cout][cin][k] flattened
  b: Float32Array;
  cin: number;
  cout: number;
  k: number;
  pad: number;
  act: "relu" | null;
  pool: number;
}

interface PreparedModel {
  doc: CnnDoc;
  blocks: PreparedBlock[];
  head: { w: Float32Array; b: Float32Array; cin: number; cout: number; act: "relu" | null }[];
  /** How many extra columns the head takes (0 for a version 1 model). */
  extraDim: number;
}

const prepared = new WeakMap<CnnDoc, PreparedModel>();

/** Flatten the JSON weights once per model, then reuse across every beat. */
export function prepare(doc: CnnDoc): PreparedModel {
  const hit = prepared.get(doc);
  if (hit) return hit;
  const blocks: PreparedBlock[] = doc.blocks.map((b) => {
    const cout = b.conv.w.length;
    const cin = b.conv.w[0]!.length;
    const k = b.conv.w[0]![0]!.length;
    const w = new Float32Array(cout * cin * k);
    let at = 0;
    for (let co = 0; co < cout; co++)
      for (let ci = 0; ci < cin; ci++) for (let t = 0; t < k; t++) w[at++] = b.conv.w[co]![ci]![t]!;
    return {
      w,
      b: Float32Array.from(b.conv.b),
      cin,
      cout,
      k,
      pad: (k - 1) >> 1,
      act: b.act,
      pool: b.pool,
    };
  });
  const head = doc.head.map((l) => ({
    w: (() => {
      const out = new Float32Array(l.w.length * l.w[0]!.length);
      let at = 0;
      for (const row of l.w) for (const v of row) out[at++] = v;
      return out;
    })(),
    b: Float32Array.from(l.b),
    cin: l.w[0]!.length,
    cout: l.w.length,
    act: l.act,
  }));
  const m: PreparedModel = {
    doc,
    blocks,
    head,
    extraDim: extraWidth(doc),
  };
  // The head must be exactly as wide as the pooled features plus the extras it
  // declares. Anything else is a corrupt file, and it should say so here rather
  // than quietly reading the wrong weights.
  const pooled = blocks.length ? blocks[blocks.length - 1]!.cout : 0;
  const cin = head.length ? head[0]!.cin : 0;
  if (cin !== pooled + m.extraDim) {
    throw new Error(`model: head takes ${cin} inputs, expected ${pooled} + ${m.extraDim} extra`);
  }
  prepared.set(doc, m);
  return m;
}

/** Number of extra head columns the document declares. */
function extraWidth(doc: CnnDoc): number {
  const ex = doc.extra;
  if (!ex?.kind || ex.kind === "none") return 0;
  if (ex.kind === "rr") return ex.names?.length ?? (ex.center as number[] | undefined)?.length ?? 3;
  return 1;
}

function block(x: Float32Array, len: number, b: PreparedBlock): { x: Float32Array; len: number } {
  const { w, b: bias, cin, cout, k, pad } = b;
  const outLen = len; // "same" padding, stride 1
  const y = new Float32Array(cout * outLen);

  for (let co = 0; co < cout; co++) {
    const yoff = co * outLen;
    y.fill(bias[co]!, yoff, yoff + outLen);
    for (let ci = 0; ci < cin; ci++) {
      const wbase = (co * cin + ci) * k;
      const xoff = ci * len;
      for (let t = 0; t < k; t++) {
        const wt = w[wbase + t]!;
        if (wt === 0) continue;
        // Output index i reads x[i + t - pad]; clamp the overlap to the valid
        // span so the boundary needs no per-sample branch.
        const lo = Math.max(0, pad - t);
        const hi = Math.min(outLen, len + pad - t);
        for (let i = lo; i < hi; i++) y[yoff + i]! += wt * x[xoff + i + t - pad]!;
      }
    }
  }

  if (b.act === "relu") for (let i = 0; i < y.length; i++) if (y[i] < 0) y[i] = 0;

  if (b.pool <= 1) return { x: y, len: outLen };
  const p = b.pool;
  const pl = Math.floor(outLen / p);
  const z = new Float32Array(cout * pl);
  for (let co = 0; co < cout; co++) {
    for (let i = 0; i < pl; i++) {
      let m = -Infinity;
      for (let t = 0; t < p; t++) {
        const v = y[co * outLen + i * p + t];
        if (v > m) m = v;
      }
      z[co * pl + i] = m;
    }
  }
  return { x: z, len: pl };
}

/**
 * Per-window normalisation, matching `build_beats.normalise()`.
 *
 * Centre on the core median, divide by the core's 90th-percentile absolute
 * deviation, floored at 1% of the window peak. The MAD was the original
 * statistic and is degenerate on this data: the signal is quantised, so a
 * window on a flat baseline has most of its core at exactly the median, the MAD
 * is 0, and the division sends the window to 10^5. Getting this wrong at
 * inference does not throw; it silently feeds the network a window unlike
 * anything it trained on.
 *
 * Also returns the scale it divided by. That number is the amplitude the
 * normalisation throws away, and it is the one cue that says "this stretch is
 * unusable" — so it is what the model's extra head input is built from.
 */
export function normaliseWindow(
  seg: Float32Array,
  pre: number,
): { x: Float32Array; scale: number } {
  const coreStart = Math.max(0, pre - 50);
  const coreEnd = Math.min(seg.length, pre + 100);
  const core = seg.subarray(coreStart, coreEnd);
  const med = median(core);

  const dev = new Float32Array(core.length);
  for (let i = 0; i < core.length; i++) dev[i] = Math.abs(core[i]! - med);
  dev.sort();

  let peak = 0;
  for (let i = 0; i < seg.length; i++) {
    const a = Math.abs(seg[i]!);
    if (a > peak) peak = a;
  }

  let scale = quantileSorted(dev, 0.9);
  scale = Math.max(scale, 0.01 * peak, 1e-6);

  const out = new Float32Array(seg.length);
  for (let i = 0; i < seg.length; i++) out[i] = (seg[i]! - med) / scale;
  return { x: out, scale };
}

function median(a: Float32Array): number {
  const t = Array.from(a).sort((p, q) => p - q);
  return quantileSorted(t, 0.5);
}

/** Linear-interpolated quantile of an ascending array — numpy's default. */
function quantileSorted(sorted: ArrayLike<number>, q: number): number {
  const n = sorted.length;
  if (n === 0) return 0;
  if (n === 1) return sorted[0]!;
  const pos = (n - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.min(n - 1, lo + 1);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

/**
 * Cut one window around `sample`, padding with an edge value at the record
 * boundary — the same rule as `build_beats.cut` in Python.
 */
export function cutWindow(
  sig: Float32Array,
  sample: number,
  win: number,
  pre: number,
): Float32Array {
  const start = sample - pre;
  const out = new Float32Array(win);
  for (let i = 0; i < win; i++) {
    const j = start + i;
    const k = j < 0 ? 0 : j >= sig.length ? sig.length - 1 : j;
    out[i] = sig[k];
  }
  return out;
}

/**
 * Forward pass over an already-normalised input. Returns raw logits.
 *
 * `extra` holds the standardised head inputs — one number for the log(scale)
 * models, an array for the timing-ratio model — and is required exactly when
 * the document declares any; `prepare` has already checked that the head width
 * agrees.
 */
export function forward(
  doc: CnnDoc,
  x: Float32Array,
  extra?: number | ArrayLike<number>,
): Float32Array {
  const m = prepare(doc);
  let cur = x;
  let len = x.length;
  for (const b of m.blocks) {
    const r = block(cur, len, b);
    cur = r.x;
    len = r.len;
  }
  // Global average pool over the length axis.
  const cout = cur.length / len;
  const pooled = new Float32Array(cout + m.extraDim);
  for (let c = 0; c < cout; c++) {
    let s = 0;
    for (let i = 0; i < len; i++) s += cur[c * len + i]!;
    pooled[c] = s / len;
  }
  if (m.extraDim) {
    if (extra === undefined) throw new Error("model: forward() needs its extra inputs");
    if (typeof extra === "number") {
      if (m.extraDim !== 1) throw new Error(`model: head takes ${m.extraDim} extras, got a scalar`);
      pooled[cout] = extra;
    } else {
      if (extra.length !== m.extraDim) {
        throw new Error(`model: head takes ${m.extraDim} extras, got ${extra.length}`);
      }
      for (let i = 0; i < m.extraDim; i++) pooled[cout + i] = extra[i]!;
    }
  }
  let h = pooled;
  for (const layer of m.head) {
    const out = new Float32Array(layer.cout);
    for (let o = 0; o < layer.cout; o++) {
      let s = layer.b[o]!;
      const row = o * layer.cin;
      for (let i = 0; i < layer.cin; i++) s += layer.w[row + i]! * h[i]!;
      out[o] = s;
    }
    if (layer.act === "relu") for (let i = 0; i < out.length; i++) if (out[i]! < 0) out[i] = 0;
    h = out;
  }
  return h;
}

export function softmax(logits: Float32Array): Float32Array {
  let m = -Infinity;
  for (const v of logits) if (v > m) m = v;
  const out = new Float32Array(logits.length);
  let s = 0;
  for (let i = 0; i < logits.length; i++) {
    out[i] = Math.exp(logits[i] - m);
    s += out[i];
  }
  for (let i = 0; i < out.length; i++) out[i] /= s;
  return out;
}

export interface BeatPrediction {
  /** Argmax class index into `doc.classes`. */
  cls: number;
  /** Probability of the argmax class. */
  prob: number;
  probs: Float32Array;
}

/**
 * The whole inference chain for one raw window: normalise, standardise the
 * extras, forward. `classifyBeats` and the parity test both go through here, so
 * there is one definition of "what the network is fed".
 *
 * `extra` is already standardised by the caller, because what the extras are
 * depends on the model: a scalar for log(scale) (`extraFromScale`), an array
 * for the timing ratios (`standardiseExtra` over `rrFeatures`).
 */
export function logitsForWindow(
  doc: CnnDoc,
  raw: Float32Array,
  extra?: number | ArrayLike<number>,
): Float32Array {
  const { x } = normaliseWindow(raw, doc.pre);
  return forward(doc, x, extra);
}

/**
 * The extras for one exported parity row, built the way the app builds them
 * from a live segment. Both the parity test and the model page go through
 * here, so neither can drift from what `classifyBeats` does.
 */
export function parityExtra(doc: CnnDoc, row: ParityRow): number | number[] | undefined {
  if (row.rr) {
    const R = rrFeatures(Float64Array.from(row.rr.peaks), doc.fs);
    return standardiseExtra(doc, R.subarray(row.rr.index * 3, row.rr.index * 3 + 3));
  }
  const raw = Float32Array.from(row.raw);
  if (row.record) {
    const { scale } = normaliseWindow(raw, doc.pre);
    return extraFromScale(doc, scale, row.record.center, row.record.std);
  }
  if (row.extra !== undefined) {
    const { scale } = normaliseWindow(raw, doc.pre);
    return extraFromScale(doc, scale);
  }
  return undefined;
}

/** log(scale) → the standardised scalar the head expects, or undefined. */
export function extraFromScale(
  doc: CnnDoc,
  scale: number,
  center?: number,
  std?: number,
): number | undefined {
  const ex = doc.extra;
  if (!ex?.kind || ex.kind === "none" || ex.kind === "rr") return undefined;
  const c = center ?? (ex.center as number | undefined) ?? 0;
  const s = std ?? (ex.std as number | undefined) ?? 1;
  return (Math.log(scale) - c) / s;
}

/**
 * Standardise raw feature values with the centre and spread stored in the
 * document. Used for the timing ratios, whose columns are already
 * patient-invariant (they are ratios), so one global pair per column is right.
 */
export function standardiseExtra(doc: CnnDoc, values: ArrayLike<number>): number[] | undefined {
  const ex = doc.extra;
  if (!ex?.kind || ex.kind === "none") return undefined;
  const center = asColumns(ex.center, values.length);
  const std = asColumns(ex.std, values.length);
  const out: number[] = [];
  for (let i = 0; i < values.length; i++) out.push((values[i]! - center[i]!) / std[i]!);
  return out;
}

function asColumns(v: number | number[] | undefined, n: number): number[] {
  if (Array.isArray(v)) return v;
  if (typeof v === "number") return new Array(n).fill(v);
  return new Array(n).fill(0);
}

/**
 * Timing ratios per beat, matching `build_beats.rr_ratios` exactly.
 *
 * A 250-sample window holds one second, which at a normal rate contains
 * neither neighbouring R peak — so the window cannot show that a beat arrived
 * early, and that is the defining property of a supraventricular ectopic.
 * These three numbers carry it from the peak positions alone:
 *
 *   pre_ratio   RR(i-1,i) / local median RR   — prematurity
 *   post_ratio  RR(i,i+1) / local median RR   — the pause
 *   sum_ratio   the average of the two        — net timing
 *
 * The median is over 25 beats each side, excluding the intervals that touch
 * beat i, so a run of ectopics cannot drag its own baseline toward itself.
 * Implausible intervals are dropped, the result is clamped to [0.3, 3] and a
 * beat with no usable neighbourhood gets 1.0 ("no evidence"). Every one of
 * those rules is in the Python function; this has to agree or the parity test
 * fails.
 */
export function rrFeatures(peaks: ArrayLike<number>, fs: number): Float32Array {
  const n = peaks.length;
  const minRr = 0.2 * fs;
  const maxRr = 3.0 * fs;
  const half = 25;
  const out = new Float32Array(n * 3);
  const rr = new Float64Array(n).fill(NaN);
  for (let i = 1; i < n; i++) {
    const d = peaks[i]! - peaks[i - 1]!;
    rr[i] = d >= minRr && d <= maxRr ? d : NaN;
  }
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - half);
    const hi = Math.min(n, i + half + 1);
    const near: number[] = [];
    for (let j = lo; j < hi; j++) {
      if (j === i - 1 || j === i || j === i + 1) continue;
      const v = rr[j]!;
      if (Number.isFinite(v)) near.push(v);
    }
    let pre = NaN;
    let post = NaN;
    if (near.length) {
      const med = quantileSorted(
        near.sort((a, b) => a - b),
        0.5,
      );
      if (med > 0) {
        pre = rr[i]! / med;
        if (i + 1 < n) post = rr[i + 1]! / med;
      }
    }
    out[i * 3] = clampRatio(pre);
    out[i * 3 + 1] = clampRatio(post);
    out[i * 3 + 2] =
      Number.isFinite(pre) && Number.isFinite(post) ? clampRatio((pre + post) / 2) : 1.0;
  }
  return out;
}

function clampRatio(v: number): number {
  if (!Number.isFinite(v)) return 1.0;
  return Math.min(3.0, Math.max(0.3, v));
}

/**
 * Centre and spread of log(scale) over one segment's beats, for the
 * per-record transform. A patient's signal quality is what the Q label is
 * relative to, so the cue only means something next to the rest of that
 * patient's beats — a global centre hands the head an absolute amplitude whose
 * between-patient offset it cannot know.
 */
export function recordExtra(scales: Float32Array): { center: number; std: number } {
  const logs = Array.from(scales, (s) => Math.log(s)).sort((a, b) => a - b);
  const center = quantileSorted(logs, 0.5);
  let acc = 0;
  for (const v of logs) acc += (v - center) * (v - center);
  const std = Math.sqrt(acc / Math.max(1, logs.length)) || 1;
  return { center, std };
}

/** Classify every beat. Returns arrays aligned with the input peak order. */
export function classifyBeats(
  doc: CnnDoc,
  sig: Float32Array,
  peaks: Int32Array,
): { cls: Int8Array; prob: Float32Array; probs: Float32Array } {
  const n = peaks.length;
  const k = doc.classes.length;
  const cls = new Int8Array(n);
  const prob = new Float32Array(n);
  const probs = new Float32Array(n * k);

  // Cut and normalise once, keeping each window's scale: the per-record
  // transform needs all of them before any beat can be scored.
  const wins: Float32Array[] = new Array(n);
  const scales = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const r = normaliseWindow(cutWindow(sig, peaks[i], doc.window, doc.pre), doc.pre);
    wins[i] = r.x;
    scales[i] = r.scale;
  }
  const perRecord = doc.extra?.kind === "log_scale_record";
  const stats = perRecord ? recordExtra(scales) : null;
  // The timing ratios come from the whole peak train at once, not from the
  // window, so they are computed once here and indexed per beat.
  const kind = doc.extra?.kind ?? "none";
  const ratios = kind === "rr" ? rrFeatures(peaks, doc.fs) : null;

  for (let i = 0; i < n; i++) {
    let extra: number | number[] | undefined;
    if (ratios) {
      extra = standardiseExtra(doc, ratios.subarray(i * 3, i * 3 + 3));
    } else if (perRecord) {
      extra = extraFromScale(doc, scales[i]!, stats!.center, stats!.std);
    } else {
      extra = extraFromScale(doc, scales[i]!);
    }
    const logits = forward(doc, wins[i]!, extra);
    const p = softmax(logits);
    probs.set(p, i * k);
    let best = 0;
    for (let c = 1; c < k; c++) if (p[c] > p[best]) best = c;
    cls[i] = best;
    prob[i] = p[best];
  }
  return { cls, prob, probs };
}
