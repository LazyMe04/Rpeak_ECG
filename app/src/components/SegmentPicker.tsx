import { memo, useMemo } from "react";
import type { SegmentInfo } from "../lib/signal/types";
import { ListIcon } from "./icons";
import { Panel } from "./Panel";
import { useT } from "../lib/i18n";
import { qualityLabel, qualityTone } from "../lib/quality";

interface Props {
  segments: SegmentInfo[];
  current: string | null;
  onSelect: (seg: SegmentInfo) => void;
  onClose: () => void;
}

function f1Tone(f1: number | null): string {
  if (f1 == null) return "text-faint";
  if (f1 >= 98) return "text-green-400";
  if (f1 >= 95) return "text-yellow-400";
  return "text-red-400";
}

/**
 * Segment browser. 24 segments across 12 patients, grouped so a patient's two
 * recordings sit together -- they are the same chest lead, ~70 minutes apart,
 * which makes them the natural pair to compare.
 */
export const SegmentPicker = memo(function SegmentPicker({
  segments,
  current,
  onSelect,
  onClose,
}: Props) {
  const { t, num } = useT();
  const groups = useMemo(() => {
    const map = new Map<number, SegmentInfo[]>();
    for (const s of segments) {
      const list = map.get(s.patient) ?? [];
      list.push(s);
      map.set(s.patient, list);
    }
    return [...map.entries()].sort((a, b) => a[0] - b[0]);
  }, [segments]);

  return (
    <Panel
      title={t("Dataset")}
      icon={<ListIcon size={18} className="text-blue-400" />}
      onClose={onClose}
      testId="segments"
      className="absolute left-20 top-20 w-[min(360px,calc(100vw-6rem))] max-h-[calc(100vh-13rem)] z-30 flex flex-col"
      headerClassName="px-4 pt-4 pb-1"
      bodyClassName="px-4 pb-4 flex flex-col min-h-0"
    >
      <div className="text-[11px] text-faint mb-3">
        {t("Icentia11k · {n} segments · {p} patients · 250 Hz", {
          n: segments.length,
          p: groups.length,
        })}
      </div>

      <div className="scrollable-content -mr-2 pr-2">
        {groups.map(([patient, list]) => (
          <div key={patient} className="mb-3">
            <div className="text-[11px] uppercase tracking-wider text-faint mb-1.5">
              {t("Patient {id}", { id: String(patient).padStart(5, "0") })}
            </div>
            <div className="space-y-1">
              {list.map((seg) => {
                const active = seg.record === current;
                return (
                  <button
                    key={seg.record}
                    type="button"
                    onClick={() => onSelect(seg)}
                    className={`w-full text-left rounded-lg px-2.5 py-2 border transition-colors ${
                      active
                        ? "border-blue-400/60 bg-blue-500/15"
                        : "border-transparent hover:bg-[var(--panel-hover)]"
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="mono text-[13px] font-semibold">{seg.record}</span>
                      <span className={`mono text-[11px] ${f1Tone(seg.detector?.f1 ?? null)}`}>
                        F1 {seg.detector ? num(seg.detector.f1, 1) : "--"}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 mt-0.5 text-[11px] text-dim">
                      <span className="mono">
                        {seg.hrMean != null ? `${num(seg.hrMean, 0)} BPM` : "--"}
                      </span>
                      <span className="text-faint">·</span>
                      <span className="mono">{t("{n} beats", { n: seg.nBeats })}</span>
                      <span className="text-faint">·</span>
                      <span className="mono">
                        {t("{n} min", { n: num(seg.durationS / 60, 0) })}
                      </span>
                      {seg.counts.V > 0 && (
                        <span className="text-red-400 mono">{seg.counts.V}V</span>
                      )}
                      {seg.counts.S > 0 && (
                        <span className="text-yellow-400 mono">{seg.counts.S}S</span>
                      )}
                    </div>
                    {/* Only when it is not fine: a row of green "normal" ticks
                        is noise, and the point of the label here is to warn
                        before a reader spends time on a recording that cannot
                        be read. The vitals panel names it either way. */}
                    {seg.quality !== "ok" && (
                      <div className={`mt-0.5 text-[11px] ${qualityTone(seg.quality)}`}>
                        {t(qualityLabel(seg.quality))}
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </Panel>
  );
});
