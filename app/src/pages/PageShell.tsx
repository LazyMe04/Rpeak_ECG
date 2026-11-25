/**
 * Shared frame for the two documentation pages.
 *
 * The monitor is a fixed dashboard; these pages are documents. They scroll
 * inside the same 64px navbar offset the monitor uses, so the app still feels
 * like one window. `data-page-ready` is the hook `scripts/shot.ts --page` waits
 * on: the pages load their numbers asynchronously, and a screenshot taken
 * before the JSON arrives would show the loading state and prove nothing.
 *
 * `sections` turns the header into a table of contents. Both pages have grown
 * past a screen or seven of scrolling, and the only way to reach a section was
 * to drag the scrollbar and watch for the heading -- which is not navigation.
 * The list is rendered from caller data, not scraped from the DOM, so a section
 * that exists and a section that is reachable cannot drift apart.
 */
import { memo, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { MoonIcon, SunIcon } from "../components/icons";
import { useT } from "../lib/i18n";

export interface PageSection {
  id: string;
  title: string;
}

interface Props {
  eyebrow: string;
  title: string;
  subtitle: ReactNode;
  theme: "dark" | "light";
  onToggleTheme: () => void;
  ready: boolean;
  /** Ordered section list for the table of contents and the scroll spy. */
  sections?: PageSection[];
  children: ReactNode;
}

/** Scroll offset that keeps a jumped-to heading clear of the navbar. */
const JUMP_GAP = 12;

/** Ids are authored in the pages; the hash is percent-encoded in links. */
const slug = (id: string) => `#${id}`;

function readHash(): string {
  try {
    return decodeURIComponent(window.location.hash.replace(/^#/, ""));
  } catch {
    return "";
  }
}

export const PageShell = memo(function PageShell({
  eyebrow,
  title,
  subtitle,
  theme,
  onToggleTheme,
  ready,
  sections,
  children,
}: Props) {
  const { t } = useT();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [current, setCurrent] = useState<string>("");

  const scrollToId = useCallback((id: string, smooth: boolean) => {
    const pane = scrollRef.current;
    const target = document.getElementById(id);
    if (!pane || !target) return false;
    // Scroll the document pane, not the window: the pane is the scroller, and
    // `scroll-margin` on the section is unreliable across the two scroll roots.
    const top = target.offsetTop - pane.offsetTop - JUMP_GAP;
    pane.scrollTo({ top, behavior: smooth ? "smooth" : "auto" });
    return true;
  }, []);

  const jump = useCallback(
    (id: string) => {
      if (!scrollToId(id, true)) return;
      // Mirror the section into the URL so a section can be linked and the
      // browser's own back button undoes the jump.
      if (readHash() !== id) {
        window.history.pushState(null, "", slug(id));
      }
      setCurrent(id);
    },
    [scrollToId],
  );

  // A deep link (`?page=docs#numbers`) has to land once the page has rendered.
  // The sections are inside the ready branch, so wait for `ready`.
  useEffect(() => {
    if (!ready || !sections?.length) return;
    const id = readHash();
    if (!id) return;
    // Two frames: the first commit may have laid out the loading branch.
    const t = window.setTimeout(() => scrollToId(id, false), 60);
    return () => window.clearTimeout(t);
  }, [ready, sections, scrollToId]);

  // Scroll spy: the current section is the last heading that has crossed the
  // top of the pane. Tracked on the pane's own scroll event, so it costs one
  // rAF-friendly listener and nothing when the page is not scrollable.
  useEffect(() => {
    const pane = scrollRef.current;
    if (!pane || !sections?.length) return;
    let queued = false;
    const apply = () => {
      queued = false;
      // Read the headings here rather than caching them. At mount the pane is
      // showing the loading branch, so no section exists and every offset would
      // be a cached `Infinity`; the pane's own box does not change when the
      // content arrives, so a ResizeObserver never corrects it. Measuring per
      // frame costs ~10 offsetTop reads and stays right as images load.
      const tops = sections.map((s) => {
        const el = document.getElementById(s.id);
        return { id: s.id, y: el ? el.offsetTop - pane.offsetTop : Infinity };
      });
      const at = pane.scrollTop + JUMP_GAP + 8;
      // Bottom of the pane: the last section can be shorter than the viewport,
      // so it would never become "the last heading crossed". Claim the last
      // entry explicitly in that case.
      const bottom = pane.scrollHeight - pane.clientHeight - 2;
      let found = "";
      if (pane.scrollTop >= bottom) {
        found = tops.filter((x) => Number.isFinite(x.y)).at(-1)?.id ?? "";
      } else {
        for (const s of tops) if (s.y <= at) found = s.id;
        // Above the first heading -- the top of the page -- nothing has
        // crossed the line yet. The first section is still the one the reader
        // is looking at, so name it rather than leaving the contents blank.
        if (!found) found = tops.find((x) => Number.isFinite(x.y))?.id ?? "";
      }
      setCurrent(found);
    };
    const onScroll = () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(apply);
    };
    // Heading positions also move when the content arrives or reflows, which is
    // not a scroll event; a ResizeObserver on the inner content catches that.
    const ro = new ResizeObserver(apply);
    const content = pane.firstElementChild;
    if (content) ro.observe(content);
    pane.addEventListener("scroll", onScroll, { passive: true });
    apply();
    return () => {
      pane.removeEventListener("scroll", onScroll);
      ro.disconnect();
    };
  }, [sections, ready]);

  return (
    <div ref={scrollRef} data-page-scroll className="h-full overflow-y-auto scrollable-content">
      <div
        className="mx-auto max-w-[1100px] px-4 md:px-8 py-8 pb-24"
        data-page-ready={ready ? "" : undefined}
      >
        <header className="flex items-start gap-4 mb-6">
          <div className="min-w-0">
            <div className="text-[11px] uppercase tracking-[0.18em] text-faint mb-1">{eyebrow}</div>
            <h1 className="text-2xl md:text-3xl font-bold leading-tight">{title}</h1>
            <div className="text-sm text-dim mt-1.5 max-w-2xl leading-relaxed">{subtitle}</div>
          </div>
          <button
            type="button"
            onClick={onToggleTheme}
            className="icon-btn w-9 h-9 shrink-0 ml-auto"
            aria-label={t(
              theme === "dark" ? "Switch to the light theme" : "Switch to the dark theme",
            )}
            title={t(theme === "dark" ? "Light theme" : "Dark theme")}
          >
            {theme === "dark" ? <SunIcon size={18} /> : <MoonIcon size={18} />}
          </button>
        </header>

        {sections && sections.length > 0 && (
          <nav aria-label={t("On this page")} data-toc className="panel px-4 py-3 mb-4">
            <div className="text-[10px] uppercase tracking-[0.18em] text-faint mb-2">
              {t("On this page")}
            </div>
            <ol className="flex flex-wrap gap-x-4 gap-y-1.5">
              {sections.map((s, i) => {
                const active = current === s.id;
                return (
                  <li key={s.id}>
                    <a
                      href={slug(s.id)}
                      data-toc-item={s.id}
                      aria-current={active ? "location" : undefined}
                      onClick={(e) => {
                        // A plain anchor would change the URL and let the browser
                        // scroll the wrong root; the pane is the scroller here.
                        e.preventDefault();
                        jump(s.id);
                      }}
                      className={`text-[11px] leading-snug transition-colors ${
                        active
                          ? "text-[var(--text)] font-semibold"
                          : "text-dim hover:text-[var(--text)]"
                      }`}
                    >
                      <span className="mono text-faint mr-1">{i + 1}</span>
                      {t(s.title)}
                    </a>
                  </li>
                );
              })}
            </ol>
          </nav>
        )}

        <div className="space-y-4">{children}</div>
      </div>
    </div>
  );
});

/** Shown while a page's data files are still being read. */
export function PageLoading({ what }: { what: string }) {
  const { t } = useT();
  return (
    <div className="panel p-6 flex items-center gap-3">
      <div className="animate-spin w-4 h-4 border-2 border-blue-400 border-t-transparent rounded-full" />
      <span className="text-sm text-dim">{t("Reading {what}…", { what: t(what) })}</span>
    </div>
  );
}

/** A page's data file failed to load: say which one and where it comes from. */
export function PageError({ what, error }: { what: string; error: string }) {
  const { t } = useT();
  return (
    <div className="panel p-6 border-red-500/40">
      <div className="text-red-400 font-semibold mb-1">
        {t("Cannot read {what}", { what: t(what) })}
      </div>
      <div className="text-sm text-dim break-words">{error}</div>
      <div className="text-xs text-faint mt-3 leading-snug">
        {t("These pages read the same")} <span className="mono">data/</span>{" "}
        {t("folder as the monitor. In a browser,")} <span className="mono">npm run dev</span>{" "}
        {t("serves it at")} <span className="mono">/data</span>
        {t("; in the packaged app it must sit beside the executable, in")}{" "}
        <span className="mono">%LOCALAPPDATA%\Rpeak\data</span>
        {t(", or at the path in")} <span className="mono">RPEAK_DATA_DIR</span>.
      </div>
    </div>
  );
}
