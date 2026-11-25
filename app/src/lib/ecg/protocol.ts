/**
 * Messages between the main thread and the delineation worker.
 *
 * Separate from the detection protocol because the jobs are separate: detection
 * finds the R peaks, delineation needs them already. Keeping the types apart
 * means the HRV panel can import a peak type without pulling a worker in.
 */

import type { DelinArrays } from "./delineate";

export interface DelineateRequest {
  /** Copy of the segment, transferred. */
  sig: Float32Array;
  /** The R peaks to delineate, transferred. Sorted sample indices. */
  peaks: Int32Array;
  fs: number;
  /** Echoed back so a stale result can be discarded by the caller. */
  record: string;
}

export interface DelineateMedian {
  prMs: number | null;
  qrsMs: number;
  qtMs: number;
  qtcMs: number;
}

export interface DelineateDone {
  record: string;
  /** The same peaks, in the same order, so arrays and beats line up. */
  peaks: Int32Array;
  delin: DelinArrays;
  missingP: number;
  median: DelineateMedian;
  ms: number;
}

export interface DelineateFail {
  error: string;
}

export type DelineateReply = DelineateDone | DelineateFail;
