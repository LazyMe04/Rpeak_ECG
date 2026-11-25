import { memo, useEffect, useRef } from "react";
import { WINDOW, type ReplayEngine } from "../lib/playback";
import type { AnnotationTrack } from "../lib/signal/annotations";
import type { BeatSymbol } from "../lib/signal/types";
import type { DelinArrays } from "../lib/ecg/delineate";

/** Height reserved under the trace for the time ruler. */
const RULER_H = 24;
/**
 * Height of the PQRST caliper lane, between the plot and the ruler.
 *
 * Boundaries go here rather than over the trace: full-height bands stripe the
 * whole strip, and a bracket laid on the trace collides with the wave it is
 * measuring. A lane of its own reads like the caliper strip on a paper ECG.
 */
const LANE_H = 24;
/** Height reserved at the bottom for the floating transport bar. */
const TRANSPORT_RESERVE = 92;
const MINOR_PX = 40;
const MAJOR_PX = 200;

interface Palette {
  wave: string;
  waveSoft: string;
  gridMinor: string;
  gridMajor: string;
  gridAxis: string;
  faint: string;
  detect: string;
  delinP: string;
  delinQrs: string;
  delinT: string;
  beat: Record<BeatSymbol, string>;
}

function readPalette(): Palette {
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  return {
    wave: v("--wave", "#00ff33"),
    waveSoft: v("--wave-soft", "rgba(0,255,51,0.22)"),
    gridMinor: v("--grid-minor", "rgba(148,163,184,0.13)"),
    gridMajor: v("--grid-major", "rgba(148,163,184,0.26)"),
    gridAxis: v("--grid-axis", "rgba(148,163,184,0.38)"),
    faint: v("--text-faint", "#64748b"),
    detect: v("--detect", "#38bdf8"),
    delinP: v("--delin-p", "#f472b6"),
    delinQrs: v("--delin-qrs", "#22d3ee"),
    delinT: v("--delin-t", "#fbbf24"),
    beat: {
      N: v("--beat-N", "#00ff33"),
      S: v("--beat-S", "#fac800"),
      V: v("--beat-V", "#ff6568"),
      Q: v("--beat-Q", "#c07eff"),
    },
  };
}

function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

/** First index whose value is >= v. */
function lowerBound(a: Int32Array, v: number): number {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (a[mid]! < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

interface Props {
  engine: ReplayEngine;
  theme: "dark" | "light";
  track: AnnotationTrack | null;
  showBeats: boolean;
  /** Detector output for the loaded segment, if it has finished. */
  detected: Int32Array | null;
  showDetected: boolean;
  /** PQRST boundaries aligned with `delinPeaks`, once the worker answers. */
  delin: { peaks: Int32Array; arrays: DelinArrays } | null;
  showDelineation: boolean;
}

/**
 * The waveform surface.
 *
 * Canvas2D rather than the reference's webgl-plot: 1,000 points at 60 fps is
 * ~0.3 ms of rasterisation, and the same pass draws the grid, the reference
 * beat overlay and the time ruler, which webgl-plot cannot do without extra
 * line objects. The visual result is closer to the reference than the WebGL
 * line was, and it has no WebGL2 context to lose.
 */
export const WaveformCanvas = memo(function WaveformCanvas({
  engine,
  theme,
  track,
  showBeats,
  detected,
  showDetected,
  delin,
  showDelineation,
}: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  const size = useRef({ w: 0, h: 0, dpr: 1 });
  const peak = useRef(0);
  const gain = useRef(1);
  const primed = useRef(false);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return;

    const palette = readPalette();
    primed.current = false;
    peak.current = 0;

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      size.current = { w, h, dpr };
      canvas.width = Math.max(1, Math.round(w * dpr));
      canvas.height = Math.max(1, Math.round(h * dpr));
      // Resizing the backing store clears it; ask for a repaint even if paused.
      engine.invalidate();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    const draw = (samples: Float32Array, pos: number) => {
      const { w, h, dpr } = size.current;
      if (w <= 0 || h <= 0) return;
      const fs = engine.fs;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      const lane = showDelineation && delin ? LANE_H : 0;
      const plotH = Math.max(20, h - RULER_H - TRANSPORT_RESERVE - lane);
      const mid = plotH / 2;

      // ---- grid -----------------------------------------------------------
      ctx.lineWidth = 1;
      ctx.strokeStyle = palette.gridMinor;
      ctx.beginPath();
      for (let x = w; x >= 0; x -= MINOR_PX) {
        const px = Math.round(x) + 0.5;
        ctx.moveTo(px, 0);
        ctx.lineTo(px, plotH);
      }
      for (let y = plotH; y >= 0; y -= MINOR_PX) {
        const py = Math.round(y) + 0.5;
        ctx.moveTo(0, py);
        ctx.lineTo(w, py);
      }
      ctx.stroke();

      ctx.strokeStyle = palette.gridMajor;
      ctx.beginPath();
      for (let x = w; x >= 0; x -= MAJOR_PX) {
        const px = Math.round(x) + 0.5;
        ctx.moveTo(px, 0);
        ctx.lineTo(px, plotH);
      }
      for (let y = plotH; y >= 0; y -= MAJOR_PX) {
        const py = Math.round(y) + 0.5;
        ctx.moveTo(0, py);
        ctx.lineTo(w, py);
      }
      ctx.stroke();

      ctx.strokeStyle = palette.gridAxis;
      ctx.beginPath();
      ctx.moveTo(0, Math.round(mid) + 0.5);
      ctx.lineTo(w, Math.round(mid) + 0.5);
      ctx.stroke();

      // ---- auto-gain ------------------------------------------------------
      let framePeak = 0;
      for (let i = 0; i < samples.length; i++) {
        const v = samples[i];
        if (!Number.isFinite(v)) continue;
        const a = Math.abs(v);
        if (a > framePeak) framePeak = a;
      }
      if (framePeak > peak.current) peak.current = framePeak;
      else peak.current = Math.max(framePeak, peak.current * 0.985);
      const peakV = Math.max(peak.current, 0.02);
      const target = (plotH * 0.4) / peakV;
      // First frame after a segment change: snap the gain instead of easing
      // into it, so the trace does not visibly grow from flat.
      if (!primed.current) {
        gain.current = target;
        primed.current = true;
      }
      gain.current += (target - gain.current) * 0.08;
      const g = Math.min(Math.max(gain.current, plotH * 0.02), plotH * 4);

      // ---- trace ----------------------------------------------------------
      const n = samples.length;
      const dx = w / (n - 1);
      const frac = pos - Math.floor(pos);

      // NaN marks the part of the window that has no data yet (right after a
      // seek to the very start); breaking the path there leaves it blank
      // instead of drawing a flat line.
      const path = new Path2D();
      let pen = false;
      for (let i = 0; i < n; i++) {
        const v = samples[i];
        if (!Number.isFinite(v)) {
          pen = false;
          continue;
        }
        const x = i * dx - frac * dx;
        const y = mid - v * g;
        if (pen) path.lineTo(x, y);
        else {
          path.moveTo(x, y);
          pen = true;
        }
      }
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.strokeStyle = palette.waveSoft;
      ctx.lineWidth = 5;
      ctx.stroke(path);
      ctx.strokeStyle = palette.wave;
      ctx.lineWidth = 1.6;
      ctx.stroke(path);

      // ---- reference beats ------------------------------------------------
      if (track && showBeats) {
        const startS = pos - WINDOW;
        const first = track.lowerBound(Math.floor(startS) - 1);
        for (let i = first; i < track.length; i++) {
          const b = track.beats[i];
          if (b.sample > pos) break;
          const x = ((b.sample - startS) / WINDOW) * w;
          if (x < -4 || x > w + 4) continue;
          const color = palette.beat[b.symbol];

          ctx.globalAlpha = 0.14;
          ctx.strokeStyle = color;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(Math.round(x) + 0.5, 0);
          ctx.lineTo(Math.round(x) + 0.5, plotH);
          ctx.stroke();
          ctx.globalAlpha = 1;

          // Tick on the baseline, so the beat cadence stays readable even when
          // the trace is flat or the R apex is off-window.
          ctx.fillStyle = color;
          ctx.fillRect(Math.round(x) - 1, plotH - 5, 2, 5);

          const idx = Math.round(b.sample - startS);
          const v = idx >= 0 && idx < n ? samples[idx] : Number.NaN;
          if (Number.isFinite(v)) {
            const y = mid - v * g;
            ctx.beginPath();
            ctx.arc(x, y, 3, 0, Math.PI * 2);
            ctx.fill();
            ctx.globalAlpha = 0.35;
            ctx.beginPath();
            ctx.arc(x, y, 6, 0, Math.PI * 2);
            ctx.fill();
            ctx.globalAlpha = 1;
          }

          // Only clinically abnormal beats get a letter; N and Q are shown by
          // colour alone, or the trace becomes a wall of labels.
          if (b.symbol === "S" || b.symbol === "V") {
            ctx.fillStyle = color;
            ctx.font = "700 11px ui-sans-serif, system-ui, sans-serif";
            ctx.textAlign = "center";
            ctx.fillText(b.symbol, x, 13);
          }
        }
      }

      // ---- detector output ------------------------------------------------
      // Drawn as hollow rings on the apex plus a triangle at the top edge: the
      // ring shows where the detector put the beat, the triangle keeps the
      // cadence readable when the apex is off-window. Deliberately a different
      // shape from the filled reference circles so the two can be compared
      // without relying on colour alone.
      if (detected && showDetected) {
        const startS = pos - WINDOW;
        const first = lowerBound(detected, Math.floor(startS) - 1);
        ctx.strokeStyle = palette.detect;
        ctx.fillStyle = palette.detect;
        ctx.lineWidth = 1.2;
        for (let i = first; i < detected.length; i++) {
          const s = detected[i]!;
          if (s > pos) break;
          const x = ((s - startS) / WINDOW) * w;
          if (x < -4 || x > w + 4) continue;

          ctx.globalAlpha = 0.9;
          ctx.beginPath();
          ctx.moveTo(x, 1);
          ctx.lineTo(x - 3.5, 8);
          ctx.lineTo(x + 3.5, 8);
          ctx.closePath();
          ctx.fill();

          const idx = Math.round(s - startS);
          const v = idx >= 0 && idx < n ? samples[idx] : Number.NaN;
          if (Number.isFinite(v)) {
            ctx.globalAlpha = 0.55;
            ctx.beginPath();
            ctx.arc(x, mid - v * g, 5, 0, Math.PI * 2);
            ctx.stroke();
          }
        }
        ctx.globalAlpha = 1;
      }

      // ---- PQRST boundaries -----------------------------------------------
      // Three coloured caliper bars in a lane under the plot: P, QRS and T are
      // each shown at their measured extent, aligned with the beats above them.
      // The lane is part of the layout only while the overlay is on, so turning
      // it off gives the trace its height back rather than leaving a gap.
      if (delin && showDelineation) {
        const startS = pos - WINDOW;
        const a = delin.arrays;
        const first = lowerBound(delin.peaks, Math.floor(startS) - Math.round(0.4 * fs));
        const last = pos + Math.round(0.8 * fs);
        const top = plotH + 4;
        const barY = plotH + LANE_H - 7;

        // Lane separators, so the strip reads as a lane and not as loose marks.
        ctx.strokeStyle = palette.gridAxis;
        ctx.globalAlpha = 0.5;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, Math.round(top - 2) + 0.5);
        ctx.lineTo(w, Math.round(top - 2) + 0.5);
        ctx.stroke();
        ctx.globalAlpha = 1;

        ctx.font = "600 9px ui-sans-serif, system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "alphabetic";

        const bar = (on: number, off: number, color: string, label: string) => {
          if (on < 0 || off < 0 || off <= on) return;
          const x0 = ((on - startS) / WINDOW) * w;
          const x1 = ((off - startS) / WINDOW) * w;
          if (x1 < -2 || x0 > w + 2) return;
          const bw = Math.max(2, x1 - x0);

          ctx.fillStyle = color;
          ctx.globalAlpha = 0.85;
          ctx.fillRect(x0, barY, bw, 2.5);
          // End ticks: the exact boundary samples, which is what a reader
          // would put a caliper on.
          ctx.fillRect(x0, barY - 3, 1, 8);
          ctx.fillRect(x0 + bw - 1, barY - 3, 1, 8);

          if (bw > (label.length > 1 ? 22 : 9)) {
            ctx.globalAlpha = 0.95;
            ctx.fillText(label, x0 + bw / 2, barY - 6);
          }
        };

        for (let i = first; i < delin.peaks.length; i++) {
          const r = delin.peaks[i]!;
          if (r > last) break;
          bar(a.pOn[i]!, a.pOff[i]!, palette.delinP, "P");
          bar(a.qrsOn[i]!, a.qrsOff[i]!, palette.delinQrs, "QRS");
          bar(a.tOn[i]!, a.tOff[i]!, palette.delinT, "T");
        }
        ctx.globalAlpha = 1;
      }

      // ---- playhead -------------------------------------------------------
      ctx.strokeStyle = palette.wave;
      ctx.globalAlpha = 0.5;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(w - 0.5, 0);
      ctx.lineTo(w - 0.5, plotH);
      ctx.stroke();
      ctx.globalAlpha = 1;

      // ---- time ruler -----------------------------------------------------
      const rulerY = plotH + lane;
      ctx.strokeStyle = palette.gridAxis;
      ctx.beginPath();
      ctx.moveTo(0, rulerY + 0.5);
      ctx.lineTo(w, rulerY + 0.5);
      ctx.stroke();

      ctx.font = "10px ui-monospace, SFMono-Regular, Consolas, monospace";
      ctx.textAlign = "center";
      const firstSec = Math.max(0, Math.floor((pos - WINDOW) / fs));
      const lastSec = Math.floor(pos / fs);
      for (let s = firstSec; s <= lastSec; s++) {
        const x = w - ((pos - s * fs) / WINDOW) * w;
        const majorTick = s % 5 === 0;
        ctx.globalAlpha = majorTick ? 0.85 : 0.4;
        ctx.beginPath();
        ctx.moveTo(Math.round(x) + 0.5, rulerY);
        ctx.lineTo(Math.round(x) + 0.5, rulerY + (majorTick ? 7 : 4));
        ctx.stroke();
        if (majorTick) {
          ctx.fillStyle = palette.faint;
          ctx.fillText(clock(s), x, rulerY + RULER_H - 5);
        }
      }
      ctx.globalAlpha = 1;
    };

    engine.onRender = draw;
    engine.invalidate();
    return () => {
      ro.disconnect();
      if (engine.onRender === draw) engine.onRender = null;
    };
  }, [engine, theme, track, showBeats, detected, showDetected, delin, showDelineation]);

  return <canvas ref={ref} className="absolute inset-0 w-full h-full" />;
});
