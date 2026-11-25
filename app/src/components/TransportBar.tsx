import { memo } from "react";
import type { PlaybackStatus } from "../lib/playback";
import { SPEEDS } from "../lib/playback";
import { useT } from "../lib/i18n";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  PauseIcon,
  PlayIcon,
  SkipBackIcon,
  SkipForwardIcon,
} from "./icons";

interface Props {
  status: PlaybackStatus;
  disabled: boolean;
  onToggle: () => void;
  onSpeed: (speed: number) => void;
  onSeek: (seconds: number) => void;
  onSkip: (deltaSeconds: number) => void;
  onBeatStep: (dir: -1 | 1) => void;
}

function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/**
 * Floating transport, styled like the reference's panels so it reads as part
 * of the same dashboard rather than a media player bolted on.
 */
export const TransportBar = memo(function TransportBar({
  status,
  disabled,
  onToggle,
  onSpeed,
  onSeek,
  onSkip,
  onBeatStep,
}: Props) {
  const { t, num } = useT();
  const pct = status.duration > 0 ? (status.position / status.duration) * 100 : 0;

  return (
    <div className="absolute bottom-5 left-1/2 -translate-x-1/2 z-30 panel px-4 py-3 flex items-center gap-3 w-[min(860px,calc(100vw-6rem))]">
      <button
        type="button"
        onClick={onToggle}
        disabled={disabled}
        className={`w-11 h-11 shrink-0 rounded-full flex items-center justify-center border transition-colors ${
          disabled
            ? "bg-gray-500/15 text-gray-500 border-gray-500/25 cursor-not-allowed"
            : status.playing
              ? "bg-blue-500/25 text-blue-300 border-blue-500/40 hover:bg-blue-500/35"
              : "bg-blue-500/20 text-blue-400 border-blue-500/30 hover:bg-blue-500/30"
        }`}
        title={t(status.playing ? "Pause (Space)" : "Play (Space)")}
        aria-label={t(status.playing ? "Pause" : "Play")}
      >
        {status.playing ? <PauseIcon size={18} /> : <PlayIcon size={18} />}
      </button>

      <div className="flex items-center gap-0.5 shrink-0">
        <button
          type="button"
          className="icon-btn w-8 h-8"
          onClick={() => onBeatStep(-1)}
          disabled={disabled}
          title={t("Previous beat (Shift+Left)")}
          aria-label={t("Previous beat")}
        >
          <ChevronLeftIcon size={16} />
        </button>
        <button
          type="button"
          className="icon-btn w-8 h-8"
          onClick={() => onSkip(-10)}
          disabled={disabled}
          title={t("Back 10 s (Left)")}
          aria-label={t("Back 10 seconds")}
        >
          <SkipBackIcon size={15} />
        </button>
        <button
          type="button"
          className="icon-btn w-8 h-8"
          onClick={() => onSkip(10)}
          disabled={disabled}
          title={t("Forward 10 s (Right)")}
          aria-label={t("Forward 10 seconds")}
        >
          <SkipForwardIcon size={15} />
        </button>
        <button
          type="button"
          className="icon-btn w-8 h-8"
          onClick={() => onBeatStep(1)}
          disabled={disabled}
          title={t("Next beat (Shift+Right)")}
          aria-label={t("Next beat")}
        >
          <ChevronRightIcon size={16} />
        </button>
      </div>

      <div className="flex-1 min-w-0">
        <input
          type="range"
          className="seek w-full"
          min={0}
          max={Math.max(status.duration, 0.001)}
          step={0.05}
          value={Math.min(status.position, status.duration)}
          onChange={(e) => onSeek(Number(e.target.value))}
          disabled={disabled}
          aria-label={t("Seek")}
        />
        <div className="flex justify-between mt-1.5 mono text-[11px] text-dim">
          <span className="tabular-nums">
            {clock(status.position)}
            <span className="text-faint"> / {clock(status.duration)}</span>
          </span>
          <span className="text-faint">{num(pct, 1)}%</span>
        </div>
      </div>

      <div className="flex items-center gap-1 shrink-0">
        {SPEEDS.map((s) => (
          <button
            key={s}
            type="button"
            className="seg-btn mono"
            data-active={status.speed === s}
            onClick={() => onSpeed(s)}
            disabled={disabled}
            title={`${t("Playback speed")} ${s}×`}
          >
            {s}&times;
          </button>
        ))}
      </div>
    </div>
  );
});
