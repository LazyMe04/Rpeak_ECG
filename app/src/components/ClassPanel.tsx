import { memo, useMemo } from "react";
import type { ClassificationResult } from "../hooks/useClassification";
import { BrainIcon } from "./icons";
import { Panel } from "./Panel";
import { useT } from "../lib/i18n";

interface Props {
  classification: ClassificationResult | null;
  classifying: boolean;
  error: string | null;
  /** True while the model itself is still being fetched. */
  loadingModel: boolean;
  /** Beat index nearest the playhead, or -1. */
  activeBeat: number;
  /** True when the peak set came from the live detector rather than annotations. */
  liveDetector: boolean;
  onClose: () => void;
}

const CLASS_TONE: Record<string, string> = {
  N: "text-green-400",
  S: "text-orange-400",
  V: "text-red-400",
  Q: "text-purple-400",
};

const CLASS_MEANING: Record<string, string> = {
  N: "Normal",
  S: "Supraventricular ectopic",
  V: "Ventricular ectopic",
  Q: "Unclassifiable",
};

export const ClassPanel = memo(function ClassPanel({
  classification,
  classifying,
  error,
  loadingModel,
  activeBeat,
  liveDetector,
  onClose,
}: Props) {
  const { t, td, num } = useT();
  const counts = useMemo(() => {
    if (!classification) return null;
    const k = classification.classes.length;
    const n = new Int32Array(k);
    for (let i = 0; i < classification.cls.length; i++) n[classification.cls[i]]++;
    const total = classification.cls.length || 1;
    const meanProb = new Float32Array(k);
    const seen = new Int32Array(k);
    for (let i = 0; i < classification.cls.length; i++) {
      const c = classification.cls[i];
      meanProb[c] += classification.prob[i];
      seen[c]++;
    }
    for (let c = 0; c < k; c++) if (seen[c]) meanProb[c] /= seen[c];
    return { n, total, meanProb };
  }, [classification]);

  const here = useMemo(() => {
    if (!classification || activeBeat < 0 || activeBeat >= classification.cls.length) return null;
    const k = classification.classes.length;
    const c = classification.cls[activeBeat];
    return {
      cls: c,
      name: classification.classes[c],
      prob: classification.prob[activeBeat],
      probs: classification.probs.subarray(activeBeat * k, (activeBeat + 1) * k),
    };
  }, [classification, activeBeat]);

  const body = () => {
    if (loadingModel) return <div className="text-sm text-dim">{t("Loading the model…")}</div>;
    if (error)
      return (
        <div className="text-sm text-red-400 break-words">
          {/* `td` rather than the raw string: the hook's own messages are
              sentences and are in the dictionary; a message thrown by the
              worker passes through in the language the exception was written
              in, which is the best that can be done for a stack trace's text. */}
          {td(error)}
        </div>
      );
    if (classifying) return <div className="text-sm text-dim">{t("Classifying beats…")}</div>;
    if (!classification) return <div className="text-sm text-dim">{t("Classifier is off.")}</div>;
    if (!counts) return null;

    return (
      <>
        <div className="text-xs text-faint mb-2">
          {t("{n} beats ·", { n: num(classification.cls.length) })}{" "}
          {classification.ms < 1000
            ? `${num(classification.ms, 0)} ms`
            : `${num(classification.ms / 1000, 1)} s`}
          {liveDetector ? t(" · live detector peaks") : t(" · reference annotation peaks")}
        </div>

        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-faint">
              <th className="text-left font-normal pb-1">{t("Class")}</th>
              <th className="text-right font-normal pb-1">{t("Beats")}</th>
              <th className="text-right font-normal pb-1">{t("Share")}</th>
              <th className="text-right font-normal pb-1">{t("Mean p")}</th>
            </tr>
          </thead>
          <tbody>
            {classification.classes.map((name, c) => (
              <tr key={name} title={t(CLASS_MEANING[name]!)}>
                <td className={`py-0.5 ${CLASS_TONE[name] ?? ""}`}>
                  <span className="font-semibold">{name}</span>{" "}
                  <span className="text-xs text-faint">{t(CLASS_MEANING[name]!)}</span>
                </td>
                <td className="text-right mono">{num(counts.n[c])}</td>
                <td className="text-right mono text-dim">
                  {num((100 * counts.n[c]) / counts.total, 2)}%
                </td>
                <td className="text-right mono text-dim">
                  {counts.n[c] ? num(counts.meanProb[c], 2) : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="mt-4 pt-3 border-t border-[var(--panel-border)]">
          <div className="text-xs text-faint mb-1">{t("Beat at the playhead")}</div>
          {here ? (
            <>
              <div className="flex items-baseline gap-2 mb-2">
                <span className={`text-2xl font-semibold ${CLASS_TONE[here.name] ?? ""}`}>
                  {here.name}
                </span>
                <span className="text-sm text-dim">{t(CLASS_MEANING[here.name]!)}</span>
                <span className="ml-auto mono text-sm">{num(here.prob * 100, 1)}%</span>
              </div>
              <div className="flex gap-1 h-1.5">
                {Array.from(here.probs).map((p, i) => (
                  <div
                    key={i}
                    className="flex-1 rounded-sm overflow-hidden bg-[var(--panel-border)]"
                    title={`${classification.classes[i]} ${num(p * 100, 1)}%`}
                  >
                    <div
                      className="h-full bg-blue-400"
                      style={{ width: `${p * 100}%`, opacity: i === here.cls ? 1 : 0.35 }}
                    />
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div className="text-sm text-dim">{t("No beat at the playhead.")}</div>
          )}
        </div>
      </>
    );
  };

  return (
    <Panel
      title={t("AI Beat Classifier")}
      icon={<BrainIcon size={16} className="text-purple-400" />}
      onClose={onClose}
      testId="classify"
      className="absolute top-20 right-4 z-30 w-[340px] max-h-[calc(100%-160px)] overflow-y-auto"
      headerClassName="px-4 pt-4 pb-3"
      bodyClassName="px-4 pb-4"
    >
      {body()}
    </Panel>
  );
});
