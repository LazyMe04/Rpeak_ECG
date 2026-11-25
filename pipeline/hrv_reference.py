"""Reference implementation of the G4 analyses, for parity with the app.

Two analyses live here, both defined by formula rather than by a library, so
the TypeScript port can be checked exactly:

  hrv(rr)          time-domain statistics and the FFT spectrum of the RR
                   tachogram, computed the way src/lib/ecg/hrv.ts computes it.
  synth_ecg(...)   a synthetic ECG whose P/QRS/T boundaries are known to the
                   sample, used to measure the delineator's timing error.

Run:
  python -I hrv_reference.py --record p00000_s00 --json out.json

The detector peaks come from detect_v4 itself, so the app can compare its HRV
on detector output without dumping peaks separately.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
from scipy import signal as sps

sys.path.insert(0, str(Path(__file__).resolve().parent))
from config import CATALOG  # noqa: E402
from detect import load  # noqa: E402
from detect_v4 import detect  # noqa: E402

RESAMPLE_HZ = 4.0
BANDS = {
    "vlf": (0.003, 0.04),
    "lf": (0.04, 0.15),
    "hf": (0.15, 0.40),
}

# (mu, sigma, amplitude) in seconds relative to the R peak, for the synthetic
# fixture. Amplitudes are chosen so the boundary conventions below land well
# above the noise floor: at +/-3 sigma the Q and S tails are only 0.3% of the R,
# which is not measurable on any signal with noise in it.
WAVES = {
    "p": (-0.16, 0.025, 0.15),
    "q": (-0.030, 0.012, -0.25),
    "r": (0.0, 0.012, 1.0),
    "s": (0.030, 0.012, -0.35),
    "t": (0.28, 0.060, 0.30),
}


def band_power(freqs: np.ndarray, psd: np.ndarray, lo: float, hi: float) -> float:
    """Sum of bin powers whose centre falls in [lo, hi).

    Deliberately a plain bin sum rather than trapezoid integration: it is a
    discrete quantity with no interpolation choices, which is what makes the
    TypeScript port checkable to 1e-9 instead of "close".
    """
    m = (freqs >= lo) & (freqs < hi)
    return float(psd[m].sum())


def hrv(peaks: list[int] | np.ndarray, fs: int, dump: Path | None = None) -> dict:
    peaks = np.asarray(peaks, dtype=np.int64)
    if len(peaks) < 4:
        return {"ok": False, "reason": "fewer than 4 peaks"}

    rr_all = np.diff(peaks).astype(np.float64) / fs
    # Physiological gate. A beat pair shorter than 300 ms or longer than 2 s is
    # a detection error or a pause, not an interval; including it would put a
    # spike into every statistic below.
    keep = (rr_all > 0.30) & (rr_all < 2.00)
    rr = rr_all[keep]
    if len(rr) < 4:
        return {"ok": False, "reason": "fewer than 4 valid intervals"}

    rr_ms = rr * 1000.0
    diffs = np.diff(rr_ms)
    mean_rr = float(rr_ms.mean())
    sdnn = float(rr_ms.std(ddof=1))
    rmssd = float(np.sqrt(np.mean(diffs**2)))
    pnn50 = float(np.mean(np.abs(diffs) > 50.0))
    pnn20 = float(np.mean(np.abs(diffs) > 20.0))
    # "Irregular" is a >12.5% change over one beat, relative to the shorter of
    # the pair; the same rule probe_rhythm.py used to rank the records.
    short = np.minimum(rr_ms[1:], rr_ms[:-1])
    irregular = float(np.mean(np.abs(diffs) > 0.125 * short))

    # Tachogram: each interval placed at the midpoint of its two peaks. The
    # midpoint is computed from the peak samples directly rather than by a
    # cumulative sum, so it does not drift and the TypeScript port can use the
    # identical expression.
    mids = ((peaks[:-1] + peaks[1:]) / 2.0) / fs
    mids, rr_kept = mids[keep], rr_all[keep]

    freq = {}
    psd_info = None
    if len(rr_kept) >= 20 and (mids[-1] - mids[0]) > 30.0:
        span = float(mids[-1] - mids[0])
        n_grid = int(np.ceil(span * RESAMPLE_HZ))
        grid = mids[0] + np.arange(n_grid) / RESAMPLE_HZ
        sig = np.interp(grid, mids, rr_kept) * 1000.0  # ms
        sig = sig - sig.mean()  # detrend: remove the mean

        # Hann window as np.hanning defines it: 0.5 - 0.5 cos(2 pi n / (N-1)).
        n = len(sig)
        win = 0.5 - 0.5 * np.cos(2.0 * np.pi * np.arange(n) / max(n - 1, 1))
        # Zero-pad to a power of two. The transform is unchanged in magnitude,
        # but the bin grid becomes exactly 2^m, which is what lets the
        # TypeScript port use a plain radix-2 FFT and still agree to 1e-9.
        npad = 1 << (n - 1).bit_length()
        spec = np.fft.rfft(sig * win, n=npad)
        power = (np.abs(spec) ** 2) / (RESAMPLE_HZ * float((win**2).sum()))
        power[1:-1] *= 2.0  # one-sided
        freqs = np.fft.rfftfreq(npad, d=1.0 / RESAMPLE_HZ)

        for name, (lo, hi) in BANDS.items():
            freq[name] = band_power(freqs, power, lo, hi)
        total = float(power[(freqs >= 0.003) & (freqs < 0.40)].sum())
        freq["total"] = total
        freq["lf_hf"] = float(freq["lf"] / freq["hf"]) if freq["hf"] > 1e-12 else None
        denom = freq["lf"] + freq["hf"]
        freq["lf_nu"] = 100.0 * freq["lf"] / denom if denom > 1e-12 else None
        freq["hf_nu"] = 100.0 * freq["hf"] / denom if denom > 1e-12 else None
        psd_info = {
            "n_resampled": int(n),
            "n_fft": int(npad),
            "resolution_hz": float(freqs[1] - freqs[0]) if len(freqs) > 1 else None,
        }
        if dump is not None:
            # The tachogram and its PSD, so the port can be compared stage by
            # stage instead of only on the four band sums. Raw little-endian
            # float64, which Node can read without a .npy parser.
            for name, arr in (
                ("grid", grid),
                ("epochs", sig),
                ("freqs", freqs),
                ("power", power),
            ):
                Path(f"{dump}.{name}.f64").write_bytes(
                    arr.astype("<f8").tobytes()
                )

    return {
        "ok": True,
        "n_peaks": int(len(peaks)),
        "n_intervals": int(len(rr)),
        "gated": int(len(rr_all) - len(rr)),
        "duration_s": float((peaks[-1] - peaks[0]) / fs),
        "mean_rr_ms": mean_rr,
        "min_rr_ms": float(rr_ms.min()),
        "max_rr_ms": float(rr_ms.max()),
        "sdnn_ms": sdnn,
        "rmssd_ms": rmssd,
        "pnn50": pnn50,
        "pnn20": pnn20,
        "heart_rate_bpm": 60000.0 / mean_rr,
        "rr_cv": sdnn / mean_rr,
        "irregular_frac": irregular,
        "freq": freq,
        "freq_info": psd_info,
    }


def synth_ecg(fs: int = 250, seconds: float = 30.0, rr_s: float = 0.8,
              seed: int = 0) -> tuple[np.ndarray, np.ndarray, list[dict], int]:
    """A synthetic ECG whose P/QRS/T boundaries are known to the sample.

    The waveform is a sum of five Gaussians per beat, which makes the boundary
    question well posed: a wave has no natural end, so "the end" has to be a
    stated convention. Two are used here, and the truth is found numerically on
    the *clean* signal so it matches the convention exactly:

      QRS onset/offset   last sample, walking outward from the steepest sample
                         of the QRS, whose slope is still above 10% of the
                         steepest slope in the window
      P and T on/off     last sample where the wave is still 5% of its own
                         excursion, walking outward from its peak

    Both fractions are the ones `app/src/lib/ecg/delineate.ts` uses, so this
    fixture measures whether the implementation follows its stated definition —
    not whether that definition is the clinically correct one, which no
    boundary-free dataset can answer.

    The wave amplitudes are deliberately large enough that those crossings sit
    well above the noise floor. An earlier version used ±3 sigma supports, which
    put the QRS onset 12 ms from the R where the Q has already cancelled the R's
    tail: the "truth" was a 26 ms sliver buried in noise.

    Returns (noisy, clean, truth, fs). `clean` has neither noise nor baseline
    wander; `noisy` is what the delineator is scored on.
    """
    rng = np.random.default_rng(seed)
    n = int(round(seconds * fs))
    t = np.arange(n) / fs

    # (mu, sigma, amplitude), all in seconds relative to the R peak.
    beats = np.arange(0.6, seconds - 0.8, rr_s)
    clean = np.zeros(n)
    for r_s in beats:
        for mu, sd, amp in WAVES.values():
            clean += amp * np.exp(-0.5 * ((t - (r_s + mu)) / sd) ** 2)

    noisy = clean + rng.normal(0.0, 0.005, n)
    # A slow baseline wander, which the delineator must ignore.
    noisy += 0.05 * np.sin(2 * np.pi * 0.25 * t)

    # The truth is measured on the *clean* signal after the same 40 Hz low-pass
    # the app applies before measuring anything. Without this the comparison
    # carries the filter's group delay as a constant 10 ms bias, which would be
    # scored as a delineator error when it is a property of the chain.
    # `clean` (the unfiltered Gaussian sum) is what the filter input is; the
    # filtered version is what goes in the dump and what the truth refers to.
    clean_f = sps.sosfilt(_delineate_sos(), clean)
    truth = _truth_from_clean(clean_f, fs, rr_s)
    return noisy.astype(np.float32), clean_f.astype(np.float32), truth, fs


def _delineate_sos() -> np.ndarray:
    """The app's delineation low-pass, read from the single coefficient source."""
    raw = json.loads(Path(r"D:\Rpeak-Desktop\app\src\lib\filterCoeffs.json").read_text())
    return np.array([
        [s["b0"], s["b1"], s["b2"], s["a0"], s["a1"], s["a2"]]
        for s in raw["delineate"]
    ])


def _truth_from_clean(clean: np.ndarray, fs: int, rr_s: float) -> list[dict]:
    """Boundary truth for a clean signal, by the conventions the port uses."""
    QRS_SLOPE_FRAC = 0.1
    SLOW_FRAC = 0.05
    n = len(clean)

    def edge(centre: int, step: int, thresh: float) -> int:
        """Outward walk from a wave's extremum to where it falls below thresh."""
        last, i = centre, centre
        while 0 <= i < n and abs(float(clean[i])) > thresh:
            last = i
            i += step
        return last

    def slope(i: int) -> float:
        return abs(float(clean[i + 1]) - float(clean[i - 1])) * 0.5

    def slope_edge(centre: int, step: int, thresh: float) -> int:
        """Slope walk with the same three-sample tolerance the port uses."""
        last, i, run = centre, centre, 0
        while 0 <= i < n:
            if slope(i) > thresh:
                last, run = i, 0
            else:
                run += 1
                if run >= 3:
                    break
            i += step
        return last

    def extreme(centre_s: float, half_s: float) -> int:
        lo = max(0, int(round((centre_s - half_s) * fs)))
        hi = min(n - 1, int(round((centre_s + half_s) * fs)))
        return lo + int(np.argmax(np.abs(clean[lo:hi + 1])))

    truth: list[dict] = []
    for r_s in np.arange(0.6, n / fs - 0.8, rr_s):
        r_idx = int(round(r_s * fs))
        q_lo = max(1, r_idx - int(round(0.08 * fs)))
        s_hi = min(n - 2, r_idx + int(round(0.08 * fs)))
        left = q_lo + int(np.argmax([slope(i) for i in range(q_lo, r_idx + 1)]))
        right = r_idx + int(np.argmax([slope(i) for i in range(r_idx, s_hi + 1)]))
        thresh = QRS_SLOPE_FRAC * max(slope(left), slope(right))

        p_idx = extreme(r_s + WAVES["p"][0], 0.04)
        t_idx = extreme(r_s + WAVES["t"][0], 0.08)
        p_amp = abs(float(clean[p_idx]))
        t_amp = abs(float(clean[t_idx]))
        truth.append({
            "r": r_idx,
            "p_on": edge(p_idx, -1, SLOW_FRAC * p_amp),
            "p_off": edge(p_idx, +1, SLOW_FRAC * p_amp),
            "qrs_on": slope_edge(left, -1, thresh),
            "qrs_off": slope_edge(right, +1, thresh),
            "t_on": edge(t_idx, -1, SLOW_FRAC * t_amp),
            "t_off": edge(t_idx, +1, SLOW_FRAC * t_amp),
            "t_peak": t_idx,
        })
    return truth


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--record", default="p00000_s00")
    ap.add_argument("--json", type=Path)
    args = ap.parse_args()

    sig, ref, fs, _ann = load(args.record)
    out: dict = {"record": args.record, "fs": fs, "from": {}}

    gold = Path(args.json).with_suffix("") if args.json else None
    if gold is not None:
        gold.parent.mkdir(parents=True, exist_ok=True)

    out["from"]["annotations"] = hrv(
        ref, fs, None if gold is None else Path(f"{gold}.ann")
    )

    # "even" is the deterministic K-means init the TypeScript port reproduces;
    # using it here makes the peak set — and therefore every RR below —
    # identical between the two implementations.
    peaks = detect(sig, fs, kmeans_init="even")
    out["from"]["detector"] = hrv(
        peaks, fs, None if gold is None else Path(f"{gold}.det")
    )
    out["n_detected"] = int(len(peaks))
    if gold is not None:
        # Raw float64 rather than .npy: sample indices are exact in float64, and
        # the TypeScript test can read them with no header parser.
        Path(f"{gold}.det_peaks.f64").write_bytes(
            peaks.astype("<f8").tobytes()
        )
        Path(f"{gold}.ann_peaks.f64").write_bytes(
            ref.astype("<f8").tobytes()
        )

    if args.json:
        args.json.write_text(json.dumps(out, indent=1), encoding="utf-8")
        print(f"wrote {args.json}")
    else:
        print(json.dumps(out, indent=1))


if __name__ == "__main__":
    main()
