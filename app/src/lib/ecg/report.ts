/**
 * Session reports and exports.
 *
 * A "session" here is a span of the loaded segment that the user marks by
 * starting and stopping the recorder. The report is a plain object, and the two
 * exports are derived from it:
 *
 *   JSON  the whole report, including the summary statistics
 *   CSV   one row per beat, which is what a reader needs to plot or re-analyse
 *
 * Everything is computed from data already on the main thread (peaks,
 * annotations, and the delineation arrays), so a report is a pure function of
 * what is on screen — no second pass over the signal, and no numbers that the
 * UI is not also showing.
 */

import type { DelinArrays } from "./delineate";
import { computeHrv, type HrvResult } from "./hrv";
import type { AnnotationTrack } from "../signal/annotations";
import type { BeatSymbol } from "../signal/types";

export interface SessionSpan {
  record: string;
  fs: number;
  fromS: number;
  toS: number;
  /** Wall-clock, epoch ms, for the report header. */
  startedAt: number;
  endedAt: number;
}

export interface BeatRow {
  sample: number;
  tS: number;
  symbol: BeatSymbol | null;
  rrMs: number | null;
  prMs: number | null;
  qrsMs: number | null;
  qtMs: number | null;
  qtcMs: number | null;
}

export interface SessionReport {
  schema: "rpeak-session/1";
  record: string;
  fs: number;
  span: { fromS: number; toS: number; durationS: number };
  wall: { startedAt: string; endedAt: string; elapsedS: number };
  peaks: { source: string; total: number; inSpan: number };
  beats: { rows: number; byClass: Record<BeatSymbol, number> | null };
  rate: { meanRrMs: number; minRrMs: number; maxRrMs: number; heartRateBpm: number } | null;
  intervals: {
    prMs: number | null;
    qrsMs: number | null;
    qtMs: number | null;
    qtcMs: number | null;
    missingP: number;
  } | null;
  hrv: {
    sdnnMs: number;
    rmssdMs: number;
    pnn50: number;
    pnn20: number;
    lf: number | null;
    hf: number | null;
    lfHf: number | null;
    lfNu: number | null;
    hfNu: number | null;
    gated: number;
  } | null;
  notes: string[];
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  xs.sort((a, b) => a - b);
  const m = xs.length >> 1;
  return xs.length % 2 ? xs[m]! : (xs[m - 1]! + xs[m]!) / 2;
}

function finite(v: number): number | null {
  return Number.isFinite(v) ? v : null;
}

interface BuildArgs {
  span: SessionSpan;
  peaks: Int32Array | null;
  peakSource: string;
  track: AnnotationTrack | null;
  delin: { peaks: Int32Array; arrays: DelinArrays } | null;
}

/** Per-beat rows for the span, aligned with the delineation arrays. */
export function buildBeatRows({
  span,
  peaks,
  track,
  delin,
}: Omit<BuildArgs, "peakSource">): BeatRow[] {
  if (!peaks || peaks.length === 0) return [];
  const fs = span.fs;
  const fromS = Math.round(span.fromS * fs);
  const toS = Math.round(span.toS * fs);

  // Symbol lookup by sample, because the report is driven by the peak list
  // (which may be the detector's) and the classes come from the annotations.
  const symbols = new Map<number, BeatSymbol>();
  if (track) for (const b of track.beats) symbols.set(b.sample, b.symbol);

  const delinIndex = new Map<number, number>();
  if (delin) {
    for (let i = 0; i < delin.peaks.length; i++) delinIndex.set(delin.peaks[i]!, i);
  }

  const rows: BeatRow[] = [];
  for (let i = 0; i < peaks.length; i++) {
    const s = peaks[i]!;
    if (s < fromS || s > toS) continue;
    const di = delinIndex.get(s);
    const a = delin?.arrays;
    rows.push({
      sample: s,
      tS: s / fs,
      symbol: symbols.get(s) ?? null,
      rrMs: i > 0 ? ((s - peaks[i - 1]!) / fs) * 1000 : null,
      prMs: di != null ? finite(a!.prMs[di]!) : null,
      qrsMs: di != null ? finite(a!.qrsMs[di]!) : null,
      qtMs: di != null ? finite(a!.qtMs[di]!) : null,
      qtcMs: di != null ? finite(a!.qtcMs[di]!) : null,
    });
  }
  return rows;
}

export function buildSessionReport(args: BuildArgs): SessionReport {
  const { span, peaks, peakSource, track, delin } = args;
  const rows = buildBeatRows(args);
  const inSpan = rows.map((r) => r.sample);

  const byClass = track
    ? rows.reduce(
        (acc, r) => {
          if (r.symbol) acc[r.symbol]++;
          return acc;
        },
        { N: 0, S: 0, V: 0, Q: 0 } as Record<BeatSymbol, number>,
      )
    : null;

  // Rate statistics from the in-span intervals only, so the number describes
  // the marked session and not the whole segment.
  const rrs = rows.map((r) => r.rrMs).filter((v): v is number => v != null && v > 0);
  const rate =
    rrs.length > 0
      ? {
          meanRrMs: rrs.reduce((a, b) => a + b, 0) / rrs.length,
          minRrMs: Math.min(...rrs),
          maxRrMs: Math.max(...rrs),
          heartRateBpm: 60000 / (rrs.reduce((a, b) => a + b, 0) / rrs.length),
        }
      : null;

  // Interval medians over the span's delineated beats.
  let intervals: SessionReport["intervals"] = null;
  if (delin) {
    const prs: number[] = [];
    const qrss: number[] = [];
    const qts: number[] = [];
    const qtcs: number[] = [];
    let missingP = 0;
    const set = new Set(inSpan);
    for (let i = 0; i < delin.peaks.length; i++) {
      if (!set.has(delin.peaks[i]!)) continue;
      const a = delin.arrays;
      if (Number.isFinite(a.prMs[i]!)) prs.push(a.prMs[i]!);
      else missingP++;
      if (Number.isFinite(a.qrsMs[i]!)) qrss.push(a.qrsMs[i]!);
      if (Number.isFinite(a.qtMs[i]!)) qts.push(a.qtMs[i]!);
      if (Number.isFinite(a.qtcMs[i]!)) qtcs.push(a.qtcMs[i]!);
    }
    intervals = {
      prMs: median(prs),
      qrsMs: median(qrss),
      qtMs: median(qts),
      qtcMs: median(qtcs),
      missingP,
    };
  }

  const hrv = summarizeHrv(computeHrv(inSpan, span.fs));

  const notes: string[] = [];
  if (!delin) {
    notes.push("PQRST delineation was not run for this session; interval columns are empty.");
  }
  if (byClass === null) {
    notes.push("Reference annotations were not loaded; beat classes are unknown.");
  }
  notes.push("QTc is Bazett (QT / sqrt(RR)). Intervals outside 300-2000 ms are excluded from HRV.");

  return {
    schema: "rpeak-session/1",
    record: span.record,
    fs: span.fs,
    span: {
      fromS: span.fromS,
      toS: span.toS,
      durationS: Math.max(0, span.toS - span.fromS),
    },
    wall: {
      startedAt: new Date(span.startedAt).toISOString(),
      endedAt: new Date(span.endedAt).toISOString(),
      elapsedS: Math.max(0, (span.endedAt - span.startedAt) / 1000),
    },
    peaks: { source: peakSource, total: peaks?.length ?? 0, inSpan: rows.length },
    beats: { rows: rows.length, byClass },
    rate,
    intervals,
    hrv,
    notes,
  };
}

function summarizeHrv(h: HrvResult): SessionReport["hrv"] {
  if (!h.ok) return null;
  return {
    sdnnMs: h.sdnnMs,
    rmssdMs: h.rmssdMs,
    pnn50: h.pnn50,
    pnn20: h.pnn20,
    lf: h.freq?.lf ?? null,
    hf: h.freq?.hf ?? null,
    lfHf: h.freq?.lfHf ?? null,
    lfNu: h.freq?.lfNu ?? null,
    hfNu: h.freq?.hfNu ?? null,
    gated: h.gated,
  };
}

/** One row per beat. Values are printed at 1 decimal; empty when not measured.
 *
 *  Dot decimals on purpose, unlike the panels: this file is comma-separated,
 *  so a Vietnamese comma decimal would split one value into two fields. */

export function beatsToCsv(rows: BeatRow[]): string {
  const head = "time_s,sample,symbol,rr_ms,pr_ms,qrs_ms,qt_ms,qtc_ms";
  const num = (v: number | null, d = 1) => (v == null ? "" : v.toFixed(d));
  const body = rows.map((r) =>
    [
      r.tS.toFixed(3),
      r.sample,
      r.symbol ?? "",
      num(r.rrMs),
      num(r.prMs),
      num(r.qrsMs),
      num(r.qtMs),
      num(r.qtcMs),
    ].join(","),
  );
  return [head, ...body].join("\n");
}

/** Trigger a browser download without touching the DOM outside the document. */
export function downloadText(filename: string, text: string, mime: string): void {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoking immediately can cancel the download in some browsers; a tick is
  // enough for the navigation to start.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function reportFilename(report: SessionReport, ext: string): string {
  const f = Math.round(report.span.fromS);
  const t = Math.round(report.span.toS);
  return `${report.record}_${f}-${t}s.${ext}`;
}
