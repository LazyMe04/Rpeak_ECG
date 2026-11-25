import type { AnnotationFile, SegmentInfo } from "./signal/types";
import { AnnotationTrack, parseAnnotationFile } from "./signal/annotations";
import { readDataset, readDatasetJson } from "./dataset";
import { describeSource } from "./source";

/**
 * The catalogue: which segments exist, their annotations, and their samples.
 *
 * All three come through `dataset.ts`, so the same code reads from Vite
 * middleware in the browser and from the packaged app's IPC command. Nothing
 * here knows which host it is running on.
 */

/**
 * Turn a low-level failure into something a user can act on.
 *
 * In the packaged app the interesting fact is usually *where the app looked*,
 * which the URL cannot express; in the browser the HTTP status says it all.
 * The path comes from `source.ts`, so it names the folder currently in force —
 * including when that is one the user chose — rather than a guess.
 */
async function withLocation(e: unknown): Promise<Error> {
  const src = await describeSource();
  const base = e instanceof Error ? e.message : String(e);
  return new Error(src ? `${base} (dataset folder: ${src.path})` : base);
}

export async function loadSegments(): Promise<SegmentInfo[]> {
  try {
    return await readDatasetJson<SegmentInfo[]>("catalog/segments.json");
  } catch (e) {
    throw await withLocation(e);
  }
}

/**
 * pipeline/export_f32.py names each file after the record, so the path is
 * derivable and no extra index request is needed.
 */
export function signalPath(record: string): string {
  return `catalog/f32/${record}.f32`;
}

/**
 * The raw little-endian float32 samples of one segment.
 *
 * 1,048,577 samples = 4 MB, which fits in memory on the target laptop and makes
 * seeking instant. Range requests would save nothing and would make scrubbing
 * latency-bound.
 */
export async function loadSignal(record: string): Promise<Float32Array> {
  let bytes: Uint8Array;
  try {
    bytes = await readDataset(signalPath(record));
  } catch (e) {
    throw await withLocation(e);
  }
  if (bytes.byteLength % 4 !== 0) {
    throw new Error(`${record}: ${bytes.byteLength} bytes is not a float32 array`);
  }
  // `readDataset` may hand back a view into a larger buffer (an IPC payload),
  // so slice to the exact range before reinterpreting it as float32.
  const exact =
    bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
      ? bytes.buffer
      : bytes.slice().buffer;
  return new Float32Array(exact as ArrayBuffer);
}

export async function loadAnnotations(seg: SegmentInfo): Promise<AnnotationTrack> {
  try {
    return parseAnnotationFile(await readDatasetJson<AnnotationFile>(seg.annPath));
  } catch (e) {
    throw await withLocation(e);
  }
}
