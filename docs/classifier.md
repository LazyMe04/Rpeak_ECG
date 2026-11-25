# Beat classification: the CNN, the data, and the numbers

Status: **trained, exported to `data/models/beatcnn.json`, parity-tested against
PyTorch, wired into the app's "AI Beat Classifier" panel, and ablated.** This
document records what the labels actually mean, how the training set was chosen,
the defect that stopped the first three runs from learning anything, the honest
per-class numbers, and three attempts at the same question — can an input the
window cannot hold, or a decision rule on top of it, make the model better?
`log(scale)` was tried first and the ablation rejected it. Three RR ratios were
tried second and the ablation accepts them: macro-F1 0.5776 → 0.5965, S F1 0.498
→ 0.549, and V the class that paid (0.499 → 0.460). A logit bias on the N/Q
border was tried third: it removes most of the biggest error cell but the gain
holds on one checkpoint and reverses on two, so it was measured, documented and
not shipped. All three results are on the app's AI Model page.

## Result

Held-out evaluation: 138,296 beats from 6 patients whose recordings never enter
training (`p00019`, `p00114`, `p00225`, `p00228`, `p00239`, `p00267`). Best
epoch 10 of 18; early stopping ended the run.

**Accuracy 0.7266, macro-F1 0.5965.** That macro-F1 is the number to read.
Accuracy is inflated by the 71% N majority — a model that answered N for every
beat would score 0.71 and have macro-F1 0.21.

| class | meaning                  | support | Se     | PPV    | F1     |
| ----- | ------------------------ | ------- | ------ | ------ | ------ |
| N     | normal                   | 98,199  | 75.90% | 92.75% | 83.48% |
| S     | supraventricular ectopic | 12,737  | 62.87% | 48.65% | 54.85% |
| V     | ventricular ectopic      | 7,813   | 51.66% | 41.51% | 46.03% |
| Q     | unclassifiable           | 19,547  | 71.19% | 43.82% | 54.25% |

Confusion matrix, rows true N/S/V/Q, columns predicted:

```
        N      S      V      Q
N   74533   4548   2436  16682
S    2130   8008   1921    678
V      77   3218   4036    482
Q    3617    686   1329  13915
```

The dominant error is still N → Q: 16,682 normal beats called unclassifiable,
more than every other N error combined. It was 18,163 in the previous model and
the timing ratios did not move it; G10 then measured whether a decision rule
could, and the answer is that it moves the cell but not the score reliably — see
["The N/Q boundary (G10)"](#the-nq-boundary-g10--measured-three-ways-not-shipped)
and ["What the model still cannot see"](#what-the-model-still-cannot-see).

Against the `log(scale)` model (macro-F1 0.5776, archived in `data/models/v2/`)
the gain is +0.019 macro-F1, concentrated in N (79.60 → 83.48) and S
(49.81 → 54.85) with Q up slightly (51.71 → 54.25) and V down (49.90 → 46.03).
Unlike the previous retrain, this one has an ablation behind it: the same
weights fed a constant or a shuffled copy of the ratios lose 0.087 and 0.150
macro-F1 respectively, and S loses 0.19 F1 when the ratios are zeroed. The
network is reading the column.

### Per patient

`pipeline/eval_cnn.py` re-runs the checkpoint on each held-out patient. The
pooled number hides how much the model varies between people, so the spread is
reported rather than a single average.

| patient | beats  | N Se/PPV    | S Se/PPV    | V Se/PPV    | Q Se/PPV    | present macro-F1 |
| ------- | ------ | ----------- | ----------- | ----------- | ----------- | ---------------- |
| p00019  | 24,302 | 79.5 / 99.3 | 76.3 / 83.6 | 39.3 / 21.8 | 77.1 / 4.6  | 0.512            |
| p00114  | 26,692 | 26.5 / 81.7 | — / —       | 85.9 / 38.2 | 79.1 / 43.0 | 0.495            |
| p00225  | 19,116 | 87.7 / 95.2 | 76.3 / 46.2 | — / —       | 70.0 / 57.2 | 0.706            |
| p00228  | 32,427 | 80.2 / 85.7 | 54.9 / 61.3 | 76.7 / 1.3  | 70.6 / 64.8 | 0.527            |
| p00239  | 18,511 | 84.1 / 94.2 | — / —       | 41.3 / 68.6 | 54.0 / 59.4 | 0.657            |
| p00267  | 17,248 | 97.6 / 94.9 | — / —       | 43.6 / 94.3 | 45.7 / 64.8 | 0.698            |

The present-class macro-F1 averages **0.599** across the six patients, close to
the pooled 0.5965. Three of the six have no S beats at all and one has no V
beats, so the plain four-class macro-F1 (mean 0.493) charges them for classes
they cannot score; the present-class column is the comparable one. Five of the
six patients improved on the `log(scale)` model, p00239 is the exception
(0.729 → 0.657), and the ordering of patients changed: p00114 and p00019 used to
be the two weakest and now sit at 0.495 and 0.512 while p00225 and p00267 lead.

The spread is still wide, and the low end is still a recording dominated by
unusable stretches: p00114 keeps 26.5% of its normal beats and p00019 has Q
precision 4.6% — it calls unusable signal almost everywhere. The model is not
uniformly mediocre; it fails where the signal does.

## What "Q" means here

This matters more than any single number, because it changes what the model is
asked to learn. On PhysioNet, icentia11k's annotation codes are N (normal), S
(supraventricular ectopic), V (ventricular ectopic), Q — and Q is documented as
**"Undefined: unclassifiable beat"**, not a rhythm.

The evidence agrees with the documentation: Q beats occur in runs of up to
1,844 consecutive beats, their morphology correlation with a normal template
has a median of 0.83 against 0.99 for N, and the local signal around them is
noisier. Q marks stretches where the annotator declined to label a beat, which
in a 70-minute chest-strap recording means movement artefact, disconnection, or
a rhythm the annotator would not commit to.

So the classifier has four outputs, as AAMI EC57 groups them, but the fourth
means "this does not look like a usable beat" rather than "this is a specific
arrhythmia". The app's panel labels it _Unclassifiable_ for that reason.

## Data: a cheap survey, then a targeted download

The obvious problem with icentia11k is class frequency. A survey of 400
patients (1,597 segments, 8,547,624 beats) read only `.hea`/`.atr` sidecars —
~50 KB each against 2.1 MB for the signal — and found:

| class | beats     | share  |
| ----- | --------- | ------ |
| N     | 6,294,201 | 73.64% |
| S     | 65,426    | 0.77%  |
| V     | 48,805    | 0.57%  |
| Q     | 2,139,192 | 25.03% |

At those rates, a random 30-patient sample would carry roughly 20,000 S beats —
but concentrated in a handful of people. 70 patients had at least 50 S beats
and 67 had at least 50 V beats. The training set was therefore chosen rather
than sampled: patients ranked by `min(S, 3000) + min(V, 3000) + 0.1·(S + V)`,
the cap stopping one prolific patient from crowding out variety. Thirty
patients, 120 segments, ~252 MB of signal.

The result is 786,518 windows over 142 records on disk, of which the split uses
120 (24 patients training, 6 held out): 522,652 training windows and 138,296
held-out windows.

### Split by patient, never by window

A 70-minute recording is one person's heart; adjacent beats are near-duplicates.
A window-level split would put near-identical beats in train and test and report
a score that measures memorisation. `train_cnn.py` refuses to run if the train
and validation patient sets intersect.

## The normalisation defect

The first three training runs did not learn at all: a full epoch of 2,042
gradient steps left the loss above the uniform-prediction baseline and the model
predicted N for every held-out beat. The cause was in the data, not the network.

Windows are normalised per beat, because a chest strap's gain drifts and a
per-record z-score drags every window toward the segment mean. The first version
divided by the **median absolute deviation** of the QRS-bearing core. On this
signal that is degenerate: icentia11k is quantised, so a window sitting on a
flat baseline has more than half its core samples at exactly the median, the
MAD is 0, the `1e-6` floor takes over, and the window arrives with an amplitude
of 10^5–10^6. Measured over 3,000 beats per record, the MAD is zero for 2.4% of
windows in `p00214_s01` and 66% in `p00355_s03`; one batch of 256 almost always
contained an outlier, and the first BatchNorm layer then normalised each channel
against a batch whose statistics were set by it.

The fix, in `build_beats.normalise` and mirrored in `app/src/lib/ecg/cnn.ts`:

1. centre the window on the core median;
2. divide by the **90th percentile** of the absolute deviation from that median
   — zero for none of the records measured, and stable across patients;
3. floor the scale at 1% of the window peak, which bounds the normalised
   window at 100 even for a pathological flat window.

`npm run test:cnn` pins both halves: the normalised core must have median 0 and
90th-percentile deviation 1, and a synthetic near-flat window must stay bounded.

Step 2 also _returns_ the scale it divided by, which is what the next section is
about.

## Architecture, sized against a measured browser budget

The app has no ONNX runtime and will not gain one: the project is a readable
rebuild, and an inference engine is a multi-megabyte third-party bundle with its
own WASM loading and its own failure modes. Weights travel as JSON and a
hand-written forward pass runs them.

That is only defensible if the forward pass fits the browser's budget. Raw
scalar throughput measured in this environment is ~721 MMAC/s, so a window of
~225k MAC costs ~0.3 ms of arithmetic and ~1 ms per beat in practice — about
6.5–9 s for a 70-minute segment's ~6,900 beats, in a worker, depending on machine
load. An earlier 4-block, 1.1M-MAC design measured 34 s per segment, which is not
a classifier anyone will wait for. Computing the three timing ratios over the
whole peak train costs 35 ms per segment, so the extra input is not where the
time goes.

```
input 1 × 250 (1 s at 250 Hz, R at sample 100)
  Block( 1 → 16, k=5, pool=4)   250 → 62
  Block(16 → 32, k=5, pool=4)    62 → 15
  Block(32 → 32, k=3, pool=2)    15 →  7
  global average pool            → 32
  concat three RR ratios         → 35
  dropout 0.3 → dense 35 → 32 (ReLU) → dropout → dense 32 → 4
```

7,156 parameters trained. The exported file carries 7,076: the three
convolutions are bias-free while training, so folding BatchNorm in adds one bias
per output channel (16 + 32 + 32 = 80) while removing two BatchNorm values per
channel (160), a net −80. Both numbers are correct and the page shows the
derivation; see [model-and-docs.md](model-and-docs.md#the-ai-model-page).

The receptive field is ~60 samples (240 ms), enough for the QRS width that
separates V from N.

BatchNorm is folded into the preceding convolution at export, so the app never
has to remember whether BN runs before or after the activation, and four
tensors per block disappear from the runtime.

## The timing ratios, and the ablation that accepts them

Class S is supraventricular ectopia, and what defines it is not the shape of the
beat but when it arrives: early, and followed by a pause. A 250-sample window
holds one second, which at a normal rate contains neither neighbouring R peak, so
that fact is not in the input at all. This was the strongest remaining accuracy
argument, and G8 is the reason it was measured before it was believed.

`pipeline/probe_rr.py` reports the cue on the six held-out patients, using
`build_beats.rr_ratios` — the same function that fills the shards, clamping and
edge fill included, so the probe cannot measure something the retrain would not
get. Each beat gets three dimensionless numbers:

| feature      | definition                                 | what it says           |
| ------------ | ------------------------------------------ | ---------------------- |
| `pre_ratio`  | RR(i−1, i) / median of the surrounding RRs | prematurity            |
| `post_ratio` | RR(i, i+1) / median of the surrounding RRs | the compensatory pause |
| `sum_ratio`  | the mean of the two, over the same median  | net timing             |

The median is over 25 beats each side, **excluding the two intervals that touch
beat i** — otherwise a run of ectopics drags its own baseline toward itself and
the ratio collapses toward 1. Ratios rather than raw RR because heart rate
differs by patient; a raw interval in samples would let the network identify the
person instead of the rhythm.

Measured (AUC, oriented so "premature" scores high):

|        | pre_ratio | post_ratio | sum_ratio |
| ------ | --------- | ---------- | --------- |
| S vs N | **0.932** | 0.621      | 0.765     |
| V vs N | **0.986** | 0.801      | 0.661     |
| Q vs N | 0.581     | 0.417      | 0.579     |

As a single threshold on `pre_ratio < 0.90`, S reaches Se 84.0% / PPV 49.7%
(F1 0.624) and V Se 97.8% / PPV 50.2% (F1 0.664) — against N only, which flatters
both numbers, but it says the cue is not marginal. The probe's own sampling
matters here and is documented in its docstring: computing the ratios on a sparse
subsample instead of the full beat sequence stretched every interval and dropped
S vs N from 0.93 to 0.52, which looks exactly like "the cue is useless" and is an
artefact of the probe. The shard builder always sees the whole record, so the
trained model never has that problem.

`build_beats.py` stores the ratios per window (`R` in each shard, three columns),
`train_cnn.py --extra-mode rr` feeds them standardised by the training set's
centre and spread, and `ablate_extra.py` accepts or rejects the result:

| RR ratios fed to the head | accuracy   | macro-F1   | N F1  | S F1  | V F1  | Q F1  |
| ------------------------- | ---------- | ---------- | ----- | ----- | ----- | ----- |
| real                      | **0.7266** | **0.5965** | 0.835 | 0.549 | 0.460 | 0.542 |
| zero (training mean)      | 0.7051     | 0.5094     | 0.817 | 0.360 | 0.322 | 0.538 |
| shuffled across beats     | 0.6202     | 0.4469     | 0.745 | 0.246 | 0.267 | 0.529 |
| `pre_ratio` zeroed        | 0.7127     | 0.5622     | 0.826 | 0.474 | 0.420 | 0.529 |
| `post_ratio` zeroed       | 0.7184     | 0.5804     | 0.829 | 0.521 | 0.431 | 0.541 |
| `sum_ratio` zeroed        | 0.7240     | 0.5905     | 0.834 | 0.536 | 0.450 | 0.543 |

This is the opposite of the `log(scale)` result and it is not a small effect:
replacing the three columns with their training mean costs 0.087 macro-F1 and
0.19 F1 on S, and shuffling them across beats — same distribution, wrong beat —
costs 0.150 macro-F1, more than any run-to-run spread measured on this model. The
convolutional stack cannot recover the information from the window, because the
information is not there.

The per-column rows say which column is doing the work. `pre_ratio` carries most
of it (S −0.075 when zeroed, V −0.041); `post_ratio` contributes less (S −0.028,
V −0.029); `sum_ratio` is nearly inert (−0.013, −0.011) because it is a linear
combination of the other two and the head can form it itself. It was kept anyway:
99 weights (3 columns × 32 units, plus 3 biases) are not worth a special case, and
the per-column ablation is only possible because the columns are separate.

Four runs, same data, same split, same seed:

| run                               | extra input            | accuracy | macro-F1 |
| --------------------------------- | ---------------------- | -------- | -------- |
| `beatcnn_ctrl`                    | none                   | 0.6828   | 0.5260   |
| `beatcnn_rec`                     | log(scale), per record | 0.7007   | 0.5073   |
| `beatcnn` (G8, archived in `v2/`) | log(scale), global     | 0.6931   | 0.5776   |
| `beatcnn_rr` (shipped)            | three RR ratios        | 0.7266   | 0.5965   |

The shipped model is the last row. The gap from the first row to it is +0.070
macro-F1, but only the ablation above earns the attribution: the earlier
`log(scale)` retrain also gained +0.05 over the control, and that gain turned out
to be run-to-run variance. The difference between the two episodes is not the
size of the gain, it is that removing this column takes 0.087 away and removing
that one took 0.002.

## The log(scale) input, and the ablation that rejects it (G8)

Per-beat normalisation is what makes the network insensitive to chest-strap gain
drift, but it also divides away the amplitude — and unusable stretches are
noisier and therefore larger. Measured on the held-out records, `log(scale)`
alone separates Q from N at **AUC 0.615**, and S from N at 0.366 (i.e. 0.634
with the sign flipped: S windows are quieter, not noisier). The previous version
of this document proposed passing it as a second input, and predicted it would
be the biggest single accuracy lever. It was implemented, trained, and then
ablated, and the prediction is wrong.

`pipeline/probe_scale.py` measures the cue, `build_beats.py` stores it per
window (`S` in each shard, alongside `X`), and the network takes it as a 33rd
head input, standardised before the concatenation. Two standardisations were
tried:

- **global** — one centre and spread from the training set, stored in the model
  file so the app applies the same transform;
- **per record** — centred and scaled within each recording, because "unusable"
  is relative to a patient's own signal quality. The app derives the two numbers
  from the segment it is classifying.

`pipeline/ablate_extra.py` then feeds the trained weights a constant instead of
the real value, and separately the real values shuffled across beats. If the
column carries anything, both should hurt.

| log(scale) fed to the head | accuracy | macro-F1 | N F1  | S F1  | V F1  | Q F1  |
| -------------------------- | -------- | -------- | ----- | ----- | ----- | ----- |
| real                       | 0.6931   | 0.5776   | 0.796 | 0.498 | 0.499 | 0.517 |
| zero (training mean)       | 0.6890   | 0.5770   | 0.791 | 0.497 | 0.506 | 0.514 |
| shuffled across beats      | 0.6882   | 0.5761   | 0.790 | 0.497 | 0.504 | 0.513 |

Every per-class F1 moves by 0.007 or less, in both directions. **The network
does not use the column.** The per-record variant is the same story: its
ablation is flat too (macro-F1 0.5073 real against 0.5133 with the column
zeroed), even though that run's _decisions_ differ sharply from the global one —
N → Q drops from 18,163 to 11,599 and Q precision rises to 47.9%, at the cost of
S and V collapsing to F1 0.371 and 0.298.

Three runs, same data, same split, same seed:

| run                               | extra input            | accuracy | macro-F1 |
| --------------------------------- | ---------------------- | -------- | -------- |
| `beatcnn_ctrl`                    | none                   | 0.6828   | 0.5260   |
| `beatcnn_rec`                     | log(scale), per record | 0.7007   | 0.5073   |
| `beatcnn` (G8, archived in `v2/`) | log(scale), global     | 0.6931   | 0.5776   |

The control is the load-bearing row: it reproduces the previous model's
confusion matrix _exactly_ — 71,016 / 7,066 / 3,266 / 16,851 and so on — which
says the refactored training script is bit-identical to the one that produced it,
that the seed is deterministic, and therefore that the only thing separating the
0.526 run from the 0.578 run is the extra column. Since the ablation says the
column is inert, the +0.05 is not the column's value: adding one input changes
the head's shape, the initialisation, and every subsequent gradient, and this
model on six patients has that much run-to-run spread.

Why the cue does not help, when it is measurably real: a noisy window is a noisy
_shape_, and the convolution stack already sees the shape. `log(scale)` is a
one-number summary of high-frequency content the network reads directly. It is
redundant, not invisible. The same argument explains why the per-record variant
changed the decision boundary without being depended on: it moved the
optimisation, not the information.

The consequence for the N → Q confusion is that it is **not** an input problem.
The 18,163 normal beats called Q are a decision-boundary problem: the class
weights, the cap and a 32-unit head decide where "unusable" starts, and the
boundary currently leans toward Q — Q is 24% of the corpus and carries a large
weight, so an ambiguous noisy beat is cheaper to call Q than to call N. That
shows up in Q's precision of 0.41: most Q calls are wrong. Fixing it means
changing the loss or the threshold, not adding a channel.

## Training

- **Loss**: cross-entropy weighted by the inverse square root of class
  frequency, normalised to mean 1. Full inverse frequency over-corrects and
  inflates false positives; the square root is the middle ground.
- **Class cap**: each class is capped at 60,000 windows per epoch
  (`--cap-per-class`). 65% of the corpus is N from the same 24 people; the
  400,000th N window teaches nothing, but it does make an epoch 2,042 steps of
  which two thirds are N. Capping turns a pass into a meaningful number of
  gradient steps for S and V.
- **Augmentation**: baseline wander (0.05–0.5 Hz, ±0.6), gain drift
  (0.92–1.08), time shift (±20 ms, the annotation's own jitter), and small
  Gaussian noise. No time stretching — that would invent heart rates the
  patient never had. Vectorised per batch: the per-window Python version cost
  138 µs per window, 72 s per epoch, more than the forward and backward pass
  combined. Augmentation deliberately does not touch `log(scale)`: the network
  is told the pre-augmentation amplitude, which is what the app measures. The
  RR ratios are computed from annotated peak positions, which augmentation
  never moves — a time shift moves the window, not the beat train.
- **Optimiser**: AdamW, lr 2e-3, weight decay 1e-4, cosine schedule over 25
  epochs, early stop after 8 epochs without a macro-F1 gain. Seed 20261119.
- **Extra input**: `--extra-mode {rr,record,global,none}`. The shipped
  checkpoint uses `rr`; `none` is the control, and the two `log(scale)` modes
  are kept because their ablation is the reason to trust this one's.

## Parity: the test that makes a hand-written forward pass defensible

`pipeline/cnn_export.py` writes the folded weights plus eight windows from the
validation records and the exact logits PyTorch produced for them.
`npm run test:cnn` runs the same windows through `app/src/lib/ecg/cnn.ts` and
compares.

Each parity row carries the window **before** normalisation, so the TypeScript
side re-runs the whole chain — cut, normalise, derive the extras, standardise,
forward — rather than starting from an input Python prepared. For the timing
ratios the row carries the surrounding **peak positions**, not the ratios, so the
test calls the app's own `rrFeatures` over a real peak train, median and all,
rather than checking only the standardisation of a number Python computed. That
cost one real bug: the first export sliced 51 peaks starting at the median
window's first beat, which left the interval _into_ that beat NaN inside the
slice and dropped a value Python's median had used; the ratio vectors disagreed
by up to 8×10⁻². Exporting one peak beyond the window at each end, and clipping
the slice index accordingly, fixed it. The two implementations share no code, and
agreement to 3×10⁻⁶ on the logits (tolerance 2×10⁻⁴) and 9×10⁻⁸ on the ratios
means the weight layout, the BN folding, the padding, the pooling truncation, the
normalisation and the extra inputs all agree. A shape check would catch none of
them. The test also checks that shifting the extras by one standard deviation
moves the logits, so a dropped column cannot pass silently, and pins the ratio
rules — a steady rhythm scores 1.0, the first beat has no previous interval, an
implausible interval is neutralised, and a premature beat scores below 1.

## In the app

The purple rail entry opens the classifier panel. The model is fetched once from
`/data/models/beatcnn.json`; classification runs in a worker over the same peak
set the rest of the app uses (detector peaks when the detector is on,
annotations otherwise), and the panel reports the per-class counts and shares,
the mean confidence, and the full distribution for the beat nearest the
playhead. With `data/models/` empty the panel says so and the app carries on —
that is how a fresh clone behaves.

Measured end to end by `npm run smoke` on `p00000_s00`: 6,886 detector peaks
classified in 6.5–9.1 s across repeat runs, i.e. **0.95–1.3 ms per beat**, as this
machine's CPU load moved between 24% and 57%. That is slower than the 0.79–0.86 ms
measured at G8 on the same segment with the same three blocks, and the difference
is machine load, not the model: the forward pass is fixed arithmetic, and the RR
model's extra three multiplies are nothing against 225k MACs. The classes it
returned were 6,611 N / 2 S / 0 V / 273 Q, and that segment's annotations are
6,641 N / 0 S / 0 V / 244 Q — the live mix is within a few tenths of a percent
of the reference, and the two S calls are false positives at 0.03% of beats.

## Reproducing

```
cd pipeline
python -I probe_rr.py --split val --n 4000
python -I probe_scale.py --records p00019_s00 p00225_s00 --n 3000
python -I build_beats.py --all --json ../data/catalog/g5/beats.json
python -I train_cnn.py --train-records <24 records> --val-records <6 records> \
    --epochs 25 --batch 256 --cap-per-class 60000 --extra-mode rr \
    --out ../data/models/beatcnn
python -I cnn_export.py --checkpoint ../data/models/beatcnn.pt --out ../data/models/beatcnn.json
python -I eval_cnn.py --checkpoint ../data/models/beatcnn.pt --out ../data/models/beatcnn.eval.json
python -I ablate_extra.py --checkpoint ../data/models/beatcnn.pt \
    --compare ../data/models/beatcnn_ctrl.pt ../data/models/v2/beatcnn.pt \
    --out ../data/models/beatcnn.ablate.json

# G10: is N -> Q a threshold problem? Sweep, out-of-fold, then the transfer test.
python -I probe_q_boundary.py --out ../data/models/beatcnn.qboundary.json
python -I probe_q_prior.py
python -I probe_q_transfer.py --bias -1.0 --out ../data/models/beatcnn.qtransfer.json

# G12: is S precision or V fixable by a rule, and what is a per-record prior worth?
python -I probe_sv_boundary.py
python -I probe_sv_features.py

cd ../app
npm run test:cnn     # PyTorch vs TypeScript logits
npm run smoke        # the live page, including this classifier
```

`--extra-mode none` with everything else unchanged is the control, and it
reproduces `data/models/v1/` exactly. That is worth re-running before believing
any future change to this model.

## What the model still cannot see

The N → Q confusion was blamed on the normaliser hiding amplitude. That
hypothesis has been tested and rejected: `log(scale)` is in the input, the
ablation shows the network ignores it, and the errors remain. The timing ratios
were the next candidate and they did not move that cell either (18,163 → 16,682,
inside the run-to-run spread of the model). What is left is a decision-boundary
problem — where the model puts the line between "noisy normal" and "unusable" —
which is a question about the loss and the threshold, and about the fact that Q is
a human annotator's refusal rather than a physical event.

That was a claim, so G10 measured it. Three probes, and the conclusion is
narrower than the claim and more useful:

- **A bias on the N/Q border does what the claim said.** A symmetric logit bias
  (Q −0.75, N +0.75) moves the 16,682 normal-called-Q beats down to 5,521, takes
  N↔Q errors from 20,299 to 12,725, and raises macro-F1 from 0.5965 to 0.6251. See
  G10 below for the numbers. The boundary is real and it is badly placed.
- **The gain in macro-F1 is not real.** +0.027 on the shipped checkpoint, and
  **−0.011** and **−0.009** on the two other checkpoints at the same constant on the
  same beats. It sits inside the 0.05 run-to-run spread, which is precisely the
  evidence G8 rejected `log(scale)` on. So it does not ship, and the model page says
  so instead of quoting the best number.
- **Where the bias does help, it helps the two patients with the worst recordings.**
  Tuned per patient it is worth +0.106 on p00114 and +0.102 on p00019 and nothing
  at all on p00267. That is a per-recording prior — and the pooled-corpus prior
  correction does not recover it, because the six held-out patients range from
  1.0% to 35.8% Q. One constant cannot be right for the pool and for each person.

S and V have both moved, in different directions. S F1 is 0.549 (was 0.498), from
recall 55.0% → 62.9% at similar precision. V F1 fell slightly to 0.460 (was
0.499) even though the ablation shows the network leans on the ratios for it: V
beats called N dropped from 1,273 to 77, and V beats called S rose from 1,335 to
3,218. The model now reads a premature beat's timing and picks the wrong ectopic
class, rather than missing the timing entirely — a different error at a similar
score. V is rare enough that a handful of mistakes moves its F1.

## The N/Q boundary (G10) — measured three ways, not shipped

`docs/classifier.md` closed G9 by calling N → Q "a decision boundary, not a
missing input". G10 tested that with post-hoc rules on the same logits: no
retrain, so every rule changes only where the line is drawn.

**The rule.** Add a constant to Q's logit and the opposite to N's —
`b_q = −s`, `b_n = +s` — leaving S and V alone. Biasing Q alone is mostly
absorbed by the softmax as a prior shift; moving N the other way lets the rule
trade the two errors against each other.

**Pooled sweep on the six held-out patients, shipped checkpoint:**

| bias ±s       | accuracy | macro-F1   | N F1  | S F1  | V F1  | Q F1  | N→Q    |
| ------------- | -------- | ---------- | ----- | ----- | ----- | ----- | ------ |
| 0.00 (argmax) | 0.7266   | 0.5965     | 0.835 | 0.549 | 0.460 | 0.542 | 16,682 |
| −0.25         | 0.7591   | 0.6125     | 0.864 | 0.553 | 0.469 | 0.564 | 11,255 |
| −0.50         | 0.7788   | 0.6214     | 0.881 | 0.554 | 0.479 | 0.572 | 7,817  |
| **−0.75**     | 0.7908   | **0.6251** | 0.890 | 0.551 | 0.491 | 0.569 | 5,521  |
| −1.00         | 0.7975   | 0.6234     | 0.895 | 0.541 | 0.503 | 0.555 | 3,874  |
| −1.25         | 0.7997   | 0.6158     | 0.897 | 0.520 | 0.514 | 0.533 | 2,707  |
| −1.50         | 0.7984   | 0.6026     | 0.896 | 0.490 | 0.522 | 0.503 | 1,806  |

At −1.00 the N↔Q errors total 12,126 against 20,299, and accuracy is 0.7975. The
peak macro-F1 is at −0.75 (0.6251) and it is a plateau, not a point: −0.50 and
−1.00 are within 0.004 of it. Past −1.25 accuracy keeps rising while macro-F1
falls, because Q recall collapses and the N↔Q trade starts costing S and V.

**Out of fold.** Tune the constant on five patients, apply it to the sixth, rotate
through all six. That is the check that stops the rule fitting the evaluation set:

|                                 | accuracy | macro-F1 | vs argmax   |
| ------------------------------- | -------- | -------- | ----------- |
| argmax                          | 0.7266   | 0.5965   | —           |
| bias q only, out of fold        | 0.7644   | 0.6072   | +0.0107     |
| bias q/n symmetric, out of fold | 0.7903   | 0.6221   | **+0.0256** |

The constant each fold wanted was −0.75 or −1.00, never outside that, so the
rotation is stable in the thing it tunes. Applying one fixed −0.75 to all six
scores 0.6251, slightly _above_ the rotation's 0.6221 — the per-fold tuning adds
noise rather than information. Out of fold is the honest number and it is still a
gain.

**The test that rejected it.** 0.05 macro-F1 is the run-to-run spread between two
retrains of this recipe, so a +0.027 gain on one checkpoint could be that
checkpoint's luck. The same constant, unchanged, on the same beats, across every
checkpoint the recipe has produced:

| checkpoint          | extra input            | argmax | at bias −1.00 | delta       | N→Q            |
| ------------------- | ---------------------- | ------ | ------------- | ----------- | -------------- |
| `beatcnn_ctrl`      | none                   | 0.5260 | 0.5355        | +0.0095     | 16,851 → 4,118 |
| `beatcnn_rec`       | log(scale), per record | 0.5073 | 0.4965        | **−0.0108** | 11,599 → 3,171 |
| `beatcnn` (v2)      | log(scale), global     | 0.5776 | 0.5683        | **−0.0092** | 18,163 → 5,285 |
| `beatcnn` (shipped) | three RR ratios        | 0.5965 | 0.6234        | +0.0269     | 16,682 → 3,874 |

Two of the three comparisons move backwards. The direction of the _N → Q_ change
is consistent across all four (−76%, −73%, −71%, −77%) and so is accuracy (+0.078,
+0.051, +0.071, +0.071); what does not transfer is whether macro-F1 improves, and
macro-F1 is the number that matters on this class balance. A rule that lifts one
checkpoint and lowers two others is a property of that checkpoint, not of the
recipe.

One detail in that table is what makes the point sharp. The G8 model has _more_
N → Q errors than the shipped one (18,163 against 16,682) and the same rule
loses 0.009 macro-F1 on it; the shipped model gains 0.027. The error count does
not predict which model the rule helps, so the rule is not correcting a shared
defect in the boundary.

**Where the rule is genuinely right.** Tuned per patient on their own beats, the
best constant is −1.50 for p00019 (+0.101), −1.50 for p00114 (+0.106), −0.50 for
p00225 (+0.022), −0.25 for p00228 (+0.007), −0.25 for p00239 (+0.007) and 0.00
for p00267 (+0.000). The two patients that want a big bias are the two whose
recordings are dominated by unusable stretches — p00019 has Q precision 4.6% and
p00114 keeps 26.5% of its normal beats — and the one that wants no change has Q
at 8.4% of its beats with the best normal-beat recall in the set (97.6%). The
pooled-corpus prior correction does not find those constants:
`log(q_train) − log(1/K)` gives N +0.95 and Q −0.09 (a 0.09 shift, not a 1.5 one),
and applying it at full strength takes macro-F1 _down_ to 0.5519 by dragging S to
0.373 and V to 0.410. The right correction is per recording, and a per-recording
prior is not something a 1-second window can know.

So the G10 conclusion is the G9 one narrowed: N → Q is a decision boundary with a
70-minute-recording-sized cause, and it stays unfixed. The numbers are in
`data/models/beatcnn.qboundary.json` and `data/models/beatcnn.qtransfer.json`.

## S and V precision: no cheap rule, so no retrain (G12)

G11 closed the docs backlog and left one measured question: S precision 0.487 and
V F1 0.460 are the two weakest numbers, and `probe_sv_boundary.py` shows they are
not thresholds. The remaining hope was another input. G8 spent a retrain on that
hope and the ablation rejected the input, so this time the cheap half came first:
measure candidate cues on the beats the model gets _wrong_ and refuse to propose
a retrain for a cue that cannot move them.

`probe_sv_features.py` asks three different questions of nine cues, all computed
from beat positions so each one is reimplementable in TypeScript:

1. **Can the cue tell a true S from an N?** That is how G9 justified its retrain.
2. **Among the windows the model called S, can the cue find the true ones?** This
   is the precision question, and it is stricter — the model has already used the
   same evidence and still called these beats S. This is the check G8 skipped.
3. **Can the cue separate a true V from a true S among those calls?** That is
   where V → S lives (3,218 beats).

AUC is reported pooled and _within patient_. The within-patient number is the one
that decides: a cue that only separates at pooled level is the recording's prior,
and that is not something a 1-s window can carry.

| cue        | S vs N (within) | S precision (within) | V vs S (within) |
| ---------- | --------------- | -------------------- | --------------- |
| `pre`      | 0.027           | 0.155                | 0.268           |
| `post`     | 0.790           | 0.664                | 0.631           |
| `sum`      | 0.229           | 0.342                | 0.484           |
| `rr_sd`    | 0.619           | 0.560                | 0.445           |
| `rr_ms`    | 0.544           | 0.469                | 0.610           |
| `early_ms` | 0.973           | 0.836                | 0.732           |
| `prev_pre` | 0.550           | 0.598                | 0.663           |
| `next_pre` | 0.789           | 0.663                | 0.631           |
| `pause`    | 0.931           | 0.626                | 0.505           |

The striking row is `pre`: **0.027** for S against N, i.e. 0.973 inverted. True S
beats are early and normal beats are not, at within-patient AUC 0.97 — and `pre`
is _already an input to the shipped model_. `early_ms` is the same signal in
milliseconds, and its precision AUC 0.836 is `1 − 0.155` to within noise. So the
information is present and the model still calls those beats S. That is not a
missing input; it is a mis-weighted one.

`rr_ms` (baseline rate in milliseconds) is the one cue that is genuinely new: it
correlates +0.19 with the model's V−S logit gap, so it is not a restatement of
what the network already sees. Its within-patient AUC on the V-versus-S question
is 0.610, against 0.679 for the model's own logit gap. It adds nothing the model
does not already know better.

### The rule that looked best pooled, and failed out of fold

Demoting S calls whose `pre` exceeds a threshold is the obvious use of that 0.836:
"if the model says S but the beat did not arrive early, believe something else."

| t (`pre` above this loses its S call) | accuracy | macro-F1   | S Se  | S PPV | demoted |
| ------------------------------------- | -------- | ---------- | ----- | ----- | ------- |
| 0.90                                  | 0.7381   | 0.6018     | 0.578 | 0.563 | 3,421   |
| 0.95                                  | 0.7351   | **0.6037** | 0.624 | 0.532 | 1,548   |
| 1.00                                  | 0.7287   | 0.5984     | 0.629 | 0.496 | 323     |
| 1.05                                  | 0.7269   | 0.5968     | 0.629 | 0.488 | 40      |

Pooled, +0.007 macro-F1 at t = 0.95 with precision 0.487 → 0.532. Run out of
fold, tuning `t` on five patients and scoring the sixth:

| patient    | tuned t  | argmax | rule   | delta       |
| ---------- | -------- | ------ | ------ | ----------- |
| p00019     | 0.95     | 0.5123 | 0.5132 | +0.0009     |
| p00114     | 0.95     | 0.3716 | 0.3713 | −0.0003     |
| p00225     | 0.95     | 0.5296 | 0.5485 | +0.0190     |
| **p00228** | **0.85** | 0.5271 | 0.4842 | **−0.0429** |
| p00239     | 0.95     | 0.4926 | 0.4927 | +0.0000     |
| p00267     | 0.95     | 0.5237 | 0.5237 | +0.0000     |

Mean out-of-fold macro-F1 **0.4889 against 0.4928**, i.e. **−0.0039**. The one
patient who carries the pooled gain is p00225 (+0.019); the one who pays for it is
p00228 (−0.043), the patient with the most S beats and the worst S precision
(0.535–0.688 across her four records). The same shape as G10: a rule tuned on the
pool, reversed on the patient who needs it.

Why p00228 is different is measurable and it is the whole story. Her median
`rr_sd` is 0.084–0.146 — she has the most irregular rhythm of the six — so
"early" is not a well-defined word in her recording. A rule that demotes beats
for _not being early_ removes true S beats from the patient who has the most of
them.

### The ceiling, for whoever tries this next

A per-recording prior is still the right explanation for all of this. G10 measured
its best-case value on the N/Q cell; this run measured it on every cell, using the
_true_ class frequencies of each held-out record as the prior — a thing no
deployed method could know:

|                     | accuracy | macro-F1   | N F1  | S F1  | V F1      | Q F1  |
| ------------------- | -------- | ---------- | ----- | ----- | --------- | ----- |
| argmax              | 0.7266   | 0.5965     | 0.835 | 0.549 | 0.460     | 0.542 |
| oracle record prior | 0.7953   | **0.6776** | 0.873 | 0.618 | **0.648** | 0.572 |

**+0.081 macro-F1, and V nearly +0.19.** That is the largest single gain this
project has measured, and it is not reachable by a retrain: it is information
about the recording that a one-second window does not contain. Two estimators were
tried against it and both failed — BBSE on a source confusion matrix from the
training records (the model is too confident there: the matrix says S→S 0.93, the
held-out truth is 0.63) and EM on the model's own posteriors (converges to the
argmax and gains nothing). The reason is structural: the estimated priors for
p00114 come out 0.06–0.21 N where the truth is 0.52–0.62, because the model is
wrong about those records in a consistent direction, and a prior cannot correct a
bias it estimates from the same wrong evidence.

The conclusion this run supports is narrow and it closes the item:

- **No S or V rule is worth shipping.** The best pooled rule loses 0.004 out of
  fold; the best feature is weaker than the model's own logit on the cell it would
  fix.
- **No retrain is worth starting.** The input that would help (`pre`) is already
  in the head; the input that is new (`rr_ms`) is redundant with the logits. A
  retrain cannot fix a weighting the training set did not ask it to fix, and the
  ceiling is not a weight, it is knowledge of the recording.
- **If this is ever reopened, the target is the recording, not the window** — a
  per-recording prior estimated from a longer stretch of that patient's own beats,
  which needs an interface the app does not have (the worker classifies a record at
  a time and could expose it, but no estimator tried here works).

Artefact: `data/models/beatcnn.svfeatures.json` (features, the prematurity sweep,
the out-of-fold folds, the oracle ceiling, and where each patient's S false
positives come from).

## Known limits

- **N → Q is a decision boundary, and the boundary is not fixable from inside the
  model.** G10 measured it: a symmetric bias on the two logits removes 75% of the
  cell, but the macro-F1 gain holds on one of four checkpoints and reverses on two
  others, so it was not shipped. The per-patient view says why — the patients that
  need it are the ones with unusable stretches, and the amount they need varies
  with how much of the recording is unusable. Expect N → Q to stay the largest
  error, and do not read the raw cell count as a morphology failure.
- **S precision is the soft spot, and it is not fixable by a rule or a retrain.**
  A supraventricular ectopic looks like a normal beat; what marks it is that it
  arrives early. The three RR ratios give the network that timing — the ablation
  shows it uses them — and S recall rose from 55.0% to 62.9%, taking S F1 to 0.549.
  What remains is precision (48.7%). G12 measured why: prematurity separates a true
  S from an N at within-patient AUC 0.97, and `pre_ratio` is _already in the head_,
  so the model has the information and mis-weights it. Every post-hoc rule on that
  cue gains on the pool and loses out of fold (−0.004), and the feature that is
  genuinely new (`rr_ms`) is weaker than the model's own logit gap. Expect S to
  trail N, and do not read that as a missing input.
- **V is the lowest-scoring class, and its errors are the S problem seen from the
  other side.** F1 0.460, down from 0.499. Ventricular beats called N fell 1,273 →
  77 while V → S rose 1,335 → 3,218: the model reads the premature timing and
  picks the wrong ectopic class. The V ↔ S question inside the model's own S calls
  is the hardest thing left (within-patient AUC 0.679 for the logit gap, at best),
  and no timing cue beats it. G12's ceiling measurement says a per-recording prior
  would take V to 0.648 — the largest gain anyone has measured here — and that is
  knowledge of the recording, not of the beat.
- **Q is a refusal label, not a rhythm.** A good Q score means the model
  detects unusable signal, not that it recognises a fourth arrhythmia. It does
  not do that well: Q precision is 0.44 at the argmax boundary, 0.68 once the
  boundary is moved to where it should be — which is itself the evidence that the
  gap is placement, not recognition.
- **Single lead, single dataset.** Everything here is one chest lead at 250 Hz
  from icentia11k. Nothing in the numbers supports use on a different lead
  placement without retraining.
- **The validation set is six patients**, and per-patient variance is large —
  present-class macro-F1 from 0.495 to 0.706, and run-to-run spread of 0.05
  macro-F1 on the same data. Three of them contain no S beats, so the pooled S
  row is carried by three patients. The per-patient table above is the full
  picture; do not quote the pooled numbers as if they were uniform.
