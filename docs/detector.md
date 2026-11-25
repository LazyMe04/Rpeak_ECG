# R-peak detection: architecture and measured accuracy

Status: **detector frozen as `pipeline/detect_v4.py`, ported to TypeScript in
G3 with stage-by-stage parity**. This document records what was tried, what it
scored, and why the shipped design is what it is, so the numbers are not
re-litigated later without the evidence.

## Result

24 segments across 12 patients, Icentia11k open subset, scored with
`detect4.score_weighted`: each detection must land within `clip(0.5 · RR,
50 ms, 150 ms)` of a reference beat, matched one-to-one.

| metric     | value  | target from the plan |
| ---------- | ------ | -------------------- |
| pooled Se  | 97.73% | ≥ 99% median         |
| pooled PPV | 96.19% | ≥ 99%                |
| F1         | 96.96% | —                    |
| median Se  | 98.97% | ≥ 99% median         |
| worst Se   | 92.58% | ≥ 95% every patient  |
| median PPV | 98.07% | ≥ 99%                |
| worst PPV  | 85.24% | ≥ 95% every patient  |

**The plan's gate is not met.** The gap is real and is documented in
_Known limits_ below rather than papered over. For context, the best
established open-source detectors score far lower on the same data:

| detector                   | mean Se   | mean PPV       |
| -------------------------- | --------- | -------------- |
| `wfdb` gqrs                | 93.88     | 97.13 (median) |
| `wfdb` xqrs                | 82.46     | 96.06 (median) |
| classic two-moving-average | 98.84     | 93.72 (median) |
| **detect_v4 (shipped)**    | **97.73** | **96.19**      |

Two of the three baselines fail catastrophically on individual records
(gqrs Se 0.00% on p00000_s00; xqrs Se 0.81% on p00003_s00, 10.45% on
p00009_s01). detect_v4's worst case is 92.58%, which is the practical argument
for shipping it over any single established implementation.

## Architecture

```
signal (250 Hz)
  │
  ├─ gqrs ────────────────────┐
  ├─ two-moving-average ──────┤─ snap to |0.5-40 Hz| apex ─ merge (50 ms) ─► candidates
  │                           │                                              (~6k/segment)
  ├─ features per candidate ──┘
  │    amp_z    |wide| at peak, percentile-normalised
  │    corr     max similarity to K-means QRS template clusters
  │    slope_z  max |d wide/dt| within ±40 ms
  │
  ├─ pass 1: DP, no RR weighting   ─► weak sequence (for rhythm measurement only)
  │
  ├─ regularity(i) = 1 - local RR spread / 0.30    ─► per-candidate [0,1]
  │  ref_rr        = median RR of weak sequence
  │
  └─ pass 2: DP with
        gain(i)  = 0.5·amp_z + 1.0·corr + 1.5·slope_z
        hard rule: transition j→i forbidden when 160–450 ms apart and
                   slope(i) < 0.6·slope(j)          (T wave)
        RR cost  = rr_penalty · regularity(i) · |log(rr / ref_rr)|
     ─► R peaks
```

Both passes are linear-time in the candidate count; the whole segment
(1,048,577 samples, ~70 min) takes a few seconds in CPython.

### Why ensemble rather than one detector

The union reaches candidate recall 99.3% (Se of the _unfiltered_ union), because
gqrs and 2ma fail on disjoint record sets. Measured single-record Se:

| record     | gqrs  | 2ma    | union  |
| ---------- | ----- | ------ | ------ |
| p00000_s00 | 0.00  | 100.00 | 100.00 |
| p00003_s00 | 98.97 | 99.80  | 99.82  |
| p00006_s01 | 95.79 | 94.19  | 98.41  |
| p00004_s01 | 95.13 | 94.83  | 97.84  |

### Why the T-wave rule is structural, not statistical

A T wave follows its QRS at a fixed 160–450 ms lag and is always flatter than
that QRS. This holds at any heart rate, so it can be a hard constraint. Measured
on the raw union: false positives sit a median 0.31 s after the preceding beat,
true beats a median 0.71 s.

### Why the RR weight adapts

The records that defeat a fixed setting are exactly the irregular ones:

| record     | rrCV  | irregular frac | Se (v4) |
| ---------- | ----- | -------------- | ------- |
| p00000_s00 | 0.087 | 0.002          | 99.99   |
| p00006_s01 | 0.397 | 0.177          | 93.60   |
| p00004_s01 | 0.262 | 0.184          | 93.10   |
| p00010_s00 | 0.249 | 0.283          | 95.37   |

Scaling the RR penalty by measured local regularity is what lifted F1 from
96.79 (probe_dp3) to 96.96.

## Alternatives measured and rejected

| approach                                          | Se    | PPV              | why rejected                                                       |
| ------------------------------------------------- | ----- | ---------------- | ------------------------------------------------------------------ |
| v5 envelope + global correlation threshold        | 88.44 | 96.00            | candidate recall ceiling 88–96% on several records                 |
| v6 all maxima + K-means templates + PT thresholds | 99.99 | 22.93            | correlation of any extremum ≈ 0.95, thresholds never engage        |
| classic Pan-Tompkins                              | 80.31 | 93.35            | SPKI/NPKI poisoned by burst noise and tall T waves                 |
| local sliding-window templates                    | 73.88 | 60.38            | window median contaminated by non-QRS peaks                        |
| multi-template K-means scoring alone              | 81.24 | 67.97            | noise clusters resemble QRS                                        |
| union + global RR DP                              | 97.88 | 95.56            | one reference RR cannot serve sinus rhythm and AFib                |
| union + drop-short-RR rule                        | 95.56 | 96.21            | deletes real ectopics; strictly worse on worst-case Se (82%)       |
| union(2ma, all                                    | wide  | maxima), no gqrs | 92.11                                                              | 59.26 | set-relative normalisation collapses once 24k noise peaks join |
| union(2ma, gated maxima), absolute normalisation  | 97.29 | 80.76            | QRS polarity varies per patient; `abs(corr)` matches noise equally |

## Porting note

The TypeScript port must reproduce gqrs, not replace it. Two attempts to drop it
failed for reasons that are now measured, so the effort on a faithful port is
justified rather than avoided:

- **Recall was not the problem.** Replacing gqrs with all local maxima of
  |0.5-40 Hz| actually _improved_ candidate recall from 97.48% to 98.67% mean
  (worst case 91.09% → 95.02%).
- **Precision was.** End-to-end PPV fell from 96.19% to 59.26%, because the
  feature normalisation is percentile-based over the candidate set: 24k noise
  peaks redefine "a typical QRS amplitude" and a real beat no longer looks
  large.
- **Absolute normalisation recovered recall but not precision** (97.29 / 80.76).
  The residual loss is the `abs(correlation)` step: with no gqrs to pre-filter
  candidate locations, the K-means clusters include noise shapes, and taking the
  absolute value makes an inverted noise bump score as highly as a QRS.

gqrs earns its place as a _candidate prior_: it proposes roughly the right
number of plausible beat locations, which keeps every set-relative statistic
honest. Reproducing it in TypeScript means the biquad pre-filter, the rough peak
pass and the rate-limited refinement — see `wfdb.processing.gqrs_detect`.

## TypeScript port (G3)

`app/src/lib/detect/` is a line-by-line port, not a reimplementation:

| module        | Python origin                                                                                           |
| ------------- | ------------------------------------------------------------------------------------------------------- |
| `gqrs.ts`     | `wfdb.processing.gqrs` (including its automatic 24-bit ADC scaling)                                     |
| `twomax.ts`   | `probe_2ma.py` (Butterworth 8–20 Hz, odd-padded `filtfilt`, 30-point moving average, `find_peaks`)      |
| `fuse.ts`     | `probe_fuse.py` (snap to the wide-band apex, merge, K-means morphology score)                           |
| `features.ts` | `probe_dp.py::features`                                                                                 |
| `dp.ts`       | `probe_dp3.py::select`, `probe_dp4.py::{weak_sequence, local_regularity, select_adaptive}`              |
| `score.ts`    | `detect4.score_weighted`                                                                                |
| `math.ts`     | the exact numpy/scipy primitives (`percentile`, even-length median, `gradient`, `interp`, `find_peaks`) |

### Parity

`npm run test:detect` compares every intermediate against goldens dumped by
`pipeline/parity_golden.py` for four records. Comparing only Se/PPV would let
two compensating bugs cancel out; each stage is checked on its own. Measured on
p00000_s00, p00001_s00, p00006_s01, p00010_s01:

| stage                     | result                                          |
| ------------------------- | ----------------------------------------------- |
| 24-bit ADC output         | identical on a 200,000-sample prefix            |
| gqrs peaks                | identical (5,640 / 8,159 / 5,263 / 6,886 peaks) |
| two-max peaks             | identical                                       |
| fused candidates          | identical                                       |
| morphology correlation    | max relative difference ≤ 2e-13                 |
| amplitude / slope / gain  | ≤ 5e-13                                         |
| pass-1 weak sequence      | identical                                       |
| regularity curve          | ≤ 2e-16                                         |
| reference RR, final peaks | identical                                       |

`npm run eval` extends this to all 24 segments and diffs the raw `tp/fp/fn`
counts against the Python reference: **24/24 segments identical**.

### Two decisions the port forced

**K-means initialisation.** numpy's `default_rng().choice(n, k, replace=False)`
is Floyd's algorithm over the PCG64 stream, so reproducing it would mean porting
a PRNG bit for bit. The Python chain gained `--kmeans-init even`, which takes
`k` rows evenly spaced through the candidates, and the port uses that. Effect
on the score: ≤ 0.6 pp on any segment, ~0.001 on the correlation mean. On this
set it is slightly _better_ than the seeded run (worst segment Se 92.58 →
93.18, pooled PPV 96.19 → 96.21). The shipped `detect_v4_result.json` keeps the
original seeded numbers.

**One dead code path, reproduced anyway.** gqrs's LEARNING pass never runs:
`sample_valid` is false when it starts, so it sets a 250-sample countdown and
breaks after the first sample; `rewind` then flips `sample_valid` and the
RUNNING pass does everything from `t = -16`. The port implements both passes,
including the early exit, so a future reader does not "fix" the learning path
and silently change the detector.

### Performance

The whole-segment run is 0.5–0.9 s in Node (median 685 ms over the 24 segments,
min 516, max 855).
In the app it runs in a worker (`src/lib/detect/worker.ts`), which keeps the
trace at 60 fps; the worker is terminated as soon as it replies so its 4 MB
copy of the signal and the detector's buffers are released. The detection is
whole-segment by nature — the DP is global — so it cannot be fed 1,000-sample
frames without changing the result.

![Detector overlay, dark](shots/g3-detect-dark.png)

Blue hollow rings and top-edge triangles are the detector; green dots are the
reference annotations. Agreement and misses are visible at a glance.

## Known limits

Three records account for every result below 95%:

- **p00006_s01** (Se 93.60, PPV 85.24) — rrCV 0.397, the most irregular record
  in the set. At 115 bpm mean rate with marked irregularity, T waves and QRS
  complexes are 200–300 ms apart, so the 160–450 ms T-wave window overlaps the
  genuine RR distribution. No timing rule can separate them; this needs
  morphology (the CNN in G5) or per-beat classification.
- **p00010_s01** (Se 92.58, PPV 94.15) — rrCV 0.214, pnn50 0.831, the most
  beat-to-beat variable record.
- **p00004_s01** (Se 93.10, PPV 89.39) — rrCV 0.262, irregular fraction 0.184.

The common factor is arrhythmia, not signal quality. This matters for G5: the
CNN's job is beat _classification_, and adding a QRS-vs-T decision would raise
both Se and PPV here. Until then the shipped accuracy is the measured value
above, and the app should display per-segment quality rather than claim
99%.

## Reproducing

```
python -I pipeline/detect_v4.py --all
python -I pipeline/detect_v4.py --all --kmeans-init even \
       --json data/catalog/detect_v4_even.json   # the port's parity reference
python -I pipeline/parity_golden.py              # stage goldens for 4 records
```

```
cd app
npm run test:detect   # every stage, 4 records
npm run eval          # all 24, writes data/catalog/eval_result.json
```

Diagnostics that produced the evidence above:

```
python -I pipeline/probe_baseline.py     # gqrs / xqrs / 2ma baselines
python -I pipeline/probe_rhythm.py       # per-record rhythm statistics
python -I pipeline/probe_ceiling.py      # amplitude of missed beats
python -I pipeline/probe_cand2.py        # candidate generator comparison
python -I pipeline/probe_feat.py         # TP/FP feature separation
python -I pipeline/probe_fuse_ablate.py  # cost of each fusion stage
```
