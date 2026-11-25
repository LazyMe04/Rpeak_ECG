/**
 * Detection worker.
 *
 * detect_v4 takes 0.7-2 s on a 1,048,577-sample segment (Node timings; a
 * browser is in the same range). That is a fifth of a second of dropped frames
 * at 60 fps if it ran inline, so it runs here instead and the main thread keeps
 * rendering the trace at full rate.
 *
 * The whole segment arrives as a transferred Float32Array. Peak indices come
 * back as an Int32Array, transferred as well; the sample values are not needed
 * on the main thread.
 */

import { detectV4 } from "./detectV4";
import type { DetectReply, DetectRequest } from "./protocol";

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<DetectRequest>) => void) | null;
  postMessage: (msg: DetectReply, transfer?: Transferable[]) => void;
};

ctx.onmessage = (e) => {
  const { sig, fs } = e.data;
  try {
    const t0 = performance.now();
    const { peaks, cand } = detectV4(sig, { fs });
    ctx.postMessage({ peaks, candCount: cand.length, ms: performance.now() - t0 }, [peaks.buffer]);
  } catch (err) {
    ctx.postMessage({ error: err instanceof Error ? err.message : String(err) });
  }
};
