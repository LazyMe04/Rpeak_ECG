import { memo, useEffect, useMemo, useState } from "react";
import type { AnnotationTrack } from "../lib/signal/annotations";
import type { DelinArrays } from "../lib/ecg/delineate";
import {
  beatsToCsv,
  buildBeatRows,
  buildSessionReport,
  downloadText,
  reportFilename,
  type BeatRow,
  type SessionReport,
} from "../lib/ecg/report";
import type { BeatSymbol } from "../lib/signal/types";
import { CircleDotIcon, DownloadIcon } from "./icons";
import { Panel } from "./Panel";
import { useT } from "../lib/i18n";

interface Props {
  record: string | null;
  fs: number;
  durationS: number;
  positionS: number;
  track: AnnotationTrack | null;
  peaks: Int32Array | null;
  peakSource: string;
  delin: { peaks: Int32Array; arrays: DelinArrays } | null;
  delineating: boolean;
  onClose: () => void;
}

const SYMBOLS: BeatSymbol[] = ["N", "S", "V", "Q"];

function mmss(s: number): string {
  const v = Math.max(0, Math.floor(s));
  const m = Math.floor(v / 60);
  return `${m}:${String(v % 60).padStart(2, "0")}`;
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-dim">{label}</span>
      <span className="mono text-right">{value}</span>
    </div>
  );
}

/**
 * Session recording and report.
 *
 * The recorder marks a span of the current segment: press start, play or scrub,
 * press stop. The report is built from that span only, so the numbers describe
 * what was marked rather than the whole 70-minute record. "Whole segment"
 * produces the same report for the entire segment in one click, which is the
 * common case.
 *
 * Exports are plain files: a JSON summary and a per-beat CSV. Nothing is
 * uploaded anywhere, and no state is kept after the page closes.
 */
export const ReportPanel = memo(function ReportPanel({
  record,
  fs,
  durationS,
  positionS,
  track,
  peaks,
  peakSource,
  delin,
  delineating,
  onClose,
}: Props) {
  const { t, num } = useT();
  // "--" for a value the report does not carry, otherwise the language's
  // decimal convention: 0,596 rather than 0.596 in Vietnamese.
  const f = (v: number | null | undefined, d = 0) =>
    v == null || !Number.isFinite(v) ? "--" : num(v, d);
  const [rec, setRec] = useState<{ fromS: number; startedAt: number } | null>(null);
  const [result, setResult] = useState<{ report: SessionReport; rows: BeatRow[] } | null>(null);
  const [note, setNote] = useState<string | null>(null);

  // Wall-clock elapsed while recording. The App already re-renders at ~8 Hz
  // during playback, but a paused recorder still needs a ticking number.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!rec) return;
    const id = window.setInterval(() => setTick((t) => t + 1), 1000);
    return () => window.clearInterval(id);
  }, [rec]);

  const args = useMemo(
    () => ({
      peaks,
      peakSource,
      track,
      delin,
    }),
    [peaks, peakSource, track, delin],
  );

  const finish = (fromS: number, toS: number, startedAt: number) => {
    if (!record) return;
    if (toS - fromS < 0.2) {
      setNote(t("The playhead has not moved past the start of the session yet."));
      return;
    }
    const span = { record, fs, fromS, toS, startedAt, endedAt: Date.now() };
    const report = buildSessionReport({ span, ...args });
    const rows = buildBeatRows({ span, ...args });
    setResult({ report, rows });
    setNote(null);
    setRec(null);
  };

  const start = () => {
    if (!record) return;
    setResult(null);
    setNote(null);
    setRec({ fromS: positionS, startedAt: Date.now() });
  };

  const stop = () => {
    if (!rec) return;
    finish(rec.fromS, positionS, rec.startedAt);
  };

  const whole = () => {
    if (!record || durationS <= 0) return;
    const now = Date.now();
    finish(0, durationS, now);
  };

  const exportJson = () => {
    if (!result) return;
    downloadText(
      reportFilename(result.report, "json"),
      JSON.stringify(result.report, null, 2),
      "application/json",
    );
  };

  const exportCsv = () => {
    if (!result) return;
    downloadText(reportFilename(result.report, "csv"), beatsToCsv(result.rows), "text/csv");
  };

  const elapsedSignal = rec ? positionS - rec.fromS : 0;
  const elapsedWall = rec ? (Date.now() - rec.startedAt) / 1000 : 0;

  return (
    <Panel
      title={t("Session")}
      icon={<CircleDotIcon size={18} className="text-red-400" />}
      onClose={onClose}
      testId="report"
      className="absolute right-4 top-20 w-[min(380px,calc(100vw-6rem))] z-30"
      headerClassName="px-4 pt-4 pb-3"
      bodyClassName="px-4 pb-4"
    >
      <div className="flex items-center gap-2 mb-3">
        {rec ? (
          <button
            type="button"
            onClick={stop}
            className="flex-1 rounded-lg px-3 py-2 text-sm font-semibold border transition-colors"
            style={{
              borderColor: "rgba(239,68,68,0.5)",
              background: "rgba(239,68,68,0.16)",
              color: "var(--danger)",
            }}
          >
            {t("Stop & build report")}
          </button>
        ) : (
          <button
            type="button"
            onClick={start}
            disabled={!record}
            className="flex-1 rounded-lg px-3 py-2 text-sm font-semibold border transition-colors disabled:opacity-40"
            style={{ borderColor: "var(--panel-border)", background: "var(--panel-hover)" }}
          >
            {t("Start session")}
          </button>
        )}
        <button
          type="button"
          onClick={whole}
          disabled={!record || rec !== null}
          className="rounded-lg px-3 py-2 text-sm border transition-colors disabled:opacity-40"
          style={{ borderColor: "var(--panel-border)", background: "var(--panel-hover)" }}
        >
          {t("Whole segment")}
        </button>
      </div>

      {rec && (
        <div
          className="rounded-lg border p-3 mb-3 text-[12px]"
          style={{ borderColor: "var(--panel-border)" }}
        >
          <div className="flex items-center gap-2 text-red-400 font-semibold mb-1.5">
            <span className="relative flex w-2.5 h-2.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-60" />
              <span className="relative inline-flex rounded-full w-2.5 h-2.5 bg-red-500" />
            </span>
            {t("Recording")}
          </div>
          <Row label={t("From")} value={mmss(rec.fromS)} />
          <Row label={t("Signal elapsed")} value={mmss(elapsedSignal)} />
          <Row label={t("Wall elapsed")} value={mmss(elapsedWall)} />
          <div className="text-[11px] text-faint mt-1.5 leading-snug">
            {t(
              "Play or scrub the trace, then stop. The report covers the signal span between start and stop.",
            )}
          </div>
        </div>
      )}

      {note && <div className="text-[11px] text-yellow-400 mb-3 leading-snug">{note}</div>}

      {delineating && (
        <div className="text-[11px] text-cyan-400 mb-2 flex items-center gap-1.5">
          <span className="animate-spin w-3 h-3 border border-current border-t-transparent rounded-full" />
          {t("Delineating PQRST for the interval columns…")}
        </div>
      )}

      {result ? (
        <>
          <div
            className="rounded-lg border p-3 mb-3 text-[12px] space-y-1.5"
            style={{ borderColor: "var(--panel-border)" }}
          >
            <div className="text-[11px] uppercase tracking-wider text-faint mb-1">
              {t("Report · {record}", { record: result.report.record })}
            </div>
            <Row
              label={t("Span")}
              value={`${mmss(result.report.span.fromS)} → ${mmss(
                result.report.span.toS,
              )} (${mmss(result.report.span.durationS)})`}
            />
            <Row
              label={t("Beats in span")}
              value={`${result.report.beats.rows} · ${t(result.report.peaks.source)}`}
            />
            {result.report.rate && (
              <>
                <Row
                  label={t("Mean R-R")}
                  value={`${f(result.report.rate.meanRrMs)} ms (${f(
                    result.report.rate.heartRateBpm,
                  )} bpm)`}
                />
                <Row
                  label={t("R-R range")}
                  value={`${f(result.report.rate.minRrMs)}–${f(result.report.rate.maxRrMs)} ms`}
                />
              </>
            )}
            {result.report.intervals ? (
              <Row
                label={t("Median PR/QRS/QT")}
                value={`${f(result.report.intervals.prMs)} / ${f(
                  result.report.intervals.qrsMs,
                )} / ${f(result.report.intervals.qtMs)} ms`}
              />
            ) : (
              <Row label={t("Intervals")} value={t("not measured")} />
            )}
            {result.report.hrv && (
              <>
                <Row
                  label={t("SDNN / RMSSD")}
                  value={`${f(result.report.hrv.sdnnMs)} / ${f(result.report.hrv.rmssdMs)} ms`}
                />
                <Row
                  label="LF/HF"
                  value={result.report.hrv.lfHf == null ? "--" : f(result.report.hrv.lfHf, 2)}
                />
              </>
            )}
            {result.report.beats.byClass && (
              <div className="flex items-center justify-between pt-1">
                <span className="text-dim">{t("Classes")}</span>
                <span className="flex gap-2">
                  {SYMBOLS.map((s) => (
                    <span key={s} className="mono text-[11px]">
                      <span style={{ color: `var(--beat-${s})` }}>{s}</span>{" "}
                      {result.report.beats.byClass![s]}
                    </span>
                  ))}
                </span>
              </div>
            )}
          </div>

          <div className="flex gap-2">
            <button
              type="button"
              onClick={exportCsv}
              className="flex-1 flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold border transition-colors"
              style={{ borderColor: "var(--panel-border)", background: "var(--panel-hover)" }}
            >
              <DownloadIcon size={14} /> {t("Beats CSV")}
            </button>
            <button
              type="button"
              onClick={exportJson}
              className="flex-1 flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold border transition-colors"
              style={{ borderColor: "var(--panel-border)", background: "var(--panel-hover)" }}
            >
              <DownloadIcon size={14} /> {t("Report JSON")}
            </button>
          </div>
          <div className="text-[11px] text-faint mt-2 leading-snug">
            {t(
              "CSV: one row per beat with R-R and PQRST intervals. JSON: the summary above plus the conventions used. Both are written to your downloads folder.",
            )}
          </div>
        </>
      ) : (
        !rec && (
          <div className="text-[11px] text-faint leading-snug">
            {t("No report yet. Start a session and stop it, or report the whole segment.")}
            {!record ? t(" Load a segment first.") : ""}
          </div>
        )
      )}
    </Panel>
  );
});
