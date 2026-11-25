import type { SignalSource } from "./types";

/**
 * Replays a segment exported by pipeline/export_f32.py.
 *
 * Each segment is 1,048,577 float32 samples = 4 MB, which fits comfortably in
 * memory on the target laptop and makes seeking instant. Streaming with ranges
 * would save nothing and would make scrubbing latency-bound, so the whole
 * segment is loaded once and wrapped in a Float32Array view.
 *
 * The loader is injected rather than a URL: the browser fetches the file, the
 * packaged app asks Rust for its bytes, and this class does not care which.
 * See `lib/catalog.ts` for both arms.
 */
export class FileReplaySource implements SignalSource {
  private data: Float32Array | null = null;
  private inflight: Promise<void> | null = null;

  constructor(
    readonly id: string,
    private readonly fetchSamples: () => Promise<Float32Array>,
    readonly fs: number,
    readonly length: number,
  ) {}

  get ready(): boolean {
    return this.data !== null;
  }

  /**
   * The loaded samples, or null before `load()` resolves.
   *
   * Exposed read-only for offline work that needs the whole segment, such as
   * handing a copy to the detection worker.
   */
  get samples(): Float32Array | null {
    return this.data;
  }

  async load(): Promise<void> {
    if (this.data) return;
    if (this.inflight) return this.inflight;

    this.inflight = (async () => {
      const view = await this.fetchSamples();
      if (view.length < this.length) {
        throw new Error(`${this.id}: expected ${this.length} samples, got ${view.length}`);
      }
      this.data = view;
    })();

    try {
      await this.inflight;
    } finally {
      this.inflight = null;
    }
  }

  read(start: number, count: number, out: Float32Array, outOffset = 0): number {
    if (!this.data) return 0;
    const from = Math.max(0, Math.min(start, this.length));
    const n = Math.max(0, Math.min(count, this.length - from, out.length - outOffset));
    if (n === 0) return 0;
    out.set(this.data.subarray(from, from + n), outOffset);
    return n;
  }

  dispose(): void {
    this.data = null;
    this.inflight = null;
  }
}
