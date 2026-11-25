/**
 * Fixed-size ring buffer of display samples.
 *
 * The ECG view is a scrolling window: the newest sample is always at the right
 * edge and history falls off the left. A ring buffer gives that for free with
 * zero allocation per sample, which matters because the playback loop pushes
 * one sample per tick at up to 60x real time.
 */
export class RingBuffer {
  readonly capacity: number;
  private data: Float32Array;
  private head = 0; // next write position
  private size = 0;

  constructor(capacity = 1000) {
    if (capacity <= 0) throw new Error("capacity must be positive");
    this.capacity = capacity;
    this.data = new Float32Array(capacity);
  }

  get length(): number {
    return this.size;
  }

  clear(): void {
    this.data.fill(0);
    this.head = 0;
    this.size = 0;
  }

  push(v: number): void {
    this.data[this.head] = v;
    this.head = (this.head + 1) % this.capacity;
    if (this.size < this.capacity) this.size++;
  }

  pushMany(src: ArrayLike<number>, offset = 0, count = src.length - offset): void {
    const n = Math.max(0, Math.min(count, src.length - offset));
    for (let i = 0; i < n; i++) this.push(src[offset + i] as number);
  }

  /** Value at logical index `i` (0 = oldest still held). */
  at(i: number): number {
    if (i < 0 || i >= this.size) return 0;
    const start = (this.head - this.size + this.capacity) % this.capacity;
    return this.data[(start + i) % this.capacity] as number;
  }

  /**
   * Copy oldest -> newest into `out`, which is always `capacity` long.
   *
   * A partially filled buffer (the first window after a seek to the start of a
   * segment) is right-aligned and padded on the left with NaN, so the trace
   * grows leftward from the right edge. Padding with the oldest value instead
   * would draw a flat line that looks like real, motionless signal.
   */
  toArray(out?: Float32Array): Float32Array {
    const dst = out && out.length === this.capacity ? out : new Float32Array(this.capacity);
    const pad = this.capacity - this.size;
    for (let i = 0; i < pad; i++) dst[i] = Number.NaN;
    const start = (this.head - this.size + this.capacity) % this.capacity;
    for (let i = 0; i < this.size; i++) {
      dst[pad + i] = this.data[(start + i) % this.capacity] as number;
    }
    return dst;
  }
}
