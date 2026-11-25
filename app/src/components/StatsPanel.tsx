import { memo, useMemo } from "react";
import { PeakTrack } from "../lib/signal/annotations";
import type { AnnotationTrack } from "../lib/signal/annotations";
import type { BeatSymbol, SegmentInfo } from "../lib/signal/types";
import type { DelineationResult } from "../hooks/useDelineation";
import { HeartIcon, TrendingUpIcon } from "./icons";
import { Panel } from "./Panel";
import { useT } from "../lib/i18n";
import { qualityLabel, qualityTone } from "../lib/quality";

interface Props {
  track: AnnotationTrack | null;
  fs: number;
  positionSamples: number;
  segment: SegmentInfo | null;
  /** Detector output for the loaded segment, once the worker answers. */
  detection: { peaks: Int32Array; ms: number; record: string } | null;
  detecting: boolean;
  detectError: string | null;
  /** PQRST boundaries for the same segment, once the worker answers. */
  delineation: DelineationResult | null;
  delineating: boolean;
  delinError: string | null;
  onClose: () => void;
}

const SYMBOLS: BeatSymbol[] = ["N", "S", "V", "Q"];

const CLASS_LABEL: Record<BeatSymbol, string> = {
  N: "Normal",
  S: "Supraventricular",
  V: "Ventricular",
  Q: "Unclassifiable",
};

const CLASS_VAR: Record<BeatSymbol, string> = {
  N: "var(--beat-N)",
  S: "var(--beat-S)",
  V: "var(--beat-V)",
  Q: "var(--beat-Q)",
};

function f1Tone(f1: number | null | undefined): string {
  if (f1 == null) return "text-faint";
  if (f1 >= 98) return "text-green-400";
  if (f1 >= 95) return "text-yellow-400";
  return "text-red-400";
}

/**
 * Live vitals for the replayed segment.
 *
 * The rate numbers come from the live detector when it has a result for this
 * segment, and from the reference annotations otherwise; the panel says which,
 * because the two disagree on a few percent of beats and a number without its
 * source is not interpretable. Beat classes are always the reference labels --
 * the detector locates R peaks and does not classify them.
 */
export const StatsPanel = memo(function StatsPanel({
  track,
  fs,
  positionSamples,
  segment,
  detection,
  detecting,
  detectError,
  delineation,
  delineating,
  delinError,
  onClose,
}: Props) {
  const { t, num } = useT();
  const peaks = useMemo(() => (detection ? new PeakTrack(detection.peaks) : null), [detection]);

  const stats = useMemo(() => {
    const src = peaks ?? track;
    if (!src) return null;
    const rr = src.medianRR(positionSamples, fs, 12);
    if (peaks) {
      return {
        rr,
        bpm: rr ? (60 * fs) / rr : null,
        seen: peaks.countUpTo(positionSamples),
      };
    }
    const counts = track!.countsUpTo(positionSamples);
    return {
      rr,
      bpm: rr ? (60 * fs) / rr : null,
      seen: counts.N + counts.S + counts.V + counts.Q,
      counts,
    };
  }, [peaks, track, fs, positionSamples]);

  const counts = useMemo(
    () => track?.countsUpTo(positionSamples) ?? null,
    [track, positionSamples],
  );
  const fromDetector = peaks !== null;

  // The delineated beat nearest the playhead. Scrubbing therefore reads like
  // moving a caliper across the strip, which is how these numbers are read on
  // paper; the segment medians underneath are the stable summary.
  const beatIv = useMemo(() => {
    if (!delineation || delineation.peaks.length === 0) return null;
    const pk = delineation.peaks;
    let lo = 0;
    let hi = pk.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (pk[mid]! < positionSamples) lo = mid + 1;
      else hi = mid;
    }
    const cand = [lo - 1, lo].filter((i) => i >= 0 && i < pk.length);
    if (cand.length === 0) return null;
    let best = cand[0]!;
    for (const i of cand) {
      if (Math.abs(pk[i]! - positionSamples) < Math.abs(pk[best]! - positionSamples)) best = i;
    }
    const a = delineation.delin;
    return {
      prMs: a.prMs[best]!,
      qrsMs: a.qrsMs[best]!,
      qtMs: a.qtMs[best]!,
      qtcMs: a.qtcMs[best]!,
    };
  }, [delineation, positionSamples]);

  const ms = (v: number | null | undefined) =>
    v == null || !Number.isFinite(v) ? "--" : `${Math.round(v)}`;

  const bpm = stats?.bpm ?? null;
  const bpmColor =
    bpm == null
      ? "text-faint"
      : bpm >= 60 && bpm <= 100
        ? "text-green-400"
        : bpm < 60
          ? "text-yellow-400"
          : "text-red-400";

  const maxCount = counts ? Math.max(1, ...SYMBOLS.map((s) => counts[s])) : 1;

  return (
    <Panel
      title={t("Vitals")}
      icon={<TrendingUpIcon size={18} className="text-cyan-400" />}
      onClose={onClose}
      testId="stats"
      className="absolute right-4 top-20 bottom-[104px] w-[min(340px,calc(100vw-6rem))] z-30 flex flex-col"
      bodyClassName="scrollable-content px-4 pb-4 flex-1 min-h-0"
    >
      {/* Source of the rate numbers */}
      <div className="flex items-center justify-between mb-3 text-[11px]">
        <span className="uppercase tracking-wider text-faint">{t("Source")}</span>
        {detecting ? (
          <span className="flex items-center gap-1.5 text-blue-400">
            <span className="animate-spin w-3 h-3 border border-current border-t-transparent rounded-full" />
            {t("Detecting…")}
          </span>
        ) : detectError ? (
          <span className="text-red-400" title={detectError}>
            {t("Detector failed")}
          </span>
        ) : fromDetector ? (
          <span className="text-green-400">
            {t("Live detector · {ms} ms", { ms: Math.round(detection!.ms) })}
          </span>
        ) : (
          <span className="text-dim">{t("Reference annotations")}</span>
        )}
      </div>

      {/* Heart rate */}
      <div className="rounded-lg border p-3 mb-3" style={{ borderColor: "var(--panel-border)" }}>
        <div className="flex items-end justify-between">
          <span className="text-sm text-dim">{t("Heart rate")}</span>
          <div className="flex items-center gap-1.5">
            <HeartIcon
              size={16}
              className={bpm != null && bpm >= 60 && bpm <= 100 ? "text-red-400" : "text-faint"}
            />
            <span className={`mono font-bold text-2xl leading-none ${bpmColor}`}>
              {bpm == null ? "--" : Math.round(bpm)}
            </span>
            <span className="text-xs text-dim mb-0.5">BPM</span>
          </div>
        </div>
        <div className="text-[11px] text-faint mt-2">
          {t("Median of the last 12 s of R-R intervals")}
        </div>{" "}
      </div>

      <div className="grid grid-cols-2 gap-2 mb-3">
        <div className="rounded-lg border p-2.5" style={{ borderColor: "var(--panel-border)" }}>
          <div className="text-[11px] text-dim">R-R</div>
          <div className="mono text-sm font-semibold">
            {stats?.rr ? `${Math.round((stats.rr / fs) * 1000)} ms` : "--"}
          </div>
        </div>
        <div className="rounded-lg border p-2.5" style={{ borderColor: "var(--panel-border)" }}>
          <div className="text-[11px] text-dim">{t("Beats so far")}</div>
          <div className="mono text-sm font-semibold">{stats ? stats.seen : "--"}</div>
        </div>
      </div>

      {/* Intervals */}
      <div className="rounded-lg border p-3 mb-3" style={{ borderColor: "var(--panel-border)" }}>
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm text-dim">{t("Intervals")}</span>
          {delineating ? (
            <span className="flex items-center gap-1.5 text-[11px] text-cyan-400">
              <span className="animate-spin w-3 h-3 border border-current border-t-transparent rounded-full" />
              {t("Delineating…")}
            </span>
          ) : delinError ? (
            <span className="text-[11px] text-red-400" title={delinError}>
              {t("Delineation failed")}
            </span>
          ) : delineation ? (
            <span className="text-[11px] text-cyan-400">{t("nearest beat")}</span>
          ) : (
            <span className="text-[11px] text-faint">{t("PQRST off")}</span>
          )}
        </div>
        <div className="grid grid-cols-4 gap-1.5 text-center">
          {[
            ["PR", beatIv?.prMs],
            ["QRS", beatIv?.qrsMs],
            ["QT", beatIv?.qtMs],
            ["QTc", beatIv?.qtcMs],
          ].map(([label, v]) => (
            <div key={label as string}>
              <div className="text-[10px] uppercase tracking-wider text-faint">{label}</div>
              <div className="mono text-sm font-semibold">
                {ms(v as number | undefined)}
                <span className="text-[9px] text-faint font-normal"> ms</span>
              </div>
            </div>
          ))}
        </div>
        <div className="text-[11px] text-faint mt-2 leading-snug">
          {delineation
            ? t("Segment median PR {pr} · QRS {qrs} · QT {qt} ms · {n} beats in {ms} ms", {
                pr: ms(delineation.median.prMs),
                qrs: ms(delineation.median.qrsMs),
                qt: ms(delineation.median.qtMs),
                n: delineation.peaks.length,
                ms: Math.round(delineation.ms),
              }) +
              (delineation.missingP > 0
                ? t(" No P found on {pct}% of beats.", {
                    pct: Math.round(
                      (100 * delineation.missingP) / Math.max(1, delineation.peaks.length),
                    ),
                  })
                : "")
            : t("Turn on PQRST in the left rail to measure P, QRS and T boundaries.")}
        </div>
      </div>

      {/* Beat classes */}
      <div className="space-y-2">
        <div className="text-[11px] uppercase tracking-wider text-faint">
          {t("Beat classes")}
          {fromDetector ? t(" (reference)") : ""}
        </div>
        {SYMBOLS.map((sym) => {
          const count = counts?.[sym] ?? 0;
          return (
            <div key={sym} className="flex items-center gap-2">
              <span className="mono text-xs w-3 font-bold" style={{ color: CLASS_VAR[sym] }}>
                {sym}
              </span>
              <span className="text-[11px] text-dim w-[92px] truncate">{t(CLASS_LABEL[sym])}</span>
              <div
                className="flex-1 h-1.5 rounded-full overflow-hidden"
                style={{ backgroundColor: "var(--panel-track)" }}
              >
                <div
                  className="h-full rounded-full transition-[width] duration-300"
                  style={{
                    width: `${(count / maxCount) * 100}%`,
                    backgroundColor: CLASS_VAR[sym],
                  }}
                />
              </div>
              <span className="mono text-[11px] w-10 text-right">{count}</span>
            </div>
          );
        })}
      </div>

      {/* Segment facts */}
      <div
        className="mt-4 pt-3 border-t text-[11px] space-y-1.5"
        style={{ borderColor: "var(--panel-border)" }}
      >
        <div className="flex justify-between">
          <span className="text-dim">{t("Segment")}</span>
          <span className="mono">{segment?.record ?? "--"}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-dim">{t("Mean HR (segment)")}</span>
          <span className="mono">
            {segment?.hrMean != null ? `${num(segment.hrMean, 0)} BPM` : "--"}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-dim">{t("Quality")}</span>
          <span className={`mono ${qualityTone(segment?.quality)}`}>
            {t(qualityLabel(segment?.quality))}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-dim">{t("Detector F1")}</span>
          <span className={`mono ${f1Tone(segment?.detector?.f1)}`}>
            {segment?.detector ? `${num(segment.detector.f1, 2)}%` : "--"}
          </span>
        </div>
        <div className="pt-1.5 text-faint leading-snug">
          {fromDetector
            ? t(
                "R-R and heart rate come from the detector running in a worker over the whole segment. Beat classes are the reference labels; the detector does not classify.",
              )
            : t(
                "Vitals come from the reference annotations shipped with the dataset. Turn on the detector in the left rail to compare.",
              )}
        </div>
      </div>
    </Panel>
  );
});
