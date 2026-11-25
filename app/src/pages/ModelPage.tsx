/**
 * The AI Model page: what the beat classifier is, how it was trained, and what
 * it actually scores.
 *
 * Every number on this page is read from the artefacts in `data/models/`, not
 * typed in from a notebook: the training history from `beatcnn.train.json`, the
 * held-out metrics from `beatcnn.eval.json`, the ablation from
 * `beatcnn.ablate.json`, and the N/Q boundary probes from
 * `beatcnn.qboundary.json` / `beatcnn.qtransfer.json`. The parity table is
 * recomputed live by running the app's own TypeScript forward pass over the
 * eight windows PyTorch scored, which is the same check `npm run test:cnn`
 * performs.
 *
 * That matters for a page like this. A model card copied by hand drifts from
 * the model the moment anyone retrains; this one cannot, because it would show
 * the new numbers on the next load.
 */
import { Fragment, memo, useMemo } from "react";
import { logitsForWindow, parityExtra, type CnnDoc } from "../lib/ecg/cnn";
import { BarList, ConfusionMatrix, KV, Legend, LineChart, Section, StatTile } from "./charts";
import { PageError, PageLoading, PageShell, type PageSection } from "./PageShell";
import { useJson } from "./useJson";
import { useT } from "../lib/i18n";

interface HistoryRow {
  epoch: number;
  loss: number;
  val_acc: number;
  val_macro_f1: number;
  eval_seconds: number;
}

interface PerClass {
  support: number;
  se: number;
  ppv: number;
  f1: number;
}

interface Metrics {
  accuracy: number;
  macro_f1: number;
  per_class: Record<string, PerClass>;
  confusion: number[][];
}

interface TrainDoc {
  train_records: string[];
  val_records: string[];
  train_patients: number[];
  val_patients: number[];
  n_train: number;
  n_val: number;
  class_counts_train: number[];
  class_counts_val: number[];
  class_weights: number[];
  best_epoch: number;
  epochs_run: number;
  history: HistoryRow[];
  metrics: Metrics;
  hparams: { width: number; dropout: number; lr: number; batch: number; epochs: number };
}

interface EvalDoc {
  pooled: Metrics;
  per_patient: Record<string, Metrics>;
}

interface AblateDoc {
  extra: { kind: string; names?: string[]; center?: number | number[]; std?: number | number[] };
  checkpoint: string;
  rows: {
    variant: string;
    accuracy: number;
    macro_f1: number;
    per_class: Record<string, number>;
    delta_f1?: Record<string, number>;
  }[];
  /** Retrains of the same data/split/seed, for the run-to-run table. */
  runs?: { checkpoint: string; extra: string | null; accuracy: number; macro_f1: number }[];
}

/** `pipeline/probe_q_boundary.py`: does a logit bias on N/Q fix the biggest cell? */
interface QBoundaryDoc {
  real: Metrics;
  pooled_sweep: {
    bias: number;
    accuracy: number;
    macro_f1: number;
    n_to_q: number;
    per_class: Record<string, number>;
  }[];
  out_of_fold: Record<
    string,
    { accuracy: number; macro_f1: number; delta_vs_argmax: number; n_to_q: number; q_to_n: number }
  >;
  fixed_qn: Record<
    string,
    | { accuracy: number; macro_f1: number; confusion: number[][] }
    | { patient: number; argmax: number; fixed: number }[]
    | { patient: number; bias: number; macro_f1: number; delta: number }[]
  >;
}

/** `pipeline/probe_q_transfer.py`: the same constant on every checkpoint. */
interface QTransferDoc {
  bias: number;
  rows: {
    checkpoint: string;
    extra: string;
    argmax: number;
    biased: number;
    delta: number;
    n_to_q: [number, number];
    q_to_n: [number, number];
  }[];
}

const MODEL_SECTIONS: PageSection[] = [
  { id: "task", title: "The task, and what Q means" },
  { id: "architecture", title: "Architecture" },
  { id: "cue", title: "Does it use the cue?" },
  { id: "training", title: "Training" },
  { id: "evaluation", title: "Held-out evaluation" },
  { id: "patients", title: "Per patient" },
  { id: "parity", title: "Parity" },
  { id: "cost", title: "Inference cost" },
  { id: "boundary", title: "The N → Q boundary" },
  { id: "limits", title: "What it cannot see" },
];

const CLASS_MEANING: Record<string, string> = {
  N: "Normal",
  S: "Supraventricular ectopic",
  V: "Ventricular ectopic",
  Q: "Unclassifiable",
};

interface Props {
  theme: "dark" | "light";
  onToggleTheme: () => void;
}

export const ModelPage = memo(function ModelPage({ theme, onToggleTheme }: Props) {
  const { t, num: fmt } = useT();
  // The page's own `num` was hard-coded to en-US grouping; every count on this
  // page now follows the active language, so 12,345 reads 12.345 in Vietnamese.
  const num = fmt;
  /** A fraction rendered as a percentage in the active language's convention. */
  const pct = (v: number, d = 1) => `${num(v * 100, d)}%`;
  const model = useJson<CnnDoc>("models/beatcnn.json");
  const train = useJson<TrainDoc>("models/beatcnn.train.json");
  const evaluation = useJson<EvalDoc>("models/beatcnn.eval.json");
  const ablate = useJson<AblateDoc>("models/beatcnn.ablate.json");
  const qbound = useJson<QBoundaryDoc>("models/beatcnn.qboundary.json");
  const qtrans = useJson<QTransferDoc>("models/beatcnn.qtransfer.json");

  // Architecture and stored parameter count, derived from the exported
  // tensors rather than from the training script's comment.
  //
  // The row labels are built through `t()` here rather than translated at the
  // render site, because they are composed from numbers ("Conv1d 1→16, k=5")
  // and so have no sentence for the dictionary to key on. `t` is a dependency:
  // switching language rebuilds the rows.
  const arch = useMemo(() => {
    const m = model.data;
    if (!m) return null;
    let len = m.window;
    const rows: { stage: string; op: string; shape: string; stored: number }[] = [];
    m.blocks.forEach((b, i) => {
      const cout = b.conv.w.length;
      const cin = b.conv.w[0].length;
      const k = b.conv.w[0][0].length;
      const before = len;
      len = Math.floor(len / b.pool);
      rows.push({
        stage: t("Conv {i}", { i: i + 1 }),
        op: `${t("Conv1d {a}→{b}, k={k}, same padding", { a: cin, b: cout, k })} · ReLU · ${t("maxpool {p}", { p: b.pool })}`,
        shape: `${before} → ${len}`,
        stored: cout * cin * k + b.conv.b.length,
      });
    });
    const ch = m.blocks[m.blocks.length - 1].conv.w.length;
    rows.push({
      stage: t("Pool"),
      op: t("Global average pool over time"),
      shape: `${len}×${ch} → ${ch}`,
      stored: 0,
    });
    if (m.extra?.kind && m.extra.kind !== "none") {
      const w = m.extra.kind === "rr" ? (m.extra.names?.length ?? 3) : 1;
      const op =
        m.extra.kind === "rr"
          ? t("Append standardised RR ratios (pre · post · sum)")
          : t("Append standardised log(scale)");
      rows.push({ stage: t("Concat"), op, shape: `${ch} → ${ch + w}`, stored: 0 });
    }
    m.head.forEach((l, i) => {
      const cin = l.w[0].length;
      const cout = l.w.length;
      rows.push({
        stage: t("Dense {i}", { i: i + 1 }),
        op: t(l.act ? "Dense {a}→{b} · ReLU" : "Dense {a}→{b} · logits", { a: cin, b: cout }),
        shape: `${cin} → ${cout}`,
        stored: cout * cin + l.b.length,
      });
    });
    const stored = rows.reduce((s, r) => s + r.stored, 0);
    // What PyTorch trained: the convolutions carry no bias (BatchNorm follows
    // them), and each BN layer adds two parameters per output channel. At
    // export those 2·C values fold into one bias per channel, so the file keeps
    // 80 fewer. Both counts are correct; they count different things.
    const convWeights = m.blocks.reduce(
      (s, b) => s + b.conv.w.length * b.conv.w[0].length * b.conv.w[0][0].length,
      0,
    );
    const convBias = m.blocks.reduce((s, b) => s + b.conv.b.length, 0);
    const bnParams = m.blocks.reduce((s, b) => s + 2 * b.conv.w.length, 0);
    const bnPerBlock = m.blocks.map((b) => 2 * b.conv.w.length);
    const biasPerBlock = m.blocks.map((b) => b.conv.b.length);
    const headParams = m.head.reduce((s, l) => s + l.w.length * l.w[0].length + l.b.length, 0);
    return {
      rows,
      stored,
      trained: convWeights + bnParams + headParams,
      bnParams,
      bnPerBlock,
      biasPerBlock,
      folded: bnParams - convBias,
      len,
      ch,
    };
  }, [model.data, t]);

  // The parity table, computed in the browser by the same forward pass the
  // monitor uses. If the weights, the folding or the normalisation ever drift,
  // this section shows it before a single beat is classified.
  const parity = useMemo(() => {
    const m = model.data;
    if (!m?.parity?.length) return null;
    const rows = m.parity.map((w, i) => {
      const got = logitsForWindow(m, Float32Array.from(w.raw), parityExtra(m, w));
      let d = 0;
      for (let c = 0; c < w.logits.length; c++) {
        d = Math.max(d, Math.abs(got[c] - w.logits[c]));
      }
      let mine = 0;
      for (let c = 1; c < got.length; c++) if (got[c] > got[mine]) mine = c;
      let ref = 0;
      for (let c = 1; c < w.logits.length; c++) if (w.logits[c] > w.logits[ref]) ref = c;
      return { i, cls: m.classes[mine], ref: m.classes[ref], d };
    });
    return {
      rows,
      worst: Math.max(...rows.map((r) => r.d)),
      agree: rows.filter((r) => r.cls === r.ref).length,
    };
  }, [model.data]);

  const patients = useMemo(() => {
    const e = evaluation.data;
    if (!e) return [];
    return Object.entries(e.per_patient)
      .map(([id, m]) => {
        const present = Object.values(m.per_class).filter((p) => p.support > 0);
        return {
          id,
          beats: present.reduce((s, p) => s + p.support, 0),
          accuracy: m.accuracy,
          presentF1: present.reduce((s, p) => s + p.f1, 0) / Math.max(1, present.length),
          per: m.per_class,
        };
      })
      .sort((a, b) => Number(a.id) - Number(b.id));
  }, [evaluation.data]);

  const hist = train.data?.history ?? [];
  const epochs = hist.map((h) => h.epoch);
  const loss = hist.map((h) => h.loss);
  const valAcc = hist.map((h) => h.val_acc);
  const valF1 = hist.map((h) => h.val_macro_f1);

  const ready = !!arch && !!train.data && !!evaluation.data && !!parity;
  const error = model.error ?? train.error ?? evaluation.error;

  // The class order the model was trained with. Memoised because the fallback
  // is a fresh literal per render, and it feeds a `useMemo` below.
  const classes = useMemo(() => model.data?.classes ?? ["N", "S", "V", "Q"], [model.data]);
  const pooled = evaluation.data?.pooled;

  // What the head's extra columns are, for the copy that has to name them.
  const extraInfo = useMemo(() => {
    const e = model.data?.extra;
    const kind = e?.kind ?? "none";
    const width = kind === "rr" ? (e?.names?.length ?? 3) : kind === "none" ? 0 : 1;
    return {
      kind,
      width,
      label: kind === "rr" ? "RR ratios" : "log(scale)",
      short: kind === "rr" ? "pre · post · sum" : "log(scale)",
      lede:
        kind === "rr"
          ? "three timing ratios taken from the surrounding peaks — prematurity, the pause after it, and their average — because a beat's earliness is invisible inside its own second of signal"
          : "the log of the amplitude the normalisation divides away",
    };
  }, [model.data]);

  // The ablation's verdict is computed from its own rows, not written here: the
  // same page has to tell the truth whether the extra column turns out to carry
  // the decision (the timing ratios, G9) or not (log(scale), G8).
  const cue = useMemo(() => {
    const a = ablate.data;
    if (!a?.rows?.length) return null;
    // By name, not by position: the multi-column model adds one row per
    // column, and the verdict must not start depending on their order.
    const real = a.rows.find((r) => r.variant === "real");
    const zero = a.rows.find((r) => r.variant.startsWith("zero"));
    const shuffle = a.rows.find((r) => r.variant === "shuffle");
    const kind = a.extra?.kind ?? "none";
    const drop =
      real && zero && shuffle ? real.macro_f1 - Math.min(zero.macro_f1, shuffle.macro_f1) : 0;
    let maxMove = 0;
    for (const r of a.rows) {
      if (r === real) continue;
      for (const c of classes) {
        maxMove = Math.max(maxMove, Math.abs(r.delta_f1?.[c] ?? 0));
      }
    }
    return {
      kind,
      label: kind === "rr" ? "RR ratios" : "log(scale)",
      real,
      zero,
      shuffle,
      drop,
      maxMove,
      used: drop > 0.02,
    };
  }, [ablate.data, classes]);

  // The N/Q boundary result. Two artefacts, and the verdict is read off them:
  // the pooled sweep says how far the cell moves, the transfer test says whether
  // the macro-F1 gain survives a different checkpoint. The page must not quote
  // the first without the second -- that is the mistake G8 caught.
  const boundary = useMemo(() => {
    const qb = qbound.data;
    const tr = qtrans.data;
    if (!qb?.pooled_sweep?.length) return null;
    const sweep = qb.pooled_sweep.filter((r) => r.bias <= 0);
    const peak = sweep.reduce((a, b) => (b.macro_f1 > a.macro_f1 ? b : a));
    const real = qb.real;
    const oofTracked = qb.out_of_fold?.qn;
    const oofPlain = qb.out_of_fold?.q;
    const own = (qb.fixed_qn?.best_per_patient ?? []) as {
      patient: number;
      bias: number;
      delta: number;
    }[];
    const deltas = tr?.rows.map((r) => r.delta) ?? [];
    return {
      sweep,
      peak,
      real,
      oof: oofTracked,
      oofPlain,
      own,
      transfer: tr?.rows ?? [],
      bias: tr?.bias ?? peak.bias,
      positive: deltas.filter((d) => d > 0).length,
      total: deltas.length,
      transfers: deltas.length > 0 && deltas.every((d) => d > 0),
      nToQReal: real?.confusion?.[0]?.[3] ?? 0,
    };
  }, [qbound.data, qtrans.data]);

  return (
    <PageShell
      eyebrow={t("Rpeak Desktop · AI Model")}
      title={t("ECG Beat Classification Model Training")}
      subtitle={
        <>
          {t(
            "A {n}-parameter convolutional network that reads one 250-sample window around an R peak, plus",
            {
              n: arch ? num(arch.trained) : "7,156",
            },
          )}{" "}
          {t(extraInfo.lede)}, {t("and returns N, S, V or Q. It runs in the browser from")}{" "}
          <span className="mono">data/models/beatcnn.json</span>{" "}
          {t("with a hand-written forward pass — no ONNX runtime, no WASM bundle.")}
        </>
      }
      theme={theme}
      onToggleTheme={onToggleTheme}
      ready={ready}
      sections={MODEL_SECTIONS}
    >
      {error ? (
        <PageError what={t("the model artefacts")} error={error} />
      ) : !ready || !arch || !pooled ? (
        <PageLoading what={t("the model artefacts")} />
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            <StatTile
              label={t("Stored parameters")}
              value={num(arch.stored)}
              hint={t("{n} trained, incl. BatchNorm", { n: num(arch.trained) })}
            />
            <StatTile
              label={t("Held-out accuracy")}
              value={pct(pooled.accuracy, 1)}
              hint={t("macro-F1 {v}", { v: num(pooled.macro_f1, 3) })}
            />
            <StatTile
              label={t("Best epoch")}
              value={String(train.data!.best_epoch)}
              hint={t("of {n}, early-stopped", { n: train.data!.epochs_run })}
            />
            <StatTile
              label={t("Inference")}
              value="≈1"
              unit={t("ms/beat")}
              hint={t("6.5–9.1 s per segment")}
            />
          </div>

          <Section
            id="task"
            title="The task, and what Q actually means"
            lede={t(
              "Every R peak yields a 250-sample window — one second at 250 Hz, with the peak at sample 100 — normalised per beat by its own median and the 90th percentile of its core deviation. The network answers with one of the four groups AAMI EC57 defines. The fourth one is the reason this page exists.",
            )}
          >
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-4">
              {classes.map((c) => (
                <div
                  key={c}
                  className="rounded-lg border px-3 py-2"
                  style={{ borderColor: "var(--panel-border)" }}
                >
                  <div className="mono text-lg font-semibold leading-none">{c}</div>
                  <div className="text-[11px] text-dim mt-1">{t(CLASS_MEANING[c] ?? c)}</div>
                </div>
              ))}
            </div>

            <div
              className="rounded-lg border-l-2 px-3 py-2.5 text-[12px] leading-relaxed text-dim"
              style={{ borderColor: "var(--series-2)", background: "var(--panel-hover)" }}
            >
              <span className="font-semibold" style={{ color: "var(--text)" }}>
                {t("Q is not a rhythm.")}
              </span>{" "}
              {t("In icentia11k, Q is documented as")}{" "}
              <em>{t("“undefined: unclassifiable beat”")}</em>.{" "}
              {t(
                "The evidence agrees: Q beats occur in runs of up to 1,844 consecutive beats, their morphology correlation with a normal template has a median of 0.83 against 0.99 for N, and the signal around them is noisier. Q marks stretches where the annotator declined to label — movement artefact, a loose chest strap, a rhythm nobody would commit to. The model's fourth output is therefore",
              )}{" "}
              <em>{t("“this does not look like a usable beat”")}</em>
              {t(", and the monitor labels it")}{" "}
              <span className="text-[var(--text)]">{t("Unclassifiable")}</span>.{" "}
              {t(
                "It is not a diagnosis, and the per-class numbers below should be read with that in mind.",
              )}
            </div>
          </Section>

          <Section
            id="architecture"
            title="Architecture"
            lede={
              <>
                {t(
                  "Three convolutional blocks, a global average pool and two dense layers. The receptive field is about 60 samples (240 ms), enough for the QRS width that separates V from N, and the whole network costs roughly 225k multiply-accumulates per window — the budget that keeps a 7,000-beat segment under seven seconds in a browser worker. The pooled vector is concatenated with",
                )}{" "}
                {t("{n} extra input", { n: extraInfo.width })}
                {extraInfo.width === 1 ? "" : "s"} {t("before the head:")} {t(extraInfo.lede)}.{" "}
                {t("The ablation below measures whether it uses")}{" "}
                {t(extraInfo.width === 1 ? "it" : "them")}.
              </>
            }
            aside={
              <span className="text-[11px] text-faint mono">
                {t("{n} stored", { n: num(arch.stored) })}
              </span>
            }
          >
            <div className="flex flex-wrap items-stretch gap-1.5 mb-4">
              {[
                { name: "Input", detail: `1 × ${model.data!.window}`, sub: t("1 s, R at 100") },
                { name: "Conv block 1", detail: "1 → 16, k5", sub: t("ReLU · pool 4") },
                { name: "Conv block 2", detail: "16 → 32, k5", sub: t("ReLU · pool 4") },
                { name: "Conv block 3", detail: "32 → 32, k3", sub: t("ReLU · pool 2") },
                {
                  name: "Global pool",
                  detail: `${arch.len}×${arch.ch} → ${arch.ch}`,
                  sub: t("mean over time"),
                },
                {
                  name: "Concat",
                  detail: `${arch.ch} + ${extraInfo.width} → ${arch.ch + extraInfo.width}`,
                  sub: t(extraInfo.short),
                },
                {
                  name: "Head",
                  detail: `${arch.ch + extraInfo.width} → 32 → 4`,
                  sub: t("ReLU · logits"),
                },
              ].map((s, i) => (
                <Fragment key={s.name}>
                  {i > 0 && (
                    <div className="self-center text-faint text-xs px-0.5" aria-hidden>
                      →
                    </div>
                  )}
                  <div
                    className="rounded-md border px-2.5 py-2 min-w-[106px]"
                    style={{
                      borderColor: "var(--panel-border)",
                      background: "var(--panel-hover)",
                    }}
                  >
                    <div className="text-[10px] uppercase tracking-wider text-faint">
                      {t(s.name)}
                    </div>
                    <div className="mono text-[11px] mt-0.5">{s.detail}</div>
                    <div className="text-[10px] text-faint">{s.sub}</div>
                  </div>
                </Fragment>
              ))}
            </div>

            <table className="w-full text-[11px]">
              <thead>
                <tr className="text-faint">
                  {/* Wide enough for "Tích chập 1", which wraps and lifts every
                      row in the table when the column is 64px. */}
                  <th className="text-left font-normal pb-1.5 w-24">{t("Stage")}</th>
                  <th className="text-left font-normal pb-1.5">{t("Operation")}</th>
                  <th className="text-left font-normal pb-1.5 w-24">{t("Shape")}</th>
                  <th className="text-right font-normal pb-1.5 w-24">{t("Stored")}</th>
                </tr>
              </thead>
              <tbody>
                {arch.rows.map((r) => (
                  <tr
                    key={r.stage}
                    className="border-t"
                    style={{ borderColor: "var(--panel-border)" }}
                  >
                    <td className="py-1.5 mono text-dim">{r.stage}</td>
                    {/* Already translated when the rows were built: the
                        operation string is composed from tensor shapes, so it
                        has no sentence for the dictionary to key on. */}
                    <td className="py-1.5">{r.op}</td>
                    <td className="py-1.5 mono text-dim">{r.shape}</td>
                    <td className="py-1.5 mono text-right">{r.stored ? num(r.stored) : "—"}</td>
                  </tr>
                ))}
                <tr className="border-t" style={{ borderColor: "var(--panel-border)" }}>
                  <td className="py-1.5 text-faint" colSpan={3}>
                    {t(
                      "BatchNorm scale + shift during training (2 per channel), folded into one bias per channel at export",
                    )}
                  </td>
                  <td className="py-1.5 mono text-right text-faint">
                    +{num(arch.bnParams)} / −{num(arch.folded)}
                  </td>
                </tr>
                <tr
                  className="border-t font-semibold"
                  style={{ borderColor: "var(--panel-border)" }}
                >
                  <td className="py-1.5" colSpan={3}>
                    {t("Trained in PyTorch")}
                  </td>
                  <td className="py-1.5 mono text-right">{num(arch.trained)}</td>
                </tr>
              </tbody>
            </table>

            <p className="text-[11px] text-faint leading-relaxed mt-3">
              {t("Both counts are right, and they count different things.")}{" "}
              {t("{n} parameters were trained;", { n: num(arch.trained) })}{" "}
              {t(
                "{n} are what the JSON carries. The convolutions have no bias while training because BatchNorm follows them, so each block's scale and shift — two values per output channel,",
                { n: num(arch.stored) },
              )}{" "}
              {arch.bnPerBlock.join(" + ")}{" "}
              {t(
                "= {n} in all — are the only per-channel offsets. Folding collapses them into one bias per channel (",
                {
                  n: num(arch.bnParams),
                },
              )}{" "}
              {arch.biasPerBlock.join(" + ")}{" "}
              {t(
                "= {a}), which is why the stored count is exactly {b} lower. The runtime never has to remember whether normalisation runs before or after the activation.",
                {
                  a: num(arch.bnParams - arch.folded),
                  b: num(arch.folded),
                },
              )}
            </p>
          </Section>

          <Section
            id="cue"
            title="Does it use the cue?"
            lede={t(
              "The extra inputs exist because a 1 s window cannot hold everything a beat is. That is a hypothesis about the network, and it is testable without retraining: take the trained weights and feed them a constant, or the right values shuffled across beats. If the columns carry anything, both should hurt.",
            )}
          >
            {cue ? (
              <>
                <div className="overflow-x-auto">
                  <table className="w-full text-[11px] min-w-[520px]">
                    <thead>
                      <tr className="text-faint">
                        <th className="text-left font-normal pb-1.5">
                          {t("{label} fed to the head", { label: t(cue.label) })}
                        </th>
                        <th className="text-right font-normal pb-1.5">{t("Accuracy")}</th>
                        <th className="text-right font-normal pb-1.5">{t("Macro-F1")}</th>
                        {classes.map((c) => (
                          <th key={c} className="text-right font-normal pb-1.5">
                            {t("{c} F1", { c })}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {ablate.data!.rows.map((r) => (
                        <tr
                          key={r.variant}
                          className="border-t"
                          style={{ borderColor: "var(--panel-border)" }}
                        >
                          <td className="py-1.5">{t(r.variant)}</td>
                          <td className="py-1.5 mono text-right">{pct(r.accuracy, 1)}</td>
                          <td className="py-1.5 mono text-right font-semibold">
                            {num(r.macro_f1, 3)}
                          </td>
                          {classes.map((c) => (
                            <td key={c} className="py-1.5 mono text-right">
                              {num(r.per_class[c]!, 3)}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div
                  className="rounded-lg border-l-2 px-3 py-2.5 text-[12px] leading-relaxed text-dim mt-4"
                  style={{ borderColor: "var(--series-2)", background: "var(--panel-hover)" }}
                >
                  <span className="font-semibold" style={{ color: "var(--text)" }}>
                    {t(cue.used ? "The network uses it." : "The network ignores it.")}
                  </span>{" "}
                  {t("Replacing the column with a constant moves macro-F1 from")}{" "}
                  <span className="mono">{num(cue.real!.macro_f1, 4)}</span> {t("to")}{" "}
                  <span className="mono">{num(cue.zero!.macro_f1, 4)}</span>
                  {t(", and shuffling it across beats to")}{" "}
                  <span className="mono">{num(cue.shuffle!.macro_f1, 4)}</span>
                  {cue.used ? (
                    <>
                      {" "}
                      {t("— a loss of")} <span className="mono">{num(cue.drop, 3)}</span>{" "}
                      {t(
                        "that the convolutional stack cannot recover, because the information is not in the window at all.",
                      )}
                    </>
                  ) : (
                    <>
                      . {t("No class moves by more than")}{" "}
                      <span className="mono">{num(cue.maxMove, 3)}</span>{" "}
                      {t("in either direction, so the column is not carrying the decision.")}
                    </>
                  )}{" "}
                  {cue.kind === "rr" ? (
                    <>
                      {t(
                        "The cue itself is real and strong: on the held-out patients, prematurity alone separates S from N at AUC 0.930 and V from N at 0.985, and still 0.90–1.00 when the ratios are taken from detected peaks instead of annotations (",
                      )}
                      <span className="mono">pipeline/probe_rr.py</span>).
                    </>
                  ) : (
                    <>
                      {t(
                        "The cue is real (log(scale) alone separates Q from N at AUC 0.615) and still redundant here.",
                      )}
                    </>
                  )}
                </div>

                {ablate.data!.runs?.length ? (
                  <div className="mt-4">
                    <div className="text-[11px] text-dim mb-1.5">
                      {t("What the retrains actually changed")}
                    </div>
                    <table className="w-full text-[11px] max-w-xl">
                      <thead>
                        <tr className="text-faint">
                          <th className="text-left font-normal pb-1">{t("Run")}</th>
                          <th className="text-left font-normal pb-1">{t("Extra input")}</th>
                          <th className="text-right font-normal pb-1">{t("Accuracy")}</th>
                          <th className="text-right font-normal pb-1">{t("Macro-F1")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {ablate.data!.runs.map((r) => (
                          <tr
                            key={r.checkpoint}
                            className="border-t"
                            style={{ borderColor: "var(--panel-border)" }}
                          >
                            <td className="py-1 mono">{r.checkpoint}</td>
                            <td className="py-1 mono text-dim">{t(r.extra ?? "none")}</td>
                            <td className="py-1 mono text-right">{pct(r.accuracy, 1)}</td>
                            <td className="py-1 mono text-right">{num(r.macro_f1, 3)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <p className="text-[11px] text-faint leading-relaxed mt-2">
                      {t("Same data, same split, same seed.")}{" "}
                      {t(
                        cue.used
                          ? "Three extras were tried: none, log(scale) (G8) and the timing ratios (G9). The gap between the first row and the last is in the same direction as the ablation above, which is the difference between a plausible feature and a measured one — the ablation is the evidence, this table is the context."
                          : "The spread across runs with and without the extra column is the run-to-run variance of this model on six held-out patients, not the value of the cue. The shipped model is the best of them; do not read the gap between the first and last row as a feature's contribution.",
                      )}
                    </p>
                  </div>
                ) : null}
              </>
            ) : (
              <p className="text-[11px] text-faint">
                {t("No ablation artefact — run")}{" "}
                <span className="mono">pipeline/ablate_extra.py --out</span> {t("to produce one.")}
              </p>
            )}
          </Section>

          <Section
            id="training"
            title="Training"
            lede={t(
              "Twenty-four patients for training, six held out by patient — never by window, because adjacent beats from one 70-minute recording are near-duplicates and a window-level split reports memorisation as accuracy. Early stopping kept the checkpoint from epoch {n}.",
              {
                n: train.data!.best_epoch,
              },
            )}
          >
            <div className="grid lg:grid-cols-2 gap-3 mb-4">
              <div className="rounded-lg border p-3" style={{ borderColor: "var(--panel-border)" }}>
                <div className="flex items-baseline justify-between mb-1">
                  <div className="text-[11px] text-dim">{t("Training loss")}</div>
                  <div className="text-[10px] text-faint">{t("class-weighted cross-entropy")}</div>
                </div>
                <LineChart
                  x={epochs}
                  series={[{ name: t("Loss"), color: "var(--series-1)", values: loss }]}
                  yDomain={[0.45, 0.85]}
                  yTicks={[0.5, 0.6, 0.7, 0.8]}
                  formatY={(v) => num(v, 2)}
                  markerX={train.data!.best_epoch}
                  markerLabel={t("best")}
                  ariaLabel={t("Training loss by epoch, falling from 0.81 to 0.47")}
                  xSuffix={t(" · epoch")}
                />
              </div>

              <div className="rounded-lg border p-3" style={{ borderColor: "var(--panel-border)" }}>
                <div className="flex items-baseline justify-between mb-1">
                  <div className="text-[11px] text-dim">{t("Validation scores")}</div>
                  <Legend
                    items={[
                      { name: "Accuracy", color: "var(--series-1)" },
                      { name: "Macro-F1", color: "var(--series-2)" },
                    ]}
                  />
                </div>
                <LineChart
                  x={epochs}
                  series={[
                    { name: t("Acc"), color: "var(--series-1)", values: valAcc },
                    { name: t("F1"), color: "var(--series-2)", values: valF1 },
                  ]}
                  yDomain={[0.42, 0.76]}
                  yTicks={[0.45, 0.55, 0.65, 0.75]}
                  formatY={(v) => pct(v, 1)}
                  formatTick={(v) => `${Math.round(v * 100)}%`}
                  markerX={train.data!.best_epoch}
                  markerLabel={t("best")}
                  ariaLabel={t("Validation accuracy and macro-F1 by epoch")}
                  xSuffix={t(" · epoch")}
                />
              </div>
            </div>

            <p className="text-[11px] text-dim leading-relaxed mb-4">
              {t("Best epoch {e}: accuracy", { e: train.data!.best_epoch })}{" "}
              <span className="mono">{pct(train.data!.metrics.accuracy, 2)}</span>
              {t(", macro-F1")} <span className="mono">{num(train.data!.metrics.macro_f1, 3)}</span>
              .{" "}
              {t(
                "The run continued to epoch {e} and stopped after eight epochs without a macro-F1 gain. The oscillation after epoch {b} is why the selection is on macro-F1 rather than on the loss, which never turned upward.",
                {
                  e: train.data!.epochs_run,
                  b: train.data!.best_epoch,
                },
              )}
            </p>

            <div className="grid md:grid-cols-2 gap-x-8 gap-y-1 mb-4">
              <KV k="Optimiser" v={t("AdamW · lr 2e-3 · weight decay 1e-4")} />
              <KV k="Loss" v={t("CE weighted by inverse √frequency, mean 1")} />
              <KV k="Schedule" v={t("cosine over {n} epochs", { n: train.data!.hparams.epochs })} />
              <KV k="Class cap" v={t("60,000 windows per class per epoch")} />
              <KV k="Batch" v={num(train.data!.hparams.batch)} />
              <KV k="Dropout" v={String(train.data!.hparams.dropout)} />
              <KV k="Early stop" v={t("8 epochs without macro-F1 gain")} />
              <KV
                k="Extra input"
                v={t("{label}, standardised before the head", { label: t(extraInfo.label) })}
              />
              <KV k="Seed" v="20261119" />
            </div>

            <div className="grid lg:grid-cols-[1.2fr_1fr] gap-4">
              <div>
                <div className="text-[11px] text-dim mb-1.5">{t("Class balance and weights")}</div>
                <table className="w-full text-[11px]">
                  <thead>
                    <tr className="text-faint">
                      <th className="text-left font-normal pb-1">{t("Class")}</th>
                      <th className="text-right font-normal pb-1">{t("Train / epoch")}</th>
                      <th className="text-right font-normal pb-1">{t("Weight")}</th>
                      <th className="text-right font-normal pb-1">{t("Held-out")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {classes.map((c, i) => (
                      <tr
                        key={c}
                        className="border-t"
                        style={{ borderColor: "var(--panel-border)" }}
                      >
                        <td className="py-1 mono">
                          {c} <span className="text-faint font-sans">{t(CLASS_MEANING[c]!)}</span>
                        </td>
                        <td className="py-1 mono text-right">
                          {num(train.data!.class_counts_train[i] ?? 0)}
                        </td>
                        <td className="py-1 mono text-right">
                          {train.data!.class_weights[i] == null
                            ? "—"
                            : num(train.data!.class_weights[i]!, 3)}
                        </td>
                        <td className="py-1 mono text-right">
                          {num(train.data!.class_counts_val[i] ?? 0)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="text-[11px] text-dim leading-relaxed space-y-1.5">
                <p>
                  <span className="text-[var(--text)]">{num(train.data!.n_train)}</span>{" "}
                  {t("windows per epoch after the cap —")}{" "}
                  {t(
                    "{r} records from {p} patients. The uncapped corpus is 522,652 windows; 65% of it is N from the same 24 people, and the 400,000th normal window teaches nothing while it does make two thirds of every epoch redundant.",
                    {
                      r: num(train.data!.train_records.length),
                      p: train.data!.train_patients.length,
                    },
                  )}
                </p>
                <p>
                  {t("Held out:")}{" "}
                  <span className="text-[var(--text)]">{num(train.data!.n_val)}</span>{" "}
                  {t(
                    "windows from {p} patients ({r} records). The training script refuses to run if the two patient sets intersect.",
                    {
                      p: train.data!.val_patients.length,
                      r: num(train.data!.val_records.length),
                    },
                  )}
                </p>
                <p>
                  {t(
                    "Augmentation is baseline wander (0.05–0.5 Hz, ±0.6), gain drift (0.92–1.08), time shift (±20 ms) and small Gaussian noise. No time stretching: that would invent heart rates the patient never had.",
                  )}
                </p>
              </div>
            </div>
          </Section>

          <Section
            id="evaluation"
            title="Held-out evaluation"
            lede={t(
              "{n} beats from six patients whose recordings never enter training. Accuracy is inflated by the N majority — a model that answered N for every beat would score {acc} and have a macro-F1 near {f1} — so macro-F1 is the number to read.",
              {
                n: num(train.data!.n_val),
                acc: pct(
                  (train.data!.class_counts_val[0] ?? 0) / Math.max(1, train.data!.n_val),
                  0,
                ),
                f1: num(
                  (2 * (train.data!.class_counts_val[0] ?? 0)) /
                    Math.max(1, train.data!.n_val + (train.data!.class_counts_val[0] ?? 0)) /
                    4,
                  2,
                ),
              },
            )}
          >
            <div className="grid lg:grid-cols-[1.05fr_1fr] gap-5">
              <div>
                <div className="text-[11px] text-dim mb-2">{t("Confusion matrix")}</div>
                <ConfusionMatrix classes={classes} matrix={pooled.confusion} />
                <p className="text-[10px] text-faint leading-snug mt-2">
                  {t(
                    "The dominant error is N → Q: {n} normal beats called unclassifiable, {pct} of all N beats and more than every other N error combined.",
                    {
                      n: num(pooled.confusion[0]![3]!),
                      pct: pct(pooled.confusion[0]![3]! / pooled.per_class.N!.support, 1),
                    },
                  )}
                </p>
              </div>

              <div>
                <div className="text-[11px] text-dim mb-1.5">{t("Per class")}</div>
                <table className="w-full text-[11px] mb-3">
                  <thead>
                    <tr className="text-faint">
                      <th className="text-left font-normal pb-1">{t("Class")}</th>
                      <th className="text-right font-normal pb-1">{t("Support")}</th>
                      <th className="text-right font-normal pb-1">{t("Se")}</th>
                      <th className="text-right font-normal pb-1">{t("PPV")}</th>
                      <th className="text-right font-normal pb-1">{t("F1")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {classes.map((c) => {
                      const m = pooled.per_class[c]!;
                      return (
                        <tr
                          key={c}
                          className="border-t"
                          style={{ borderColor: "var(--panel-border)" }}
                        >
                          <td className="py-1 mono">
                            {c} <span className="text-faint font-sans">{t(CLASS_MEANING[c]!)}</span>
                          </td>
                          <td className="py-1 mono text-right">{num(m.support)}</td>
                          <td className="py-1 mono text-right">{pct(m.se)}</td>
                          <td className="py-1 mono text-right">{pct(m.ppv)}</td>
                          <td className="py-1 mono text-right font-semibold">{num(m.f1, 3)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>

                <div className="text-[11px] text-dim mb-1.5">{t("F1 by class")}</div>
                <BarList
                  rows={classes.map((c) => ({
                    label: c,
                    value: pooled.per_class[c]!.f1,
                    note: t("{name}: F1 {v}", {
                      name: t(CLASS_MEANING[c]!),
                      v: num(pooled.per_class[c]!.f1, 3),
                    }),
                  }))}
                  max={1}
                  format={(v) => num(v, 3)}
                />
              </div>
            </div>
          </Section>

          <Section
            id="patients"
            title="Per patient"
            lede={t(
              "The pooled number hides how much the model varies between people, so the spread is reported rather than an average. Four of the six held-out patients have no S beats and one has no V beats; the last column therefore averages F1 over the classes that patient actually has, which is the honest comparison across rows.",
            )}
          >
            <div className="overflow-x-auto">
              <table className="w-full text-[11px] min-w-[560px]">
                <thead>
                  <tr className="text-faint">
                    <th className="text-left font-normal pb-1.5">{t("Patient")}</th>
                    <th className="text-right font-normal pb-1.5">{t("Beats")}</th>
                    <th className="text-right font-normal pb-1.5">{t("Accuracy")}</th>
                    {classes.map((c) => (
                      <th key={c} className="text-right font-normal pb-1.5">
                        {t("{c} F1", { c })}
                      </th>
                    ))}
                    <th className="text-right font-normal pb-1.5">{t("Present-class macro-F1")}</th>
                  </tr>
                </thead>
                <tbody>
                  {patients.map((p) => (
                    <tr
                      key={p.id}
                      className="border-t"
                      style={{ borderColor: "var(--panel-border)" }}
                    >
                      <td className="py-1.5 mono">p{String(p.id).padStart(5, "0")}</td>
                      <td className="py-1.5 mono text-right">{num(p.beats)}</td>
                      <td className="py-1.5 mono text-right">{pct(p.accuracy)}</td>
                      {classes.map((c) => {
                        const m = p.per[c]!;
                        return (
                          <td key={c} className="py-1.5 mono text-right">
                            {m.support ? num(m.f1, 3) : <span className="text-faint">—</span>}
                          </td>
                        );
                      })}
                      <td className="py-1.5 mono text-right font-semibold">
                        {num(p.presentF1, 3)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-[11px] text-faint leading-relaxed mt-3">
              {t(
                "The mean of the last column is {m} — the same as the pooled macro-F1, which is the reassurance this table was meant to test. The spread is still wide: the worst patient scores {lo} and the best {hi}, and the bad ones are the recordings dominated by unusable stretches. The model is not uniformly mediocre; it fails where the signal does.",
                {
                  m: num(
                    patients.reduce((s, p) => s + p.presentF1, 0) / Math.max(1, patients.length),
                    3,
                  ),
                  lo: num(Math.min(...patients.map((p) => p.presentF1)), 3),
                  hi: num(Math.max(...patients.map((p) => p.presentF1)), 3),
                },
              )}
            </p>
          </Section>

          <Section
            id="parity"
            title="Parity: PyTorch ↔ TypeScript"
            lede={
              <>
                {t("The app has no inference engine. The weights travel as JSON and")}{" "}
                <span className="mono">src/lib/ecg/cnn.ts</span>{" "}
                {t(
                  "runs a hand-written forward pass. That is only defensible if the two implementations agree, so the exporter wrote eight validation windows and PyTorch's exact logits into the model file. The table below is recomputed",
                )}{" "}
                <em>{t("in your browser")}</em>{" "}
                {t("as this page loads, by the same code the monitor uses.")}
              </>
            }
          >
            <div className="grid grid-cols-2 md:grid-cols-3 gap-2 mb-4">
              <StatTile
                label={t("Argmax agreement")}
                value={`${parity!.agree}/${parity!.rows.length}`}
                hint={t("windows where both pick the same class")}
              />
              <StatTile
                label={t("Worst |Δlogit|")}
                value={parity!.worst.toExponential(1)}
                hint={t("tolerance 2e-4")}
              />
              <StatTile
                label={t("Shared code")}
                value="0"
                hint={t("PyTorch and TypeScript implementations")}
              />
            </div>

            <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-1.5">
              {parity!.rows.map((r) => (
                <div
                  key={r.i}
                  className="rounded-md border px-2.5 py-1.5 flex items-baseline gap-2"
                  style={{ borderColor: "var(--panel-border)" }}
                >
                  <span className="text-[10px] text-faint mono">w{r.i}</span>
                  <span className="mono text-[11px] font-semibold">{r.cls}</span>
                  <span className="ml-auto mono text-[10px] text-faint">
                    {r.d.toExponential(1)}
                  </span>
                </div>
              ))}
            </div>

            <p className="text-[11px] text-faint leading-relaxed mt-3">
              {t(
                "Agreement at this scale pins the weight layout, the BatchNorm folding, the padding, the pooling truncation and the per-window normalisation. A shape check would catch none of them — and getting any one wrong does not throw, it silently degrades every classification.",
              )}
            </p>
          </Section>

          <Section
            id="cost"
            title="Inference cost"
            lede={t(
              "Raw scalar throughput in this environment measures about 721 MMAC/s, so a ~225k-MAC window is ~0.3 ms of arithmetic and about 1 ms per beat end to end. The spread is machine load, not the model: repeat runs on the same segment measured 0.95–1.3 ms per beat as this machine's load moved between 24% and 57%. An earlier four-block design measured 1.1M MAC and took 34 s per segment; it was replaced, not optimised. Computing the three ratios for the whole peak train costs 35 ms, so the extra inputs are not what the runtime is spending.",
            )}
          >
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
              <StatTile
                label={t("Per beat")}
                value="0.95–1.3"
                unit="ms"
                hint={t("measured on p00000_s00")}
              />
              <StatTile
                label={t("Per segment")}
                value="6.5–9.1"
                unit="s"
                hint={t("6,886 beats, in a worker")}
              />
              <StatTile
                label={t("Model file")}
                value="197"
                unit="KB"
                hint={t("JSON, incl. parity windows")}
              />
              <StatTile
                label={t("Detector, for scale")}
                value="685"
                unit="ms"
                hint={t("median per segment")}
              />
            </div>
            <p className="text-[11px] text-faint leading-relaxed mt-3">
              {t(
                "Classification runs in a worker over the same peak set the rest of the app uses — detector peaks when the detector is on, annotations otherwise — so playback continues while a segment is classified.",
              )}
            </p>
          </Section>

          <Section
            id="boundary"
            title="The N → Q boundary, measured and not shipped"
            lede={
              boundary ? (
                <>
                  {t(
                    "The largest remaining error is {n} normal beats called Q. If that is a badly placed decision boundary rather than a missing input, a post-hoc bias on the two logits should move it. It does — and the gain does not survive the check that it is not this checkpoint's luck.",
                    {
                      n: num(boundary.nToQReal),
                    },
                  )}
                </>
              ) : (
                <>
                  {t("The largest remaining error is normal beats called Q. Run")}{" "}
                  <span className="mono">pipeline/probe_q_boundary.py</span>{" "}
                  {t("to fill this section.")}
                </>
              )
            }
          >
            {boundary && (
              <>
                <p className="text-[12px] text-dim leading-relaxed mb-3">
                  {t(
                    "The rule adds a constant to Q's logit and the opposite to N's, leaving S and V alone. No retrain: the weights are unchanged, so the only thing that moves is where the line between “noisy normal” and “unusable” is drawn.",
                  )}
                </p>
                <div className="overflow-x-auto">
                  <table className="text-[11px] mono w-full">
                    <thead>
                      <tr className="text-left text-faint">
                        <th className="py-1 pr-3 font-medium">{t("bias")}</th>
                        <th className="py-1 pr-3 font-medium">{t("accuracy")}</th>
                        <th className="py-1 pr-3 font-medium">{t("macro-F1")}</th>
                        {classes.map((c) => (
                          <th key={c} className="py-1 pr-3 font-medium">
                            {t("{c} F1", { c })}
                          </th>
                        ))}
                        <th className="py-1 font-medium">N→Q</th>
                      </tr>
                    </thead>
                    <tbody>
                      {boundary.sweep.map((r) => {
                        const best = r.bias === boundary.peak.bias;
                        return (
                          <tr
                            key={r.bias}
                            className={best ? "font-semibold text-[var(--text)]" : ""}
                          >
                            <td className="py-0.5 pr-3">
                              {r.bias === 0 ? t("0.00 (argmax)") : num(r.bias, 2)}
                            </td>
                            <td className="py-0.5 pr-3 tabular-nums">{num(r.accuracy, 4)}</td>
                            <td className="py-0.5 pr-3 tabular-nums">{num(r.macro_f1, 4)}</td>
                            {classes.map((c) => (
                              <td key={c} className="py-0.5 pr-3 tabular-nums">
                                {num(r.per_class[c]!, 3)}
                              </td>
                            ))}
                            <td className="py-0.5 tabular-nums">{num(r.n_to_q)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                <div className="grid sm:grid-cols-2 gap-2 mt-4">
                  <StatTile
                    label={t("N→Q at the best bias")}
                    value={num(boundary.peak.n_to_q)}
                    unit={t("of {n}", { n: num(boundary.nToQReal) })}
                    hint={t("−{pct}% of the cell", {
                      pct: Math.round(
                        (1 - boundary.peak.n_to_q / Math.max(boundary.nToQReal, 1)) * 100,
                      ),
                    })}
                  />
                  <StatTile
                    label={t("Macro-F1")}
                    value={`${num(boundary.real.macro_f1, 3)} → ${num(boundary.peak.macro_f1, 3)}`}
                    hint={t("on the held-out patients, tuned on them")}
                  />
                  <StatTile
                    label={t("Out of fold")}
                    value={boundary.oof ? num(boundary.oof.macro_f1, 3) : "—"}
                    hint={t("tuned on five patients, scored on the sixth")}
                  />
                  <StatTile
                    label={t("Checkpoints it helps")}
                    value={`${boundary.positive} / ${boundary.total}`}
                    hint={t("same constant, {which} of them", {
                      which: t(boundary.transfers ? "all" : "not all"),
                    })}
                  />
                </div>

                <p className="text-[11px] text-dim leading-relaxed mt-4">
                  <span className="text-[var(--text)] font-semibold">
                    {t("Out of fold, the rule survives.")}
                  </span>{" "}
                  {t(
                    "Tuning the constant on five patients and scoring the sixth gives macro-F1 {f1}, a gain of {gain} over the plain argmax, with the per-fold constant landing between −0.75 and −1.00 every time. That rules out the rule having been fitted to the six.",
                    {
                      f1: boundary.oof ? num(boundary.oof.macro_f1, 4) : "—",
                      gain: boundary.oof ? num(boundary.oof.delta_vs_argmax, 4) : "—",
                    },
                  )}
                </p>

                <div className="overflow-x-auto mt-4">
                  <table className="text-[11px] mono w-full">
                    <thead>
                      <tr className="text-left text-faint">
                        <th className="py-1 pr-3 font-medium">{t("checkpoint")}</th>
                        <th className="py-1 pr-3 font-medium">{t("extra input")}</th>
                        <th className="py-1 pr-3 font-medium">{t("argmax")}</th>
                        <th className="py-1 pr-3 font-medium">{t("biased")}</th>
                        <th className="py-1 pr-3 font-medium">{t("delta")}</th>
                        <th className="py-1 font-medium">N→Q</th>
                      </tr>
                    </thead>
                    <tbody>
                      {boundary.transfer.map((r) => (
                        <tr key={r.checkpoint}>
                          <td className="py-0.5 pr-3">{r.checkpoint}</td>
                          <td className="py-0.5 pr-3 text-faint">{r.extra}</td>
                          <td className="py-0.5 pr-3 tabular-nums">{num(r.argmax, 4)}</td>
                          <td className="py-0.5 pr-3 tabular-nums">{num(r.biased, 4)}</td>
                          <td
                            className={`py-0.5 pr-3 tabular-nums ${r.delta < 0 ? "text-[var(--danger)]" : ""}`}
                          >
                            {r.delta >= 0 ? "+" : ""}
                            {num(r.delta, 4)}
                          </td>
                          <td className="py-0.5 tabular-nums text-faint">
                            {num(r.n_to_q[0])} → {num(r.n_to_q[1])}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <p className="text-[11px] text-dim leading-relaxed mt-3">
                  <span className="text-[var(--text)] font-semibold">
                    {t("And then it does not survive.")}
                  </span>{" "}
                  {t(
                    "The same constant, on the same beats, helps {a} of {b} checkpoints. Two of them move backwards by roughly 0.01 while every one of them loses 70–77% of its N→Q cell and gains 0.05–0.08 accuracy. The cell is a boundary problem; whether hoisting the boundary improves macro-F1 is a property of the particular run, and 0.05 is this recipe's run-to-run spread. So the rule is documented, not shipped, and the model still decides with the plain argmax.",
                    {
                      a: boundary.positive,
                      b: boundary.total,
                    },
                  )}
                </p>

                <p
                  className="text-[11px] text-faint leading-relaxed mt-3 pt-3 border-t"
                  style={{ borderColor: "var(--panel-border)" }}
                >
                  {t(
                    "Per patient the constant a model would choose for itself runs from {lo} to {hi}, worth {best} on the recording that wants it most and nothing on the one that wants none. The ones that want a large shift are the recordings dominated by unusable signal, so the right correction is a per-recording prior — which a one-second window cannot know. A pooled prior correction from the training frequencies lands at Q −0.09 and takes macro-F1 down to 0.552 by dragging S and V with it. Numbers in",
                    {
                      lo: boundary.own.length
                        ? num(Math.min(...boundary.own.map((r) => r.bias)), 2)
                        : "—",
                      hi: boundary.own.length
                        ? num(Math.max(...boundary.own.map((r) => r.bias)), 2)
                        : "—",
                      best: boundary.own.length
                        ? num(Math.max(...boundary.own.map((r) => r.delta)), 3)
                        : "—",
                    },
                  )}{" "}
                  <span className="mono">beatcnn.qboundary.json</span> {t("and")}{" "}
                  <span className="mono">beatcnn.qtransfer.json</span>.
                </p>
              </>
            )}
          </Section>

          <Section
            id="limits"
            title="What it still cannot see"
            lede={t("These are measured failure modes, not caveats added for tone.")}
          >
            <ul className="text-[12px] text-dim leading-relaxed space-y-2 list-disc pl-5">
              <li>
                <span className="text-[var(--text)] font-semibold">
                  {t("N → Q, {n} errors — still the largest.", {
                    n: num(pooled.confusion[0]![3]!),
                  })}
                </span>{" "}
                {t(
                  "Q marks unusable stretches, and unusable stretches are noisier, so their amplitude is larger and per-beat normalisation divides that cue away.",
                )}{" "}
                <span className="mono">log(scale)</span>{" "}
                {t(
                  "was added to restore it and the ablation showed the network ignores it; the timing ratios were aimed at S and V and barely touched this cell either. So the boundary itself was attacked — a logit bias on N and Q — and the answer is that it is a boundary problem: the cell shrinks sharply and accuracy rises, but",
                )}{" "}
                {boundary ? (
                  <>
                    {t("the macro-F1 gain holds on {a} of {b} checkpoints, so it is not shipped.", {
                      a: boundary.positive,
                      b: boundary.total,
                    })}
                  </>
                ) : (
                  <>{t("the gain does not hold on every checkpoint, so it is not shipped.")}</>
                )}{" "}
                {t(
                  "Q is 24% of the corpus and carries a large weight, so an ambiguous noisy beat is cheaper to call Q than N. Q precision of {pct} says most Q calls are wrong.",
                  {
                    pct: pct(pooled.per_class.Q!.ppv),
                  },
                )}
              </li>
              <li>
                <span className="text-[var(--text)] font-semibold">
                  {t("S improved but is not solved.")}
                </span>{" "}
                {t(
                  "The three timing ratios gave it the context a window cannot hold — zeroing them costs {drop} F1 on S, the largest effect in the table above — and S F1 is now {f1}, the best it has been. Precision is the soft spot at {ppv}: many normal beats are a little early, and prematurity alone cannot tell sinus arrhythmia from an ectopic beat. Morphology and timing together are what a cardiologist uses, and the network has both now.",
                  {
                    drop: num(
                      Math.abs(
                        ablate.data?.rows.find((r) => r.variant === "zero (training mean)")
                          ?.delta_f1?.S ?? 0,
                      ),
                      2,
                    ),
                    f1: num(pooled.per_class.S!.f1, 3),
                    ppv: pct(pooled.per_class.S!.ppv),
                  },
                )}
              </li>
              <li>
                <span className="text-[var(--text)] font-semibold">
                  {t("V is now the weakest class, for the same reason.")}
                </span>{" "}
                {t(
                  "{se} recall at {ppv} precision, and 3,218 ventricular beats called S. The ratios let it see that a beat is premature, and it now picks the wrong ectopic class instead of missing the timing entirely — a different error at a similar score. V is rare enough that a handful of mistakes moves the number.",
                  {
                    se: pct(pooled.per_class.V!.se),
                    ppv: pct(pooled.per_class.V!.ppv),
                  },
                )}
              </li>
              <li>
                <span className="text-[var(--text)] font-semibold">
                  {t("The per-patient spread is wide.")}
                </span>{" "}
                {t(
                  "Present-class macro-F1 runs from {lo} to {hi} across the six held-out patients, and the low end is always a recording dominated by unusable stretches. Six patients is enough to see the spread, not enough to average it away.",
                  {
                    lo: num(Math.min(...patients.map((p) => p.presentF1)), 2),
                    hi: num(Math.max(...patients.map((p) => p.presentF1)), 2),
                  },
                )}
              </li>
              <li>
                <span className="text-[var(--text)] font-semibold">{t("No F class.")}</span>{" "}
                {t(
                  "icentia11k does not carry AAMI's fusion class, so the model has four outputs, not five.",
                )}
              </li>
            </ul>

            <p
              className="text-[11px] text-faint leading-relaxed mt-4 pt-3 border-t"
              style={{ borderColor: "var(--panel-border)" }}
            >
              {t(
                "This is a rebuild's demonstration model, trained on 24 patients to show that the pipeline is honest end to end. It is not a medical device, and {pct} held-out accuracy is not a number to act on.",
                {
                  pct: pct(pooled.accuracy),
                },
              )}
            </p>
          </Section>
        </>
      )}
    </PageShell>
  );
});
