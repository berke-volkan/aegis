/**
 * ────────────────────────────────────────────────────────────────────────────
 *  AEGIS LIVENESS ENGINE  ·  `lib/zk/liveness.ts`
 * ────────────────────────────────────────────────────────────────────────────
 *
 * This is the module that answers the only question that matters during a call:
 *
 *      "Is the voice on the line a live human who enrolled this baseline,
 *       answering a challenge they have just seen for the first time?"
 *
 * It produces two independent artefacts:
 *
 *   A) A VERDICT — `similarityBps`, `livenessBps` and an attack `flags`
 *      bitfield, derived from the speaker embedding plus a battery of acoustic
 *      liveness checks (speech presence, response latency, pitch jitter, HNR,
 *      spectral naturalness, syllable bursts, loop/replay correlation).
 *
 *   B) A PROOF WORD — a 32-byte public-signal attestation, signed with the
 *      biometric key, ready for `verifyCallWithLiveness` on Monad.
 *
 * ── Why the layering matters ────────────────────────────────────────────────
 * A threshold score alone is spoofable: a deepfake that reproduces the enrolled
 * speaker well enough scores high. So the verdict *alone is never trusted*:
 *
 *   • the scores are committed to inside the signed message, and
 *   • the signature is produced with the key that is bound to the enrolled
 *     biometric template, and
 *   • the message is bound to a fresh, single-use on-chain challenge, so it
 *     cannot be lifted from a previous call.
 *
 * An attacker therefore has to defeat the acoustics *and* steal the device
 * secret *and* be lucky with the challenge. That is the real defence; the score
 * is just what makes the verdict explainable to a human operator.
 *
 * Where a real deployment goes further: `similarityBps`, `livenessBps` and the
 * flag battery move *inside* a zk-circuit, the prover emits a Groth16/PLONK
 * proof instead of a client-signed word, and an on-chain verifier contract
 * checks it. The contract surface in `AegisCallZK.sol` is already shaped for
 * that swap.
 */
import { encodeAbiParameters, keccak256, type Address } from "viem";

import {
  cosineSimilarity,
  type Voiceprint,
} from "../audio/features";
import {
  keyForTemplate,
  signLiveness,
  signatureAnchor,
  verifyLivenessSignature,
  type BiometricKey,
} from "./biometricKey";
import { isChallengeExpired, type LivenessChallenge } from "./challenges";
import {
  ATTACK_FLAGS,
  clampBps,
  computeBinding,
  packLivenessProof,
  PROOF_VERSION,
} from "./pack";
import { DOMAIN_LIVENESS, bytesToHex, hash, type Bytes32 } from "./primitives";

/** Every threshold in one place, surfaced in the UI so nothing is a magic number. */
export const LIVENESS_THRESHOLDS = {
  /** digital silence is never a human */
  minRms: 0.012,
  /** at least this fraction of frames must carry speech energy */
  minSpeechFrameRatio: 0.12,
  /**
   * A human needs a moment to *read* a code they have never seen before. The
   * clock runs from the moment the challenge became visible to the first speech
   * frame — including the gap before the user even pressed record. A prerecorded
   * or synthesised response has no read-and-react delay, which is precisely
   * what separates it from a live human here.
   */
  responseLatencyMinMs: 200,
  responseLatencyMaxMs: 12_000,
  /** plausible fundamental-frequency band for an adult speaker */
  f0Range: [70, 320] as const,
  /** natural cycle-to-cycle pitch jitter; a synthesised voice sits at ~0 */
  jitterHuman: [0.008, 0.075] as const,
  /**
   * SYNTHETIC rule: below this measured jitter the voice is machine-stable.
   *
   * Placed in the *gap* between the two measured populations rather than at the
   * textbook value: real human speech measures ≈0.5–3 % jitter per 10 ms frame,
   * a vocoder measures ≈0.1–0.2 %, and the autocorrelation pitch tracker loses
   * further resolution on low-pitched voices. 0.3 % sits between them.
   *
   * This rule is deliberately *lenient*. Jitter is a secondary signal: a false
   * positive locks out a paying customer, while a missed deepfake still has to
   * defeat the biometric key binding and the similarity check. The layers are
   * ordered by how cheap each one is, not by how confident it is.
   */
  jitterSyntheticCeiling: 0.003,
  minVoicedFramesForJitter: 20,
  /** harmonics-to-noise ratio band for a close-mic voice */
  hnrRange: [7, 32] as const,
  /** spectral flatness ceiling: above this the "voice" is noise-like */
  flatnessCeiling: 0.55,
  /** speech spectral centroid band */
  centroidRange: [250, 3_400] as const,
  /** answering a 4-digit code takes at least this many syllables */
  minSyllableBursts: 2,
  /**
   * Cosine similarity of the MFCC mean+std embedding.
   *
   * CALIBRATION NOTE: measured on a synthetic corpus (see
   * `scripts/verify-frontend.mjs`) the same "speaker" scores ≈0.95 and a
   * different one ≈0.62. These numbers must be re-measured on a real speech
   * corpus before production — they are the single most important constants in
   * the file, and they are surfaced in the UI's Proof Inspector.
   */
  similarityFloor: 0.72,
  similarityStrong: 0.88,
  /** normalised autocorrelation peak that indicates a looped sample */
  loopCorrelationCeiling: 0.55,
  /** weights of the liveness sub-scores (must sum to 1) */
  weights: {
    presence: 0.24,
    responseLatency: 0.2,
    pitchNaturalness: 0.18,
    spectralNaturalness: 0.18,
    articulation: 0.2,
  },
} as const;

/** Sub-scores, all normalised to 0..1, kept for the Proof Inspector. */
export type LivenessBreakdown = {
  presence: number;
  responseLatency: number;
  pitchNaturalness: number;
  spectralNaturalness: number;
  articulation: number;
};

export type AttackVerdict = {
  flags: number;
  flagNames: string[];
  reasons: string[];
};

export type LivenessResult = {
  /** 0..10_000 */
  similarityBps: number;
  /** 0..10_000 */
  livenessBps: number;
  cosine: number;
  breakdown: LivenessBreakdown;
  verdict: AttackVerdict;
  voiceprint: Voiceprint;
  /** keccak256 of the submitted PCM — replay ledger key */
  audioDigest: Bytes32;
  /** ms from the challenge becoming visible to the first speech frame */
  responseLatencyMs: number;
};

/**
 * Scores a capture against the baseline and the live challenge.
 *
 * @param capture      the just-recorded audio analysis
 * @param baseline     the enrolled voiceprint
 * @param challenge    the challenge that was displayed
 * @param audioDigest  keccak256 of the submitted PCM
 * @param priorDigests digests of every capture taken in this session (replay ledger)
 */
export function scoreLiveness(params: {
  capture: Voiceprint;
  /**
   * The enrolled speaker's embedding, straight out of the local vault.
   *
   * Deliberately just the embedding rather than a whole `Voiceprint`: the vault
   * persists the vector, and similarity is the only thing the baseline
   * contributes here. Rebuilding a synthetic Voiceprint around it (with empty
   * `features`) was a trap waiting for someone to read a field off it.
   */
  baselineEmbedding: Float32Array;
  challenge: LivenessChallenge;
  audioDigest: Bytes32;
  priorDigests: readonly Bytes32[];
  /**
   * When the microphone was actually opened. Together with the first speech
   * frame this gives the human read-and-react latency, measured from the
   * moment the challenge appeared. Defaults to the capture start, which makes
   * the latency metric relative to the recording rather than the challenge.
   */
  captureStartedAt?: number;
  now?: number;
}): LivenessResult {
  const {
    capture,
    baselineEmbedding,
    challenge,
    audioDigest,
    priorDigests,
    now = Date.now(),
  } = params;
  const T = LIVENESS_THRESHOLDS;
  const f = capture.features;

  // -------------------------------------------------------------- similarity
  const cosine = cosineSimilarity(capture.embedding, baselineEmbedding);
  const similarityBps = clampBps(
    ((cosine - T.similarityFloor) / (T.similarityStrong - T.similarityFloor)) * 10_000,
  );

  // Response latency, measured from the challenge becoming visible.
  const preRollMs = Math.max(0, (params.captureStartedAt ?? challenge.issuedAt) - challenge.issuedAt);
  const responseLatencyMs = Number.isFinite(f.onsetMs) ? preRollMs + f.onsetMs : Number.POSITIVE_INFINITY;

  // -------------------------------------------------------------- sub-scores
  const speechRatio = f.totalFrames ? f.speechFrames / f.totalFrames : 0;
  const presence =
    Math.min(1, speechRatio / T.minSpeechFrameRatio) *
    Math.min(1, f.rms / T.minRms) *
    // a pause-free wall of sound is not an answer either
    clamp01(1 - Math.max(0, f.longestPauseMs - 2_500) / 2_500);

  const responseLatency = band(
    responseLatencyMs,
    T.responseLatencyMinMs,
    T.responseLatencyMaxMs,
    900,
  );

  const f0Ok = f.f0Mean >= T.f0Range[0] && f.f0Mean <= T.f0Range[1];
  const jitter = f.f0Jitter;
  const jitterOk = jitter >= T.jitterHuman[0] && jitter <= T.jitterHuman[1];
  const pitchNaturalness =
    (f0Ok ? 1 : Math.max(0, 1 - distanceToBand(f.f0Mean, T.f0Range) / 150)) *
    // below the natural jitter floor the pitch is machine-stable, and the
    // score degrades with how stable it is.
    (jitterOk ? 1 : jitter < T.jitterHuman[0] ? jitter / T.jitterHuman[0] : 1) *
    clamp01(f.voicedRatio / 0.25);

  const centroidOk =
    f.centroid >= T.centroidRange[0] && f.centroid <= T.centroidRange[1];
  const spectralNaturalness =
    (centroidOk ? 1 : Math.max(0, 1 - distanceToBand(f.centroid, T.centroidRange) / 1_200)) *
    (f.flatness <= T.flatnessCeiling ? 1 : 1 - (f.flatness - T.flatnessCeiling)) *
    band(f.hnrDb, T.hnrRange[0], T.hnrRange[1], 6);

  const bursts = f.syllableBursts;
  const articulation =
    clamp01(bursts / T.minSyllableBursts) *
    (f.zcr > 0.005 && f.zcr < 0.45 ? 1 : 0.6) *
    // spread of energy across the capture: reading digits is not one long tone
    clamp01(energySpread(f.envelope) / 0.35);

  const breakdown: LivenessBreakdown = {
    presence,
    responseLatency,
    pitchNaturalness,
    spectralNaturalness,
    articulation,
  };

  const livenessBps = clampBps(
    10_000 *
      (T.weights.presence * presence +
        T.weights.responseLatency * responseLatency +
        T.weights.pitchNaturalness * pitchNaturalness +
        T.weights.spectralNaturalness * spectralNaturalness +
        T.weights.articulation * articulation),
  );

  // ------------------------------------------------------------- hard flags
  const flags: number[] = [];
  const reasons: string[] = [];

  // 1. REPLAY — this exact audio was already submitted in this session, or the
  //    capture correlates with itself at a lag (a cut-and-paste loop).
  if (priorDigests.some((d) => d === audioDigest)) {
    flags.push(ATTACK_FLAGS.REPLAY);
    reasons.push("PCM digest matches an earlier capture in this session");
  }
  if (f.loopScore > T.loopCorrelationCeiling) {
    flags.push(ATTACK_FLAGS.REPLAY);
    reasons.push(`self-correlation ${f.loopScore.toFixed(2)} ⇒ looped / stitched sample`);
  }

  // 2. SYNTHETIC — voiced audio whose pitch is machine-stable. Jitter is the
  //    single most reliable cheap discriminator: a live larynx wanders, a
  //    vocoder does not. Enough voiced frames are required so that noise, which
  //    also has ~zero jitter, cannot trip the rule.
  const voicedFrames = f.voicedRatio * f.totalFrames;
  if (voicedFrames >= T.minVoicedFramesForJitter && f.f0Jitter < T.jitterSyntheticCeiling) {
    flags.push(ATTACK_FLAGS.SYNTHETIC);
    reasons.push(
      `pitch jitter ${(f.f0Jitter * 100).toFixed(2)}% over ${Math.round(voicedFrames)} voiced frames ⇒ synthesised voice`,
    );
  }

  // 3. TEMPLATE_DRIFT — the voice no longer matches the enrolled speaker.
  if (cosine < T.similarityFloor) {
    flags.push(ATTACK_FLAGS.TEMPLATE_DRIFT);
    reasons.push(
      `embedding cosine ${cosine.toFixed(3)} < ${T.similarityFloor} ⇒ different speaker or heavily processed audio`,
    );
  }

  // 4. TEMPO_SPOOF — answered with no read-and-react delay, or implausibly late.
  if (
    responseLatencyMs < T.responseLatencyMinMs ||
    responseLatencyMs > T.responseLatencyMaxMs
  ) {
    flags.push(ATTACK_FLAGS.TEMPO_SPOOF);
    reasons.push(
      `first speech at ${Number.isFinite(responseLatencyMs) ? `${responseLatencyMs.toFixed(0)}ms` : "never"} after the challenge appeared, outside the human window ${T.responseLatencyMinMs}–${T.responseLatencyMaxMs}ms`,
    );
  }

  // 5. CHALLENGE_MISMATCH — answered after the challenge expired, or not at all.
  if (isChallengeExpired(challenge, now)) {
    flags.push(ATTACK_FLAGS.CHALLENGE_MISMATCH);
    reasons.push("challenge expired before the response completed");
  }
  if (speechRatio < T.minSpeechFrameRatio) {
    flags.push(ATTACK_FLAGS.MIC_SPOOF);
    reasons.push(`only ${(speechRatio * 100).toFixed(0)}% of frames contain speech energy`);
  }

  const flagBitfield = flags.reduce((acc, bit) => acc | bit, 0);

  return {
    similarityBps,
    livenessBps,
    cosine,
    breakdown,
    verdict: {
      flags: flagBitfield,
      flagNames: decodeFlags(flagBitfield),
      reasons,
    },
    voiceprint: capture,
    audioDigest,
    responseLatencyMs,
  };
}

/** Flattens a bitfield into the individual flag names. */
export function decodeFlags(flags: number): string[] {
  const names: string[] = [];
  for (const [name, bit] of Object.entries(ATTACK_FLAGS)) {
    if (flags & bit) names.push(name);
  }
  return names;
}

// ===========================================================================
//  PROOF ASSEMBLY
// ===========================================================================

export type LivenessTranscript = {
  /** the 32-byte word to submit on-chain */
  proofWord: Bytes32;
  /** the 64-byte BIP-340 signature (kept locally, anchored in the word) */
  signature: `0x${string}`;
  /** message that was signed */
  signedMessage: Bytes32;
  /** the fresh-binding value the contract recomputes */
  binding: `0x${string}`;
  sigAnchor: number;
  similarityBps: number;
  livenessBps: number;
  flags: number;
  flagNames: string[];
  reasons: string[];
  breakdown: LivenessBreakdown;
  cosine: number;
  audioDigest: Bytes32;
  /** did the live template re-derive the *exact* registered commitment? */
  biometricKeyMatched: boolean;
  /** local BIP-340 verification result (always true if we got here) */
  signatureValid: boolean;
  challengeId: number;
  challengeSeed: Bytes32;
  expiresAt: number;
  authNonce: number;
  accepted: boolean;
  transcriptLines: Array<[string, string]>;
};

/**
 * Assembles and signs the 32-byte proof word.
 *
 * The signed message binds *everything* the verdict depends on: the
 * commitment, the user, the challenge seed, the on-chain nonce, the deadline,
 * both scores, the flag bitfield and the digest of the exact audio. The
 * signature is made with the key bound to the enrolled template, so the verdict
 * is tamper-evident end to end.
 */
export function proveLiveness(params: {
  scored: LivenessResult;
  key: BiometricKey;
  registeredCommitment: Bytes32;
  user: Address;
  challenge: LivenessChallenge;
  authNonce: number;
  thresholds: { minLivenessBps: number; minSimilarityBps: number };
}): LivenessTranscript {
  const { scored, key, registeredCommitment, user, challenge, authNonce, thresholds } = params;

  // What key would *this* capture imply? Equal to the registered commitment when
  // the capture reproduces the enrolled template bit-for-bit.
  const live = keyForTemplate(key.salt, scored.voiceprint.digest);
  const biometricKeyMatched = live.commitment === registeredCommitment;

  const similarityBps = scored.similarityBps;
  const livenessBps = scored.livenessBps;
  const flags = scored.verdict.flags;

  const accepted =
    flags === 0 &&
    similarityBps >= thresholds.minSimilarityBps &&
    livenessBps >= thresholds.minLivenessBps;

  // ---- the message that gets signed -------------------------------------
  const signedMessage = keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" }, // DOMAIN_LIVENESS
        { type: "bytes32" }, // registered commitment C
        { type: "address" }, // user
        { type: "uint8" }, // challengeId
        { type: "bytes32" }, // challenge seed
        { type: "uint32" }, // on-chain authNonce
        { type: "uint64" }, // challenge deadline
        { type: "uint16" }, // similarityBps
        { type: "uint16" }, // livenessBps
        { type: "uint8" }, // attack flags
        { type: "bytes32" }, // digest of the submitted audio
      ],
      [
        keccak256(DOMAIN_LIVENESS),
        registeredCommitment,
        user,
        challenge.id,
        challenge.seed,
        authNonce,
        BigInt(Math.floor(challenge.expiresAt / 1000)),
        similarityBps,
        livenessBps,
        flags,
        scored.audioDigest,
      ],
    ),
  );

  // ---- sign with the biometric key, then verify locally ------------------
  const { signature } = signLiveness(signedMessage, key);
  const signatureValid = verifyLivenessSignature(registeredCommitment, signedMessage, signature);

  const sigAnchor = signatureAnchor(signature);

  // ---- the freshness binding the contract will recompute -----------------
  const binding = computeBinding({
    commitment: registeredCommitment,
    user,
    challengeId: challenge.id,
    authNonce,
  });

  const proofWord = packLivenessProof({
    version: PROOF_VERSION,
    challengeId: challenge.id,
    livenessBps,
    similarityBps,
    flags,
    sigAnchor,
    authNonce,
    binding,
  });

  const sigHex = bytesToHex(signature);

  return {
    proofWord,
    signature: sigHex,
    signedMessage,
    binding,
    sigAnchor,
    similarityBps,
    livenessBps,
    flags,
    flagNames: decodeFlags(flags),
    reasons: scored.verdict.reasons,
    breakdown: scored.breakdown,
    cosine: scored.cosine,
    audioDigest: scored.audioDigest,
    biometricKeyMatched,
    signatureValid,
    challengeId: challenge.id,
    challengeSeed: challenge.seed,
    expiresAt: challenge.expiresAt,
    authNonce,
    accepted,
    transcriptLines: buildTranscript({
      registeredCommitment,
      liveCommitment: live.commitment,
      user,
      challenge,
      authNonce,
      signedMessage,
      signature: sigHex,
      sigAnchor,
      similarityBps,
      livenessBps,
      flags,
      audioDigest: scored.audioDigest,
      binding,
      proofWord,
      signatureValid,
      biometricKeyMatched,
      accepted,
      thresholds,
    }),
  };
}

function buildTranscript(input: {
  registeredCommitment: Bytes32;
  liveCommitment: Bytes32;
  user: Address;
  challenge: LivenessChallenge;
  authNonce: number;
  signedMessage: Bytes32;
  signature: `0x${string}`;
  sigAnchor: number;
  similarityBps: number;
  livenessBps: number;
  flags: number;
  audioDigest: Bytes32;
  binding: `0x${string}`;
  proofWord: Bytes32;
  signatureValid: boolean;
  biometricKeyMatched: boolean;
  accepted: boolean;
  thresholds: { minLivenessBps: number; minSimilarityBps: number };
}): Array<[string, string]> {
  const { challenge, thresholds } = input;
  return [
    ["challengeId", `${challenge.id} · ${challenge.template.title}`],
    ["challenge seed", input.challenge.seed],
    ["audio digest", input.audioDigest],
    ["registered commitment C", input.registeredCommitment],
    [
      "live-derived commitment C'",
      `${input.liveCommitment}${input.biometricKeyMatched ? "  == C ✓" : "  (≠ C)"}`,
    ],
    ["authNonce", `${input.authNonce}`],
    [
      "signed message",
      `${input.signedMessage}  ← scores + flags + audio digest + challenge`,
    ],
    ["BIP-340 signature (r‖s)", input.signature],
    ["signature verifies vs C", input.signatureValid ? "true ✓" : "false ✗"],
    ["sigAnchor", `0x${input.sigAnchor.toString(16).padStart(2, "0")}`],
    ["binding (recomputed on-chain)", input.binding],
    [
      "similarityBps",
      `${input.similarityBps} (min ${thresholds.minSimilarityBps})`,
    ],
    ["livenessBps", `${input.livenessBps} (min ${thresholds.minLivenessBps})`],
    ["flags", `0x${input.flags.toString(16).padStart(2, "0")}${input.flags ? " · " + decodeFlags(input.flags).join(", ") : " · clean"}`],
    ["proof word", input.proofWord],
    ["verdict", input.accepted ? "ACCEPTED" : "REJECTED"],
  ];
}

// ===========================================================================
//  small numeric helpers
// ===========================================================================

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** 1 inside [lo, hi], decaying to 0 over `edge` outside it. */
function band(value: number, lo: number, hi: number, edge: number): number {
  if (value >= lo && value <= hi) return 1;
  if (value < lo) return clamp01(1 - (lo - value) / edge);
  return clamp01(1 - (value - hi) / edge);
}

function distanceToBand(value: number, [lo, hi]: readonly number[]): number {
  if (value < lo) return lo - value;
  if (value > hi) return value - hi;
  return 0;
}

/** Normalised spread of energy across the capture (0 = one short blip). */
function energySpread(envelope: number[]): number {
  if (envelope.length === 0) return 0;
  const total = envelope.reduce((a, b) => a + b, 0);
  if (total <= 0) return 0;
  let active = 0;
  for (const v of envelope) if (v > 0.15) active++;
  return active / envelope.length;
}
