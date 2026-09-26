/**
 * Speaker-embedding + liveness feature extraction.
 *
 * The pipeline is classical DSP (this is what telephony anti-spoofing has used
 * for decades), which keeps the MVP dependency-free and fully auditable:
 *
 *   pre-emphasis → framing (25 ms / 10 ms) → Hann → 512-pt FFT
 *     → 26 mel bands → log → DCT-II → 20 MFCC
 *     → per-frame stats (mean + std) → 40-dim embedding, L2-normalised
 *     → aux acoustics: F0 mean/jitter, spectral centroid, rolloff, flatness,
 *       zero-crossing rate, RMS, HNR, speech-onset latency
 *
 * The embedding answers "same speaker?". The aux acoustics answer "a live
 * human, right now, answering a challenge it has just seen?" — which is the
 * part a prerecorded or synthesised sample cannot fake.
 */
import { dct, estimateF0, fft, hannWindow, melFilterbank } from "./dsp";
import { hash, type Bytes32 } from "../zk/primitives";

export const TARGET_SAMPLE_RATE = 16_000;
export const FRAME_SIZE = 400; // 25 ms @ 16 kHz
export const FRAME_HOP = 160; // 10 ms @ 16 kHz
/** Pitch is estimated over 50 ms — see `estimateF0` for why the 25 ms frame is too short. */
const F0_WINDOW_MS = 50;
const F0_WINDOW = (F0_WINDOW_MS / 1000) * TARGET_SAMPLE_RATE; // 800 @ 16 kHz
const FFT_SIZE = 512;
const MEL_BANDS = 26;
const MFCC_COUNT = 20; // c1..c20, c0 (energy) is dropped: mic gain must not matter
export const EMBEDDING_DIM = MFCC_COUNT * 2; // mean + std per coefficient

export type AcousticFeatures = {
  /** 0..1 — how periodic/voiced the speech is. */
  voicedRatio: number;
  f0Mean: number;
  /** cycle-to-cycle pitch jitter, relative. Voiced humans: 0.01–0.04 */
  f0Jitter: number;
  /** spectral centroid in Hz */
  centroid: number;
  /** Hz where 85 % of the energy lives */
  rolloff: number;
  /** 0..1 — flatness 0 = tonal, 1 = white noise (TTS often lands in-between) */
  flatness: number;
  zcr: number;
  rms: number;
  /** harmonics-to-noise ratio in dB. Natural voice ≈ 12–25 dB */
  hnrDb: number;
  /** frames whose energy exceeds the noise floor */
  speechFrames: number;
  totalFrames: number;
  /** ms from challenge display to first speech — humans need 250–4000 ms */
  onsetMs: number;
  /** longest silent gap inside the capture (ms) */
  longestPauseMs: number;
  /** per-frame RMS, already noise-gated to 0..1 — used for syllable bursts */
  envelope: number[];
  /** duration of one envelope frame in ms */
  frameMs: number;
  /** autocorrelation peak of the whole capture (≈1 for a looped sample) */
  loopScore: number;
  /**
   * Number of contiguous energy bursts separated by real pauses. Reading a
   * 4-digit code produces several; a steady tone produces one. Computed once
   * here so both the enrolment liveness check and the in-call scorer agree.
   */
  syllableBursts: number;
  /**
   * How much the energy level moves around, 0..10_000. A live utterance is
   * articulated (high); a synthesised hum or a padded recording is flat (low).
   */
  energyMovementBps: number;
};

export type Voiceprint = {
  embedding: Float32Array;
  features: AcousticFeatures;
  /** keccak256 of the quantised embedding — the value bound into the key. */
  digest: Bytes32;
  durationMs: number;
  sampleCount: number;
  /**
   * Levels measured on the RAW signal, before gain normalisation.
   *
   * Every feature below is deliberately gain-invariant (mic gain must not change
   * a speaker's identity), which means the analysis can no longer answer "is
   * anything coming in at all?". These two fields are what the absolute checks
   * — too quiet, digital silence — are allowed to look at.
   */
  raw: { peak: number; rms: number };
};

const cache = new WeakMap<Float32Array, ReturnType<typeof buildFilters>>();
function buildFilters() {
  return {
    window: hannWindow(FRAME_SIZE),
    filters: melFilterbank(MEL_BANDS, FFT_SIZE, TARGET_SAMPLE_RATE),
  };
}

/** Main entry point: raw mono float samples (target 16 kHz) → voiceprint. */
export function analyseVoiceprint(samples: Float32Array, sampleRate = TARGET_SAMPLE_RATE): Voiceprint {
  if (samples.length < FRAME_SIZE) throw new Error("capture too short to analyse");

  const { window, filters } = cache.get(samples) ?? (() => {
    const built = buildFilters();
    cache.set(samples, built);
    return built;
  })();

  // ---- framing ----------------------------------------------------------
  const frameCount = Math.max(1, Math.floor((samples.length - FRAME_SIZE) / FRAME_HOP) + 1);
  const re = new Float32Array(FFT_SIZE);
  const im = new Float32Array(FFT_SIZE);
  const power = new Float32Array(FFT_SIZE / 2 + 1);

  const mfccFrames: Float32Array[] = [];
  const centroids: number[] = [];
  const rolloffs: number[] = [];
  const flatness: number[] = [];
  const zcrs: number[] = [];
  const rmss: number[] = [];
  const hnrs: number[] = [];
  const f0s: number[] = [];
  const f0Track: number[] = [];
  /** Per-frame harmonic-bin mask, reused so the frame loop allocates nothing. */
  const mask = new Uint8Array(FFT_SIZE / 2 + 1);

  // ---- gain normalisation -------------------------------------------------
  // MFCCs, HNR, flatness and the loop score are all ratios, but a quiet mic
  // would otherwise push the whole envelope towards the noise floor and make a
  // perfectly good speaker look like silence. Scaling to a fixed peak makes every
  // measurement gain-invariant; the raw levels are reported separately in
  // `Voiceprint.raw` for the absolute "is anything arriving?" checks.
  let rawPeak = 0;
  let rawSum = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i]);
    if (a > rawPeak) rawPeak = a;
    rawSum += samples[i] * samples[i];
  }
  const rawRms = Math.sqrt(rawSum / samples.length);
  const gain = rawPeak > 1e-6 ? 0.95 / rawPeak : 1;
  const signal =
    gain === 1 ? samples : (() => {
      const out = new Float32Array(samples.length);
      for (let i = 0; i < samples.length; i++) out[i] = samples[i] * gain;
      return out;
    })();

  // Pre-emphasis (0.97) is applied in place on a copy.
  const pre = new Float32Array(signal.length);
  pre[0] = signal[0];
  for (let i = 1; i < signal.length; i++) pre[i] = signal[i] - 0.97 * signal[i - 1];

  const noiseFloor = 0.02; // 2 % of the normalised peak

  for (let f = 0; f < frameCount; f++) {
    const offset = f * FRAME_HOP;

    // ---- spectrum -------------------------------------------------------
    for (let i = 0; i < FRAME_SIZE; i++) {
      re[i] = pre[offset + i] * window[i];
      im[i] = 0;
    }
    re.fill(0, FRAME_SIZE);
    im.fill(0, FRAME_SIZE);
    fft(re, im);

    let total = 0;
    for (let k = 0; k < power.length; k++) {
      const p = re[k] * re[k] + im[k] * im[k];
      power[k] = p;
      total += p;
    }

    // ---- log-mel → MFCC -------------------------------------------------
    const logMel = new Float32Array(MEL_BANDS);
    for (let b = 0; b < MEL_BANDS; b++) {
      const { start, weights } = filters[b];
      let acc = 0;
      for (let k = 0; k < weights.length; k++) acc += power[start + k] * weights[k];
      logMel[b] = Math.log(acc + 1e-10);
    }
    const cepstrum = dct(logMel, MFCC_COUNT + 1);
    const frame = new Float32Array(MFCC_COUNT);
    for (let c = 0; c < MFCC_COUNT; c++) frame[c] = cepstrum[c + 1];
    mfccFrames.push(frame);

    // ---- aux acoustics --------------------------------------------------
    let weighted = 0;
    let logSum = 0;
    for (let k = 1; k < power.length; k++) {
      const hz = (k * sampleRate) / FFT_SIZE;
      weighted += hz * power[k];
      logSum += Math.log(power[k] + 1e-12);
    }
    centroids.push(total > 0 ? weighted / total : 0);
    flatness.push(total > 0 ? Math.exp(logSum / (power.length - 1)) / (total / (power.length - 1)) : 0);

    let acc85 = 0;
    let roll = 0;
    for (let k = 1; k < power.length; k++) {
      acc85 += power[k];
      if (acc85 >= 0.85 * total) {
        roll = (k * sampleRate) / FFT_SIZE;
        break;
      }
    }
    rolloffs.push(roll);

    let zc = 0;
    let energy = 0;
    for (let i = 0; i < FRAME_SIZE; i++) {
      energy += signal[offset + i] * signal[offset + i];
      if (i > 0 && (signal[offset + i] >= 0) !== (signal[offset + i - 1] >= 0)) zc++;
    }
    zcrs.push(zc / FRAME_SIZE);
    rmss.push(Math.sqrt(energy / FRAME_SIZE));

    // Pitch on a 50 ms window centred on this frame, not the 25 ms MFCC frame:
    // two pitch periods of correlation is far too little to be reliable.
    const half = (F0_WINDOW_MS / 2 / 1000) * sampleRate;
    const f0Start = Math.max(0, Math.min(offset - half, signal.length - F0_WINDOW));
    const f0Window = signal.subarray(f0Start, f0Start + F0_WINDOW);
    const f0 =
      rmss[rmss.length - 1] > noiseFloor && f0Window.length >= F0_WINDOW
        ? estimateF0(f0Window, sampleRate)
        : 0;
    f0s.push(f0);
    f0Track.push(f0);

    // ---- HNR: energy at the ACTUAL harmonics vs. the rest ---------------
    // This has to be pitch-synchronous. Summing "every 6th bin" — the earlier
    // approach — silently assumed a fixed ~187 Hz pitch, so every real voice
    // measured a *negative* harmonics-to-noise ratio (−2 dB on clean speech)
    // and the number carried no information. Here the harmonic grid is derived
    // from this frame's own F0.
    if (f0 > 0) {
      const binHz = sampleRate / FFT_SIZE;
      const bins = power.length - 1;
      const maxHarmonic = Math.min(Math.floor((bins * binHz) / f0), 40);
      mask.fill(0);
      for (let k = 1; k <= maxHarmonic; k++) {
        const centre = (k * f0) / binHz;
        // ±1 bin: the main lobe of a Hann-windowed 512-point FFT spans ~3 bins,
        // so ±1 captures the peak without swallowing the inter-harmonic gap.
        const lo = Math.max(1, Math.round(centre) - 1);
        const hi = Math.min(bins, Math.round(centre) + 1);
        for (let b = lo; b <= hi; b++) mask[b] = 1;
      }
      let harmonic = 0;
      let noise = 0;
      for (let b = 1; b <= bins; b++) {
        if (mask[b]) harmonic += power[b];
        else noise += power[b];
      }
      hnrs.push(10 * Math.log10((harmonic + 1e-12) / (noise + 1e-12)));
    }
  }

  // ---- embedding: per-coefficient mean + std ----------------------------
  const embedding = new Float32Array(EMBEDDING_DIM);
  for (let c = 0; c < MFCC_COUNT; c++) {
    let mean = 0;
    for (const f of mfccFrames) mean += f[c];
    mean /= mfccFrames.length;
    let variance = 0;
    for (const f of mfccFrames) variance += (f[c] - mean) ** 2;
    variance /= mfccFrames.length;
    embedding[c] = mean;
    embedding[MFCC_COUNT + c] = Math.sqrt(variance);
  }
  l2Normalise(embedding);

  // ---- timeline stats ---------------------------------------------------
  const speech = rmss.map((r) => r > noiseFloor);
  const speechFrames = speech.filter(Boolean).length;
  const firstSpeech = speech.indexOf(true);
  const frameMs = (FRAME_HOP / sampleRate) * 1000;

  // Envelope, noise-gated and peak-normalised so burst detection is gain-free.
  const peakRms = Math.max(...rmss, 1e-9);
  const envelope = rmss.map((r) => Math.max(0, (r - noiseFloor) / (peakRms - noiseFloor || 1)));

  let longestPauseMs = 0;
  let run = 0;
  for (const isSpeech of speech) {
    if (isSpeech) {
      longestPauseMs = Math.max(longestPauseMs, run * frameMs);
      run = 0;
    } else {
      run++;
    }
  }
  longestPauseMs = Math.max(longestPauseMs, run * frameMs);

  const voiced = f0s.filter((f) => f > 0);
  const f0Mean = voiced.length ? voiced.reduce((a, b) => a + b, 0) / voiced.length : 0;
  let jitterSum = 0;
  let jitterCount = 0;
  for (let i = 1; i < f0Track.length; i++) {
    if (f0Track[i] > 0 && f0Track[i - 1] > 0) {
      jitterSum += Math.abs(f0Track[i] - f0Track[i - 1]) / f0Track[i - 1];
      jitterCount++;
    }
  }

  const features: AcousticFeatures = {
    voicedRatio: f0s.length ? voiced.length / f0s.length : 0,
    f0Mean,
    f0Jitter: jitterCount ? jitterSum / jitterCount : 1,
    centroid: mean(centroids),
    rolloff: mean(rolloffs),
    flatness: mean(flatness),
    zcr: mean(zcrs),
    rms: Math.sqrt(rmss.reduce((a, b) => a + b * b, 0) / rmss.length),
    hnrDb: mean(hnrs),
    speechFrames,
    totalFrames: mfccFrames.length,
    onsetMs: firstSpeech === -1 ? Number.POSITIVE_INFINITY : firstSpeech * frameMs,
    longestPauseMs,
    envelope,
    frameMs,
    loopScore: detectLoop(signal, sampleRate),
    syllableBursts: countSyllableBursts(envelope, frameMs),
    energyMovementBps: energyMovementBps(envelope),
  };

  return {
    embedding,
    features,
    digest: hashTemplate(embedding),
    durationMs: (samples.length / sampleRate) * 1000,
    sampleCount: samples.length,
    raw: { peak: rawPeak, rms: rawRms },
  };
}

/**
 * Counts contiguous energy bursts separated by real pauses (≈ syllables).
 * Reading a 4-digit code gives several; a steady synthesised tone gives one.
 */
export function countSyllableBursts(envelope: number[], frameMs: number, gate = 0.28): number {
  const minGapFrames = Math.max(1, Math.round(80 / frameMs));
  let bursts = 0;
  let inBurst = false;
  let silence = 0;
  for (const v of envelope) {
    if (v > gate) {
      if (!inBurst) {
        bursts++;
        inBurst = true;
      }
      silence = 0;
    } else if (inBurst) {
      silence++;
      if (silence >= minGapFrames) inBurst = false;
    }
  }
  return bursts;
}

/**
 * How much the level moves, 0..10_000. Derived from the spread of the envelope
 * rather than its variance, so it is robust to a single loud onset.
 */
export function energyMovementBps(envelope: number[]): number {
  if (envelope.length === 0) return 0;
  const active = envelope.filter((v) => v > 0.1);
  if (active.length === 0) return 0;
  const sorted = [...active].sort((a, b) => a - b);
  const p10 = sorted[Math.floor(sorted.length * 0.1)];
  const p90 = sorted[Math.floor(sorted.length * 0.9)];
  // A live utterance spans most of the available dynamic range; a hum does not.
  return Math.round(Math.max(0, Math.min(1, (p90 - p10) / 0.7)) * 10_000);
}

/** keccak256 over the int16-quantised embedding (lossy but stable). */
export function hashTemplate(embedding: Float32Array): Bytes32 {
  const quantised = new Int16Array(embedding.length);
  for (let i = 0; i < embedding.length; i++) {
    quantised[i] = Math.max(-32768, Math.min(32767, Math.round(embedding[i] * 32767)));
  }
  return hash(new Uint8Array(quantised.buffer));
}

/** Cosine similarity in [-1, 1] (both embeddings are already L2-normalised). */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) throw new Error("embedding dimension mismatch");
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

export function l2Normalise(v: Float32Array): Float32Array {
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < v.length; i++) v[i] /= norm;
  return v;
}

/**
 * Whole-capture autocorrelation peak over *long* lags, via FFT.
 *
 * A genuine microphone capture of a live voice never repeats itself, so no long
 * lag correlates strongly with the signal. A *looped* recording (the cheapest
 * deepfake of all: cut-and-paste, or a device playing a loop) lines up perfectly
 * with itself at the loop period, which is what this catches.
 *
 * Why FFT: the loop period is unknown and can be anywhere from ~0.3 s to several
 * seconds. A direct search over that range is O(n·maxLag) — hundreds of millions
 * of multiply-adds in JS. Autocorrelation via `IFFT(|FFT(x)|²)` is O(n log n) and
 * exact, and `fft()` is already here for the MFCC front-end.
 *
 * Short lags are deliberately *excluded*: below ~250 ms, ordinary speech
 * correlates strongly with itself through its pitch period and formants, so
 * including them would flag every human.
 */
export function detectLoop(
  samples: Float32Array,
  sampleRate = TARGET_SAMPLE_RATE,
  { minLagMs = 250, maxLagMs = 3_000 } = {},
): number {
  const n = Math.min(samples.length, 48_000);
  const minLag = Math.max(1, Math.floor((minLagMs / 1000) * sampleRate));
  const maxLag = Math.min(n - 1, Math.floor((maxLagMs / 1000) * sampleRate));
  if (n <= minLag * 2) return 0;

  // mean-remove so the autocorrelation is not dominated by DC
  let mean = 0;
  for (let i = 0; i < n; i++) mean += samples[i];
  mean /= n;

  // next power of two >= 2n so the linear correlation is not circular
  let size = 1;
  while (size < 2 * n) size <<= 1;
  if (size > 1 << 17) return 0; // ~4.3 s @48 kHz is plenty; bail beyond

  const re = new Float64Array(size);
  const im = new Float64Array(size);
  for (let i = 0; i < n; i++) re[i] = samples[i] - mean;

  fft64(re, im);

  // power spectrum
  for (let i = 0; i < size; i++) {
    const p = re[i] * re[i] + im[i] * im[i];
    re[i] = p;
    im[i] = 0;
  }

  // inverse FFT (our fft() is forward-only, so conjugate the input trick:
  // conj → forward → conj → scale)
  for (let i = 0; i < size; i++) im[i] = -im[i];
  fft64(re, im);
  for (let i = 0; i < size; i++) {
    re[i] /= size;
    im[i] = -im[i] / size;
  }

  const zeroLag = re[0];
  if (!(zeroLag > 0)) return 0;

  // Normalise by the *overlapping* energy rather than the total, i.e. a proper
  // normalised cross-correlation. Using the total energy would divide a long
  // loop by the length of the window that fits, so a perfect 1.7 s loop inside a
  // 3 s capture would only score ~0.45.
  //
  //   corr(lag) = Σ_{i<n-lag} x[i]·x[i+lag]
  //   eA(lag)   = Σ_{i<n-lag} x[i]²       = pre[n-lag]
  //   eB(lag)   = Σ_{i<n-lag} x[i+lag]²   = pre[n] - pre[lag]
  const pre = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    const v = samples[i] - mean;
    pre[i + 1] = pre[i] + v * v;
  }

  let best = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const len = n - lag;
    if (len < minLag) break;
    const eA = pre[len];
    const eB = pre[n] - pre[lag];
    const denom = Math.sqrt(eA * eB);
    if (denom <= 0) continue;
    const norm = re[lag] / denom;
    if (norm > best) best = norm;
  }
  return Math.min(1, best);
}

/** Float64 variant of the radix-2 FFT, used by the autocorrelation. */
function fft64(re: Float64Array, im: Float64Array): void {
  const n = re.length;
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

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
