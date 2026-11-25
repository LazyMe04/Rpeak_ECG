import type { AnnotationFile, Beat, BeatSymbol } from "./types";

/**
 * Reference beat annotations, held as a sorted sample array.
 *
 * Binary search is the only thing the render loop needs: "which beats fall in
 * the visible window" runs every frame, and a linear scan over ~7,000 beats
 * would be wasteful. The counts and RR queries are used by the stats panel,
 * which updates at ~8 Hz.
 */
export class AnnotationTrack {
  readonly beats: Beat[];
  private readonly samples: Int32Array;
  private readonly symbols: BeatSymbol[];
  /** Prefix counts per symbol, so "beats so far" is O(1). */
  private readonly cumulative: Record<BeatSymbol, Int32Array>;

  constructor(beats: Beat[]) {
    const sorted = [...beats].sort((a, b) => a.sample - b.sample);
    this.beats = sorted;
    this.samples = new Int32Array(sorted.length);
    this.symbols = sorted.map((b) => b.symbol);
    const cum = {
      N: new Int32Array(sorted.length + 1),
      S: new Int32Array(sorted.length + 1),
      V: new Int32Array(sorted.length + 1),
      Q: new Int32Array(sorted.length + 1),
    };
    for (let i = 0; i < sorted.length; i++) {
      cum.N[i + 1] = cum.N[i]! + (sorted[i]!.symbol === "N" ? 1 : 0);
      cum.S[i + 1] = cum.S[i]! + (sorted[i]!.symbol === "S" ? 1 : 0);
      cum.V[i + 1] = cum.V[i]! + (sorted[i]!.symbol === "V" ? 1 : 0);
      cum.Q[i + 1] = cum.Q[i]! + (sorted[i]!.symbol === "Q" ? 1 : 0);
      this.samples[i] = sorted[i]!.sample;
    }
    this.cumulative = cum;
  }

  get length(): number {
    return this.samples.length;
  }

  /** First index whose sample is >= `s`. */
  lowerBound(s: number): number {
    let lo = 0;
    let hi = this.samples.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.samples[mid]! < s) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** Beats with start <= sample <= end. */
  range(start: number, end: number): Beat[] {
    const a = this.lowerBound(start);
    const b = this.lowerBound(end + 1);
    return this.beats.slice(a, b);
  }

  /** Index of the first beat at or after `sample`, or -1. */
  nextIndex(sample: number): number {
    const i = this.lowerBound(sample);
    return i < this.samples.length ? i : -1;
  }

  /** Index of the last beat at or before `sample`, or -1. */
  prevIndex(sample: number): number {
    const i = this.lowerBound(sample + 1) - 1;
    return i >= 0 ? i : -1;
  }

  /**
   * Median RR (in samples) over beats ending at or before `sample`, looking
   * back `windowS` seconds. Returns null when fewer than two beats qualify --
   * the UI shows "--" rather than a fabricated number.
   */
  medianRR(sample: number, fs: number, windowS = 12): number | null {
    const b = this.lowerBound(sample + 1);
    const a = this.lowerBound(sample - windowS * fs);
    if (b - a < 2) return null;
    const rr: number[] = [];
    for (let i = Math.max(a + 1, 1); i < b; i++) {
      rr.push(this.samples[i]! - this.samples[i - 1]!);
    }
    if (rr.length === 0) return null;
    rr.sort((x, y) => x - y);
    const m = rr.length >> 1;
    return rr.length % 2 ? rr[m]! : (rr[m - 1]! + rr[m]!) / 2;
  }

  /** Class counts for every beat at or before `sample`. */
  countsUpTo(sample: number): Record<BeatSymbol, number> {
    const i = this.lowerBound(sample + 1);
    return {
      N: this.cumulative.N[i]!,
      S: this.cumulative.S[i]!,
      V: this.cumulative.V[i]!,
      Q: this.cumulative.Q[i]!,
    };
  }

  symbolAt(i: number): BeatSymbol {
    return this.symbols[i] ?? "N";
  }
}

export function parseAnnotationFile(json: AnnotationFile): AnnotationTrack {
  return new AnnotationTrack(json.beats ?? []);
}

/**
 * A bare peak set: detector output, with no symbols attached.
 *
 * The detector produces positions only, so it cannot be an `AnnotationTrack`.
 * It needs the same two queries the render loop and the vitals panel make --
 * "which peaks are visible" and "what is the local median RR" -- so it gets the
 * same sorted-array treatment rather than a separate ad-hoc loop.
 */
export class PeakTrack {
  private readonly samples: Int32Array;

  constructor(peaks: ArrayLike<number>) {
    this.samples = Int32Array.from(peaks).sort();
  }

  get length(): number {
    return this.samples.length;
  }

  /** First index whose sample is >= `s`. */
  lowerBound(s: number): number {
    let lo = 0;
    let hi = this.samples.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.samples[mid]! < s) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  at(i: number): number {
    return this.samples[i]!;
  }

  /** Number of peaks at or before `sample`. */
  countUpTo(sample: number): number {
    return this.lowerBound(sample + 1);
  }

  /** Median RR in samples over the last `windowS` seconds, or null. */
  medianRR(sample: number, fs: number, windowS = 12): number | null {
    const b = this.lowerBound(sample + 1);
    const a = this.lowerBound(sample - windowS * fs);
    if (b - a < 2) return null;
    const rr: number[] = [];
    for (let i = Math.max(a + 1, 1); i < b; i++) {
      rr.push(this.samples[i]! - this.samples[i - 1]!);
    }
    if (rr.length === 0) return null;
    rr.sort((x, y) => x - y);
    const m = rr.length >> 1;
    return rr.length % 2 ? rr[m]! : (rr[m - 1]! + rr[m]!) / 2;
  }
}
