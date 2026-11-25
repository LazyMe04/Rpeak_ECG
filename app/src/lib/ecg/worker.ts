/**
 * Delineation worker.
 *
 * Delineating a 70-minute segment means filtering 1,048,577 samples and walking
 * ~7,000 beats: ~100 ms in Node, but still a visible stall if it ran inline
 * while the trace is scrolling at 60 fps. Same pattern as the detection worker:
 * one job per worker, then terminate, so the 4 MB signal copy is released.
 */

import { delineateSegment, summarizeDelineation } from "./delineate";
import type { DelineateReply, DelineateRequest } from "./protocol";

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<DelineateRequest>) => void) | null;
  postMessage: (msg: DelineateReply, transfer?: Transferable[]) => void;
};

ctx.onmessage = (e) => {
  const { sig, peaks, fs, record } = e.data;
  try {
    const t0 = performance.now();
    const { beats, rr } = delineateSegment(sig, peaks, fs);
    const { arrays, missingP, median } = summarizeDelineation(beats, rr, fs);
    ctx.postMessage(
      {
        record,
        peaks,
        delin: arrays,
        missingP,
        median,
        ms: performance.now() - t0,
      },
      [...Object.values(arrays).map((a) => a.buffer), peaks.buffer],
    );
  } catch (err) {
    ctx.postMessage({ error: err instanceof Error ? err.message : String(err) });
  }
};
