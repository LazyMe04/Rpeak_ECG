/**
 * Beat-classification worker.
 *
 * The work is small per beat (~0.5 ms) but the count is not: a 70-minute
 * segment has ~7,000 beats, so ~5 s of solid arithmetic. On the main thread
 * that would freeze the trace for five seconds; in a worker it is a panel that
 * says "classifying" and then fills in.
 */

import { classifyBeats } from "./cnn";
import type { ClassifyReply, ClassifyRequest } from "./classifyProtocol";

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<ClassifyRequest>) => void) | null;
  postMessage: (msg: ClassifyReply, transfer?: Transferable[]) => void;
};

ctx.onmessage = (e) => {
  const { record, sig, peaks, doc } = e.data;
  try {
    const t0 = performance.now();
    const { cls, prob, probs } = classifyBeats(doc, sig, peaks);
    ctx.postMessage({ record, peaks, cls, prob, probs, ms: performance.now() - t0 }, [
      peaks.buffer,
      cls.buffer,
      prob.buffer,
      probs.buffer,
    ]);
  } catch (err) {
    ctx.postMessage({ error: err instanceof Error ? err.message : String(err) });
  }
};
