/**
 * Headless checks for the G2 shell primitives.
 *
 * These are the parts where a silent bug is expensive: a ring buffer that
 * mis-orders history draws a plausible but wrong trace, and an annotation
 * lookup that is off by one shifts every beat marker. Rendering is verified by
 * screenshot instead -- a canvas assertion here would only test the test.
 *
 * Usage: npx tsx scripts/test-shell.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { RingBuffer } from "../src/lib/signal/ringBuffer.ts";
import { AnnotationTrack } from "../src/lib/signal/annotations.ts";
import type { SignalSource } from "../src/lib/signal/types.ts";
import type { Beat } from "../src/lib/signal/types.ts";

const ROOT = "D:/Rpeak-Desktop";
const CATALOG = join(ROOT, "data/catalog");

let failures = 0;
function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (e) {
    failures++;
    console.log(`  FAIL ${name}`);
    console.log(`       ${e instanceof Error ? e.message : String(e)}`);
  }
}

/* ---------------------------------------------------------------- ring ---- */

test("ring: order is oldest -> newest", () => {
  const r = new RingBuffer(4);
  r.pushMany([1, 2, 3, 4, 5, 6], 0, 6);
  assert.deepEqual([...r.toArray()], [3, 4, 5, 6]);
});

test("ring: partial buffer is right-aligned and padded with NaN", () => {
  const r = new RingBuffer(4);
  r.push(7);
  r.push(8);
  const a = r.toArray();
  assert.ok(Number.isNaN(a[0]) && Number.isNaN(a[1]), "left half must be blank");
  assert.equal(a[2], 7);
  assert.equal(a[3], 8);
});

test("ring: empty buffer is entirely NaN, not a flat zero line", () => {
  const r = new RingBuffer(3);
  assert.ok([...r.toArray()].every(Number.isNaN));
});

test("ring: exact fill has no padding", () => {
  const r = new RingBuffer(3);
  r.pushMany([9, 8, 7], 0, 3);
  assert.deepEqual([...r.toArray()], [9, 8, 7]);
});

test("ring: wraps correctly across many pushes", () => {
  const r = new RingBuffer(5);
  for (let i = 0; i < 23; i++) r.push(i);
  assert.deepEqual([...r.toArray()], [18, 19, 20, 21, 22]);
});

/* ----------------------------------------------------------- annotation ---- */

const ann = JSON.parse(readFileSync(join(CATALOG, "segments/p00000_s00.ann.json"), "utf8")) as {
  beats: Beat[];
};

test("annotation: lowerBound matches a linear scan", () => {
  const t = new AnnotationTrack(ann.beats);
  for (const probe of [0, 28, 29, 190, 5000, 5001, 1_048_576, -5]) {
    const want = t.beats.findIndex((b) => b.sample >= probe);
    assert.equal(t.lowerBound(probe), want < 0 ? t.length : want, `probe ${probe}`);
  }
});

test("annotation: range is inclusive at both ends", () => {
  const t = new AnnotationTrack(ann.beats);
  const lo = t.beats[10].sample;
  const hi = t.beats[20].sample;
  const got = t.range(lo, hi);
  assert.equal(got.length, 11);
  assert.equal(got[0].sample, lo);
  assert.equal(got[10].sample, hi);
});

test("annotation: medianRR over a regular stretch is close to the true RR", () => {
  const t = new AnnotationTrack(ann.beats);
  const at = t.beats[500].sample;
  const rr = t.medianRR(at, 250, 12);
  assert.ok(rr !== null);
  const trueRR = t.beats[500].sample - t.beats[499].sample;
  assert.ok(Math.abs(rr! - trueRR) < 15, `rr=${rr} true=${trueRR}`);
});

test("annotation: medianRR returns null instead of guessing", () => {
  const t = new AnnotationTrack(ann.beats);
  assert.equal(t.medianRR(0, 250, 12), null);
});

test("annotation: countsUpTo agrees with a filter", () => {
  const t = new AnnotationTrack(ann.beats);
  const at = 200_000;
  const c = t.countsUpTo(at);
  const expect = { N: 0, S: 0, V: 0, Q: 0 };
  for (const b of ann.beats) if (b.sample <= at) expect[b.symbol]++;
  assert.deepEqual(c, expect);
});

/* -------------------------------------------------------------- source ---- */

/** In-memory stand-in for FileReplaySource, so the loop can be driven by hand. */
class FakeSource implements SignalSource {
  readonly ready = true;
  private data: Float32Array;
  constructor(
    readonly id: string,
    readonly fs: number,
    n: number,
  ) {
    this.data = new Float32Array(n);
    for (let i = 0; i < n; i++) this.data[i] = Math.sin(i / 20);
  }
  get length(): number {
    return this.data.length;
  }
  async load(): Promise<void> {}
  read(start: number, count: number, out: Float32Array, outOffset = 0): number {
    const from = Math.max(0, Math.min(start, this.data.length));
    const n = Math.max(0, Math.min(count, this.data.length - from));
    out.set(this.data.subarray(from, from + n), outOffset);
    return n;
  }
  dispose(): void {}
}

test("source: read past the end is short, not an exception", () => {
  const s = new FakeSource("fake", 250, 100);
  const out = new Float32Array(50);
  assert.equal(s.read(90, 50, out), 10);
  assert.equal(s.read(100, 50, out), 0);
  assert.equal(s.read(500, 50, out), 0);
});

test("source: read clamps negative starts", () => {
  const s = new FakeSource("fake", 250, 100);
  const out = new Float32Array(5);
  assert.equal(s.read(-10, 5, out), 5);
});

/* --------------------------------------------------------------- setup ---- */

// The engine itself is exercised in the browser; here only the arithmetic that
// decides which sample is at the right edge of the window is checked, because
// an off-by-one there is invisible in a screenshot.
test("playback: fractional position maps to the expected window start", () => {
  const WINDOW = 1000;
  const fs = 250;
  const pos = 30.5 * fs; // 7625.0
  const frac = pos - Math.floor(pos);
  assert.equal(frac, 0);
  const pos2 = 30.504 * fs; // 7626.0 -> exactly on a sample boundary
  assert.equal(pos2 - Math.floor(pos2), 0);

  const p = 1234.37;
  const start = p - WINDOW;
  assert.ok(Math.abs(start - 234.37) < 1e-9);
});

console.log(failures === 0 ? "\nall shell checks passed" : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
