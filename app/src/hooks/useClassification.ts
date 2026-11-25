import { useEffect, useState } from "react";

import { readDatasetJson } from "../lib/dataset";
import type { CnnDoc } from "../lib/ecg/cnn";
import type { ClassifyReply, ClassifyRequest } from "../lib/ecg/classifyProtocol";
import type { FileReplaySource } from "../lib/signal/fileReplaySource";

export interface ClassificationResult {
  record: string;
  peaks: Int32Array;
  cls: Int8Array;
  prob: Float32Array;
  probs: Float32Array;
  classes: string[];
  ms: number;
}

interface Options {
  enabled: boolean;
  record: string | null;
  source: FileReplaySource | null;
  /** Sorted R peaks; the result arrays line up with this order. */
  peaks: Int32Array | null;
}

interface Result {
  classification: ClassificationResult | null;
  classifying: boolean;
  error: string | null;
  /** Null until the model file has been fetched, or after a fetch failed. */
  model: CnnDoc | null;
  loadingModel: boolean;
}

/**
 * Classifies every beat in the loaded segment with the beat CNN.
 *
 * Two independent concerns, deliberately separate:
 *   * the model file is fetched once per page load and kept, because it is a
 *     static 100 KB artefact that does not change while the app is open;
 *   * classification re-runs whenever the peak set changes, for the same
 *     reason delineation does: annotations arrive first, the detector may
 *     replace them a second later.
 *
 * If the model is missing the hook reports it and does nothing else. The app
 * must work without `data/models/`, which is how it behaves before G5 has been
 * trained and how a fresh clone will behave.
 */
export function useClassification({ enabled, record, source, peaks }: Options): Result {
  const [classification, setClassification] = useState<ClassificationResult | null>(null);
  const [classifying, setClassifying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [model, setModel] = useState<CnnDoc | null>(null);
  const [loadingModel, setLoadingModel] = useState(false);

  useEffect(() => {
    if (!enabled || model) return;
    let cancelled = false;
    setLoadingModel(true);
    setError(null);
    readDatasetJson<CnnDoc>("models/beatcnn.json")
      .then((doc) => {
        if (cancelled) return;
        if (!Array.isArray(doc.blocks) || !Array.isArray(doc.head)) {
          throw new Error("model file is not a beat CNN export");
        }
        setModel(doc);
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          const msg = e instanceof Error ? e.message : String(e);
          setError(`no model at data/models/beatcnn.json — ${msg}`);
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingModel(false);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, model]);

  useEffect(() => {
    if (!enabled || !record || !source || !peaks || peaks.length === 0 || !model) {
      setClassifying(false);
      if (!enabled) setClassification(null);
      return;
    }

    const sig = source.samples;
    if (!sig) return;

    let cancelled = false;
    let worker: Worker;
    try {
      worker = new Worker(new URL("../lib/ecg/classifyWorker.ts", import.meta.url), {
        type: "module",
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setClassifying(false);
      return;
    }

    setClassifying(true);
    setError(null);

    worker.onmessage = (ev: MessageEvent<ClassifyReply>) => {
      if (cancelled) return;
      const msg = ev.data;
      if ("error" in msg) {
        setError(msg.error);
      } else {
        setClassification({
          record: msg.record,
          peaks: msg.peaks,
          cls: msg.cls,
          prob: msg.prob,
          probs: msg.probs,
          classes: model.classes,
          ms: msg.ms,
        });
      }
      setClassifying(false);
      worker.terminate();
    };
    worker.onerror = (ev) => {
      if (cancelled) return;
      setError(ev.message || "the classification worker failed");
      setClassifying(false);
      worker.terminate();
    };

    const sigCopy = sig.slice();
    const peakCopy = peaks.slice();
    worker.postMessage(
      { record, sig: sigCopy, peaks: peakCopy, doc: model } satisfies ClassifyRequest,
      [sigCopy.buffer, peakCopy.buffer],
    );

    return () => {
      cancelled = true;
      worker.terminate();
    };
  }, [enabled, record, source, peaks, model]);

  return { classification, classifying, error, model, loadingModel };
}
