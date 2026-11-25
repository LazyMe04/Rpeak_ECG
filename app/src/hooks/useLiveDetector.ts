import { useEffect, useState } from "react";

import type { DetectReply, DetectRequest } from "../lib/detect/protocol";
import type { FileReplaySource } from "../lib/signal/fileReplaySource";

export interface LiveDetection {
  /** Which segment this result belongs to; guards against stale results. */
  record: string;
  peaks: Int32Array;
  candCount: number;
  ms: number;
}

interface Options {
  enabled: boolean;
  record: string | null;
  fs: number;
  source: FileReplaySource | null;
}

interface Result {
  detection: LiveDetection | null;
  detecting: boolean;
  error: string | null;
}

/**
 * Runs detect_v4 on the loaded segment in a worker.
 *
 * Detection is a whole-segment operation (0.7-2 s), not a streaming one: the
 * detector keeps state across the entire record and its DP is global, so it
 * cannot be fed 1,000-sample frames without changing the result. Running it
 * once per segment in the background gives the same peaks the offline
 * evaluation scores, while the trace keeps drawing at 60 fps.
 *
 * The worker is terminated as soon as it answers, which releases its 4 MB copy
 * of the signal and the detector's internal buffers instead of holding them for
 * the life of the tab.
 */
export function useLiveDetector({ enabled, record, fs, source }: Options): Result {
  const [detection, setDetection] = useState<LiveDetection | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled || !record || !source) {
      setDetecting(false);
      setDetection(null);
      setError(null);
      return;
    }

    const sig = source.samples;
    if (!sig) return;

    let cancelled = false;
    let worker: Worker;
    try {
      worker = new Worker(new URL("../lib/detect/worker.ts", import.meta.url), {
        type: "module",
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setDetecting(false);
      return;
    }

    setDetecting(true);
    setError(null);
    setDetection(null);

    worker.onmessage = (ev: MessageEvent<DetectReply>) => {
      if (cancelled) return;
      const msg = ev.data;
      if ("error" in msg) {
        setError(msg.error);
      } else {
        setDetection({ record, peaks: msg.peaks, candCount: msg.candCount, ms: msg.ms });
      }
      setDetecting(false);
      worker.terminate();
    };
    worker.onerror = (ev) => {
      if (cancelled) return;
      setError(ev.message || "the detection worker failed");
      setDetecting(false);
      worker.terminate();
    };

    // `slice()` copies, because transferring detaches the buffer and the
    // source must stay readable for playback.
    const copy = sig.slice();
    worker.postMessage({ sig: copy, fs } satisfies DetectRequest, [copy.buffer]);

    return () => {
      cancelled = true;
      worker.terminate();
    };
  }, [enabled, record, fs, source]);

  return { detection, detecting, error };
}
