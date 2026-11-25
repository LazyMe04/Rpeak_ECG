/**
 * Faithful TypeScript port of `wfdb.processing.gqrs_detect`.
 *
 * This is a deliberate port rather than a reimplementation. Two attempts to
 * replace gqrs with something simpler lost recall on precisely the records the
 * ensemble relies on, because gqrs' quirks (its fixed 24-bit ADC scaling, the
 * trapezoid filter's startup branch, the recursive peak-prominence test) are
 * part of what makes it fail on a *different* record set than the 8-20 Hz
 * detector. See docs/detector.md for the numbers.
 *
 * Everything below follows the Python line by line, including two behaviours
 * that look like bugs and are reproduced anyway:
 *
 *  - the LEARNING pass is dead code. `sample_valid` is false when the pass
 *    starts, so it sets a 250-sample countdown and exits on the first check,
 *    having called `qf()` zero times. Measured, not assumed.
 *  - when the running R-T mean falls below `rtmin`, wfdb resets it to
 *    `rrmin`, not `rtmin`. Reproduced so the peak stream stays identical.
 *
 * Arithmetic notes: Python uses int64 for `smv`, `qfv` and `v1`. On a real
 * segment the largest magnitude seen was 6.9e11, far below 2^53, so IEEE-754
 * doubles hold every value exactly. The only translation hazard is that
 * Python's `<<`/`>>` are unbounded while JavaScript's are 32-bit: every shift
 * here is written as a multiplication or `Math.floor(x / 2**n)`.
 */

import { roundHalfEven } from "./math";

const NPEAKS = 64;
const BUFLN = 32768;
const BUFMASK = BUFLN - 1;

interface Conf {
  fs: number;
  adcGain: number;
  sps: number;
  spm: number;
  rrmean: number;
  rrdev: number;
  rrmin: number;
  rrmax: number;
  rrinc: number;
  dt: number;
  dt2: number;
  dt3: number;
  dt4: number;
  rtmin: number;
  rtmean: number;
  rtmax: number;
  v1norm: number;
  smdt: number;
  smt0: number;
  smt: number;
  pthr: number;
  pthmin: number;
  qthr: number;
  qthmin: number;
  tamean: number;
}

/** GQRS.Conf.__init__ at fs = 250, for arbitrary gain. */
function makeConf(fs: number, adcGain: number): Conf {
  const sps = Math.trunc(1 * fs + 0.5);
  const spm = Math.trunc(60 * fs + 0.5);
  const rrmean = Math.trunc((60 / 75) * sps);
  const rrdev = Math.trunc(0.2 * sps);
  const rrmin = Math.trunc(0.28 * sps);
  const rrmax = Math.trunc(2.4 * sps);
  const rrinc = Math.max(1, Math.trunc(rrmean / 40));
  const dt = Math.trunc((0.07 * sps) / 4);
  const rtmin = Math.trunc(0.25 * sps);
  const rtmean = Math.trunc(0.75 * 0.35 * sps);
  const rtmax = Math.trunc(0.33 * sps);

  const dv = adcGain * 130 * 0.001;
  const thresh = 1.0;
  const pthr = Math.trunc((thresh * dv * dv) / 6);
  const qthr = pthr * 2; // pthr << 1
  const pthmin = Math.floor(pthr / 4); // pthr >> 2
  const qthmin = Math.trunc((pthmin * 4) / 3); // (pthmin << 2) / 3

  const smdt = dt;
  return {
    fs,
    adcGain,
    sps,
    spm,
    rrmean,
    rrdev,
    rrmin,
    rrmax,
    rrinc,
    dt,
    dt2: 2 * dt,
    dt3: 3 * dt,
    dt4: 4 * dt,
    rtmin,
    rtmean,
    rtmax,
    v1norm: smdt * dt * 64,
    smdt,
    smt0: smdt,
    smt: 0,
    pthr,
    pthmin,
    qthr,
    qthmin,
    tamean: qthr,
  };
}

/**
 * Gain and baseline wfdb derives for an automatic 24-bit conversion of a
 * physical signal. Exposed so the port can log the same value the Python side
 * prints, and so `toDigital24` and `gqrsDetect` cannot disagree.
 *
 * This is not incidental. `pthr` is proportional to adc_gain squared, so the
 * detection threshold is a property of the segment's peak-to-peak amplitude,
 * not an absolute voltage.
 */
export function adcParams(sig: ArrayLike<number>): { gain: number; baseline: number } {
  const n = sig.length;
  let pmin = Infinity;
  let pmax = -Infinity;
  for (let i = 0; i < n; i++) {
    const v = sig[i] as number;
    if (Number.isNaN(v)) continue;
    if (v < pmin) pmin = v;
    if (v > pmax) pmax = v;
  }
  if (!Number.isFinite(pmin)) {
    pmin = 0;
    pmax = 0;
  }

  // _digi_bounds("24"), with dmin += 1 because the lowest value stores NaN.
  const dmin = -(2 ** 23) + 1;
  const dmax = 2 ** 23 - 1;

  let gain: number;
  let baseline: number;
  if (pmin === pmax) {
    if (pmin === 0) {
      gain = 1;
      baseline = 1;
    } else {
      gain = Math.abs(1 / pmin);
      baseline = 0;
    }
  } else {
    gain = (dmax - dmin) / (pmax - pmin);
    baseline = pmin > 0 ? Math.ceil(dmin - gain * pmin) : Math.floor(dmin - gain * pmin);
    if (dmin !== baseline) gain = (dmin - baseline) / pmin;
  }

  // Remap when the int32 baseline would overflow (only reachable when the
  // whole segment sits on one side of zero).
  const MAX_I32 = 2 ** 31 - 1;
  const MIN_I32 = -(2 ** 31) + 1;
  if (baseline > MAX_I32) {
    gain = (MAX_I32 - dmin) / Math.abs(pmin);
    baseline = MAX_I32;
  } else if (baseline < MIN_I32) {
    gain = (dmax - MIN_I32) / pmax;
    baseline = MIN_I32;
  }
  return { gain, baseline };
}

/** `d = round(p * gain + baseline)` with numpy's half-to-even rounding. */
export function toDigital24(sig: ArrayLike<number>): Float64Array {
  const { gain, baseline } = adcParams(sig);
  const n = sig.length;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = roundHalfEven((sig[i] as number) * gain + baseline);
  }
  return out;
}

class Gqrs {
  private readonly x: Float64Array;
  private readonly c: Conf;
  private readonly adcZero: number;

  private readonly smv = new Float64Array(BUFLN);
  private readonly qfv = new Float64Array(BUFLN);
  private v1 = 0;

  private t = 0;
  private tf = 0;
  private sampleValid = false;
  private countdown = -1;
  private state: "LEARNING" | "RUNNING" | "CLEANUP" = "LEARNING";
  private annotTime = 0;
  private readonly out: number[] = [];

  // Circular buffer of peaks, indexed like the Python object graph.
  private readonly pkTime = new Float64Array(NPEAKS);
  private readonly pkAmp = new Float64Array(NPEAKS);
  private readonly pkType = new Int8Array(NPEAKS);
  private readonly pkNext = new Int32Array(NPEAKS);
  private readonly pkPrev = new Int32Array(NPEAKS);
  private cur = 0;

  constructor(x: Float64Array, conf: Conf, adcZero: number) {
    this.x = x;
    this.c = conf;
    this.adcZero = adcZero;
    for (let i = 0; i < NPEAKS; i++) {
      this.pkNext[i] = (i + 1) % NPEAKS;
      this.pkPrev[i] = (i - 1 + NPEAKS) % NPEAKS;
    }
  }

  // ---- sample and buffer access ------------------------------------------

  private at(t: number): number {
    if (t < 0) {
      this.sampleValid = true;
      return this.x[0];
    }
    if (t > this.x.length - 1) {
      this.sampleValid = false;
      return this.x[this.x.length - 1];
    }
    this.sampleValid = true;
    return this.x[t];
  }

  private smvAt(t: number): number {
    return this.smv[t & BUFMASK];
  }

  private smvPut(t: number, v: number): void {
    this.smv[t & BUFMASK] = v;
  }

  private qfvAt(t: number): number {
    return this.qfv[t & BUFMASK];
  }

  private qfvPut(t: number, v: number): void {
    this.qfv[t & BUFMASK] = v;
  }

  // ---- filters ------------------------------------------------------------

  /** Trapezoidal low-pass, with its separate startup branch. */
  private sm(atT: number): number {
    let smt = this.c.smt;
    const smdt = this.c.smdt;
    // Only the startup branch reads `v`, and it assigns before using it.
    let v: number;
    while (atT > smt) {
      smt += 1;
      if (smt > this.c.smt0) {
        const tmp =
          this.smvAt(smt - 1) +
          this.at(smt + smdt) +
          this.at(smt + smdt - 1) -
          this.at(smt - smdt) -
          this.at(smt - smdt - 1);
        this.smvPut(smt, tmp);
      } else {
        v = this.at(smt);
        for (let j = 1; j < smdt; j++) {
          v += this.at(smt + j) + this.at(smt - j);
          this.smvPut(
            smt,
            v * 2 + this.at(smt + j + 1) + this.at(smt - j - 1) - this.adcZero * (smdt * 4),
          );
        }
      }
    }
    this.c.smt = smt;
    return this.smvAt(atT);
  }

  /** QRS matched filter, five difference windows scaled by v1norm. */
  private qf(): void {
    const c = this.c;
    let dv2 = this.sm(this.t + c.dt4);
    dv2 -= this.smvAt(this.t - c.dt4);
    const dv1 = this.smvAt(this.t + c.dt) - this.smvAt(this.t - c.dt);
    let dv = dv1 * 2;
    dv -= this.smvAt(this.t + c.dt2) - this.smvAt(this.t - c.dt2);
    dv = dv * 2;
    dv += dv1;
    dv -= this.smvAt(this.t + c.dt3) - this.smvAt(this.t - c.dt3);
    dv = dv * 2;
    dv += dv2;
    this.v1 += dv;
    const v0 = Math.trunc(this.v1 / c.v1norm);
    this.qfvPut(this.t, v0 * v0);
  }

  // ---- peak ring ----------------------------------------------------------

  private addPeak(peakTime: number, amp: number, type: number): void {
    const p = this.pkNext[this.cur];
    this.pkTime[p] = peakTime;
    this.pkAmp[p] = amp;
    this.pkType[p] = type;
    this.cur = p;
    this.pkAmp[this.pkNext[p]] = 0;
  }

  /** 1 = primary, 2 = secondary, cached in the ring exactly as in Python. */
  private peaktype(p: number): number {
    const cached = this.pkType[p];
    if (cached) return cached;
    const a = this.pkAmp[p];
    let t0 = this.pkTime[p] - this.c.rrmin;
    const t1 = this.pkTime[p] + this.c.rrmin;
    if (t0 < 0) t0 = 0;

    let pp = this.pkPrev[p];
    while (t0 < this.pkTime[pp] && this.pkTime[pp] < this.pkTime[this.pkNext[pp]]) {
      if (this.pkAmp[pp] === 0) break;
      if (a < this.pkAmp[pp] && this.peaktype(pp) === 1) {
        this.pkType[p] = 2;
        return 2;
      }
      pp = this.pkPrev[pp];
    }

    pp = this.pkNext[p];
    while (this.pkTime[pp] < t1 && this.pkTime[pp] > this.pkTime[this.pkPrev[pp]]) {
      if (this.pkAmp[pp] === 0) break;
      if (a < this.pkAmp[pp] && this.peaktype(pp) === 1) {
        this.pkType[p] = 2;
        return 2;
      }
      pp = this.pkNext[pp];
    }

    this.pkType[p] = 1;
    return 1;
  }

  private findMissing(r: number, p: number): number {
    if (r < 0 || p < 0) return -1;
    let minrrerr = this.pkTime[p] - this.pkTime[r];
    let s = -1;
    let q = this.pkNext[r];
    while (this.pkTime[q] < this.pkTime[p]) {
      if (this.peaktype(q) === 1) {
        const rrtmp = this.pkTime[q] - this.pkTime[r];
        let rrerr = rrtmp - this.c.rrmean;
        if (rrerr < 0) rrerr = -rrerr;
        if (rrerr < minrrerr) {
          minrrerr = rrerr;
          s = q;
        }
      }
      q = this.pkNext[q];
    }
    return s;
  }

  // ---- passes -------------------------------------------------------------

  private gqrs(fromSample: number, toSample: number): void {
    const c = this.c;
    let lastPeak = fromSample;
    let lastQrs = fromSample;
    let r = -1;

    while (this.t <= toSample + c.sps) {
      if (this.countdown < 0) {
        if (this.sampleValid) {
          this.qf();
        } else {
          this.countdown = Math.trunc(1 * c.fs + 0.5);
          this.state = "CLEANUP";
        }
      } else {
        this.countdown -= 1;
        if (this.countdown < 0) break;
      }

      const q0 = this.qfvAt(this.t);
      const q1 = this.qfvAt(this.t - 1);
      const q2 = this.qfvAt(this.t - 2);

      if (q1 > c.pthr && q2 < q1 && q1 >= q0 && this.t > c.dt4) {
        this.addPeak(this.t - 1, q1, 0);
        lastPeak = this.t - 1;
        let p = this.pkNext[this.cur];
        while (this.pkTime[p] < this.t - c.rtmax) {
          if (this.pkTime[p] >= this.annotTime + c.rrmin && this.peaktype(p) === 1) {
            if (this.pkAmp[p] > c.qthr) {
              let rr = this.pkTime[p] - this.annotTime;
              const q = this.findMissing(r, p);
              if (rr > c.rrmean + 2 * c.rrdev && rr > 2 * (c.rrmean - c.rrdev) && q >= 0) {
                p = q;
                rr = this.pkTime[p] - this.annotTime;
              }
              let rrd = rr - c.rrmean;
              if (rrd < 0) rrd = -rrd;
              c.rrdev += Math.floor((rrd - c.rrdev) / 8);
              if (rrd > c.rrinc) rrd = c.rrinc;
              c.rrmean += rr > c.rrmean ? rrd : -rrd;

              if (this.pkAmp[p] > c.qthr * 4) c.qthr += 1;
              else if (this.pkAmp[p] < c.qthr) c.qthr -= 1;
              if (c.qthr > c.pthr * 20) c.qthr = c.pthr * 20;
              lastQrs = this.pkTime[p];

              if (this.state === "RUNNING") {
                this.annotTime = this.pkTime[p] - c.dt2;
                this.out.push(this.annotTime);
                this.annotTime += c.dt2;
              }

              // Look for this beat's T-wave.
              let tw = -1;
              let rtdmin = c.rtmean;
              let qq = this.pkNext[p];
              while (this.pkTime[qq] > this.annotTime) {
                const rt = this.pkTime[qq] - this.annotTime - c.dt2;
                if (rt < c.rtmin) {
                  qq = this.pkNext[qq];
                  continue;
                }
                if (rt > c.rtmax) break;
                let rtd = rt - c.rtmean;
                if (rtd < 0) rtd = -rtd;
                if (rtd < rtdmin) {
                  rtdmin = rtd;
                  tw = qq;
                }
                qq = this.pkNext[qq];
              }
              if (tw >= 0) {
                const tmpTime = this.pkTime[tw] - c.dt2;
                const rt = tmpTime - this.annotTime;
                c.rtmean += Math.floor((rt - c.rtmean) / 16);
                if (c.rtmean > c.rtmax) c.rtmean = c.rtmax;
                else if (c.rtmean < c.rtmin) c.rtmean = c.rrmin; // wfdb quirk
                this.pkType[tw] = 2; // mark T-wave as secondary
              }
              r = p;
            } else if (this.t - lastQrs > c.rrmax && c.qthr > c.qthmin) {
              c.qthr -= Math.floor(c.qthr / 16);
            }
          }
          p = this.pkNext[p];
        }
      } else if (this.t - lastPeak > c.rrmax && c.pthr > c.pthmin) {
        c.pthr -= Math.floor(c.pthr / 16);
      }

      this.t += 1;
    }

    if (this.state === "LEARNING") return;

    // Mark the last beat or two.
    let p = this.pkNext[this.cur];
    while (this.pkTime[p] < this.pkTime[this.pkNext[p]]) {
      if (
        this.pkTime[p] >= this.annotTime + c.rrmin &&
        this.pkTime[p] < this.tf &&
        this.peaktype(p) === 1
      ) {
        this.annotTime = this.pkTime[p];
        this.out.push(this.annotTime);
      }
      p = this.pkNext[p];
    }
  }

  private rewind(): void {
    this.countdown = -1;
    this.at(this.t);
    this.annotTime = 0;
    for (let i = 0; i < NPEAKS; i++) {
      this.pkTime[i] = 0;
      this.pkType[i] = 0;
      this.pkAmp[i] = 0;
    }
  }

  detect(): number[] {
    this.sampleValid = false;
    if (this.x.length < 1) return [];

    const c = this.c;
    const t0 = 0;
    this.tf = this.x.length - 1;
    this.t = 0 - c.dt4;

    let tfLearn: number;
    if (c.spm > BUFLN) {
      tfLearn = this.tf - t0 > BUFLN ? t0 + BUFLN - c.dt4 : this.tf - c.dt4;
    } else {
      tfLearn = this.tf - t0 > c.spm ? t0 + c.spm - c.dt4 : this.tf - c.dt4;
    }

    this.countdown = -1;
    this.state = "LEARNING";
    this.gqrs(t0, tfLearn);

    this.rewind();

    this.state = "RUNNING";
    this.t = t0 - c.dt4;
    this.gqrs(t0, this.tf);

    return this.out;
  }
}

/**
 * `wfdb.processing.gqrs_detect(sig, fs)` for a physical signal: the trace is
 * converted to 24-bit integers first, and adc_zero is forced to 0.
 */
export function gqrsDetect(sig: ArrayLike<number>, fs = 250): Int32Array {
  const { gain } = adcParams(sig);
  const x = toDigital24(sig);
  const detector = new Gqrs(x, makeConf(fs, gain), 0);
  return Int32Array.from(detector.detect());
}
