/**
 * Enrolment-time liveness.
 *
 * Step 1 is the one moment where a cheap liveness check is worth running: if the
 * baseline is a deepfake, a TTS sample or a loop, every later call inherits it
 * and the similarity check will happily accept the clone forever. Rejecting a
 * bad baseline here is cheap; discovering it during a real call is not.
 *
 * ── What blocks, and what only reports ────────────────────────────────────
 * Measured on the project's own fixtures, the signals separate like this:
 *
 *   | signal          | loopScore | HNR   | jitter |
 *   |-----------------|-----------|-------|--------|
 *   | bit-exact loop  | 0.99–1.00 | 9.6   | 1.1 %  |
 *   | live voice      | 0.20–0.50 | 8–14  | 0.2–1 %|
 *   | vocoder / TTS   | 0.24      | 3.8   | 0.11 % |
 *
 * Only two of those have enough margin to refuse an enrolment on their own:
 * "no speech energy at all" and "the capture repeats itself bit-for-bit". The
 * jitter and HNR margins are thin — a real voice pushed through a laptop mic
 * carries *more* noise than a synthesiser, which moves HNR in the wrong
 * direction — so those raise a flag and are displayed, but they do not block.
 * Over-tight gates here are exactly what made step 1 unusable.
 *
 * Scores are always returned and always displayed, whether or not they gate.
 */
import { ATTACK_FLAGS } from "./pack";
import type { Voiceprint } from "../audio/features";

export type EnrollmentLiveness = {
  /** 0..10_000 — how much this looks like a live human speaking now */
  livenessBps: number;
  /** 0..10_000 — how much of the capture carries speech energy */
  presenceBps: number;
  /** 0..10_000 — how machine-stable the pitch is (low jitter = synthetic) */
  naturalnessBps: number;
  /** attack flags raised by the acoustic checks */
  flags: number;
  flagNames: string[];
  /** true when the capture is plausible as an enrolment sample */
  passes: boolean;
  /** why it failed, if `passes` is false */
  problems: string[];
  /** detected, but not disqualifying — worth a glance in the UI */
  advisories: string[];
  /** the numbers, for display */
  detail: {
    f0Mean: number;
    f0JitterPct: number;
    hnrDb: number;
    flatness: number;
    centroid: number;
    voicedRatio: number;
    speechRatio: number;
    loopScore: number;
    syllableBursts: number;
    longestPauseMs: number;
  };
};

/** Below this the enrolment sample is not believable as a human utterance. */
export const ENROLL_MIN_LIVENESS_BPS = 2_500;

/**
 * A *perfect* repetition scores ≥0.98; a live voice measured on this pipeline
 * lands between 0.20 and 0.50. 0.90 is a wide berth that still only a loop
 * crosses.
 */
export const ENROLL_LOOP_BLOCK_CEILING = 0.9;

/** Between the two: suspicious, reported, not refused. */
export const ENROLL_LOOP_ADVISORY_FLOOR = 0.6;

export function evaluateEnrollmentLiveness(voiceprint: Voiceprint): EnrollmentLiveness {
  const f = voiceprint.features;
  const T = {
    minSpeechFrameRatio: 0.12,
    /** rms at which presence earns full credit */
    fullRms: 0.048,
    jitterSyntheticCeiling: 0.002,
    flatnessCeiling: 0.55,
    centroidRange: [250, 5_200] as const,
  };

  const speechRatio = f.totalFrames ? f.speechFrames / f.totalFrames : 0;

  // ── presence ────────────────────────────────────────────────────────────
  // The one signal that is genuinely reliable: is a voice arriving right now?
  const presenceBps = clampBps(
    10_000 *
      Math.min(1, speechRatio / T.minSpeechFrameRatio) *
      Math.min(1, voiceprint.raw.rms / T.fullRms),
  );

  // ── naturalness: does it sound like a larynx, or like a vocoder? ─────────
  // Graded, not binary. A human and a vocoder land within a few hundred bps of
  // each other here, which is why this informs the report but never the gate.
  //
  // HNR is deliberately *not* in this product. It is a good measure of how
  // tanned the speech energy is, but on real hardware it tracks the microphone
  // more than the speaker: the same utterance measures ~13 dB on a clean input
  // and ~−2 dB once room noise is added. Folding that in made the score swing
  // with the desk the user was sitting at, which is worse than not using it.
  // It is still computed and displayed — it is genuinely informative to a human
  // reading the panel.
  const voicedFrames = f.voicedRatio * f.totalFrames;
  const jitterOk = f.f0Jitter >= 0.004 && f.f0Jitter <= 0.09;
  const machineStable = voicedFrames >= 20 && f.f0Jitter < T.jitterSyntheticCeiling;
  const centroidOk =
    f.centroid >= T.centroidRange[0] && f.centroid <= T.centroidRange[1];
  const naturalnessBps = clampBps(
    10_000 *
      (jitterOk ? 1 : machineStable ? 0.15 : 0.7) *
      (centroidOk ? 1 : 0.7) *
      (f.flatness <= T.flatnessCeiling ? 1 : 0.7),
  );

  const livenessBps = clampBps(
    0.5 * presenceBps + 0.35 * naturalnessBps + 0.15 * f.energyMovementBps,
  );

  // ── attack signals ──────────────────────────────────────────────────────
  const flags: number[] = [];
  const problems: string[] = [];
  const advisories: string[] = [];

  if (speechRatio < T.minSpeechFrameRatio) {
    flags.push(ATTACK_FLAGS.MIC_SPOOF);
    problems.push(
      `Kaydın yalnızca %${(speechRatio * 100).toFixed(0)}'inde konuşma enerjisi var (gereken %${(T.minSpeechFrameRatio * 100).toFixed(0)}).`,
    );
  }

  if (f.loopScore >= ENROLL_LOOP_BLOCK_CEILING) {
    flags.push(ATTACK_FLAGS.REPLAY);
    problems.push(
      `Kayıt kendi kendini birebir tekrar ediyor (kendiliğinden benzerlik ${f.loopScore.toFixed(2)}). Bu bir döngü kaydı, canlı konuşma değil.`,
    );
  } else if (f.loopScore >= ENROLL_LOOP_ADVISORY_FLOOR) {
    advisories.push(
      `Kayıt bölümleri birbirine benziyor (kendiliğinden benzerlik ${f.loopScore.toFixed(2)}).`,
    );
  }

  if (machineStable) {
    flags.push(ATTACK_FLAGS.SYNTHETIC);
    advisories.push(
      `Ton titremesi çok düşük (%${(f.f0Jitter * 100).toFixed(2)}) — vocoder benzeri. Bu kayıt engellenmedi, ama dikkatinize.`,
    );
  }

  if (livenessBps < ENROLL_MIN_LIVENESS_BPS) {
    problems.push(
      `Canlılık puanı düşük: ${livenessBps} (gereken ≥${ENROLL_MIN_LIVENESS_BPS}). Kayıt canlı bir insan konuşmasına benzemiyor.`,
    );
  }

  return {
    livenessBps,
    presenceBps,
    naturalnessBps,
    flags: flags.reduce((a, b) => a | b, 0),
    flagNames: decode(flags),
    passes: problems.length === 0,
    problems,
    advisories,
    detail: {
      f0Mean: round(f.f0Mean, 1),
      f0JitterPct: round(f.f0Jitter * 100, 2),
      hnrDb: round(f.hnrDb, 1),
      flatness: round(f.flatness, 4),
      centroid: Math.round(f.centroid),
      voicedRatio: round(f.voicedRatio, 3),
      speechRatio: round(speechRatio, 3),
      loopScore: round(f.loopScore, 3),
      syllableBursts: f.syllableBursts,
      longestPauseMs: Math.round(f.longestPauseMs),
    },
  };
}

function decode(flags: number[]): string[] {
  const names: string[] = [];
  for (const [name, bit] of Object.entries(ATTACK_FLAGS)) {
    if (flags.includes(bit)) names.push(name);
  }
  return names;
}

const clampBps = (v: number) => Math.max(0, Math.min(10_000, Math.round(v)));
const round = (v: number, d: number) => {
  const f = 10 ** d;
  return Math.round(v * f) / f;
};
