import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { NavBar, type NavKey } from "./components/NavBar";
import { IconRail, type RailPanel } from "./components/IconRail";
import { WaveformCanvas } from "./components/WaveformCanvas";
import { TransportBar } from "./components/TransportBar";
import { SegmentPicker } from "./components/SegmentPicker";
import { SourceControl } from "./components/SourceControl";
import { StatsPanel } from "./components/StatsPanel";
import { HrvPanel } from "./components/HrvPanel";
import { ReportPanel } from "./components/ReportPanel";
import { ClassPanel } from "./components/ClassPanel";
import { ErrorBoundary, FaultProbe } from "./components/ErrorBoundary";
import { ModelPage } from "./pages/ModelPage";
import { DocsPage } from "./pages/DocsPage";
import { ReplayEngine, type PlaybackStatus } from "./lib/playback";
import { loadAnnotations, loadSegments, loadSignal } from "./lib/catalog";
import { IS_TAURI } from "./lib/dataset";
import { FileReplaySource } from "./lib/signal/fileReplaySource";
import type { AnnotationTrack } from "./lib/signal/annotations";
import type { SegmentInfo } from "./lib/signal/types";
import { useTheme } from "./hooks/useTheme";
import { useT } from "./lib/i18n";
import { useLiveDetector } from "./hooks/useLiveDetector";
import { useDelineation } from "./hooks/useDelineation";
import { useClassification } from "./hooks/useClassification";
import type { ClassificationResult } from "./hooks/useClassification";

const EMPTY_STATUS: PlaybackStatus = {
  position: 0,
  duration: 0,
  playing: false,
  speed: 1,
  loaded: false,
  atEnd: false,
};

/** Index of the peak nearest `sample`, or -1 when there are none. */
function nearestPeak(peaks: Int32Array | null, sample: number): number {
  if (!peaks || peaks.length === 0) return -1;
  let lo = 0;
  let hi = peaks.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (peaks[mid] < sample) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && sample - peaks[lo - 1] <= peaks[lo] - sample) return lo - 1;
  return lo;
}

/** Per-class beat counts, keyed by class letter, for the dev smoke test. */
function countsOf(c: ClassificationResult): Record<string, number> {
  const out: Record<string, number> = {};
  for (const name of c.classes) out[name] = 0;
  for (let i = 0; i < c.cls.length; i++) out[c.classes[c.cls[i]]]!++;
  return out;
}

export default function App() {
  const [theme, toggleTheme] = useTheme();
  const { t, td, lang } = useT();

  // Three pages, one window. The monitor is the default; `?page=model|docs`
  // deep-links the other two. The monitor's own state lives in this component,
  // so switching pages pauses playback instead of tearing the engine down.
  const [page, setPage] = useState<NavKey>(() => {
    const p = new URLSearchParams(window.location.search).get("page");
    return p === "model" || p === "docs" ? p : "monitor";
  });
  const pageRef = useRef(page);
  const resumeRef = useRef(false);
  const engineRef = useRef<ReplayEngine | null>(null);
  if (!engineRef.current) engineRef.current = new ReplayEngine();
  const engine = engineRef.current;

  const [segments, setSegments] = useState<SegmentInfo[]>([]);
  const [current, setCurrent] = useState<SegmentInfo | null>(null);
  const [source, setSource] = useState<FileReplaySource | null>(null);
  const [track, setTrack] = useState<AnnotationTrack | null>(null);
  const [status, setStatus] = useState<PlaybackStatus>(EMPTY_STATUS);
  const [busy, setBusy] = useState(false);
  /**
   * A failure, plus which of the two kinds it is.
   *
   * `fatal` means the app has no usable dataset and the full-window panel with
   * the "where do I put data/" advice is right. `notice` means one thing went
   * wrong -- a deep link naming a segment this catalogue does not have -- and
   * the app can still show a segment; covering the whole window would hide the
   * trace behind a message about a link. The picker still works, so the reader
   * can get to any segment.
   */
  const [error, setError] = useState<{ message: string; fatal: boolean } | null>(null);
  const [panel, setPanel] = useState<RailPanel>(() => {
    const p = new URLSearchParams(window.location.search).get("panel");
    return p === "stats" || p === "segments" || p === "hrv" || p === "report" || p === "classify"
      ? p
      : null;
  });
  const [showBeats, setShowBeats] = useState(true);
  // The keyboard handler is installed once and must see the current panel, not
  // the one that existed when it was created.
  const panelRef = useRef(panel);
  panelRef.current = panel;
  const [detectOn, setDetectOn] = useState(false);
  const [delineateOn, setDelineateOn] = useState(false);
  // Dev-only: flips `FaultProbe` to prove the error boundary catches a real
  // render throw. Set through `window.__rpeak.fault()` by smoke.ts.
  const [devFault, setDevFault] = useState(false);
  const loadToken = useRef(0);

  const {
    detection,
    detecting,
    error: detectorError,
  } = useLiveDetector({
    enabled: detectOn,
    record: current?.record ?? null,
    fs: current?.fs ?? 250,
    source,
  });

  // A result computed for the previous segment must not be drawn on this one.
  const detected =
    detection && current && detection.record === current.record ? detection.peaks : null;

  // Reference peaks as a flat array, memoised on the track so the delineation
  // effect does not re-run on every render.
  const annotationPeaks = useMemo(
    () => (track ? Int32Array.from(track.beats.map((b) => b.sample)) : null),
    [track],
  );

  // Delineation follows the same peak set the vitals panel reads: the detector
  // when it has answered for this segment, the annotations otherwise.
  const analysisPeaks = detected ?? annotationPeaks;

  const {
    delineation,
    delineating,
    error: delinError,
  } = useDelineation({
    // Also runs while the report panel is open, which needs the interval
    // columns, and waits while the detector is running so the overlay is not
    // computed twice in the first second after a segment loads.
    enabled: (delineateOn || panel === "report") && !(detectOn && detecting),
    record: current?.record ?? null,
    fs: current?.fs ?? 250,
    source,
    peaks: analysisPeaks,
  });

  // A delineation computed for the previous segment must not be drawn on this
  // one either. Memoised, not inline: the object is a dependency of two effects
  // below, and a fresh literal each render would invalidate them every time and
  // repaint the canvas once per render.
  const delin = useMemo(
    () =>
      delineation && current && delineation.record === current.record
        ? { peaks: delineation.peaks, arrays: delineation.delin }
        : null,
    [delineation, current],
  );

  // The classifier reads the same peak set as everything else, and only runs
  // while its panel is open: it is the heaviest job in the app (~5 s for a
  // 70-minute segment) and there is no reason to pay for it unseen.
  const {
    classification,
    classifying,
    error: classError,
    loadingModel,
  } = useClassification({
    enabled: panel === "classify" && !(detectOn && detecting),
    record: current?.record ?? null,
    source,
    peaks: analysisPeaks,
  });

  const classified =
    classification && current && classification.record === current.record ? classification : null;
  // Index into the *classified* peaks, not the current ones: if the detector
  // answers while a classification from the annotation peaks is still on
  // screen, the arrays must stay aligned with each other.
  const activeBeat = classified ? nearestPeak(classified.peaks, status.position) : -1;

  // One animation loop for the lifetime of the component.
  useEffect(() => {
    engine.onStatus = setStatus;
    engine.start();
    return () => {
      engine.stop();
      engine.onStatus = null;
      engine.clearSource();
    };
  }, [engine]);

  // Development-only handle, used by scripts/smoke.ts to drive playback from
  // outside the page. It is stripped from production builds by the constant
  // fold on import.meta.env.DEV.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    (window as unknown as Record<string, unknown>).__rpeak = { engine };
  }, [engine]);

  const select = useCallback(
    async (seg: SegmentInfo, startS = 0) => {
      const token = ++loadToken.current;
      setBusy(true);
      setError(null);
      // Annotations and signal load in parallel; the trace appears as soon as
      // the 4 MB signal arrives and the beats fade in when they are ready.
      const annPromise = loadAnnotations(seg).catch(() => null);
      try {
        const src = new FileReplaySource(
          seg.record,
          () => loadSignal(seg.record),
          seg.fs,
          seg.nSamples,
        );
        await engine.setSource(src);
        if (token !== loadToken.current) return;

        setSource(src);
        setCurrent(seg);
        setTrack(null);
        if (startS > 0) engine.seekSeconds(startS);
        // A deep link to a documentation page still loads the segment in the
        // background, so pressing Monitor lands on a ready trace -- but it does
        // not play behind a page the reader is not looking at.
        if (pageRef.current === "monitor") engine.play();

        // Keep the address bar in step so a reload, or a link pasted to
        // someone else, lands on the same segment and moment.
        try {
          const url = new URL(window.location.href);
          url.searchParams.set("record", seg.record);
          url.searchParams.set("t", startS.toFixed(1));
          window.history.replaceState(null, "", url);
        } catch {
          /* history is best-effort */
        }

        const ann = await annPromise;
        if (token !== loadToken.current) return;
        setTrack(ann);
      } catch (e) {
        if (token === loadToken.current) {
          setError({ message: e instanceof Error ? e.message : String(e), fatal: false });
        }
      } finally {
        if (token === loadToken.current) setBusy(false);
      }
    },
    [engine],
  );

  // Initial catalogue load, then straight into the segment named in the URL.
  useEffect(() => {
    let cancelled = false;
    // Not awaited on purpose: an effect callback cannot be async, and every
    // failure below lands in `setError` -- there is nothing left to handle.
    void (async () => {
      try {
        const list = await loadSegments();
        if (cancelled) return;
        setSegments(list);
        if (list.length === 0) {
          setError({
            message: "The catalogue is empty. Run pipeline/export_app_index.py.",
            fatal: true,
          });
          return;
        }
        const params = new URLSearchParams(window.location.search);
        const wanted = params.get("record");
        const match = wanted ? list.find((s) => s.record === wanted) : undefined;
        if (wanted && !match) {
          // A shared link to a segment this machine does not have -- a typo, or
          // a catalog built from a different subset. Falling back to the first
          // segment silently would show the reader a different recording than
          // the link named, with nothing on screen saying so.
          setError({
            message: `no segment named ${wanted} in the catalogue — ${list.length} segments are loaded`,
            fatal: false,
          });
          return;
        }
        const seg = match ?? list[0]!;
        const t = Number(params.get("t"));
        await select(seg, Number.isFinite(t) && t > 0 ? t : 0);
      } catch (e) {
        if (!cancelled) {
          setError({ message: e instanceof Error ? e.message : String(e), fatal: true });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [select]);

  const stepBeat = useCallback(
    (dir: -1 | 1) => {
      if (!track) return;
      const here = Math.floor(engine.position);
      const i = dir > 0 ? track.nextIndex(here + 1) : track.prevIndex(here - 1);
      if (i >= 0) engine.seek(track.beats[i].sample);
    },
    [engine, track],
  );

  const onSkip = useCallback((d: number) => engine.seekBy(d), [engine]);
  const onSeek = useCallback((s: number) => engine.seekSeconds(s), [engine]);
  const onSpeed = useCallback((s: number) => engine.setSpeed(s), [engine]);
  const onToggle = useCallback(() => engine.toggle(), [engine]);

  // Leaving the monitor pauses it -- a replay running behind a static page is
  // pure battery drain -- and coming back resumes only if it was playing when
  // the user left. The page is mirrored into the URL so a reload lands where
  // the reader was.
  const navigate = useCallback(
    (key: NavKey) => {
      if (key === pageRef.current) return;
      if (key === "monitor") {
        if (resumeRef.current) engine.play();
        resumeRef.current = false;
      } else {
        // Only a departure from the monitor decides whether coming back should
        // resume. Hopping model → docs would otherwise overwrite the flag with
        // the "not playing" state it caused itself.
        if (pageRef.current === "monitor") resumeRef.current = engine.isPlaying;
        engine.pause();
        setPanel(null);
      }
      pageRef.current = key;
      setPage(key);
      try {
        const url = new URL(window.location.href);
        if (key === "monitor") url.searchParams.delete("page");
        else url.searchParams.set("page", key);
        window.history.replaceState(null, "", url);
      } catch {
        /* history is best-effort */
      }
    },
    [engine],
  );

  // Annotations arrive after the trace; while paused, that changes what is on
  // screen without changing the position, so the canvas needs a nudge.
  useEffect(() => {
    engine.invalidate();
  }, [engine, track]);

  // Same for the delineation overlay and the detector rings.
  useEffect(() => {
    engine.invalidate();
  }, [engine, delin, detected]);

  // Write the playhead into the URL whenever playback stops, so a paused view
  // is a shareable one. Doing it per frame would spam the history API.
  const playing = status.playing;
  const positionS = status.position;
  useEffect(() => {
    if (playing || !current) return;
    try {
      const url = new URL(window.location.href);
      url.searchParams.set("record", current.record);
      url.searchParams.set("t", positionS.toFixed(1));
      window.history.replaceState(null, "", url);
    } catch {
      /* history is best-effort */
    }
  }, [playing, current, positionS]);

  // The window title is what the taskbar and the Alt-Tab list show. Leaving it
  // at the static "Rpeak" makes three open windows indistinguishable, and says
  // nothing about the page the reader is on. Written on page and language
  // change only -- not per frame.
  useEffect(() => {
    const name = page === "model" ? t("AI Model") : page === "docs" ? t("Docs") : t("Monitor");
    document.title = `${name} — Rpeak`;
  }, [page, t]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // The monitor's transport keys must not drive a paused replay while a
      // documentation page has focus.
      if (pageRef.current !== "monitor") return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) return;

      switch (e.key) {
        case " ":
          e.preventDefault();
          engine.toggle();
          break;
        case "Escape":
          // Escape closes whatever panel is open, and does nothing when none
          // is. Charts on the documentation pages also use Escape (to clear
          // their cursor), but they are not on this page: the handler returns
          // early above, and their own `onKeyDown` is bound to the `<svg>`, so
          // the two never both answer one press.
          if (panelRef.current) {
            e.preventDefault();
            setPanel(null);
          }
          break;
        case "ArrowLeft":
          e.preventDefault();
          if (e.shiftKey) stepBeat(-1);
          else engine.seekBy(-5);
          break;
        case "ArrowRight":
          e.preventDefault();
          if (e.shiftKey) stepBeat(1);
          else engine.seekBy(5);
          break;
        case "1":
          engine.setSpeed(1);
          break;
        case "2":
          engine.setSpeed(4);
          break;
        case "3":
          engine.setSpeed(16);
          break;
        case "4":
          engine.setSpeed(60);
          break;
        default:
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [engine, stepBeat]);

  // Dev-only handle for scripts/smoke.ts: the detector state lives in React, so
  // the smoke test needs a way to toggle it and read the result.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const w = window as unknown as Record<string, Record<string, unknown>>;
    const handle = w.__rpeak ?? {};
    handle.detect = {
      enabled: detectOn,
      detecting,
      peaks: detected ? detected.length : null,
      error: detectorError,
      toggle: () => setDetectOn((v) => !v),
    };
    handle.delineate = {
      enabled: delineateOn,
      delineating,
      beats: delin ? delin.peaks.length : null,
      missingP: delineation?.missingP ?? null,
      median: delineation?.median ?? null,
      error: delinError,
      toggle: () => setDelineateOn((v) => !v),
    };
    handle.classify = {
      enabled: panel === "classify",
      classifying,
      beats: classified ? classified.cls.length : null,
      counts: classified ? countsOf(classified) : null,
      ms: classified ? classified.ms : null,
      error: classError,
      toggle: () => setPanel((p) => (p === "classify" ? null : "classify")),
    };
    // Proves the boundary: `fault(true)` makes a probe panel throw, and the
    // smoke test asserts the fallback appears while the trace keeps rendering.
    handle.fault = (on: boolean) => setDevFault(on);
    w.__rpeak = handle;
  }, [
    detectOn,
    detecting,
    detected,
    detectorError,
    delineateOn,
    delineating,
    delin,
    delineation,
    delinError,
    panel,
    classifying,
    classified,
    classError,
  ]);

  return (
    <div
      className="relative w-full h-full overflow-hidden"
      style={{ background: "var(--page-gradient)" }}
    >
      <NavBar
        active={page}
        onNavigate={navigate}
        datasetLabel={current ? `${current.record} · Icentia11k` : t("Icentia11k · local")}
      />

      <main className="absolute inset-x-0 top-16 bottom-0 overflow-hidden">
        {page === "monitor" ? (
          <ErrorBoundary what="the monitor" lang={lang} variant="full">
            <>
              <WaveformCanvas
                engine={engine}
                theme={theme}
                track={track}
                showBeats={showBeats}
                detected={detected}
                showDetected={detectOn}
                delin={delin}
                showDelineation={delineateOn}
              />

              <IconRail
                theme={theme}
                onToggleTheme={toggleTheme}
                panel={panel}
                onPanel={setPanel}
                showBeats={showBeats}
                onToggleBeats={() => setShowBeats((v) => !v)}
                detectOn={detectOn}
                detecting={detecting}
                detectError={detectorError}
                onToggleDetect={() => setDetectOn((v) => !v)}
                delineateOn={delineateOn}
                delineating={delineating}
                delinError={delinError}
                onToggleDelineate={() => setDelineateOn((v) => !v)}
                classifying={panel === "classify" && classifying}
                classError={classError}
              />

              {panel === "segments" && (
                <ErrorBoundary what="the dataset panel" lang={lang}>
                  <SegmentPicker
                    segments={segments}
                    current={current?.record ?? null}
                    onSelect={select}
                    onClose={() => setPanel(null)}
                  />
                </ErrorBoundary>
              )}

              {panel === "stats" && (
                <ErrorBoundary what="the vitals panel" lang={lang}>
                  <StatsPanel
                    track={track}
                    fs={current?.fs ?? 250}
                    positionSamples={engine.position}
                    segment={current}
                    detection={detected ? detection : null}
                    detecting={detectOn && detecting}
                    detectError={detectOn ? detectorError : null}
                    delineation={delin ? delineation : null}
                    delineating={delineating}
                    delinError={delinError}
                    onClose={() => setPanel(null)}
                  />
                </ErrorBoundary>
              )}

              {panel === "hrv" && (
                <ErrorBoundary what="the HRV panel" lang={lang}>
                  <HrvPanel
                    peaks={analysisPeaks}
                    fs={current?.fs ?? 250}
                    theme={theme}
                    sourceLabel={detected ? "Live detector" : "Reference annotations"}
                    pending={detectOn && detecting}
                    onClose={() => setPanel(null)}
                  />
                </ErrorBoundary>
              )}

              {panel === "classify" && (
                <ErrorBoundary what="the classifier panel" lang={lang}>
                  <ClassPanel
                    classification={classified}
                    classifying={classifying}
                    error={classError}
                    loadingModel={loadingModel}
                    activeBeat={activeBeat}
                    liveDetector={!!detected}
                    onClose={() => setPanel(null)}
                  />
                </ErrorBoundary>
              )}

              {panel === "report" && (
                <ErrorBoundary what="the session panel" lang={lang}>
                  <ReportPanel
                    record={current?.record ?? null}
                    fs={current?.fs ?? 250}
                    durationS={current?.durationS ?? 0}
                    positionS={engine.position / (current?.fs ?? 250)}
                    track={track}
                    peaks={analysisPeaks}
                    peakSource={detected ? "detector" : "annotations"}
                    delin={delin}
                    delineating={delineating}
                    onClose={() => setPanel(null)}
                  />
                </ErrorBoundary>
              )}

              {import.meta.env.DEV && (
                <ErrorBoundary what="the vitals panel" lang={lang}>
                  <FaultProbe when={!!devFault} />
                </ErrorBoundary>
              )}

              <TransportBar
                status={status}
                disabled={!current}
                onToggle={onToggle}
                onSpeed={onSpeed}
                onSeek={onSeek}
                onSkip={onSkip}
                onBeatStep={stepBeat}
              />

              {busy && (
                <div className="absolute inset-0 z-20 flex items-center justify-center pointer-events-none">
                  <div className="panel px-5 py-4 flex items-center gap-3">
                    <div className="animate-spin w-5 h-5 border-2 border-blue-400 border-t-transparent rounded-full" />
                    <span className="text-sm">{t("Loading segment…")}</span>
                  </div>
                </div>
              )}

              {error && !error.fatal && (
                // A link that cannot be followed, rather than a dataset that cannot
                // be read. It sits at the top so the trace keeps playing underneath:
                // the reader can open the segment list and pick one, and the notice
                // goes away as soon as they do (select() clears the error).
                <div className="absolute inset-x-4 top-20 z-20 flex justify-center pointer-events-none">
                  <div className="panel px-4 py-3 max-w-md border-yellow-500/40 pointer-events-auto flex items-start gap-3">
                    <div className="text-xs text-dim break-words">
                      <span className="text-yellow-400 font-semibold">
                        {t("This link names a segment that is not loaded.")}{" "}
                      </span>
                      {/* The message is built by us but names a value from the URL,
                      so only its sentence is translated. */}
                      {td(error.message)}
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setError(null);
                        setPanel("segments");
                      }}
                      className="icon-btn px-2 py-1 text-xs shrink-0"
                    >
                      {t("Open the list")}
                    </button>
                  </div>
                </div>
              )}

              {error && error.fatal && (
                <div className="absolute inset-0 z-20 flex items-center justify-center">
                  <div className="panel px-6 py-5 max-w-md text-center border-red-500/40">
                    <div className="text-red-400 font-semibold mb-1">
                      {t("Cannot load the dataset")}
                    </div>
                    {/* Only the leading sentence is ours; the rest is whatever the
                    dataset layer threw, and it stays as written. */}
                    <div className="text-sm text-dim break-words">{td(error.message)}</div>
                    {IS_TAURI ? (
                      <>
                        {/* The control, not an instruction: this panel is what a
                        reader sees when the folder is wrong, so it has to be
                        where they fix it. A successful switch reloads. */}
                        <div className="mt-4 text-left">
                          <SourceControl />
                        </div>
                        <div className="text-xs text-faint mt-2">
                          {t("Put the dataset in a")} <span className="mono">data</span>{" "}
                          {t("folder next to the installed app, or use the button above.")}
                        </div>
                      </>
                    ) : (
                      <div className="text-xs text-faint mt-3">
                        <>
                          {t("Start the app with")} <span className="mono">npm run dev</span>{" "}
                          {t("from")} D:\Rpeak-Desktop\app
                          {t("; the Vite middleware serves /data from")} D:\Rpeak-Desktop\data.
                        </>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </>
          </ErrorBoundary>
        ) : page === "model" ? (
          <ErrorBoundary what="the model card" lang={lang} variant="full">
            <ModelPage theme={theme} onToggleTheme={toggleTheme} />
          </ErrorBoundary>
        ) : (
          <ErrorBoundary what="the guide" lang={lang} variant="full">
            <DocsPage theme={theme} onToggleTheme={toggleTheme} onNavigate={navigate} />
          </ErrorBoundary>
        )}
      </main>
    </div>
  );
}
