/**
 * Minimal DSP kit: FFT, mel filterbank, DCT.
 *
 * Deliberately dependency-free and synchronous — the whole thing runs on ~2 s
 * of 16 kHz mono audio in a couple of milliseconds on a laptop, so there is no
 * excuse for sending the audio anywhere to be "analysed".
 */

/** In-place iterative radix-2 Cooley–Tukey FFT. */
export function fft(re: Float32Array, im: Float32Array): void {
  const n = re.length;
  if (n <= 1) return;
  if ((n & (n - 1)) !== 0) throw new Error("FFT length must be a power of two");

  // bit-reversal permutation
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      for (let k = 0; k < len / 2; k++) {
        const uRe = re[i + k];
        const uIm = im[i + k];
        const vRe = re[i + k + len / 2] * curRe - im[i + k + len / 2] * curIm;
        const vIm = re[i + k + len / 2] * curIm + im[i + k + len / 2] * curRe;
        re[i + k] = uRe + vRe;
        im[i + k] = uIm + vIm;
        re[i + k + len / 2] = uRe - vRe;
        im[i + k + len / 2] = uIm - vIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }
}

export function hannWindow(size: number): Float32Array {
  const w = new Float32Array(size);
  for (let i = 0; i < size; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1));
  return w;
}

export const hzToMel = (hz: number) => 2595 * Math.log10(1 + hz / 700);
export const melToHz = (mel: number) => 700 * (10 ** (mel / 2595) - 1);

/**
 * Triangular mel filterbank as a sparse matrix.
 * @returns per-band weight rows: [startBin, endBin, weights[]]
 */
export function melFilterbank(
  bands: number,
  fftSize: number,
  sampleRate: number,
  lowHz = 80,
  highHz = Math.min(7600, sampleRate / 2 - 100),
): Array<{ start: number; weights: Float32Array }> {
  const bins = fftSize / 2 + 1;
  const lowMel = hzToMel(lowHz);
  const highMel = hzToMel(highHz);
  const points = Array.from({ length: bands + 2 }, (_, i) =>
    Math.floor(((fftSize + 1) * melToHz(lowMel + ((highMel - lowMel) * i) / (bands + 1))) / sampleRate),
  );

  const out: Array<{ start: number; weights: Float32Array }> = [];
  for (let b = 0; b < bands; b++) {
    const [lo, mid, hi] = [points[b], points[b + 1], points[b + 2]];
    const start = Math.max(0, lo);
    const end = Math.min(bins - 1, hi);
    const weights = new Float32Array(Math.max(0, end - start + 1));
    for (let k = start; k <= end; k++) {
      let w = 0;
      if (k >= lo && k <= mid && mid > lo) w = (k - lo) / (mid - lo);
      else if (k > mid && k <= hi && hi > mid) w = (hi - k) / (hi - mid);
      weights[k - start] = w;
    }
    out.push({ start, weights });
  }
  return out;
}

/** Type-II DCT-II, used to turn log-mel energies into cepstral coefficients. */
export function dct(input: Float32Array, outCount: number): Float32Array {
  const n = input.length;
  const out = new Float32Array(outCount);
  for (let k = 0; k < outCount; k++) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += input[i] * Math.cos((Math.PI * k * (i + 0.5)) / n);
    out[k] = sum * Math.sqrt(2 / n);
  }
  return out;
}

/**
 * Fundamental-frequency estimate by normalised autocorrelation.
 *
 * Two things matter for robustness and both were wrong in the first version:
 *
 *   · **Window length.** The MFCC frame is 25 ms, which at 16 kHz is 400 samples
 *     — barely two pitch periods for a 120 Hz voice. Correlation over the
 *     residual is then so noisy that the peak test fails and `f0` collapses to
 *     0, which surfaces as "no reliable pitch detected" on perfectly good
 *     speech. `F0_WINDOW_MS` (50 ms) is used instead, centred on each frame.
 *   · **Range and peak threshold.** Adult speech spans roughly 70–400 Hz. The
 *     original 70–350 Hz window plus a 0.3 correlation gate rejected quieter and
 *     lower voices outright.
 *   · **Octave-down errors.** A periodic signal correlates just as well at twice
 *     its period, so the global autocorrelation peak is often the sub-harmonic
 *     and a 140 Hz voice reads as 70 Hz. The fix is to walk up from the shortest
 *     lag and take the first lag that is essentially as good as the best.
 *
 * @param frame   samples to analyse (any length; longer is more reliable)
 * @param sampleRate
 * @param opts.minHz lowest pitch to consider (upper bound = Nyquist-derived)
 * @param opts.maxHz highest pitch to consider
 * @param opts.minCorrelation peak-correlation required to report a pitch at all
 * @param opts.octaveTolerance how close to the best peak counts as "the same
 *   peak" when searching for the true (shortest) period
 */
export function estimateF0(
  frame: Float32Array,
  sampleRate: number,
  opts: { minHz?: number; maxHz?: number; minCorrelation?: number; octaveTolerance?: number } = {},
): number {
  const { minHz = 70, maxHz = 400, minCorrelation = 0.25, octaveTolerance = 0.9 } = opts;
  const minLag = Math.max(2, Math.floor(sampleRate / maxHz));
  const maxLag = Math.min(Math.floor(sampleRate / minHz), frame.length - 32);
  if (frame.length <= minLag * 2 || maxLag <= minLag) return 0;

  let mean = 0;
  for (let i = 0; i < frame.length; i++) mean += frame[i];
  mean /= frame.length;

  const corr = new Float32Array(maxLag + 1);
  for (let lag = minLag; lag <= maxLag; lag++) {
    let num = 0;
    let e1 = 0;
    let e2 = 0;
    for (let i = 0; i + lag < frame.length; i++) {
      const a = frame[i] - mean;
      const b = frame[i + lag] - mean;
      num += a * b;
      e1 += a * a;
      e2 += b * b;
    }
    corr[lag] = num / (Math.sqrt(e1 * e2) + 1e-12);
  }

  let bestLag = minLag;
  for (let lag = minLag + 1; lag <= maxLag; lag++) {
    if (corr[lag] > corr[bestLag]) bestLag = lag;
  }
  const bestValue = corr[bestLag];
  if (bestValue < minCorrelation) return 0;

  // ── octave-down correction ────────────────────────────────────────────────
  // A periodic signal correlates just as well at 2× its period, so the global
  // maximum is often the sub-harmonic: a 140 Hz voice reads as 70 Hz. Walk up
  // from the shortest lag and take the FIRST one that is essentially as good as
  // the best — that is the true period.
  let chosen = bestLag;
  for (let lag = minLag; lag < bestLag; lag++) {
    if (corr[lag] >= bestValue * octaveTolerance) {
      chosen = lag;
      break;
    }
  }

  // Parabolic interpolation around the chosen peak for sub-sample resolution.
  const y0 = chosen > minLag ? corr[chosen - 1] : 0;
  const y1 = corr[chosen];
  const y2 = chosen < maxLag ? corr[chosen + 1] : 0;
  const denom = y0 - 2 * y1 + y2;
  const shift = denom !== 0 ? (0.5 * (y0 - y2)) / denom : 0;
  const lag = chosen + Math.max(-1, Math.min(1, shift));
  return sampleRate / lag;
}
