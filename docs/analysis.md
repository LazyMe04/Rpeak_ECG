# G4 — PQRST delineation, HRV, intervals, session report

Status: **complete**. The analysis core is verified against a synthetic golden
and a Python reference; the UI reads it through a worker and exports it.

Everything below is measured, not estimated. Commands are at the bottom.

## What G4 adds

| Piece                                                       | Where                                              | Verified by                  |
| ----------------------------------------------------------- | -------------------------------------------------- | ---------------------------- |
| PQRST boundaries (P on/off/peak, QRS on/off, T on/off/peak) | `src/lib/ecg/delineate.ts`                         | `npm run test:delineate`     |
| Intervals: PR, QRS, QT, QTc (Bazett, Fridericia, Hodges)    | same                                               | same                         |
| HRV time domain + FFT spectrum                              | `src/lib/ecg/hrv.ts`                               | `npm run test:hrv`           |
| Delineation in a worker                                     | `src/lib/ecg/worker.ts`, `hooks/useDelineation.ts` | `npm run smoke`, screenshots |
| Caliper lane under the trace                                | `components/WaveformCanvas.tsx`                    | screenshots                  |
| Interval readout, per beat + segment median                 | `components/StatsPanel.tsx`                        | screenshot                   |
| HRV panel: tachogram + PSD, SDNN/RMSSD/pNN50/LF/HF          | `components/HrvPanel.tsx`                          | screenshot                   |
| Session recording, report, CSV and JSON export              | `components/ReportPanel.tsx`, `lib/ecg/report.ts`  | `npm run test:report`        |

## Delineation

### The approach, and why

Four decisions carried the whole thing, each made after the previous version
failed on a measurement:

1. **Low-pass, not the display band-pass.** The display chain's 0.5 Hz
   high-pass leaves an undershoot after every T wave of order
   `amplitude × σ/τ`, which is larger than the thresholds below. Every outward
   walk ran to its search limit on the first attempt. Delineation uses a 40 Hz
   low-pass (`delineate` in `filterCoeffs.json`) and removes baseline per wave.
2. **QRS edges by slope, P and T edges by amplitude.** The QRS is a burst of
   slope that dwarfs its surroundings, and a slope threshold is blind to the
   local baseline offset — on a chest strap that offset is a tenth of the R
   amplitude between the PR and ST segments. P and T are the opposite: their
   slopes are a few percent of the R's so a slope threshold sits in the noise,
   while their excursion from their own baseline is large.
3. **Walk outward from the extremum, not from the peak's derivative.** A
   Gaussian's derivative is zero at its apex, so "walk until the slope falls"
   stops immediately. Amplitude walks start at the extremum; slope walks start
   at the steepest sample.
4. **Bound the P search by the previous T offset.** Above ~100 bpm the P merges
   into the preceding T. Without the bound the delineator measured the T and
   fabricated a 300 ms PR — which it did, on the real segment, until the trace
   was dumped and read. A candidate whose onset lands on the window's lower
   limit is rejected outright: the wave never returned to baseline, so it was
   not a P.

### Accuracy against the synthetic golden

`pipeline/delineate_reference.py` builds 74 beats from five Gaussians and
measures boundary truth numerically, at the same threshold convention the port
uses (10% of the steepest QRS slope; 5% of the wave's own excursion). Truth is
measured on the clean signal after the app's own 40 Hz filter, so the filter's
group delay is not scored as delineator error.

| boundary     | median | p90   | max   |
| ------------ | ------ | ----- | ----- |
| P onset      | 4 ms   | 4 ms  | 8 ms  |
| P offset     | 4 ms   | 4 ms  | 8 ms  |
| QRS onset    | 0 ms   | 4 ms  | 4 ms  |
| QRS offset   | 0 ms   | 0 ms  | 0 ms  |
| T onset      | 4 ms   | 8 ms  | 12 ms |
| T peak       | 0 ms   | 4 ms  | 8 ms  |
| T offset     | 4 ms   | 8 ms  | 12 ms |
| PR interval  | 4 ms   | 12 ms | —     |
| QRS duration | 0 ms   | 4 ms  | —     |
| QT interval  | 4 ms   | 12 ms | —     |

Ordering invariant `pOn < pPeak < pOff ≤ qrsOn < r < qrsOff < tOn ≤ tPeak < tOff`
holds on every beat. One sample at 250 Hz is 4 ms, so the median error is one
sample or less on every boundary.

**What this does and does not prove.** It proves the implementation computes
what it says it computes. It does not prove the convention is the clinically
correct one: a Gaussian has no natural end, so "where the wave ends" is a
definition, and icentia11k has no boundary labels to settle it. Treat the
numbers as a bound on implementation error, not on clinical accuracy.

### Behaviour on a real segment

p00000_s00, 6,885 reference beats, 91 ms (whole segment, one thread):

|              | median |
| ------------ | ------ |
| PR           | 212 ms |
| QRS          | 68 ms  |
| QT           | 312 ms |
| QTc (Bazett) | 398 ms |

P was not found on 12.6% of beats — at 98 bpm average, with supraventricular
beats in the record, that is plausible and is reported rather than hidden. The
test also asserts every interval stays inside a physiological range, which
catches a delineator that scores well on clean synthetic data and produces
nonsense on a real chest lead.

## HRV

Published definitions applied literally:

- SDNN (ddof = 1), RMSSD, pNN50, pNN20, RR CV
- Irregular fraction: a >12.5% change over one beat relative to the shorter of
  the pair
- Physiological gate 300–2000 ms; gated intervals are counted and reported, not
  interpolated over (Kubios-style correction makes the statistic depend on the
  correction parameters, not the rhythm)
- Tachogram resampled at 4 Hz at each interval's midpoint, mean removed, Hann
  window, zero-padded to a power of two, one-sided periodogram
  `|rfft|² / (fs·Σw²)` with interior bins doubled
- Bands VLF 0.003–0.04, LF 0.04–0.15, HF 0.15–0.40 Hz; LF/HF, LF n.u., HF n.u.

Parity with `pipeline/hrv_reference.py` on three records × two peak sources
(annotations, detector): **every statistic agrees to ≤ 1.5 × 10⁻¹³**, the
tachogram sample by sample to 1.7 × 10⁻¹⁰, the PSD to 4 × 10⁻¹².

The panel plots the **millisecond** tachogram (a negative RR is meaningless)
while the transform runs on the mean-removed series. The mean removed is the
grid mean, not the mean RR — keeping those two separate is what made the plot
correct, and `test-hrv.ts` now checks both series.

The tachogram axis is clipped at the 0.5th/99.5th percentiles. One pause or one
missed beat otherwise stretches the axis until the whole 70-minute trend is a
flat line on the floor; clipped points are drawn at the edge rather than
dropped, so the outlier stays visible.

## Session report and exports

A session is a marked span of the loaded segment: start, play or scrub, stop.
"Whole segment" does the same over the full record. The report is a pure
function of what is already on the main thread (peaks, annotation classes,
delineation arrays) — no second pass over the signal, and no number the UI is
not also showing.

- **JSON** (`rpeak-session/1`): span, wall clock, peak source, beat counts by
  class, rate statistics over the span, interval medians, HRV summary, and the
  conventions used in a `notes` array.
- **CSV**: one row per beat — `time_s, sample, symbol, rr_ms, pr_ms, qrs_ms,
qt_ms, qtc_ms`. Unmeasured values are empty cells, not zeros and not `NaN`.

`npm run test:report` checks 23 properties, including that the CSV parses back
to the same rows, that the report's statistics match a direct computation, that
the delineation summary and the report agree (they are separate code paths over
the same beats), that unmeasured PR is an empty cell, and that a sub-span report
covers only beats inside it.

The buttons are also driven in a real browser, because a correct string is not a
correct file:

```
npx tsx scripts/shot.ts --panel report --download-dir ../.cache/dl-test \
  --capture-download --click "Whole segment" --click "Beats CSV" \
  --click "Report JSON" --out ../docs/shots/g4-report-dark.png
```

That clicks the two export buttons and writes what the app handed the browser:
6,885 CSV rows (317 KB) and a 1,160-byte JSON, both named
`p00000_s00_0-4194s.*`. Edge cancels downloads in this automation profile
regardless of CDP command, target directory or SmartScreen flags, which is why
`--capture-download` reads the blob at click time and Node writes it — the bytes
are the app's, only the save location is Node's.

## UI

- The left rail gained **PQRST** (delineate toggle), **HRV** and **Session**
  entries. The rail keeps the reference's 64px → 240px hover geometry.
- Boundaries are drawn in a 24px caliper lane **under** the plot, not over it.
  Two earlier attempts are worth recording: full-height tinted bands striped the
  entire strip and fought the trace, and brackets laid on the trace collided
  with the T wave they were measuring. The lane only takes height while the
  overlay is on.
- Vitals gained an Intervals block: PR/QRS/QT/QTc for the beat nearest the
  playhead plus the segment median, which is how these are read on paper —
  a caliper over the strip, with the stable summary underneath.
- Both floating panels now scroll inside a fixed height (`top-20 bottom-[104px]`),
  because at 860 px they used to run under the transport bar.
- Light theme: three new delineation hues that stay distinct from the trace,
  the beat classes and the detector, plus a red rail tone for Session.

## Verifying

```
cd D:\Rpeak-Desktop\app
npm run test:delineate     # synthetic golden + real-segment plausibility
npm run test:hrv           # HRV parity vs the Python reference
npm run test:report        # report/CSV/JSON correctness
npm run smoke              # the live page over CDP
npx tsx scripts/shot.ts --out ../docs/shots/g4-pqrst-dark.png --pqrst --panel stats
```

Regenerating the goldens (Python, from `D:\Rpeak-Desktop\pipeline`):

```
python -I delineate_reference.py --json ../data/catalog/g4/synth.json
python -I hrv_reference.py --record p00000_s00 --json ../data/catalog/g4/p00000_s00.hrv.json
```

## Known limits

- **No clinical validation.** There are no boundary labels in this dataset and
  none in the app's tests. The synthetic golden bounds implementation error.
- **QTc is Bazett in the UI**, with Fridericia and Hodges computed and exported.
  Bazett is the most-quoted and least reliable correction outside 60–100 bpm; the
  three are returned together precisely because the choice matters.
- **HRV on annotated beats inherits the annotation's errors**, and on detector
  beats inherits the detector's 96.2% PPV. The panel names its source for this
  reason.
- **VLF is reported but not interpreted.** A 70-minute segment gives ~16 VLF
  cycles: enough to measure, not enough to trust.
- **Delineation is O(n) per segment**, not incremental. It re-runs on peak-set
  changes (annotations → detector), which costs ~90 ms each time and is why the
  hook waits while the detector is running rather than computing twice.
