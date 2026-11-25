import { memo, type ReactNode } from "react";
import { ActivityIcon, ListIcon, TrendingUpIcon } from "./icons";
import { LANGS, LANG_SWITCH_ATTR, useT } from "../lib/i18n";

export type NavKey = "monitor" | "model" | "docs";

interface Props {
  active: NavKey;
  onNavigate: (key: NavKey) => void;
  datasetLabel?: string;
}

/**
 * Fixed black bar, exactly the reference's: 64px tall, blue activity mark,
 * pill-highlighted active link. All three entries are live: the monitor, the
 * model card and the user guide.
 *
 * The language switch lives here rather than on each page because the bar is
 * the one element every page shares — a reader who lands on the guide can
 * change the language without going back to the monitor first.
 */
export const NavBar = memo(function NavBar({ active, onNavigate, datasetLabel }: Props) {
  const { t, lang, setLang } = useT();

  const link = (key: NavKey, label: string, icon?: ReactNode) => (
    <button
      key={key}
      type="button"
      onClick={() => onNavigate(key)}
      aria-label={label}
      aria-current={active === key ? "page" : undefined}
      className={`px-2.5 sm:px-4 py-2 rounded-lg transition-colors flex items-center gap-2 ${
        active === key ? "bg-blue-500/20 text-blue-400" : "text-gray-400 hover:text-white"
      }`}
    >
      {icon}
      {/* The label collapses below `sm`, where three labels plus the wordmark
          do not fit in 430px -- the icon and the accessible name carry it. */}
      <span className="hidden sm:inline">{label}</span>
    </button>
  );

  return (
    <div className="fixed top-0 left-0 right-0 bg-black backdrop-blur-md border-b border-white/10 z-50">
      <div className="mx-auto px-4 max-w-[1600px]">
        <div className="flex items-center justify-between h-16">
          <div className="flex items-center gap-2 shrink-0">
            <ActivityIcon size={24} className="text-blue-400" />
            <span className="text-white font-bold text-lg">Rpeak</span>
          </div>

          {/* Visible at every width: these are the only way to reach the model
              card and the guide, so hiding them on a phone leaves the pages
              unreachable except by editing the URL. */}
          <div className="flex items-center gap-0.5 sm:gap-1">
            {link("monitor", t("Monitor"), <ActivityIcon size={16} />)}
            {link("model", t("AI Model"), <TrendingUpIcon size={16} />)}
            {link("docs", t("Docs"), <ListIcon size={16} />)}
          </div>

          <div className="flex items-center gap-2">
            <div
              className="flex items-center rounded-md border border-white/15 overflow-hidden"
              role="group"
              aria-label={t("Language")}
              {...{ [LANG_SWITCH_ATTR]: "" }}
            >
              {LANGS.map((l) => (
                <button
                  key={l.id}
                  type="button"
                  onClick={() => setLang(l.id)}
                  aria-pressed={lang === l.id}
                  title={l.name}
                  data-lang={l.id}
                  className={`px-1.5 sm:px-2 py-1 text-[11px] font-semibold transition-colors ${
                    lang === l.id
                      ? "bg-blue-500/25 text-blue-300"
                      : "text-gray-400 hover:text-white"
                  }`}
                >
                  {l.label}
                </button>
              ))}
            </div>

            <div className="hidden md:flex items-center gap-2 text-xs text-gray-500">
              <span className="w-1.5 h-1.5 rounded-full bg-green-400" />
              {/* Tagged for scripts/smoke-app.ts, which has no dev handle to read
                  in a release build and so asserts against the rendered DOM. */}
              <span className="font-mono" data-dataset-label>
                {datasetLabel ?? t("local dataset")}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
});
