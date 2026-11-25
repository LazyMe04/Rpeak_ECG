import { useEffect, useState } from "react";

import type { DelineateMedian, DelineateReply, DelineateRequest } from "../lib/ecg/protocol";
import type { DelinArrays } from "../lib/ecg/delineate";
import type { FileReplaySource } from "../lib/signal/fileReplaySource";

export interface DelineationResult {
  record: string;
  peaks: Int32Array;
  delin: DelinArrays;
  missingP: number;
  median: DelineateMedian;
  ms: number;
}

interface Options {
  enabled: boolean;
  record: string | null;
  fs: number;
  source: FileReplaySource | null;
  /** Sorted R peaks. The arrays in the result are aligned with this order. */
  peaks: Int32Array | null;
}

interface Result {
  delineation: DelineationResult | null;
  delineating: boolean;
  error: string | null;
}

/**
 * Runs PQRST delineation over the loaded segment in a worker.
 *
 * Re-runs whenever the peak set changes, which happens once per segment: the
 * reference annotations arrive first and the detector result, if enabled,
 * replaces them a second later. Both passes are cheap enough that waiting for
 * the detector instead would only make the overlay appear later.
 */
export function useDelineation({ enabled, record, fs, source, peaks }: Options): Result {
  const [delineation, setDelineation] = useState<DelineationResult | null>(null);
  const [delineating, setDelineating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled || !record || !source || !peaks || peaks.length === 0) {
      setDelineating(false);
      setDelineation(null);
      setError(null);
      return;
    }

    const sig = source.samples;
    if (!sig) return;

    let cancelled = false;
    let worker: Worker;
    try {
      worker = new Worker(new URL("../lib/ecg/worker.ts", import.meta.url), {
        type: "module",
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setDelineating(false);
      return;
    }

    setDelineating(true);
    setError(null);
    setDelineation(null);

    worker.onmessage = (ev: MessageEvent<DelineateReply>) => {
      if (cancelled) return;
      const msg = ev.data;
      if ("error" in msg) {
        setError(msg.error);
      } else {
        setDelineation({
          record: msg.record,
          peaks: msg.peaks,
          delin: msg.delin,
          missingP: msg.missingP,
          median: msg.median,
          ms: msg.ms,
        });
      }
      setDelineating(false);
      worker.terminate();
    };
    worker.onerror = (ev) => {
      if (cancelled) return;
      setError(ev.message || "the delineation worker failed");
      setDelineating(false);
      worker.terminate();
    };

    // Copies, because transferring detaches the buffers: the source must stay
    // readable for playback and the caller's peak array must stay usable.
    const sigCopy = sig.slice();
    const peakCopy = peaks.slice();
    worker.postMessage({ sig: sigCopy, peaks: peakCopy, fs, record } satisfies DelineateRequest, [
      sigCopy.buffer,
      peakCopy.buffer,
    ]);

    return () => {
      cancelled = true;
      worker.terminate();
    };
  }, [enabled, record, fs, source, peaks]);

  return { delineation, delineating, error };
}
