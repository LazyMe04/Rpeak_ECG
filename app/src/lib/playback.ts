import { DisplayFilter } from "./filters";
import { RingBuffer } from "./signal/ringBuffer";
import type { SignalSource } from "./signal/types";

/** Visible window, in samples. 1000 @ 250 Hz = 4 s, the reference app's choice. */
export const WINDOW = 1000;

/** Speeds offered in the transport bar. */
export const SPEEDS = [1, 4, 16, 60] as const;
export type Speed = (typeof SPEEDS)[number];

/**
 * Seconds of signal pushed through the display filter after a seek before the
 * first visible sample. The 0.5 Hz high-pass needs a few seconds to settle;
 * without this the trace jumps on every scrub.
 */
const PREROLL_S = 6;

/** How often the React-facing status is refreshed. 60 Hz re-renders are waste. */
const STATUS_MS = 120;

export interface PlaybackStatus {
  position: number; // seconds
  duration: number; // seconds
  playing: boolean;
  speed: number;
  loaded: boolean;
  atEnd: boolean;
}

export type RenderFn = (samples: Float32Array, positionSamples: number) => void;

/**
 * Drives sample delivery for the waveform.
 *
 * Wall-clock time is the clock: each animation frame advances a fractional
 * sample position by `dt * fs * speed`, and every whole sample crossed is
 * filtered once and pushed into the ring. Keeping `pos` fractional is what
 * makes 1x scrolling smooth -- the renderer shifts by the remainder instead of
 * snapping to whole samples.
 */
export class ReplayEngine {
  readonly ring = new RingBuffer(WINDOW);
  private source: SignalSource | null = null;
  private filter = new DisplayFilter(null);

  private pos = 0;
  private appended = 0;
  private speed: number = 1;
  private playing = false;
  private raf = 0;
  private lastFrame = 0;
  private lastStatus = 0;

  private chunk = new Float32Array(8192);
  private frame = new Float32Array(WINDOW);
  /** Set when something changed that a paused canvas must repaint for. */
  private dirty = true;

  onRender: RenderFn | null = null;
  onStatus: ((s: PlaybackStatus) => void) | null = null;

  get position(): number {
    return this.pos;
  }

  get duration(): number {
    return this.source ? this.source.length / this.source.fs : 0;
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  get fs(): number {
    return this.source?.fs ?? 250;
  }

  get loaded(): boolean {
    return this.source !== null && this.source.ready;
  }

  start(): void {
    if (this.raf) return;
    this.lastFrame = 0;
    this.raf = requestAnimationFrame(this.loop);
  }

  stop(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  async setSource(src: SignalSource): Promise<void> {
    this.pause();
    this.source?.dispose();
    this.source = src;
    this.filter.reset();
    this.ring.clear();
    this.pos = 0;
    this.appended = 0;
    await src.load();
    this.seek(0);
    this.dirty = true;
    this.emit(true);
  }

  clearSource(): void {
    this.pause();
    this.source?.dispose();
    this.source = null;
    this.filter.reset();
    this.ring.clear();
    this.pos = 0;
    this.appended = 0;
    this.dirty = true;
    this.emit(true);
  }

  play(): void {
    if (!this.loaded) return;
    if (this.pos >= (this.source?.length ?? 0)) this.seek(0);
    this.playing = true;
    this.lastFrame = 0;
    this.dirty = true;
    this.emit(true);
  }

  pause(): void {
    if (!this.playing) return;
    this.playing = false;
    this.dirty = true;
    this.emit(true);
  }

  toggle(): void {
    if (this.playing) this.pause();
    else this.play();
  }

  setSpeed(speed: number): void {
    this.speed = speed;
    this.emit(true);
  }

  /** Seek to a position in samples. */
  seek(targetSamples: number): void {
    const src = this.source;
    if (!src) return;
    const target = Math.max(0, Math.min(Math.round(targetSamples), src.length));
    const fs = src.fs;

    this.filter.reset();
    const n = Math.min(Math.round(PREROLL_S * fs), target);
    if (n > 0) {
      const start = target - n;
      const raw = new Float32Array(n);
      src.read(start, n, raw, 0);
      const keep = Math.min(WINDOW, n);
      const tail = new Float32Array(keep);
      for (let i = 0; i < n; i++) {
        const y = this.filter.process(raw[i]!);
        if (i >= n - keep) tail[i - (n - keep)] = y;
      }
      this.ring.clear();
      this.ring.pushMany(tail, 0, keep);
    } else {
      this.ring.clear();
    }

    this.pos = target;
    this.appended = target;
    this.dirty = true;
    this.emit(true);
  }

  /** Seek by seconds relative to the current position. */
  seekBy(seconds: number): void {
    this.seek(this.pos + seconds * this.fs);
  }

  /** Seek to an absolute time in seconds. */
  seekSeconds(seconds: number): void {
    this.seek(seconds * this.fs);
  }

  /** Ask for one more frame even while paused (resize, theme, new annotations). */
  invalidate(): void {
    this.dirty = true;
  }

  private loop = (t: number): void => {
    this.raf = requestAnimationFrame(this.loop);

    const dt = this.lastFrame ? Math.min(0.25, (t - this.lastFrame) / 1000) : 0;
    this.lastFrame = t;

    if (this.playing && this.source) {
      this.pos += dt * this.source.fs * this.speed;
      if (this.pos >= this.source.length) {
        this.pos = this.source.length;
        this.playing = false;
        this.emit(true);
      }
      this.fill();
      this.dirty = true;
    }

    // Repaint only when the trace can have changed. A paused dashboard that
    // rasterises 1,000 points at 60 Hz is pure battery drain.
    if (this.onRender && this.dirty) {
      this.dirty = false;
      this.ring.toArray(this.frame);
      this.onRender(this.frame, this.pos);
    }

    if (t - this.lastStatus >= STATUS_MS) {
      this.lastStatus = t;
      this.emit(false);
    }
  };

  /** Filter and enqueue every sample between what we have and `pos`. */
  private fill(): void {
    const src = this.source;
    if (!src) return;
    const end = Math.floor(this.pos);
    while (this.appended < end) {
      const want = Math.min(this.chunk.length, end - this.appended);
      const got = src.read(this.appended, want, this.chunk, 0);
      if (got <= 0) break;
      for (let i = 0; i < got; i++) this.ring.push(this.filter.process(this.chunk[i]!));
      this.appended += got;
    }
  }

  private emit(force: boolean): void {
    if (!this.onStatus) return;
    if (!force && !this.playing) return;
    const duration = this.duration;
    this.onStatus({
      position: this.pos / this.fs,
      duration,
      playing: this.playing,
      speed: this.speed,
      loaded: this.loaded,
      atEnd: this.pos >= (this.source?.length ?? 0),
    });
  }
}
