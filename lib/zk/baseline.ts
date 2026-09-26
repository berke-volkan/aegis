/**
 * ────────────────────────────────────────────────────────────────────────────
 *  AEGIS ENROLLMENT  ·  `lib/zk/baseline.ts`
 * ────────────────────────────────────────────────────────────────────────────
 *
 * STEP 1 of the flow: turn a short microphone sample into an on-chain
 * commitment that is *cryptographically bound* to the speaker's voice.
 *
 *   mic ──► 3 s of 16 kHz audio
 *        ──► MFCC embedding ──► templateDigest = keccak(quantised embedding)
 *        ──► sign-to-contract: C = P + t·G,  t = H(domain, digest, P)
 *        ──► C is written to AegisCallZK.registerBaseline(user, C)
 *
 * The raw audio and the embedding stay on the device. Only `C` and
 * `templateDigest` are ever published, and `templateDigest` is not invertible.
 *
 * What the sample is asked to contain (and why):
 *   · a spoken phrase  → the MFCC embedding needs voiced, varied phonetics
 *   · ~2.5 s minimum   → ~250 analysis frames, enough for stable statistics
 *   · a little noise is fine and expected — the scorer is gain- and
 *     noise-floor normalised, so the *same* mic/room produces stable features.
 */
import { analyseVoiceprint } from "../audio/features";
import { deriveBiometricKey, type BiometricKey } from "./biometricKey";
import { evaluateEnrollmentLiveness, type EnrollmentLiveness } from "./enrollmentLiveness";
import { pcmDigest, type Bytes32 } from "./primitives";

export const BASELINE_MIN_MS = 2_200;
export const BASELINE_TARGET_MS = 3_200;

/**
 * Enrollment gate thresholds.
 *
 * These are deliberately *low* and expressed as fractions of full scale, because
 * the first version rejected good speech: it compared `f0Mean` and `rms` against
 * fixed absolutes while the browser was also applying noise suppression and
 * automatic gain control, which is a combination that makes almost any real
 * microphone look broken.
 *
 * Refusing enrollment is expensive — the user has to redo a 3-second capture, and
 * a false rejection looks like a broken product. `zeros` are treated as evidence
 * of a problem; everything else is left to the similarity threshold, which is
 * where a bad sample is actually supposed to be caught.
 */
export const MIN_PEAK = 0.01; // 1 % of full scale
export const MIN_RMS = 0.003; // 0.3 % of full scale
export const MIN_SPEECH_RATIO = 0.1; // 10 % of frames carry speech
export const MIN_VOICED_RATIO = 0.03; // 3 % of frames are voiced

export const BASELINE_PHRASES = [
  "Aegis, biyometrik temelimi şimdi kaydediyorum.",
  "Bu benim sesim, doğrulama için gerekli temel kayıt.",
  "Canlı arama doğrulaması, temel ses profili.",
  "Kayıt işlemini tamamlıyorum, sesim doğru.",
] as const;

export type BaselineResult = {
  key: BiometricKey;
  /** the value to send to `registerBaseline(user, commitment)` */
  commitment: Bytes32;
  templateDigest: Bytes32;
  /** keccak256 of the captured PCM — the replay ledger's first entry */
  audioDigest: Bytes32;
  durationMs: number;
  embedding: Float32Array;
  /** features of the enrollment sample, shown in the UI as a "voiceprint card" */
  preview: {
    f0Mean: number;
    hnrDb: number;
    centroid: number;
    flatness: number;
    voicedRatio: number;
    speechFrames: number;
    totalFrames: number;
    /** raw level as a share of full scale, before gain normalisation */
    rawPeak: number;
    rawRms: number;
  };
  /** enrolment-time liveness result — always computed, shown in the UI */
  liveness: EnrollmentLiveness;
  transcript: Array<[string, string]>;
  ok: boolean;
  /** why enrollment would be rejected, if `ok === false` */
  problems: string[];
};

/**
 * Turns a captured baseline sample into a registrable commitment.
 * @param samples  mono float samples @16 kHz
 */
export function createBaselineProof(samples: Float32Array, sampleRate: number): BaselineResult {
  const voiceprint = analyseVoiceprint(samples, sampleRate);
  const f = voiceprint.features;
  const { peak, rms } = voiceprint.raw;

  // ---- sanity gate --------------------------------------------------------
  // Every check is expressed against the RAW signal level (so a quiet-but-valid
  // microphone is not mistaken for silence) or against ratios the capture
  // computes about itself (so gain cannot be the deciding factor). The measured
  // values are quoted in the message: "loud enough" is not actionable, "peak 3 %
  // of full scale" is.
  const problems: string[] = [];
  const speechRatio = f.totalFrames ? f.speechFrames / f.totalFrames : 0;
  const voicedRatio = f.voicedRatio;

  if (voiceprint.durationMs < BASELINE_MIN_MS) {
    problems.push(
      `Kayıt çok kısa: ${(voiceprint.durationMs / 1000).toFixed(1)} sn (en az ${(BASELINE_MIN_MS / 1000).toFixed(1)} sn). Kayıt tamamlanmadan bitmiş olabilir.`,
    );
  }
  if (peak < MIN_PEAK) {
    problems.push(
      `Mikrofon neredeyse hiç ses almıyor (tepe ${(peak * 100).toFixed(2)}%, gereken >${(MIN_PEAK * 100).toFixed(0)}%). Mikrofona yaklaşın ya da mikrofon girişini kontrol edin.`,
    );
  }
  if (rms < MIN_RMS) {
    problems.push(
      `Ortalama ses seviyesi çok düşük (RMS ${(rms * 100).toFixed(2)}%, gereken >${(MIN_RMS * 100).toFixed(0)}%). Daha yüksek sesle, mikrofona yakın konuşun.`,
    );
  }
  if (speechRatio < MIN_SPEECH_RATIO) {
    problems.push(
      `Konuşma algılanmadı: karelerin yalnızca %${(speechRatio * 100).toFixed(0)}'inde ses var (gereken %${(MIN_SPEECH_RATIO * 100).toFixed(0)}). Kayıt sırasında konuşmayı unutmayın.`,
    );
  }
  if (voicedRatio < MIN_VOICED_RATIO) {
    problems.push(
      `Ton yüksekliği (pitch) takip edilemedi: karelerin %${(voicedRatio * 100).toFixed(0)}'inde tonal ses var (gereken %${(MIN_VOICED_RATIO * 100).toFixed(0)}).`,
    );
  }

  // ---- enrolment-time liveness -------------------------------------------
  // A baseline that is a deepfake, a TTS sample or a loop poisons every later
  // call, so step 1 gets the same acoustic scrutiny — minus the challenge-based
  // checks, which have nothing to bite on yet.
  const liveness = evaluateEnrollmentLiveness(voiceprint);
  if (!liveness.passes) {
    problems.push(
      `Canlılık kontrolü geçmedi: ${liveness.problems.join(" ")} ` +
        `Ölçümler — liveness ${liveness.livenessBps}, presence ${liveness.presenceBps}, naturalness ${liveness.naturalnessBps}, F0 ${liveness.detail.f0Mean} Hz, titreme %${liveness.detail.f0JitterPct}, hece ${liveness.detail.syllableBursts}.`,
    );
  }

  const audioDigest = pcmDigest(samples);

  if (problems.length > 0) {
    return {
      key: null as unknown as BiometricKey,
      commitment: "0x" + "00".repeat(32) as Bytes32,
      templateDigest: voiceprint.digest,
      audioDigest,
      durationMs: voiceprint.durationMs,
      embedding: voiceprint.embedding,
      preview: previewOf(f, voiceprint.raw),
      liveness,
      transcript: [],
      ok: false,
      problems,
    };
  }

  const key = deriveBiometricKey(voiceprint.digest);

  return {
    key,
    commitment: key.commitment,
    templateDigest: voiceprint.digest,
    audioDigest,
    durationMs: voiceprint.durationMs,
    embedding: voiceprint.embedding,
    preview: previewOf(f, voiceprint.raw),
    liveness,
    ok: true,
    problems: [],
    transcript: [
      ["captured audio", `${(voiceprint.durationMs / 1000).toFixed(2)}s @ 16 kHz · stays on device`],
      ["raw level", `peak ${(peak * 100).toFixed(1)}% · rms ${(rms * 100).toFixed(1)}%`],
      [
        "liveness",
        `${liveness.livenessBps} bps · presence ${liveness.presenceBps} · naturalness ${liveness.naturalnessBps} · ${
          liveness.passes ? "geçti" : "KALDI"
        }`,
      ],
      [
        "acoustic",
        `F0 ${liveness.detail.f0Mean} Hz · titreme %${liveness.detail.f0JitterPct} · HNR ${liveness.detail.hnrDb} dB · hece ${liveness.detail.syllableBursts} · döngü ${liveness.detail.loopScore}`,
      ],
      ["embedding", `${voiceprint.embedding.length}-d MFCC (mean+std), L2-normalised`],
      ["F0 mean", `${f.f0Mean.toFixed(1)} Hz`],
      ["HNR", `${f.hnrDb.toFixed(1)} dB`],
      ["spectral centroid", `${f.centroid.toFixed(0)} Hz`],
      ["voiced frames", `${f.speechFrames}/${f.totalFrames}`],
      ["templateDigest", voiceprint.digest],
      ["device secret salt", `${key.salt.slice(0, 18)}…  (never transmitted)`],
      ["template shift t", `${key.shift.toString(16).slice(0, 24)}…`],
      ["zkCommitment  C = P + t·G", key.commitment],
      ["on-chain call", `registerBaseline(user, C)`],
    ],
  };
}

function previewOf(
  f: {
    f0Mean: number;
    hnrDb: number;
    centroid: number;
    flatness: number;
    voicedRatio: number;
    speechFrames: number;
    totalFrames: number;
  },
  raw: { peak: number; rms: number },
) {
  return {
    f0Mean: round(f.f0Mean, 1),
    hnrDb: round(f.hnrDb, 1),
    centroid: Math.round(f.centroid),
    flatness: round(f.flatness, 4),
    voicedRatio: round(f.voicedRatio, 3),
    speechFrames: f.speechFrames,
    totalFrames: f.totalFrames,
    // raw levels, so the UI can show what the microphone actually delivered
    rawPeak: round(raw.peak, 4),
    rawRms: round(raw.rms, 4),
  };
}

const round = (v: number, d: number) => {
  const f = 10 ** d;
  return Math.round(v * f) / f;
};
