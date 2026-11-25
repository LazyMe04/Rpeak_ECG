/**
 * Messages between the main thread and the beat-classification worker.
 *
 * Same shape as the delineation protocol: one job, one worker, terminate. The
 * model document travels with the first message rather than being imported,
 * so the app can run with no model present (`data/models/` empty) and simply
 * shows the panel's "no model" state instead of failing to load.
 */

import type { CnnDoc } from "./cnn";

export interface ClassifyRequest {
  record: string;
  /** The segment, transferred. */
  sig: Float32Array;
  /** R peaks to classify, transferred. Sorted sample indices. */
  peaks: Int32Array;
  doc: CnnDoc;
}

export interface ClassifyDone {
  record: string;
  /** The same peaks, same order, so the caller can align by index. */
  peaks: Int32Array;
  /** Class index per peak, into `doc.classes` (N, S, V, Q). */
  cls: Int8Array;
  /** Probability of the chosen class per peak. */
  prob: Float32Array;
  /** Row-major n x k probabilities, for the panel's per-beat detail. */
  probs: Float32Array;
  ms: number;
}

export interface ClassifyFail {
  error: string;
}

export type ClassifyReply = ClassifyDone | ClassifyFail;
