/**
 * The Docs page: the user guide the reference app has under /docs, rebuilt for
 * this app's actual behaviour.
 *
 * It is written against what this build does, not copied from upstream: the
 * source is a file replay rather than Bluetooth, the labels are N/S/V/Q with no
 * F class, and Q means "unclassifiable". The detector and classifier numbers
 * come from `data/catalog/eval_result.json` and `data/models/beatcnn.eval.json`
 * so the guide cannot drift from the artefacts the app ships.
 */
import { memo, useMemo } from "react";
import type { NavKey } from "../components/NavBar";
import { DotPlot, KV, Legend, Section, StatTile } from "./charts";
import { PageError, PageLoading, PageShell, type PageSection } from "./PageShell";
import { useT } from "../lib/i18n";
import { useJson } from "./useJson";

interface EvalResult {
  generated: string;
  detector: string;
  match_rule: string;
  parity: { reference: string; segments: number; exact: number };
  overall: { se: number; ppv: number; f1: number; segments: number };
  segments: { record: string; se: number; ppv: number; f1: number; tMs: number }[];
  patients: { patient: number; se: number; ppv: number; f1: number }[];
}

interface PerClass {
  support: number;
  se: number;
  ppv: number;
  f1: number;
}

interface CnnEval {
  pooled: {
    accuracy: number;
    macro_f1: number;
    per_class: Record<string, PerClass>;
    confusion: number[][];
  };
}

const CLASS_MEANING: Record<string, string> = {
  N: "Normal",
  S: "Supraventricular ectopic",
  V: "Ventricular ectopic",
  Q: "Unclassifiable",
};

const pct = (v: number, d = 1, fmt = (x: number, k: number) => x.toFixed(k)) =>
  `${fmt(v * 100, d)}%`;
/**
 * `catalog/eval_result.json` stores the detector scores already scaled to
 * percent (97.73, not 0.9773), unlike the classifier artefacts. Formatting them
 * with `pct()` produced "9773.39%" on the first render of this page.
 */
const pctRaw = (v: number, d = 2, fmt = (x: number, k: number) => x.toFixed(k)) => `${fmt(v, d)}%`;
const patientId = (n: number) => `p${String(n).padStart(5, "0")}`;

interface Props {
  theme: "dark" | "light";
  onToggleTheme: () => void;
  onNavigate: (key: NavKey) => void;
}

const DOC_SECTIONS: PageSection[] = [
  { id: "start", title: "Start here" },
  { id: "monitor", title: "The monitor" },
  { id: "tools", title: "Analysis tools" },
  { id: "numbers", title: "Understanding the numbers" },
  { id: "performance", title: "Performance" },
  { id: "dataset", title: "Dataset and licence" },
  { id: "limits", title: "Limits" },
];

const TOOLS: { title: string; tone: string; body: string; foot: string }[] = [
  {
    title: "Segment browser",
    tone: "var(--tone-blue)",
    body: "Twenty-four catalogued segments across twelve patients. Each row carries the reference beat count and the detector's F1 on that segment, so a bad recording is visible before you open it.",
    foot: "24 segments · 12 patients",
  },
  {
    title: "R-peak detection",
    tone: "var(--tone-green)",
    body: "The green rail toggle runs detect_v4 — the Python reference's algorithm, ported to TypeScript — over the whole segment in a worker. Peaks appear as hollow blue rings and top-edge triangles. The trace keeps playing while it runs.",
    foot: "Se 97.73 · PPV 96.21",
  },
  {
    title: "PQRST delineation",
    tone: "var(--tone-yellow)",
    body: "The yellow toggle finds P, QRS and T boundaries around the same peak set and draws them in a caliper lane under the trace. The Vitals panel reads its intervals.",
    foot: "91 ms per 6,885-beat segment",
  },
  {
    title: "Heart-rate variability",
    tone: "var(--tone-cyan)",
    body: "The cyan panel plots the R-R tachogram and its spectrum, and reports SDNN, RMSSD, pNN50, LF, HF and LF/HF. Intervals outside 300–2000 ms are gated, not interpolated.",
    foot: "recomputed from the current peaks",
  },
  {
    title: "Session report",
    tone: "var(--tone-red)",
    body: "The red entry records a span of the current segment and exports it as CSV (one row per beat, with class and intervals) or JSON (a summary). Both formats are plain text and carry the segment name and time base.",
    foot: "CSV · JSON",
  },
  {
    title: "AI beat classifier",
    tone: "var(--tone-purple)",
    body: "The purple entry classifies every beat as N, S, V or Q in a worker and reports per-class counts, shares and mean confidence, plus the full distribution for the beat at the playhead.",
    foot: "≈1 ms per beat",
  },
];

export const DocsPage = memo(function DocsPage({ theme, onToggleTheme, onNavigate }: Props) {
  const { t, num } = useT();
  const detector = useJson<EvalResult>("catalog/eval_result.json");
  const cnn = useJson<CnnEval>("models/beatcnn.eval.json");

  const patients = useMemo(() => {
    const d = detector.data;
    if (!d) return [];
    return [...d.patients].sort((a, b) => a.patient - b.patient);
  }, [detector.data]);

  const ready = !!detector.data && !!cnn.data;
  const error = detector.error ?? cnn.error;

  return (
    <PageShell
      eyebrow={t("Rpeak Desktop · Docs")}
      title={t("Rpeak — User Guide")}
      subtitle={t(
        "A local desktop rebuild of the Rpeak ECG monitor, running on the PhysioNet Icentia11k continuous ECG dataset. This guide covers what the app does, how to read its numbers, and where its limits are.",
      )}
      theme={theme}
      onToggleTheme={onToggleTheme}
      ready={ready}
      sections={DOC_SECTIONS}
    >
      {error ? (
        <PageError what={t("the evaluation artefacts")} error={error} />
      ) : !ready ? (
        <PageLoading what={t("the evaluation artefacts")} />
      ) : (
        <>
          <Section
            id="start"
            title={t("Start here")}
            lede={t(
              "Rpeak reads a dataset folder; it does not ship one. Everything below assumes the repository layout.",
            )}
          >
            <div className="grid md:grid-cols-2 gap-5">
              <div>
                <div className="text-[11px] text-dim mb-1.5">{t("Run it")}</div>
                <div className="space-y-1.5 text-[11px]">
                  {[
                    ["npm run dev", t("browser build at http://localhost:5173")],
                    ["npm run desktop", t("the same app in a Tauri window")],
                    ["npm run package", t("rpeak.exe + the NSIS installer")],
                    ["npm run smoke", t("drive the live page over CDP")],
                  ].map(([cmd, what]) => (
                    <div key={cmd} className="flex items-baseline gap-3">
                      <span className="mono text-[var(--text)]">{cmd}</span>
                      <span className="text-faint">{what}</span>
                    </div>
                  ))}
                </div>
                <p className="text-[11px] text-faint leading-relaxed mt-3">
                  {t("All commands run from")} <span className="mono">D:\Rpeak-Desktop\app</span>.{" "}
                  {t("The browser build serves")}{" "}
                  <span className="mono">D:\Rpeak-Desktop\data</span> {t("at")}{" "}
                  <span className="mono">/data</span> {t("through Vite middleware.")}
                </p>
              </div>

              <div>
                <div className="text-[11px] text-dim mb-1.5">
                  {t("Where the packaged app looks for the dataset")}
                </div>
                <ol className="text-[11px] text-dim leading-relaxed list-decimal pl-5 space-y-1">
                  <li>
                    <span className="mono">RPEAK_DATA_DIR</span>
                    {t(", if set.")}
                  </li>
                  <li>
                    <span className="mono">data\</span> {t("beside the executable.")}
                  </li>
                  <li>
                    <span className="mono">%LOCALAPPDATA%\Rpeak\data</span>.
                  </li>
                </ol>
                <p className="text-[11px] text-faint leading-relaxed mt-3">
                  {t(
                    "The dataset is 1.1 GB and carries its own licence, so it is deliberately not bundled. When nothing is found the app still opens and names every folder it searched.",
                  )}
                </p>
              </div>
            </div>

            <div
              className="grid md:grid-cols-2 gap-x-8 gap-y-1 mt-4 pt-3 border-t"
              style={{ borderColor: "var(--panel-border)" }}
            >
              <KV k={t("Deep link: segment and moment")} v="?record=p00004_s01&t=600" />
              <KV k={t("Deep link: open a panel")} v="&panel=stats|hrv|report|classify" />
              <KV k={t("Pin a theme")} v="?theme=light|dark" />
              <KV k={t("Open a page")} v="?page=model|docs" />
            </div>
          </Section>

          <Section
            id="monitor"
            title={t("The monitor")}
            lede={t(
              "The trace is a 1,000-sample window — four seconds at 250 Hz — scrolling through the display filter chain. Beat annotations from the dataset are drawn over it: a colour-coded dot at each R peak, a faint baseline tick, and a letter for the abnormal classes only.",
            )}
          >
            <div className="grid md:grid-cols-2 gap-5">
              <div>
                <div className="text-[11px] text-dim mb-1.5">{t("Transport")}</div>
                <p className="text-[11px] text-dim leading-relaxed">
                  {t(
                    "Play/pause, skip back and forward, beat-step, a seek slider and four speeds (1×, 4×, 16×, 60×). The left rail expands on hover: segments, beat overlay, detector, delineation, vitals, HRV, session, classifier, theme.",
                  )}
                </p>
              </div>
              <div>
                <div className="text-[11px] text-dim mb-1.5">{t("Keyboard")}</div>
                <table className="w-full text-[11px]">
                  <tbody>
                    {[
                      ["Space", t("play / pause")],
                      ["← →", t("seek ∓5 s")],
                      ["Shift + ← →", t("step one beat")],
                      ["1 2 3 4", t("speed 1× / 4× / 16× / 60×")],
                    ].map(([k, what]) => (
                      <tr key={k}>
                        <td className="py-0.5 mono text-[var(--text)] w-28">{k}</td>
                        <td className="py-0.5 text-dim">{what}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <p className="text-[11px] text-faint leading-relaxed mt-4">
              {t(
                "The address bar tracks the segment and the playhead whenever playback stops, so a paused view is a shareable link. A partly filled window is left blank rather than padded — a flat line at the left edge would read as signal.",
              )}
            </p>
          </Section>

          <Section
            id="tools"
            title={t("Analysis tools")}
            lede={t(
              "Each tool runs on the peak set the rest of the app is using: the live detector when it is on, the reference annotations otherwise. The source is always named in the panel.",
            )}
          >
            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
              {TOOLS.map((tool) => (
                <div
                  key={tool.title}
                  className="rounded-lg border p-3 flex flex-col"
                  style={{ borderColor: "var(--panel-border)" }}
                >
                  <div className="flex items-center gap-2 mb-1.5">
                    <span
                      className="w-2 h-2 rounded-full shrink-0"
                      style={{ background: tool.tone }}
                      aria-hidden
                    />
                    <span className="text-[12px] font-semibold">{t(tool.title)}</span>
                  </div>
                  <p className="text-[11px] text-dim leading-relaxed flex-1">{t(tool.body)}</p>
                  <div className="text-[10px] text-faint mono mt-2">{t(tool.foot)}</div>
                </div>
              ))}
            </div>
          </Section>

          <Section
            id="numbers"
            title={t("Understanding the numbers")}
            lede={
              <>
                {t(
                  "Detection is scored against the dataset's own R-peak annotations with a one-to-one, score-weighted match: two peaks match when they fall within",
                )}{" "}
                <span className="mono">clip(0.5 × R-R, 50 ms, 150 ms)</span>{" "}
                {t("of each other. Se is recall, PPV is precision, F1 their harmonic mean.")}
              </>
            }
          >
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-5">
              <StatTile
                label={t("Detector sensitivity")}
                value={pctRaw(detector.data!.overall.se, 2, num)}
                hint={t("{n} segments", { n: detector.data!.overall.segments })}
              />
              <StatTile
                label={t("Detector PPV")}
                value={pctRaw(detector.data!.overall.ppv, 2, num)}
                hint={`F1 ${pctRaw(detector.data!.overall.f1, 2, num)}`}
              />
              <StatTile
                label={t("Classifier accuracy")}
                value={pct(cnn.data!.pooled.accuracy, 1, num)}
                hint={`macro-F1 ${num(cnn.data!.pooled.macro_f1, 3)}`}
              />
              <StatTile
                label={t("Python parity")}
                value={`${detector.data!.parity.exact}/${detector.data!.parity.segments}`}
                hint={t("segments bit-identical")}
              />
            </div>

            <div className="text-[11px] text-dim mb-1.5">{t("Detector Se and PPV by patient")}</div>
            <Legend
              items={[
                { name: "Sensitivity", color: "var(--series-1)" },
                { name: "PPV", color: "var(--series-2)" },
              ]}
            />
            <div className="mt-1 mb-5">
              <DotPlot
                rows={patients.map((p) => ({
                  label: patientId(p.patient),
                  values: [p.se, p.ppv],
                }))}
                series={[
                  { name: t("Sensitivity"), color: "var(--series-1)" },
                  { name: t("PPV"), color: "var(--series-2)" },
                ]}
                xDomain={[85, 100]}
                xTicks={[85, 90, 95, 100]}
                format={(v) => num(v, 0)}
                xUnit="%"
                ariaLabel={t("Sensitivity and positive predictive value per patient")}
              />
            </div>

            <table className="w-full text-[11px] mb-4">
              <thead>
                <tr className="text-faint">
                  <th className="text-left font-normal pb-1">{t("Patient")}</th>
                  <th className="text-right font-normal pb-1">{t("Se")}</th>
                  <th className="text-right font-normal pb-1">{t("PPV")}</th>
                  <th className="text-right font-normal pb-1">{t("F1")}</th>
                </tr>
              </thead>
              <tbody>
                {patients.map((p) => (
                  <tr
                    key={p.patient}
                    className="border-t"
                    style={{ borderColor: "var(--panel-border)" }}
                  >
                    <td className="py-1 mono">{patientId(p.patient)}</td>
                    <td className="py-1 mono text-right">{pctRaw(p.se, 2, num)}</td>
                    <td className="py-1 mono text-right">{pctRaw(p.ppv, 2, num)}</td>
                    <td className="py-1 mono text-right">{pctRaw(p.f1, 2, num)}</td>
                  </tr>
                ))}
                <tr
                  className="border-t font-semibold"
                  style={{ borderColor: "var(--panel-border)" }}
                >
                  <td className="py-1">{t("All segments")}</td>
                  <td className="py-1 mono text-right">
                    {pctRaw(detector.data!.overall.se, 2, num)}
                  </td>
                  <td className="py-1 mono text-right">
                    {pctRaw(detector.data!.overall.ppv, 2, num)}
                  </td>
                  <td className="py-1 mono text-right">
                    {pctRaw(detector.data!.overall.f1, 2, num)}
                  </td>
                </tr>
              </tbody>
            </table>

            <p className="text-[11px] text-faint leading-relaxed mb-5">
              {t(
                "The spread is the useful part: six of twelve patients sit above 98% on both measures, while p00006 (Se 94.16, PPV 87.90) and p00004 (95.96 / 93.60) carry most of the loss. Detection is whole-segment and not streaming — switching segments re-runs it, which is why the rings appear a moment after the trace.",
              )}
            </p>

            <div className="text-[11px] text-dim mb-1.5">
              {t("Beat classifier, held-out patients")}
            </div>
            <table className="w-full text-[11px]">
              <thead>
                <tr className="text-faint">
                  <th className="text-left font-normal pb-1">{t("Class")}</th>
                  <th className="text-left font-normal pb-1">{t("Meaning")}</th>
                  <th className="text-right font-normal pb-1">{t("Support")}</th>
                  <th className="text-right font-normal pb-1">{t("Se")}</th>
                  <th className="text-right font-normal pb-1">{t("PPV")}</th>
                  <th className="text-right font-normal pb-1">{t("F1")}</th>
                </tr>
              </thead>
              <tbody>
                {Object.keys(cnn.data!.pooled.per_class).map((c) => {
                  const m = cnn.data!.pooled.per_class[c]!;
                  return (
                    <tr key={c} className="border-t" style={{ borderColor: "var(--panel-border)" }}>
                      <td className="py-1 mono font-semibold">{c}</td>
                      <td className="py-1 text-dim">{t(CLASS_MEANING[c]!)}</td>
                      <td className="py-1 mono text-right">{num(m.support)}</td>
                      <td className="py-1 mono text-right">{pct(m.se, 1, num)}</td>
                      <td className="py-1 mono text-right">{pct(m.ppv, 1, num)}</td>
                      <td className="py-1 mono text-right">{num(m.f1, 3)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="flex flex-wrap items-center gap-3 mt-3">
              <p className="text-[11px] text-faint leading-relaxed flex-1 min-w-[240px]">
                {t(
                  "Q is not a rhythm: in icentia11k it means “unclassifiable beat”. The full confusion matrix, the training curve and the PyTorch parity check are on the AI Model page.",
                )}
              </p>
              <button
                type="button"
                onClick={() => onNavigate("model")}
                className="seg-btn shrink-0"
                data-active="true"
              >
                {t("Open AI Model →")}
              </button>
            </div>
          </Section>

          <Section
            id="performance"
            title={t("Performance")}
            lede={t(
              "Measured on this machine against the 24 catalogued segments. The heavy jobs run in workers, so playback continues while they finish.",
            )}
          >
            <table className="w-full text-[11px]">
              <thead>
                <tr className="text-faint">
                  <th className="text-left font-normal pb-1">{t("Job")}</th>
                  <th className="text-left font-normal pb-1">{t("Cost")}</th>
                  <th className="text-left font-normal pb-1">{t("Where")}</th>
                </tr>
              </thead>
              <tbody>
                {[
                  ["R-peak detection", "685 ms median per segment (516–855 ms)", "worker"],
                  ["PQRST delineation", "91 ms per 6,885-beat segment", "worker"],
                  ["Beat classification", "0.95–1.3 ms per beat · 6.5–9.1 s per segment", "worker"],
                  ["HRV", "on demand, from the peak set", "main thread"],
                  ["Session report / export", "instant", "main thread"],
                ].map(([job, cost, where]) => (
                  <tr key={job} className="border-t" style={{ borderColor: "var(--panel-border)" }}>
                    <td className="py-1.5">{t(job)}</td>
                    <td className="py-1.5 mono text-dim">{t(cost)}</td>
                    <td className="py-1.5 text-faint">{t(where)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>

          <Section
            id="dataset"
            title={t("Dataset and licence")}
            lede={t(
              "Everything the app shows comes from one public dataset. Nothing is synthetic, and nothing is recorded by the app.",
            )}
          >
            <div className="grid md:grid-cols-2 gap-x-8 gap-y-1">
              <KV k={t("Dataset")} v="Icentia11k (PhysioNet)" />
              <KV k={t("Licence")} v="CC BY-NC-SA 4.0" />
              <KV k={t("Sampling rate")} v="250 Hz" />
              <KV k={t("Lead")} v={t("single chest lead")} />
              <KV k={t("Segment length")} v={t("1,048,577 samples · 69.9 min")} />
              <KV k={t("Labels")} v={t("N, S, V, Q — no F class")} />
              <KV k={t("Catalogue")} v={t("24 segments · 12 patients")} />
              <KV k={t("On disk")} v={t("142 segments · 42 patients")} />
            </div>
            <p className="text-[11px] text-faint leading-relaxed mt-4">
              {t("The app reads pre-scaled float32 copies of each segment rather than decoding")}{" "}
              <span className="mono">.dat</span>{" "}
              {t(
                "in the browser. The extra patients on disk exist so the classifier can hold out six patients by patient, never by window.",
              )}
            </p>
          </Section>

          <Section
            id="limits"
            title={t("Limits and disclaimer")}
            lede={t(
              "The rebuild fixed defects; it did not turn a research prototype into a medical device.",
            )}
          >
            <ul className="text-[12px] text-dim leading-relaxed space-y-2 list-disc pl-5">
              <li>
                <span className="text-[var(--text)] font-semibold">
                  {t("Not a medical device.")}
                </span>{" "}
                {t("No output here is a diagnosis, and none should be acted on.")}
              </li>
              <li>
                <span className="text-[var(--text)] font-semibold">
                  {t("The detector misses its 99% gate.")}
                </span>{" "}
                {t(
                  "Se 97.73 and PPV 96.21 against the annotations; the plan asked for 99% on both. The gap is stated rather than smoothed over.",
                )}
              </li>
              <li>
                <span className="text-[var(--text)] font-semibold">
                  {t("The classifier is a demonstration.")}
                </span>{" "}
                {t(
                  "{pct} held-out accuracy, macro-F1 {f1}, and a fourth class that means “unusable” rather than a rhythm. It reads three RR ratios as well as the window; the ablation of that input is on the AI Model page.",
                  {
                    pct: pct(cnn.data!.pooled.accuracy, 1),
                    f1: num(cnn.data!.pooled.macro_f1, 3),
                  },
                )}
              </li>
              <li>
                <span className="text-[var(--text)] font-semibold">
                  {t("Detection is whole-segment.")}
                </span>{" "}
                {t(
                  "A streaming detector needs a different algorithm, not a faster port: the selection dynamic program is global.",
                )}
              </li>
              <li>
                <span className="text-[var(--text)] font-semibold">
                  {t("One platform, unsigned.")}
                </span>{" "}
                {t(
                  "Windows x64 only; the installer is unsigned, so SmartScreen warns on first run, and WebView2 is a prerequisite.",
                )}
              </li>
            </ul>

            <p
              className="text-[11px] text-faint leading-relaxed mt-4 pt-3 border-t"
              style={{ borderColor: "var(--panel-border)" }}
            >
              {t("The engineering record lives in")} <span className="mono">docs/</span>
              {t(
                ": detector, analysis, classifier, app shell and packaging notes, each with the measurements behind the claims on this page.",
              )}
            </p>
          </Section>
        </>
      )}
    </PageShell>
  );
});
