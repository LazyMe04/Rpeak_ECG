/**
 * The one interface the rest of the app knows about signal.
 *
 * A source is a random-access window onto a single-lead ECG stream. The replay
 * source loads a whole segment from disk; a future Bluetooth source will wrap
 * the same interface around a growing buffer. Playback, filtering, rendering
 * and annotation all work against this, so swapping one for the other does not
 * touch the UI.
 */

export type BeatSymbol = "N" | "S" | "V" | "Q";

export interface Beat {
  /** Sample index within the segment (0-based, at `fs`). */
  sample: number;
  symbol: BeatSymbol;
}

export interface SignalSource {
  readonly id: string;
  readonly fs: number;
  /** Total number of samples, or Infinity for a live stream. */
  readonly length: number;
  readonly ready: boolean;
  /** Fetch/open the underlying data. Idempotent. */
  load(): Promise<void>;
  /**
   * Copy samples [start, start + count) into `out` at `outOffset`.
   * Returns how many samples were actually copied (may be short at the end).
   */
  read(start: number, count: number, out: Float32Array, outOffset?: number): number;
  dispose(): void;
}

export interface DetectorScore {
  se: number;
  ppv: number;
  f1: number;
  tp: number;
  fp: number;
  fn: number;
}

/** One row of data/catalog/segments.json. */
export interface SegmentInfo {
  record: string;
  patient: number;
  segment: number;
  fs: number;
  nSamples: number;
  durationS: number;
  nBeats: number;
  counts: Record<BeatSymbol, number>;
  hrMean: number | null;
  hrMin: number | null;
  hrMax: number | null;
  quality: string;
  annPath: string;
  detector: DetectorScore | null;
}

export interface AnnotationFile {
  record: string;
  fs: number;
  beats: Beat[];
  rhythms?: unknown;
}
