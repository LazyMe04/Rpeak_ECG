# Rpeak Desktop — project notes

A local PC rebuild of <https://upsidedownlabs.github.io/Rpeak/> running on the
PhysioNet Icentia11k continuous ECG dataset, with the reference's defects fixed
rather than reproduced.

## Milestones

| #   | Scope                                                                             | Status                                                                                                                                     |
| --- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| G1  | Dataset acquisition, catalogue, filter coefficients, ground truth                 | done                                                                                                                                       |
| G2  | App shell, signal replay, transport, annotation overlay                           | **done** — [app-shell.md](app-shell.md)                                                                                                    |
| G3  | Port `detect_v4` to TypeScript, live detection, parity with Python                | **done** — [detector.md](detector.md#typescript-port-g3)                                                                                   |
| G4  | PQRST, HRV, ECG intervals, session recording/report, export                       | **done** — [analysis.md](analysis.md)                                                                                                      |
| G5  | CNN beat classifier, AI panel, evaluation                                         | **done** — [classifier.md](classifier.md)                                                                                                  |
| G6  | Tauri packaging                                                                   | **done** — [packaging.md](packaging.md)                                                                                                    |
| G7  | AI Model and Docs pages                                                           | **done** — [model-and-docs.md](model-and-docs.md)                                                                                          |
| G8  | `log(scale)` input and the ablation that rejects it                               | **done** — [classifier.md](classifier.md#the-logscale-input-and-the-ablation-that-rejects-it-g8)                                           |
| G9  | RR-interval context for class S, and the ablation that accepts it                 | **done** — [classifier.md](classifier.md#the-timing-ratios-and-the-ablation-that-accepts-them)                                             |
| G10 | The N→Q decision boundary, measured three ways and not shipped                    | **done** — [classifier.md](classifier.md#the-nq-boundary-g10--measured-three-ways-not-shipped)                                             |
| G11 | The pages became navigable: a table of contents and keyboard charts               | **done** — [model-and-docs.md](model-and-docs.md#the-g11-change-the-pages-became-navigable)                                                |
| G12 | S and V precision: no rule, no retrain, and the ceiling that explains both        | **done** — [classifier.md](classifier.md#s-and-v-precision-no-cheap-rule-so-no-retrain-g12)                                                |
| G13 | The charts say where you are, and long list rows are reachable by keyboard        | **done** — [model-and-docs.md](model-and-docs.md#the-g13-change-the-charts-say-where-you-are-and-long-lists-are-reachable)                 |
| G14 | Vietnamese UI: the whole app, including the model card and the guide              | **done** — [i18n.md](i18n.md)                                                                                                              |
| G15 | The shell's edges: failure, focus, deep links and the file title                  | **done** — [app-shell.md](app-shell.md#the-g15-change-the-edges-of-the-shell)                                                              |
| G16 | Panels became dialogs, and the repo became guardable: git, lint, format, one gate | **done** — [app-shell.md](app-shell.md#the-g16-change-panels-as-dialogs), [process.md](process.md), [packaging.md](packaging.md#licensing) |

## Documents

- **[detector.md](detector.md)** — R-peak detection architecture, the measured
  accuracy (Se 97.73 / PPV 96.21), everything that was tried and rejected with
  numbers, the TypeScript port and its stage-by-stage parity evidence, and the
  honest statement that the plan's 99% gate is not met.
- **[analysis.md](analysis.md)** — G4: PQRST delineation and its error against a
  synthetic golden, HRV and its parity with the Python reference, the interval
  definitions, the session report and export formats, and the UI decisions.
- **[app-shell.md](app-shell.md)** — G2 and G15: what the shell does, where it
  deliberately departs from the reference, and how it is verified. G15 is the
  edges — a render error costs one panel instead of the window, `?record=`
  reports a bad link instead of silently loading another segment, Escape closes
  a panel, the rail's labels reach the keyboard, the window title names the page,
  and the signal-quality values stopped leaking into the screen as ASCII.
- **[classifier.md](classifier.md)** — G5, G8, G9 and G10: what "Q" actually
  means in icentia11k, the label survey that made S and V trainable, the
  normalisation defect that stopped the network learning at all, the browser
  compute budget the architecture was sized against, the honest per-class
  numbers, and three attempts at the same question. `log(scale)` was proposed as
  the biggest accuracy lever, measured, and ablated to show the network does not
  use it. The three RR ratios that followed _are_ used: macro-F1 0.5776 → 0.5965
  and S F1 0.498 → 0.549, with an ablation that loses 0.087 macro-F1 when the
  columns are replaced by a constant. G10 then attacked the largest error cell
  directly with a logit bias on N and Q: it removes 67% of the N→Q errors and
  raises accuracy to 0.798 on the shipped checkpoint, survives an out-of-fold
  check, and still fails the transfer test — it helps 2 of 4 checkpoints — so it
  is documented and not shipped. G12 then asked the same of S precision and V,
  with `probe_sv_features.py`: the cue that would fix S (prematurity) is already
  in the head, the cue that is new is weaker than the model's own logit, the best
  rule gains 0.007 pooled and loses 0.004 out of fold, and the per-recording prior
  that would fix everything is worth +0.081 macro-F1 but cannot be estimated from
  the model's own output. No retrain was started, and the reason is written down.
- **[packaging.md](packaging.md)** — G6: the GNU Rust toolchain this machine
  forced, how the packaged app finds a dataset it does not ship, the IPC bridge
  that replaced Vite's middleware, and the checks that drive the real .exe
  instead of the browser build.
- **[i18n.md](i18n.md)** — G14: Vietnamese as the shipped language, English as
  the option. The English sentence is the dictionary key, so a missing entry
  falls back to readable English rather than to a token; numbers go through
  `num()` because Vietnamese writes 72,7% where English writes 72.7%; worker
  diagnostics are split on their em dash so our sentence is translated and the
  runtime's text is not. The static audit cannot see a string passed as a prop
  to a component that translates internally, which is how the model card's ten
  headings stayed English through a passing check — so a rendered check in both
  languages is the one that guards them.
- **[model-and-docs.md](model-and-docs.md)** — G7 and G11: the two navbar
  pages, why every number on them is read from the artefacts rather than
  copied, the parameter-count derivation (7,156 trained / 7,076 stored), the
  palette that was validated for both themes, and the bugs the smoke test
  caught — resume-on-return, a 100× percentage scale, a stale HTTP cache, and a
  scroll spy that measured the loading branch. G11 added the table of contents
  with its scroll spy, and a keyboard cursor to both charts. G13 gave that
  cursor a spoken position ("3 of 12") and routed the dot plot through the same
  key handler, so PageUp/PageDown now jump ten rows.
- **[process.md](process.md)** — G16: the repository now exists (it did not
  before), a commit runs the fast half of the gate, ESLint and Prettier have
  configs with the reasons written in them, `npm run gate` stops at the first
  failure, and the light theme's contrast is measured instead of photographed.
  Plus what was deliberately not done, with the reason each one is not a gap.

## Running

```
cd D:\Rpeak-Desktop\app
npm run dev         # http://localhost:5173
npm run test        # 13 assertions on the shell primitives
npm run test:detect # every detector stage vs the Python goldens
npm run test:hrv    # HRV statistics vs the Python reference
npm run test:delineate # PQRST timing vs a synthetic golden
npm run test:report # session report, CSV and JSON exports
npm run test:cnn    # PyTorch logits vs the TypeScript forward pass
npm run test:i18n   # the language layer: fallbacks, placeholders, the detail split
npm run lint        # ESLint: stale hook deps, effects with no cleanup, dropped promises
npm run format:check # Prettier, both trees
npm run eval        # every segment: Se/PPV + parity vs Python
npm run smoke       # drives the live page over CDP (needs `npm run dev` running)
npm run smoke:pages # the AI Model and Docs pages, and page navigation
npm run smoke:lang  # the Vietnamese build: default, switch, persistence, numbers
npm run build
npm run desktop     # the same app in a Tauri window
npm run package     # rpeak.exe + NSIS installer
npm run smoke:app   # drives the packaged .exe over CDP
npm run gate        # every stage above, in order, stopping at the first failure
npm run gate -- --browser --repeat 3   # plus the browser suites, three times each
```

`npm run gate` is the one command to run before believing a change is good; the
stages, the pre-commit hook and the lint/format setup are described in
[process.md](process.md).

Classifier work, in the pipeline (`python -I`, from `pipeline/`):

```
probe_scale.py     # how well log(scale) separates N from Q, per class
probe_rr.py        # how well the timing ratios separate S and V from N
build_beats.py     # shards carry S = log(scale) and R = three timing ratios
train_cnn.py       # --extra-mode {rr,record,global,none}; none is the control
cnn_export.py      # writes version 2 JSON, parity rows carry the raw window
eval_cnn.py        # per-patient table -> beatcnn.eval.json
ablate_extra.py    # feed the head a constant / shuffled column; --compare runs
probe_q_boundary.py # sweep a logit bias on N/Q, out of fold, per patient
probe_q_prior.py    # does the training prior explain the winning constant?
probe_q_transfer.py # apply the same constant to every checkpoint
check_i18n.py      # every t("...") key has a translation, and every translation is used
```

`app/scripts/shot-window.ps1` captures the real window from the desktop (DPI-aware,
so the rectangle it measures is the rectangle it grabs). The CDP smoke test
drives the page and cannot see the window, which is how a window whose transport
bar hung below the taskbar passed every check; see
[packaging.md](packaging.md#the-window-is-sized-to-the-screen-not-to-the-design).

The left rail's green "Detect R-peaks" toggle runs `detect_v4` over the loaded
segment in a worker and overlays the result in blue. The yellow "Delineate
PQRST" toggle runs boundary detection over the same peak set and draws P / QRS /
T in a caliper lane under the trace; the cyan "Vitals" panel reads its
intervals, and the green "HRV" panel plots the tachogram and spectrum. The red
"Session" entry records a span and exports it as CSV (one row per beat) or JSON
(summary). The purple "AI Beat Classifier" entry classifies every beat in the
loaded segment as N, S, V or Q in a worker and reports the counts, the mean
confidence per class, and the full distribution for the beat under the
playhead; see [classifier.md](classifier.md) for what those numbers mean.

The dataset is served from `D:\Rpeak-Desktop\data` by Vite middleware at
`/data`; nothing is copied into the bundle.

The navbar's other two entries are documents rather than dashboards: **AI Model**
is the classifier's model card (architecture, training curves, confusion matrix,
per-patient scores, a PyTorch↔TypeScript parity table recomputed in the browser)
and **Docs** is the user guide with the detector's per-patient numbers. Both read
their figures from `data/models/` and `data/catalog/` at load, so retraining
changes the pages without editing them. `?page=model` and `?page=docs` deep-link
either one; see [model-and-docs.md](model-and-docs.md).

## Language

The app ships in **Vietnamese**; the navbar's VI / EN switch (or `?lang=en`)
puts it in English. Every page is translated — the monitor's panels, both rail
toggles, the AI Model card and the Docs guide — and every number is formatted
in the active language's convention, as is the window title. `check_i18n.py`
guards coverage and `smoke:lang` guards what a static scan cannot see; see
[i18n.md](i18n.md) for both, and for the prop-translated strings that got past
the first one.

## Layout

```
D:\Rpeak-Desktop\
  app\        Vite + React + TypeScript app (src-tauri\ = the desktop shell)
  data\       raw WFDB, catalogue (sqlite + json), f32 exports, annotations
  pipeline\   Python: download, convert, detect, probes, exports
  docs\       these notes
  logs\       dev server and long-running task output
  .cache\     npm cache, scratch
```

## Licence

The code (`app/`, `pipeline/`, `docs/`) is MIT — see [LICENSE](../LICENSE). The
ECG data and the model weights derived from it are not: Icentia11k is
CC BY-NC-SA 4.0, so a build that carries the weights is non-commercial and
share-alike. [NOTICE](../NOTICE) says exactly what covers what, including the
MIT-licensed WFDB code the GQRS port follows.

## Dataset facts

- Icentia11k, CC BY-NC-SA 4.0, single chest lead, 250 Hz, int16.
- 142 segments × 1,048,577 samples (69.9 min each) across 42 patients are on
  disk. The app's catalogue serves 24 of them (12 patients) — the ones with
  exported annotations; the rest were downloaded for G5 and hold out 6 patients
  from the 24 that train, by patient, never by window.
- Labels present: N, S, V, Q (no F class in this dataset).
- The app reads pre-scaled float32 copies (`data/catalog/f32/`, 4 MB each)
  rather than decoding `.dat` in the browser.
