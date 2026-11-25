/**
 * Messages between the main thread and the detection worker.
 *
 * Kept in their own module so the app can import the types without pulling the
 * worker module (and therefore the detector) into the main bundle.
 */

export interface DetectRequest {
  /** Copy of the segment. Transferred, so the sender's view is detached. */
  sig: Float32Array;
  fs: number;
}

export interface DetectDone {
  peaks: Int32Array;
  candCount: number;
  ms: number;
}

export interface DetectFail {
  error: string;
}

export type DetectReply = DetectDone | DetectFail;
