/**
 * ────────────────────────────────────────────────────────────────────────────
 *  ATTACK SIMULATION HARNESS  ·  `lib/zk/spoof.ts`
 * ────────────────────────────────────────────────────────────────────────────
 *
 * A security product that can only show green is a security product nobody
 * believes. This module produces the *attacking audio* the detector then has to
 * catch. Everything is synthesised in the browser — no third-party TTS, no
 * network call, and crucially **the detector is not modified or bypassed in any
 * way**: the spoofed capture is fed through exactly the same
 * `analyseVoiceprint` → `scoreLiveness` → `proveLiveness` pipeline as a real
 * capture.
 *
 * Three attack classes, each targeting a different layer:
 *
 *   `replay`      Bit-identical re-submission of an earlier capture.
 *                 → caught by the digest ledger + the self-correlation loop
 *                   detector.
 *
 *   `synthetic`   A vocoder/TTS voice: machine-constant F0, no jitter, a rigid
 *                 harmonic stack with a flat spectral tilt.
 *                 → caught by the pitch-jitter check.
 *
 *   `impostor`    A different, natural-sounding human voice (other register,
 *                 other formants, perfectly plausible jitter).
 *                 → defeats every acoustic check and is caught by the embedding
 *                   similarity / template-drift flag.
 *
 * The generator is a small **source–filter** model: a glottal pulse train
 * (source) shaped by three formant resonators (filter), gated by an irregular
 * syllable rhythm with closures between syllables. That irregularity matters:
 * a stationary sum of sinusoids self-correlates at long lags and would trip the
 * loop detector for the wrong reason, so the "honest" baseline would not be
 * honest. Real speech does not self-correlate, and neither should this.
 *
 * `keyEavesdrop` is not simulated: stealing the device secret is a wallet-level
 * compromise, out of scope for a client-side demo.
 */
import { TARGET_SAMPLE_RATE } from "../audio/features";
import { randomBytes, bytesToBigInt } from "./primitives";

export type SpoofKind = "none" | "replay" | "synthetic" | "impostor";

export const SPOOF_LABELS: Record<SpoofKind, { label: string; blurb: string }> = {
  none: { label: "Gerçek insan", blurb: "Cihazdan gerçek konuşma" },
  replay: { label: "Replay (daha önce kaydedilmiş)", blurb: "Birebir aynı PCM tekrar gönderiliyor" },
  synthetic: { label: "Derinfake (TTS / vocoder)", blurb: "Sentetik, titremesiz pitch'li ses" },
  impostor: { label: "Sahte ses (başka kişi)", blurb: "Doğal ama farklı bir konuşmacı" },
};

/** Deterministic PRNG so a given seed always yields the same waveform. */
function prng(seed: Uint8Array) {
  let s = bytesToBigInt(seed) | 1n;
  return () => {
    s ^= s >> 12n;
    s = (s ^ (s << 25n)) & 0xffffffffffffffffn;
    s ^= s >> 27n;
    return Number(((s * 0x2545f4914f6cdd1dn) & 0xffffffffffffffffn) >> 11n) / 2 ** 53;
  };
}

/** A voice: register, vocal-tract shape, and how machine-like the pitch is. */
type VoiceProfile = {
  /** fundamental frequency in Hz */
  f0: number;
  /** formant centres in Hz */
  formants: Array<{ f: number; bw: number; gain: number }>;
  /**
   * Harmonic amplitude falls off as 1/k^decay.
   * 1.0 ≈ natural source; ~0.35 ≈ the unnaturally flat tilt of a vocoder.
   */
  harmonicDecay: number;
  /**
   * Cycle-to-cycle pitch wander as a fraction of f0. Real adult speech
   * measures ≈1–3 % jitter on 10 ms frames; a vocoder measures ≈0. The value
   * here is pre-smoothing, and `f0State`'s one-pole filter scales the *measured*
   * jitter down by roughly 8×, so 0.18 lands the measurement inside the human
   * band declared in `LIVENESS_THRESHOLDS.jitterHuman`.
   */
  jitterScale: number;
  /** slow drift across the utterance */
  driftScale: number;
  /**
   * Vocal-tract length scale applied to the formant centres. Voices genuinely
   * differ here — a longer tract (~15–20 %) is the physical reason one speaker
   * is distinguishable from another at all, and it is what moves the MFCC
   * embedding. Without it two "different" speakers sound nearly identical.
   */
  formantScale: number;
};

type SpeakOptions = {
  seconds?: number;
  /** drives the utterance (phrasing, jitter realisation, noise) */
  seed: Uint8Array;
  /**
   * Silence before the first syllable. A live human always has some, because
   * they have to notice the prompt. An attacker firing a pre-rolled answer the
   * instant record opens has none — this is what the response-latency check
   * measures, so the harness needs to be able to produce both.
   */
  leadInMs?: number;
};

/** Irregular syllable rhythm with closures — the thing that kills long-lag
 *  self-correlation, because the spectral trajectory keeps changing. */
function syllableSchedule(rnd: () => number, seconds: number, leadInMs: number) {
  const out: Array<{ start: number; dur: number }> = [];
  let t = leadInMs / 1000;
  while (t < seconds) {
    const dur = 0.12 + rnd() * 0.16;
    out.push({ start: t, dur });
    t += dur + 0.03 + rnd() * 0.07; // closure between syllables
  }
  return out;
}

/** Renders a source–filter utterance for the given voice. */
function speak(voice: VoiceProfile, { seconds = 3.4, seed, leadInMs }: SpeakOptions): Float32Array {
  const rnd = prng(seed);
  const n = Math.floor(seconds * TARGET_SAMPLE_RATE);
  const out = new Float32Array(n);
  const rate = TARGET_SAMPLE_RATE;
  const schedule = syllableSchedule(
    rnd,
    seconds,
    leadInMs ?? 150 + rnd() * 200,
  );

  const maxHarm = Math.min(48, Math.floor((rate * 0.45) / voice.f0));
  const weights = new Float32Array(maxHarm);
  const sinCache = new Float32Array(maxHarm);

  let phase = 0;
  let f0State = voice.f0;
  let drift = (rnd() - 0.5) * voice.driftScale;
  let syllableIndex = -1;
  let syllF0 = voice.f0;
  let syllGain = 0;
  let syllFormants = voice.formants;
  let syllTone = 1;

  for (let i = 0; i < n; i++) {
    const t = i / rate;

    // advance the syllable cursor
    while (syllableIndex + 1 < schedule.length && t >= schedule[syllableIndex + 1].start) {
      syllableIndex++;
      const s = schedule[syllableIndex];
      // a per-syllable pitch target and a fresh vowel: real speech never holds
      // one steady timbre for the whole sentence
      syllF0 = voice.f0 * (1 + (rnd() - 0.5) * 0.14);
      syllTone = 0.86 + rnd() * 0.3;
      syllFormants = voice.formants.map((fo) => ({
        f: fo.f * voice.formantScale * (0.9 + rnd() * 0.2),
        bw: fo.bw * (0.85 + rnd() * 0.35),
        gain: fo.gain,
      }));
      void s;
    }

    // raised-cosine envelope over the syllable, silence in the closure
    let env = 0;
    if (syllableIndex >= 0) {
      const s = schedule[syllableIndex];
      const local = (t - s.start) / s.dur;
      env = local >= 0 && local <= 1 ? 0.5 - 0.5 * Math.cos(2 * Math.PI * local) : 0;
    }
    syllGain += (env - syllGain) * 0.35; // glottal-ish smoothing

    if (syllGain > 0.02) {
      // --- pitch contour: slow drift + correlated one-pole jitter ----------
      drift += (rnd() - 0.5) * 0.0008;
      drift *= 0.9995;
      const jitterState = (rnd() - 0.5) * voice.jitterScale;
      const target = syllF0 * (1 + drift) * (1 + jitterState);
      f0State += (target - f0State) * 0.12; // glottal inertia

      phase += (2 * Math.PI * f0State) / rate;

      // --- source: harmonic stack weighted by the formant resonances -----
      for (let k = 1; k <= maxHarm; k++) {
        const hz = k * f0State;
        let amp = 1 / k ** voice.harmonicDecay;
        for (const fo of syllFormants) {
          const d = (hz - fo.f) / fo.bw;
          amp += fo.gain / (1 + d * d);
        }
        weights[k - 1] = amp * syllTone;
        sinCache[k - 1] = Math.sin(phase * k);
      }
      let pulse = 0;
      for (let k = 0; k < maxHarm; k++) pulse += weights[k] * sinCache[k];

      out[i] = (pulse / maxHarm) * syllGain * 2.2;
    }

    // breath / fricative noise, always present at a low level
    out[i] += (rnd() - 0.5) * 0.01;
  }

  return out;
}

/**
 * Builds the attack waveform.
 *
 * @param kind
 * @param baselineF0  the enrolled speaker's F0, so `impostor` reads as a
 *                    *different* voice rather than a random one
 * @param seed        varies the **utterance**: phrasing, jitter realisation,
 *                    breath noise.
 * @param voiceSeed   fixes the **voice**: register, formants. Defaults to
 *                    `seed`. Holding `voiceSeed` constant while varying `seed`
 *                    gives "the same human saying something else"; changing it
 *                    gives "a different human". This split is what lets the
 *                    harness model both the honest case and the impostor case.
 */
export function synthesiseSpoof(params: {
  kind: Exclude<SpoofKind, "none" | "replay">;
  baselineF0?: number;
  seconds?: number;
  seed?: Uint8Array;
  voiceSeed?: Uint8Array;
  /** silence before the first syllable; omit for a human-like lead-in */
  leadInMs?: number;
}): Float32Array {
  const { kind, baselineF0 = 120, seconds = 3.4 } = params;
  const seed = params.seed ?? randomBytes(32);
  const voiceRnd = prng(params.voiceSeed ?? seed);
  const leadInMs = params.leadInMs;

  if (kind === "synthetic") {
    // A TTS/vocoder voice: one fixed pitch, a flat spectral tilt, no jitter.
    return speak(
      {
        f0: 118,
        formants: [
          { f: 600, bw: 90, gain: 0.7 },
          { f: 1200, bw: 110, gain: 0.4 },
          { f: 2500, bw: 160, gain: 0.2 },
        ],
        harmonicDecay: 0.35,
        jitterScale: 0,
        driftScale: 0,
        formantScale: 1,
      },
      { seconds, seed, leadInMs },
    );
  }

  // A plausible human, in a register clearly different from the baseline. The
  // formant scale is tied to the register the way a real vocal tract is: a
  // higher voice is physically a shorter tract.
  const register = voiceRnd() > 0.5 ? 1.62 : 0.66;
  const f0 = baselineF0 * register;
  return speak(
    {
      f0,
      formants: [
        { f: 620, bw: 70, gain: 1.0 },
        { f: 1180, bw: 100, gain: 0.6 },
        { f: 2600, bw: 150, gain: 0.32 },
      ],
      harmonicDecay: 1.0,
      jitterScale: 0.18,
      driftScale: 0.03,
      formantScale: (0.9 + voiceRnd() * 0.2) * register ** 0.6,
    },
    { seconds, seed, leadInMs },
  );
}

/** Normalises to a plausible input level so the scorer's gain gate is fair. */
export function normalise(samples: Float32Array, peak = 0.24): Float32Array {
  let max = 0;
  for (const v of samples) max = Math.max(max, Math.abs(v));
  if (max === 0) return samples;
  const g = peak / max;
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = samples[i] * g;
  return out;
}
