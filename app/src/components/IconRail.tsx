import { memo, type ReactNode } from "react";
import {
  ActivityIcon,
  BrainIcon,
  CircleDotIcon,
  HeartIcon,
  ListIcon,
  MoonIcon,
  SunIcon,
  TrendingUpIcon,
  WavesIcon,
  ZapIcon,
} from "./icons";
import { useT } from "../lib/i18n";

export type RailPanel = "segments" | "stats" | "hrv" | "report" | "classify" | null;

interface Props {
  theme: "dark" | "light";
  onToggleTheme: () => void;
  panel: RailPanel;
  onPanel: (p: RailPanel) => void;
  showBeats: boolean;
  onToggleBeats: () => void;
  detectOn: boolean;
  detecting: boolean;
  detectError: string | null;
  onToggleDetect: () => void;
  delineateOn: boolean;
  delineating: boolean;
  delinError: string | null;
  onToggleDelineate: () => void;
  classifying: boolean;
  classError: string | null;
}

type Tone = "blue" | "orange" | "cyan" | "purple" | "green" | "yellow" | "red";

const TONE_TEXT: Record<Tone, string> = {
  blue: "text-blue-400",
  orange: "text-orange-400",
  cyan: "text-cyan-400",
  purple: "text-purple-400",
  green: "text-green-400",
  yellow: "text-yellow-400",
  red: "text-red-400",
};

/**
 * Left icon rail, lifted from the reference: 64px wide, expands to 240px on
 * hover, circular translucent buttons that reveal their label.
 *
 * The reference floats it over the full viewport height, which puts it behind
 * the fixed navbar; here it starts below the navbar so the brand stays
 * clickable. Everything else is the same geometry.
 */
export const IconRail = memo(function IconRail({
  theme,
  onToggleTheme,
  panel,
  onPanel,
  showBeats,
  onToggleBeats,
  detectOn,
  detecting,
  detectError,
  onToggleDetect,
  delineateOn,
  delineating,
  delinError,
  onToggleDelineate,
  classifying,
  classError,
}: Props) {
  const { t } = useT();
  const item = (
    key: string,
    tone: Tone,
    active: boolean,
    label: string,
    icon: ReactNode,
    onClick: () => void,
  ) => (
    <div className="relative w-full mb-5" key={key}>
      <div className="flex items-center">
        <div className="w-12 shrink-0 flex justify-center">
          <button
            type="button"
            onClick={onClick}
            className="rail-btn"
            data-tone={tone}
            data-active={active}
            title={label}
            aria-label={label}
            aria-pressed={active}
          >
            {icon}
          </button>
        </div>
        <div className="whitespace-nowrap hidden group-hover:block group-focus-within:block ml-1">
          <span className={`text-sm font-medium ${active ? TONE_TEXT[tone] : "text-slate-400"}`}>
            {label}
          </span>
        </div>
      </div>
    </div>
  );

  return (
    <div className="fixed left-0 top-16 bottom-0 z-40 flex items-center">
      <div className="group h-full py-6 px-2 bg-[var(--rail-bg)] backdrop-blur border-r border-[var(--rail-border)] flex flex-col items-center justify-center transition-[width] duration-300 w-16 hover:w-60 focus-within:w-60 overflow-hidden">
        {item(
          "segments",
          "blue",
          panel === "segments",
          t(panel === "segments" ? "Hide Segments" : "Segments"),
          <ListIcon size={18} />,
          () => onPanel(panel === "segments" ? null : "segments"),
        )}
        {item(
          "beats",
          "orange",
          showBeats,
          t(showBeats ? "Hide Beats" : "Show Beats"),
          <ActivityIcon size={18} />,
          onToggleBeats,
        )}
        {item(
          "detect",
          "green",
          detectOn,
          t(
            detectError
              ? "Detector failed"
              : detecting
                ? "Detecting…"
                : detectOn
                  ? "Hide Detected Peaks"
                  : "Detect R-peaks",
          ),
          <ZapIcon size={18} />,
          onToggleDetect,
        )}
        {item(
          "pqrst",
          "yellow",
          delineateOn,
          t(
            delinError
              ? "Delineation failed"
              : delineating
                ? "Delineating…"
                : delineateOn
                  ? "Hide PQRST"
                  : "Delineate PQRST",
          ),
          <WavesIcon size={18} />,
          onToggleDelineate,
        )}
        {item(
          "stats",
          "cyan",
          panel === "stats",
          t(panel === "stats" ? "Hide Vitals" : "Vitals"),
          <TrendingUpIcon size={18} />,
          () => onPanel(panel === "stats" ? null : "stats"),
        )}
        {item(
          "classify",
          "purple",
          panel === "classify",
          t(
            classError
              ? "Classifier failed"
              : classifying
                ? "Classifying…"
                : panel === "classify"
                  ? "Hide AI Classifier"
                  : "AI Beat Classifier",
          ),
          <BrainIcon size={18} />,
          () => onPanel(panel === "classify" ? null : "classify"),
        )}
        {item(
          "hrv",
          "green",
          panel === "hrv",
          t(panel === "hrv" ? "Hide HRV" : "HRV"),
          <HeartIcon size={18} />,
          () => onPanel(panel === "hrv" ? null : "hrv"),
        )}
        {item(
          "report",
          "red",
          panel === "report",
          t(panel === "report" ? "Hide Session" : "Session Report"),
          <CircleDotIcon size={18} />,
          () => onPanel(panel === "report" ? null : "report"),
        )}
        {item(
          "theme",
          "purple",
          false,
          t(theme === "dark" ? "Light Mode" : "Dark Mode"),
          theme === "dark" ? <SunIcon size={18} /> : <MoonIcon size={18} />,
          onToggleTheme,
        )}
      </div>
    </div>
  );
});
