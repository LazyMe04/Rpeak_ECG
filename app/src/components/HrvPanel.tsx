import { memo, useCallback, useEffect, useMemo, useRef } from "react";
import { computeHrv, type HrvResult } from "../lib/ecg/hrv";
import { ActivityIcon } from "./icons";
import { Panel } from "./Panel";
import { useT } from "../lib/i18n";

interface Props {
  /** Peaks to analyse: detector output when available, annotations otherwise. */
  peaks: Int32Array | null;
  fs: number;
  theme: "dark" | "light";
  sourceLabel: string;
  /** True while the detector is still running, so the source may change. */
  pending: boolean;
  onClose: () => void;
}

interface PlotPalette {
  line: string;
  grid: string;
  faint: string;
  dim: string;
  lf: string;
  hf: string;
}

function readPlotPalette(): PlotPalette {
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  return {
    line: v("--accent", "#54a2ff"),
    grid: v("--panel-border", "rgba(255,255,255,0.16)"),
    faint: v("--text-faint", "#64748b"),
    dim: v("--text-dim", "#94a3b8"),
    lf: v("--orange", "#ff8b1a"),
    hf: v("--cyan", "#00d2ef"),
  };
}

/** Canvas + DPR + ResizeObserver, repainted whenever `draw` or the theme changes. */
function usePlot(
  theme: string,
  draw: (ctx: CanvasRenderingContext2D, w: number, h: number, pal: PlotPalette) => void,
) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const render = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (w <= 0 || h <= 0) return;
      canvas.width = Math.max(1, Math.round(w * dpr));
      canvas.height = Math.max(1, Math.round(h * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      draw(ctx, w, h, readPlotPalette());
    };
    render();
    const ro = new ResizeObserver(render);
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [theme, draw]);
  return ref;
}

function mmss(s: number): string {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
}

function isNum(v: number | null | undefined): v is number {
  return v != null && Number.isFinite(v);
}

/**
 * Tachogram: RR against time.
 *
 * Plotted on its own rather than over the waveform because the point is the
 * shape of the trend at a 70-minute scale, which the 4-second trace cannot show.
 */
const Tachogram = memo(function Tachogram({
  data,
  theme,
}: {
  data: { t: Float64Array; rr: Float64Array };
  theme: string;
}) {
  const draw = useCallback(
    (ctx: CanvasRenderingContext2D, w: number, h: number, pal: PlotPalette) => {
      const { t, rr } = data;
      if (rr.length < 2) return;
      const padL = 34;
      const padR = 6;
      const padT = 6;
      const padB = 14;
      const pw = w - padL - padR;
      const ph = h - padT - padB;

      // Robust axis: the 0.5th and 99.5th percentiles, not the extremes. One
      // 1.6 s pause or one missed beat would otherwise stretch the axis enough
      // that the whole trend is a flat line on the floor of the plot. The
      // clipped points are still drawn, just at the edge, so the outlier stays
      // visible rather than silently cropped.
      const sorted = Array.from(rr).sort((a, b) => a - b);
      const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
      let lo = q(0.005);
      let hi = q(0.995);
      if (!(hi > lo)) {
        lo = sorted[0]!;
        hi = sorted[sorted.length - 1]!;
      }
      const pad = Math.max(8, (hi - lo) * 0.15);
      lo -= pad;
      hi += pad;
      const t0 = t[0]!;
      const t1 = t[t.length - 1]!;
      const span = Math.max(1e-6, t1 - t0);
      const x = (v: number) => padL + ((v - t0) / span) * pw;
      const y = (v: number) => padT + (1 - (v - lo) / (hi - lo)) * ph;

      ctx.strokeStyle = pal.grid;
      ctx.lineWidth = 1;
      ctx.font = "9px ui-monospace, Consolas, monospace";
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      for (let k = 0; k <= 2; k++) {
        const v = lo + ((hi - lo) * k) / 2;
        const py = Math.round(y(v)) + 0.5;
        ctx.beginPath();
        ctx.moveTo(padL, py);
        ctx.lineTo(w - padR, py);
        ctx.stroke();
        ctx.fillStyle = pal.faint;
        ctx.fillText(`${Math.round(v)}`, padL - 4, py);
      }

      ctx.beginPath();
      for (let i = 0; i < rr.length; i++) {
        const px = x(t[i]!);
        const py = Math.min(padT + ph, Math.max(padT, y(rr[i]!)));
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.strokeStyle = pal.line;
      ctx.lineWidth = 1.2;
      ctx.lineJoin = "round";
      ctx.stroke();

      ctx.fillStyle = pal.faint;
      ctx.textBaseline = "alphabetic";
      ctx.textAlign = "left";
      ctx.fillText(mmss(t0), padL, h - 3);
      ctx.textAlign = "right";
      ctx.fillText(mmss(t1), w - padR, h - 3);
    },
    [data],
  );
  const ref = usePlot(theme, draw);
  return <canvas ref={ref} className="w-full" style={{ height: 84 }} />;
});

/**
 * Periodogram with the LF and HF bands shaded.
 *
 * Only 0-0.5 Hz is drawn: the 1/f rise below 0.04 Hz dwarfs LF and HF in dB and
 * would flatten the part of the plot the bands are about.
 */
const Spectrum = memo(function Spectrum({
  data,
  theme,
}: {
  data: { f: Float64Array; p: Float64Array };
  theme: string;
}) {
  const draw = useCallback(
    (ctx: CanvasRenderingContext2D, w: number, h: number, pal: PlotPalette) => {
      const { f, p } = data;
      if (f.length < 2) return;
      const padL = 34;
      const padR = 6;
      const padT = 12;
      const padB = 14;
      const pw = w - padL - padR;
      const ph = h - padT - padB;
      const fMax = 0.5;

      let hi = -Infinity;
      for (let i = 0; i < f.length; i++) if (f[i]! <= fMax && p[i]! > hi) hi = p[i]!;
      const lo = hi - 40;
      const x = (v: number) => padL + (v / fMax) * pw;
      const y = (v: number) => padT + (1 - (v - lo) / 40) * ph;

      const band = (a: number, b: number, color: string, label: string) => {
        ctx.globalAlpha = 0.12;
        ctx.fillStyle = color;
        ctx.fillRect(x(a), padT, x(b) - x(a), ph);
        ctx.globalAlpha = 1;
        ctx.fillStyle = pal.faint;
        ctx.font = "9px ui-sans-serif, system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(label, (x(a) + x(b)) / 2, padT - 2);
      };
      band(0.04, 0.15, pal.lf, "LF");
      band(0.15, 0.4, pal.hf, "HF");

      ctx.strokeStyle = pal.grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(padL, Math.round(padT + ph) + 0.5);
      ctx.lineTo(w - padR, Math.round(padT + ph) + 0.5);
      ctx.stroke();

      ctx.beginPath();
      let pen = false;
      for (let i = 0; i < f.length; i++) {
        if (f[i]! > fMax) break;
        const px = x(f[i]!);
        const py = y(Math.max(p[i]!, lo));
        if (pen) ctx.lineTo(px, py);
        else {
          ctx.moveTo(px, py);
          pen = true;
        }
      }
      ctx.strokeStyle = pal.line;
      ctx.lineWidth = 1.2;
      ctx.stroke();

      ctx.fillStyle = pal.faint;
      ctx.font = "9px ui-monospace, Consolas, monospace";
      ctx.textBaseline = "alphabetic";
      ctx.textAlign = "left";
      ctx.fillText("0", padL, h - 3);
      ctx.textAlign = "right";
      ctx.fillText("0.5 Hz", w - padR, h - 3);
    },
    [data],
  );
  const ref = usePlot(theme, draw);
  return <canvas ref={ref} className="w-full" style={{ height: 92 }} />;
});

function Stat({ label, value, unit }: { label: string; value: string; unit?: string }) {
  return (
    <div className="rounded-lg border p-2" style={{ borderColor: "var(--panel-border)" }}>
      <div className="text-[10px] uppercase tracking-wider text-faint truncate">{label}</div>
      <div className="mono text-sm font-semibold leading-tight">
        {value}
        {unit ? <span className="text-[9px] text-faint font-normal"> {unit}</span> : null}
      </div>
    </div>
  );
}

function Body({ hrv }: { hrv: HrvResult | null }) {
  const { t } = useT();
  if (!hrv || !hrv.ok) {
    return (
      <div className="text-[11px] text-faint leading-snug">
        {t(hrv?.reason ?? "No peaks yet.")}{" "}
        {t(
          "HRV needs at least four valid R-R intervals; the spectrum needs twenty intervals spanning 30 s.",
        )}
      </div>
    );
  }
  return null;
}

/**
 * Heart-rate variability for the loaded segment.
 *
 * Recomputed from the peak set with `computeHrv`, the same function the parity
 * test checks against the Python reference, so what the panel shows is what
 * `npm run test:hrv` verified rather than a second implementation.
 */
export const HrvPanel = memo(function HrvPanel({
  peaks,
  fs,
  theme,
  sourceLabel,
  pending,
  onClose,
}: Props) {
  const { t, num } = useT();
  // The stat tiles were fixed to a dot decimal; they now follow the language,
  // so SDNN reads 41,2 in Vietnamese and 41.2 in English.
  const f = (v: number | null | undefined, digits = 0) => (isNum(v) ? num(v, digits) : "--");
  const hrv = useMemo(() => (peaks ? computeHrv(peaks, fs) : null), [peaks, fs]);

  return (
    <Panel
      title="HRV"
      icon={<ActivityIcon size={18} className="text-cyan-400" />}
      onClose={onClose}
      testId="hrv"
      className="absolute right-4 top-20 bottom-[104px] w-[min(380px,calc(100vw-6rem))] z-30 flex flex-col"
      bodyClassName="scrollable-content px-4 pb-4 flex-1 min-h-0"
    >
      <div className="flex items-center justify-between mb-3 text-[11px]">
        <span className="uppercase tracking-wider text-faint">{t("Source")}</span>
        {pending ? (
          <span className="flex items-center gap-1.5 text-blue-400">
            <span className="animate-spin w-3 h-3 border border-current border-t-transparent rounded-full" />
            {t("Waiting for detector…")}
          </span>
        ) : (
          <span className="text-dim">{t(sourceLabel)}</span>
        )}
      </div>

      {!hrv || !hrv.ok ? (
        <Body hrv={hrv} />
      ) : (
        <>
          {hrv.tachogram && (
            <div className="mb-3">
              <div className="text-[11px] text-dim mb-1">
                {t("R-R tachogram")} <span className="text-faint">· ms</span>
              </div>
              <Tachogram data={hrv.tachogram} theme={theme} />
            </div>
          )}

          <div className="grid grid-cols-3 gap-1.5 mb-3">
            <Stat label="SDNN" value={f(hrv.sdnnMs)} unit="ms" />
            <Stat label="RMSSD" value={f(hrv.rmssdMs)} unit="ms" />
            <Stat label="pNN50" value={f(hrv.pnn50 * 100)} unit="%" />
            <Stat label={t("Mean R-R")} value={f(hrv.meanRrMs)} unit="ms" />
            <Stat label={t("Heart rate")} value={f(hrv.heartRateBpm)} unit="bpm" />
            <Stat label={t("Irregular")} value={f(hrv.irregularFrac * 100)} unit="%" />
          </div>

          {hrv.freq ? (
            <>
              <div className="mb-3">
                <div className="text-[11px] text-dim mb-1">
                  {t("R-R spectrum")}{" "}
                  <span className="text-faint">· dB, {t("4 Hz tachogram")}</span>
                </div>
                <Spectrum data={hrv.spectrum!} theme={theme} />
              </div>

              <div className="grid grid-cols-3 gap-1.5 mb-3">
                <Stat label="LF" value={f(hrv.freq.lf)} unit="ms²" />
                <Stat label="HF" value={f(hrv.freq.hf)} unit="ms²" />
                <Stat label="LF/HF" value={f(hrv.freq.lfHf, 2)} />
                <Stat label="LF n.u." value={f(hrv.freq.lfNu, 1)} unit="%" />
                <Stat label="HF n.u." value={f(hrv.freq.hfNu, 1)} unit="%" />
                <Stat label="VLF" value={f(hrv.freq.vlf)} unit="ms²" />
              </div>
            </>
          ) : (
            <div className="text-[11px] text-faint mb-3">
              {t("Spectrum unavailable: it needs 20 intervals spanning at least 30 s.")}
            </div>
          )}

          <div
            className="pt-2 border-t text-[11px] text-faint space-y-1"
            style={{ borderColor: "var(--panel-border)" }}
          >
            <div className="flex justify-between">
              <span>{t("Intervals")}</span>
              <span className="mono">
                {t("{kept} kept · {gated} gated", { kept: hrv.nIntervals, gated: hrv.gated })}
              </span>
            </div>
            <div className="flex justify-between">
              <span>{t("Analysed span")}</span>
              <span className="mono">{mmss(hrv.durationS)}</span>
            </div>
            {hrv.freqInfo?.resolutionHz != null && (
              <div className="flex justify-between">
                <span>{t("Resolution")}</span>
                <span className="mono">{num(hrv.freqInfo.resolutionHz, 4)} Hz</span>
              </div>
            )}
            <div className="leading-snug pt-1">
              {t(
                "Bands: VLF 0.003-0.04, LF 0.04-0.15, HF 0.15-0.40 Hz. Intervals outside 300-2000 ms are gated, not interpolated.",
              )}
            </div>
          </div>
        </>
      )}
    </Panel>
  );
});
