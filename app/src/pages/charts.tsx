/**
 * Chart primitives for the AI Model and Docs pages.
 *
 * These are SVG rather than the canvas the monitor uses. The monitor's plots
 * redraw every frame and carry 1,000-point traces, where canvas wins; these are
 * static series of a few dozen points, and SVG gives the hover layer, the table
 * twins and the text selection for free.
 *
 * The colour rules come from the dataviz method, not from taste:
 *
 *   * two categorical series use `--series-1` / `--series-2`, a pair validated
 *     against both page surfaces (light #ffffff, dark #0f172a);
 *   * the confusion matrix is one hue at varying opacity -- sequential, not a
 *     rainbow;
 *   * gridlines are hairline and solid; text never wears the series colour;
 *   * every chart with two or more series carries a legend, and each has a
 *     table twin somewhere on the page.
 */
import { memo, useEffect, useId, useRef, useState, type ReactNode, type RefObject } from "react";
import { useT } from "../lib/i18n";

export interface Series {
  name: string;
  /** A CSS colour, normally `var(--series-1)` or `var(--series-2)`. */
  color: string;
  values: number[];
}

const MONO = "9px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
const SANS = "10px ui-sans-serif, system-ui, sans-serif";

/** Track an element's content width, so SVG text renders at its real size. */
function useWidth(): [RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

interface TipLine {
  label: string;
  value: string;
  color?: string;
}

interface Tip {
  x: number;
  y: number;
  title?: string;
  lines: TipLine[];
  /**
   * Where the cursor sits in a long list, as "3 of 12". A sighted reader sees
   * the row label on the axis; a screen reader hears one value per keypress and
   * otherwise cannot tell how far it has travelled or how much is left.
   */
  position?: string;
}

/**
 * Arrow keys step a chart cursor; Home/End jump to the ends, Escape clears.
 *
 * Shared by the two charts so a keyboard reader learns the control once. The
 * cursor is an index into the chart's points, not a pixel: a chart drawn 400px
 * wide and the same chart drawn 1200px wide must step through the same values.
 */
function stepKey(
  e: React.KeyboardEvent,
  i: number,
  n: number,
  coarse = 10,
): { index: number } | "clear" | null {
  if (n === 0) return null;
  const step = e.shiftKey ? coarse : 1;
  switch (e.key) {
    case "ArrowRight":
    case "ArrowDown":
      return { index: Math.min(n - 1, i + step) };
    case "ArrowLeft":
    case "ArrowUp":
      return { index: Math.max(0, i - step) };
    case "PageDown":
      return { index: Math.min(n - 1, i + coarse) };
    case "PageUp":
      return { index: Math.max(0, i - coarse) };
    case "Home":
      return { index: 0 };
    case "End":
      return { index: n - 1 };
    case "Escape":
      return "clear";
    default:
      return null;
  }
}

/** The text a screen reader hears as the crosshair moves. */
function readout(tip: Tip | null): string {
  if (!tip) return "";
  const head = tip.title ? `${tip.title}: ` : "";
  const tail = tip.position ? ` (${tip.position})` : "";
  return head + tip.lines.map((l) => `${l.label} ${l.value}`).join(", ") + tail;
}

/**
 * Announce the cursor position without drawing it.
 *
 * `aria-live` is the only way a focused SVG gets its moving crosshair spoken;
 * the tooltip is a visual element and its text would not be announced on a
 * chart with `role="img"`.
 */
function Live({ text }: { text: string }) {
  return (
    <div className="sr-only" aria-live="polite" aria-atomic="true" data-chart-readout>
      {text}
    </div>
  );
}

function Tooltip({ tip, width }: { tip: Tip | null; width: number }) {
  if (!tip) return null;
  const left = Math.max(4, Math.min(tip.x + 12, Math.max(4, width - 150)));
  return (
    <div
      className="pointer-events-none absolute z-10 rounded-md border px-2 py-1.5 text-[11px] leading-tight shadow-lg"
      style={{
        left,
        top: Math.max(2, tip.y - 8),
        background: "var(--panel-fill)",
        borderColor: "var(--panel-border)",
        backdropFilter: "blur(6px)",
        minWidth: 110,
      }}
    >
      {tip.title && <div className="text-faint mb-1">{tip.title}</div>}
      {tip.lines.map((l) => (
        <div key={l.label} className="flex items-center gap-1.5">
          {l.color && (
            <span className="w-2 h-2 rounded-full shrink-0" style={{ background: l.color }} />
          )}
          <span className="text-dim">{l.label}</span>
          <span className="mono ml-auto pl-3">{l.value}</span>
        </div>
      ))}
      {tip.position && (
        <div className="text-faint mt-1 mono" data-tip-position>
          {tip.position}
        </div>
      )}
    </div>
  );
}

/** Legend: a coloured mark beside a text-token label. Never coloured text. */
export function Legend({ items }: { items: { name: string; color: string }[] }) {
  const { t } = useT();
  return (
    <div className="flex items-center gap-4 text-[11px] text-dim">
      {items.map((i) => (
        <span key={i.name} className="flex items-center gap-1.5">
          <span className="w-3 h-[2px] rounded-full" style={{ background: i.color }} aria-hidden />
          {t(i.name)}
        </span>
      ))}
    </div>
  );
}

interface LineChartProps {
  x: number[];
  series: Series[];
  height?: number;
  yDomain: [number, number];
  yTicks: number[];
  formatY?: (v: number) => string;
  /** Axis ticks may be coarser than the tooltip and end labels. */
  formatTick?: (v: number) => string;
  /** Vertical marker, normally the selected epoch. */
  markerX?: number;
  markerLabel?: string;
  endLabels?: boolean;
  ariaLabel: string;
  xSuffix?: string;
}

/**
 * Multi-series line chart with a crosshair tooltip.
 *
 * One y-axis only: callers that want two measures of different scale use two
 * charts, which is why the training loss and the validation scores are
 * separate figures rather than one dual-axis plot.
 */
export const LineChart = memo(function LineChart({
  x,
  series,
  height = 190,
  yDomain,
  yTicks,
  formatY,
  formatTick,
  markerX,
  markerLabel,
  endLabels = true,
  ariaLabel,
  xSuffix = "",
}: LineChartProps) {
  const { t, num } = useT();
  const fmtY: (v: number) => string = formatY ?? ((v: number) => num(v, 2));
  const [ref, w] = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  const [focused, setFocused] = useState(false);
  const labelId = useId();

  const padL = 40;
  const padR = endLabels ? 78 : 14;
  const padT = 14;
  const padB = 24;
  const pw = Math.max(10, w - padL - padR);
  const ph = Math.max(10, height - padT - padB);
  const n = x.length;
  const x0 = x[0] ?? 0;
  const x1 = x[n - 1] ?? 1;
  const X = (v: number) => padL + ((v - x0) / Math.max(1e-9, x1 - x0)) * pw;
  const Y = (v: number) =>
    padT + (1 - (v - yDomain[0]) / Math.max(1e-9, yDomain[1] - yDomain[0])) * ph;

  const xTicks = Array.from(
    new Set(Array.from({ length: 5 }, (_, i) => x[Math.round((i * (n - 1)) / 4)] ?? x0)),
  );

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (n === 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const i = Math.round(((mx - padL) / pw) * (n - 1));
    setHover(Math.max(0, Math.min(n - 1, i)));
  };

  const onKeyDown = (e: React.KeyboardEvent<SVGSVGElement>) => {
    // Tab lands on the chart with the cursor on the first point, so the first
    // spoken readout is a real value and not "no cursor".
    const r = stepKey(e, hover ?? 0, n);
    if (r === null) return;
    e.preventDefault();
    setHover(r === "clear" ? null : r.index);
  };

  const tip: Tip | null =
    hover == null
      ? null
      : {
          x: X(x[hover]!),
          y: Math.min(...series.map((s) => Y(s.values[hover]!))),
          title: `${x[hover]}${xSuffix}`,
          lines: series.map((s) => ({
            label: t(s.name),
            value: fmtY(s.values[hover]!),
            color: s.color,
          })),
          position: t("{i} of {n}", { i: hover + 1, n }),
        };

  return (
    <div ref={ref} className="relative select-none">
      {w > 0 && (
        <svg
          width={w}
          height={height}
          role="img"
          aria-label={t(ariaLabel)}
          aria-describedby={labelId}
          tabIndex={0}
          data-chart="line"
          onMouseMove={onMove}
          onMouseLeave={() => {
            // A mouse leave must not throw away a cursor the keyboard put down.
            if (!focused) setHover(null);
          }}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false);
            setHover(null);
          }}
          onKeyDown={onKeyDown}
          style={{ outline: "none" }}
          className="chart-focusable"
        >
          {yTicks.map((t) => (
            <g key={t}>
              <line
                x1={padL}
                x2={w - padR}
                y1={Math.round(Y(t)) + 0.5}
                y2={Math.round(Y(t)) + 0.5}
                style={{ stroke: "var(--chart-grid)" }}
                strokeWidth={1}
              />
              <text
                x={padL - 6}
                y={Y(t)}
                textAnchor="end"
                dominantBaseline="middle"
                style={{ fill: "var(--text-faint)", font: MONO }}
              >
                {(formatTick ?? fmtY)(t)}
              </text>
            </g>
          ))}

          {xTicks.map((t) => (
            <text
              key={t}
              x={X(t)}
              y={height - 6}
              textAnchor="middle"
              style={{ fill: "var(--text-faint)", font: MONO }}
            >
              {t}
            </text>
          ))}

          {markerX != null && (
            <g>
              <line
                x1={X(markerX)}
                x2={X(markerX)}
                y1={padT}
                y2={padT + ph}
                style={{ stroke: "var(--chart-axis)" }}
                strokeWidth={1}
              />
              {markerLabel && (
                <text
                  x={X(markerX) + 4}
                  y={padT + 9}
                  style={{ fill: "var(--text-faint)", font: MONO }}
                >
                  {markerLabel}
                </text>
              )}
            </g>
          )}

          {series.map((s) => (
            <polyline
              key={s.name}
              points={s.values.map((v, i) => `${X(x[i]!)},${Y(v)}`).join(" ")}
              fill="none"
              style={{ stroke: s.color }}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          ))}

          {endLabels &&
            series.map((s) => {
              const v = s.values[n - 1]!;
              return (
                <g key={s.name}>
                  <circle
                    cx={X(x1)}
                    cy={Y(v)}
                    r={4}
                    style={{ fill: s.color, stroke: "var(--background)" }}
                    strokeWidth={2}
                  />
                  <text
                    x={X(x1) + 8}
                    y={Y(v)}
                    dominantBaseline="middle"
                    style={{ fill: "var(--text)", font: SANS }}
                  >
                    {t(s.name)} {fmtY(v)}
                  </text>
                </g>
              );
            })}

          {hover != null && (
            <g>
              <line
                x1={X(x[hover]!)}
                x2={X(x[hover]!)}
                y1={padT}
                y2={padT + ph}
                data-chart-cursor=""
                style={{ stroke: "var(--chart-axis)" }}
                strokeWidth={1}
              />
              {series.map((s) => (
                <circle
                  key={s.name}
                  cx={X(x[hover]!)}
                  cy={Y(s.values[hover]!)}
                  r={3.5}
                  style={{ fill: s.color, stroke: "var(--background)" }}
                  strokeWidth={2}
                />
              ))}
            </g>
          )}
        </svg>
      )}
      <Tooltip tip={tip} width={w} />
      <div id={labelId} className="sr-only">
        {t(
          "Use the arrow keys to read values, shift for ten at a time, Page Up and Page Down for ten at a time, Home and End for the ends, Escape to clear.",
        )}
      </div>
      <Live text={readout(tip)} />
    </div>
  );
});

interface DotPlotProps {
  rows: { label: string; values: number[] }[];
  series: { name: string; color: string }[];
  xDomain: [number, number];
  xTicks: number[];
  height?: number;
  format?: (v: number) => string;
  ariaLabel: string;
  xUnit?: string;
}

/**
 * Dot plot: one row per entity, one dot per series on a shared scale.
 *
 * Chosen over grouped bars because the question is "how far apart are Se and
 * PPV for this patient", and 12 rows of paired dots read that faster than 24
 * bars. Two series share one axis, so there is no second scale to explain.
 */
export const DotPlot = memo(function DotPlot({
  rows,
  series,
  xDomain,
  xTicks,
  height,
  format,
  ariaLabel,
  xUnit = "",
}: DotPlotProps) {
  const { t, num } = useT();
  const fmt: (v: number) => string = format ?? ((v: number) => num(v, 1));
  const [ref, w] = useWidth();
  const [tip, setTip] = useState<Tip | null>(null);
  const [cur, setCur] = useState<{ ri: number; si: number } | null>(null);
  const labelId = useId();

  /**
   * Move the keyboard cursor over the grid the marks already sit on.
   *
   * Row stepping goes through `stepKey`, so a reader who has learnt the line
   * chart already knows this one: PageUp/PageDown and shift-arrow jump ten rows
   * at a time, which is the only way to reach row 30 of a long per-patient
   * table without pressing Down thirty times. Left/Right keep their own meaning
   * -- they change which measure is read, not which row.
   */
  const onKeyDown = (e: React.KeyboardEvent<SVGSVGElement>) => {
    if (rows.length === 0) return;
    const at = cur ?? { ri: 0, si: 0 };
    // Both branches below assign before the first read.
    let next: { ri: number; si: number };
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      const d = e.key === "ArrowRight" ? 1 : -1;
      next = { ri: at.ri, si: Math.max(0, Math.min(series.length - 1, at.si + d)) };
    } else {
      const r = stepKey(e, at.ri, rows.length);
      if (r === null) return;
      if (r === "clear") {
        e.preventDefault();
        setCur(null);
        setTip(null);
        return;
      }
      next = { ri: r.index, si: at.si };
    }
    // A row may be missing one series; land on the first series it has.
    while (next.si > 0 && rows[next.ri]!.values[next.si] == null) {
      next = { ...next, si: next.si - 1 };
    }
    const v = rows[next.ri]!.values[next.si];
    if (v == null) return;
    e.preventDefault();
    setCur(next);
    setTip({
      x: X(v),
      y: padT + rowH * (next.ri + 0.5) + (next.si - (series.length - 1) / 2) * gap,
      title: rows[next.ri]!.label,
      lines: [{ label: series[next.si]!.name, value: fmt(v), color: series[next.si]!.color }],
      position: t("{i} of {n}", { i: next.ri + 1, n: rows.length }),
    });
  };

  const padL = 62;
  // Wide enough for the last x tick to sit centred on the axis end without
  // being clipped by the SVG edge.
  const padR = 26;
  const padT = 8;
  const padB = 22;
  const h = height ?? rows.length * 22 + padT + padB;
  const pw = Math.max(10, w - padL - padR);
  const ph = Math.max(10, h - padT - padB);
  const X = (v: number) => padL + ((v - xDomain[0]) / Math.max(1e-9, xDomain[1] - xDomain[0])) * pw;
  const rowH = ph / Math.max(1, rows.length);
  const gap = 9;

  return (
    <div ref={ref} className="relative select-none">
      {w > 0 && (
        <svg
          width={w}
          height={h}
          role="img"
          aria-label={t(ariaLabel)}
          aria-describedby={labelId}
          tabIndex={0}
          data-chart="dots"
          onKeyDown={onKeyDown}
          onBlur={() => {
            setCur(null);
            setTip(null);
          }}
          style={{ outline: "none" }}
          className="chart-focusable"
        >
          {xTicks.map((t) => (
            <g key={t}>
              <line
                x1={Math.round(X(t)) + 0.5}
                x2={Math.round(X(t)) + 0.5}
                y1={padT}
                y2={padT + ph}
                style={{ stroke: "var(--chart-grid)" }}
                strokeWidth={1}
              />
              <text
                x={X(t)}
                y={h - 6}
                textAnchor="middle"
                style={{ fill: "var(--text-faint)", font: MONO }}
              >
                {fmt(t)}
                {xUnit}
              </text>
            </g>
          ))}

          {rows.map((r, ri) => {
            const cy = padT + rowH * (ri + 0.5);
            return (
              <g key={r.label}>
                <text
                  x={padL - 8}
                  y={cy}
                  textAnchor="end"
                  dominantBaseline="middle"
                  style={{ fill: "var(--text-dim)", font: MONO }}
                >
                  {r.label}
                </text>
                {series.map((s, si) => {
                  const v = r.values[si];
                  if (v == null) return null;
                  const y = cy + (si - (series.length - 1) / 2) * gap;
                  return (
                    <g
                      key={s.name}
                      data-dot={`${r.label}|${s.name}`}
                      data-active={cur?.ri === ri && cur?.si === si ? "" : undefined}
                      onMouseEnter={() =>
                        setTip({
                          x: X(v),
                          y,
                          title: r.label,
                          lines: [{ label: t(s.name), value: fmt(v), color: s.color }],
                        })
                      }
                      onMouseLeave={() => setTip(null)}
                    >
                      {/* Hit target larger than the mark: a 4px dot is hard to hover. */}
                      <circle cx={X(v)} cy={y} r={12} fill="transparent" />
                      <circle
                        cx={X(v)}
                        cy={y}
                        r={4}
                        style={{ fill: s.color, stroke: "var(--background)" }}
                        strokeWidth={2}
                      />
                      {cur?.ri === ri && cur?.si === si && (
                        <circle
                          cx={X(v)}
                          cy={y}
                          r={8}
                          fill="none"
                          data-dot-cursor=""
                          style={{ stroke: "var(--text)" }}
                          strokeWidth={1.5}
                        />
                      )}
                    </g>
                  );
                })}
              </g>
            );
          })}
        </svg>
      )}
      <Tooltip tip={tip} width={w} />
      <div id={labelId} className="sr-only">
        {t(
          "Use the arrow keys to move between patients and measures, shift or Page Up and Page Down for ten patients at a time, Home and End for the first and last patient, Escape to clear.",
        )}
      </div>
      <Live text={readout(tip)} />
    </div>
  );
});

interface BarRow {
  label: string;
  value: number;
  note?: string;
}

/**
 * Horizontal bars with the value at the tip.
 *
 * The data end is rounded and the baseline end is square, so the bar still
 * reads as growing from zero. One series, so no legend -- the title names it.
 */
export function BarList({
  rows,
  max,
  format,
}: {
  rows: BarRow[];
  max: number;
  format?: (v: number) => string;
}) {
  const { num } = useT();
  const fmt = format ?? ((v: number) => num(v, 1));
  return (
    <div className="space-y-1.5">
      {rows.map((r) => (
        <div key={r.label} className="flex items-center gap-2" title={r.note}>
          <div className="w-5 shrink-0 text-[11px] mono text-dim">{r.label}</div>
          <div className="flex-1 h-[10px] relative">
            <div
              className="absolute inset-y-0 left-0"
              style={{
                width: `${Math.max(1, (100 * r.value) / max)}%`,
                background: "var(--series-1)",
                borderRadius: "0 4px 4px 0",
              }}
            />
          </div>
          <div className="w-12 shrink-0 text-right mono text-[11px]">{fmt(r.value)}</div>
        </div>
      ))}
    </div>
  );
}

/**
 * Confusion matrix as a table with a sequential one-hue wash.
 *
 * The numbers stay in text ink and the wash is capped at 40% opacity, so the
 * exact values are always legible; shading only ranks them. The toggle between
 * counts and row share is the two readings the matrix supports.
 */
export function ConfusionMatrix({
  classes,
  matrix,
  format = (v) => v.toLocaleString(),
}: {
  classes: string[];
  matrix: number[][];
  format?: (v: number) => string;
}) {
  const { t, num } = useT();
  const [mode, setMode] = useState<"count" | "row">("count");
  const totals = matrix.map((row) => row.reduce((a, b) => a + b, 0));
  const max = Math.max(1, ...matrix.flat());

  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <span className="text-[11px] text-faint mr-auto">
          {t("Rows: annotated class · columns: prediction")}
        </span>
        {(
          [
            ["count", t("Counts")],
            ["row", t("Row %")],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setMode(key)}
            className="seg-btn"
            data-active={mode === key}
          >
            {label}
          </button>
        ))}
      </div>

      <table className="w-full" style={{ borderSpacing: 2, borderCollapse: "separate" }}>
        <thead>
          <tr>
            <th className="text-[10px] font-normal text-faint text-left">{t("true ↓")}</th>
            {classes.map((c) => (
              <th key={c} className="text-[10px] font-normal text-faint mono">
                {c}
              </th>
            ))}
            <th className="text-[10px] font-normal text-faint text-right">n</th>
          </tr>
        </thead>
        <tbody>
          {matrix.map((row, i) => (
            <tr key={i}>
              <th className="text-[11px] font-normal mono text-dim text-left pr-2">{classes[i]}</th>
              {row.map((v, j) => {
                const share = totals[i] ? v / totals[i] : 0;
                // sqrt lifts the mid range: linear opacity makes every
                // off-diagonal cell look identical near the top of the scale.
                const alpha = 0.05 + 0.35 * Math.sqrt(v / max);
                return (
                  <td
                    key={j}
                    className={`relative text-center mono text-[11px] py-1.5 rounded-sm ${
                      i === j ? "font-semibold" : ""
                    }`}
                    title={t("true {a} → predicted {b}: {v} ({pct}% of {a} beats)", {
                      a: classes[i]!,
                      b: classes[j]!,
                      v: num(v),
                      pct: num(share * 100, 1),
                    })}
                  >
                    <span
                      aria-hidden
                      className="absolute inset-0 rounded-sm"
                      style={{ background: "var(--series-1)", opacity: alpha }}
                    />
                    <span className="relative">
                      {mode === "count" ? format(v) : `${num(share * 100, 1)}%`}
                    </span>
                  </td>
                );
              })}
              <td className="text-right mono text-[11px] text-faint pl-2">
                {totals[i]!.toLocaleString()}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A figure that is a single number: label, value, optional hint. */
export function StatTile({
  label,
  value,
  unit,
  hint,
}: {
  label: string;
  value: string;
  unit?: string;
  hint?: string;
}) {
  return (
    <div className="rounded-lg border p-2.5" style={{ borderColor: "var(--panel-border)" }}>
      <div className="text-[10px] uppercase tracking-wider text-faint">{label}</div>
      <div className="text-xl font-semibold leading-tight mt-0.5">
        {value}
        {unit ? <span className="text-[10px] text-faint font-normal ml-1">{unit}</span> : null}
      </div>
      {hint && <div className="text-[10px] text-faint leading-snug mt-0.5">{hint}</div>}
    </div>
  );
}

/** Page section: a panel with a title, a lede and its content. */
export function Section({
  id,
  title,
  lede,
  children,
  aside,
}: {
  id?: string;
  title: string;
  lede?: ReactNode;
  children: ReactNode;
  aside?: ReactNode;
}) {
  const { t } = useT();
  return (
    <section id={id} className="panel p-5 md:p-6 scroll-mt-4">
      <div className="flex items-start gap-3 mb-1">
        <h2 className="text-base font-bold">{t(title)}</h2>
        {aside && <div className="ml-auto shrink-0">{aside}</div>}
      </div>
      {lede && <div className="text-[12px] text-dim leading-relaxed mb-4 max-w-3xl">{lede}</div>}
      {children}
    </section>
  );
}

/** Small key/value row used inside section grids. */
export function KV({ k, v }: { k: string; v: ReactNode }) {
  const { t } = useT();
  return (
    <div className="flex items-baseline justify-between gap-3 text-[11px] py-0.5">
      <span className="text-faint">{t(k)}</span>
      <span className="mono text-right">{v}</span>
    </div>
  );
}
