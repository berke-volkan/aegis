/**
 * 1:1 mirror of `AegisCallZK.LivenessSignals`.
 *
 * Every offset, width and endianness below has an assert-checked twin in
 * `contracts/AegisCallZK.sol` (`decodeLivenessProof` / `_encode`) and in
 * `contracts/test/helpers.js`. The contract re-encodes the decoded struct and
 * reverts with `DirtyProofBits()` if the input is not canonical, so the prover
 * must leave every unused bit at zero.
 *
 *   offset  size  field
 *   0x00    1     version         must be 1
 *   0x01    1     challengeId     must equal the on-chain challenge answered
 *   0x02    2     livenessBps     live-human confidence, 0..10_000
 *   0x04    2     similarityBps   template match score,  0..10_000
 *   0x06    1     flags           attack bitfield, see ATTACK_FLAGS
 *   0x07    1     sigAnchor       uint8(keccak256(sigR ++ sigS)[31])
 *   0x08    4     authNonce       must equal the user's on-chain authNonce
 *   0x0C    20    binding         bytes20(keccak256(abi.encode(
 *                                     DOMAIN, commitment, user,
 *                                     challengeId, authNonce)))
 */
import { encodeAbiParameters, keccak256, slice, type Address, type Hash } from "viem";

import type { Bytes32 } from "./primitives";

export const PROOF_VERSION = 1;

/** Bit layout of `flags` — identical to the `FLAG_*` constants in the contract. */
export const ATTACK_FLAGS = {
  REPLAY: 1 << 0,
  SYNTHETIC: 1 << 1,
  TEMPLATE_DRIFT: 1 << 2,
  TEMPO_SPOOF: 1 << 3,
  CHALLENGE_MISMATCH: 1 << 4,
  MIC_SPOOF: 1 << 5,
} as const;

export type AttackFlagName = keyof typeof ATTACK_FLAGS;

/** Human labels for the Proof Inspector and the alert card. */
export const ATTACK_FLAG_LABELS: Record<number, string> = {
  [ATTACK_FLAGS.REPLAY]: "Replay: captured audio is bit-identical to an earlier capture",
  [ATTACK_FLAGS.SYNTHETIC]: "Synthetic voice: vocoder / TTS spectral signature",
  [ATTACK_FLAGS.TEMPLATE_DRIFT]: "Speaker template drifted beyond the match threshold",
  [ATTACK_FLAGS.TEMPO_SPOOF]: "Speech cadence inconsistent with a live human",
  [ATTACK_FLAGS.CHALLENGE_MISMATCH]: "Response not bound to the live challenge",
  [ATTACK_FLAGS.MIC_SPOOF]: "Digital or virtual microphone (injection path)",
};

/** `RejectionReason` enum from the contract, for decoding events. */
export const REJECTION_REASONS = [
  "None",
  "Liveness below threshold",
  "Similarity below threshold",
  "Attack flags present",
  "Account locked out",
] as const;

export type LivenessSignals = {
  version: number;
  challengeId: number;
  livenessBps: number;
  similarityBps: number;
  flags: number;
  sigAnchor: number;
  authNonce: number;
  binding: `0x${string}`; // 20 bytes
};

/** The contract's DOMAIN constant: keccak256("AEGIS_CALL_ZK_V1"). */
export const CONTRACT_DOMAIN = keccak256("0x41454749535f43414c4c5f5a4b5f5631"); // "AEGIS_CALL_ZK_V1"

/**
 * Recomputes the freshness binding the contract will recompute.
 *
 * @dev `abi.encode` (not `packed`) — the exact encoding matters.
 * @dev The `slice(digest, 12, 20)` is not arbitrary: Solidity's
 *      `bytes32 -> bytes20` cast keeps the *leftmost* 20 bytes of the word, so
 *      the contract's `binding` field is the digest's **low 160 bits**
 *      (offsets 12..31). Mirrored by `_low20()` in AegisCallZK.sol and
 *      asserted by `contracts/test/helpers.js`.
 */
export function computeBinding(params: {
  commitment: Bytes32;
  user: Address;
  challengeId: number;
  authNonce: number;
}): `0x${string}` {
  const digest = keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "address" },
        { type: "uint8" },
        { type: "uint32" },
      ],
      [
        CONTRACT_DOMAIN,
        params.commitment,
        params.user,
        params.challengeId,
        params.authNonce,
      ],
    ),
  );
  return slice(digest, 12);
}

const u8 = (v: number) => (v & 0xff).toString(16).padStart(2, "0");
const u16 = (v: number) => (v & 0xffff).toString(16).padStart(4, "0");
const u32 = (v: number) => (v & 0xffffffff).toString(16).padStart(8, "0");

export const clampBps = (v: number) => Math.max(0, Math.min(10_000, Math.round(v)));

/** Serialises the 32-byte public-signal word exactly as Solidity decodes it. */
export function packLivenessProof(s: LivenessSignals): Bytes32 {
  if (s.version !== PROOF_VERSION) throw new Error(`proof version must be ${PROOF_VERSION}`);
  if (s.challengeId > 0xff) throw new Error("challengeId out of range");
  if (s.authNonce > 0xffffffff) throw new Error("authNonce out of range");
  if (s.sigAnchor > 0xff) throw new Error("sigAnchor out of range");

  const word =
    "0x" +
    u8(s.version) +
    u8(s.challengeId) +
    u16(clampBps(s.livenessBps)) +
    u16(clampBps(s.similarityBps)) +
    u8(s.flags) +
    u8(s.sigAnchor) +
    u32(s.authNonce) +
    s.binding.slice(2);

  if (word.length !== 66) throw new Error(`packed proof must be 32 bytes, got ${(word.length - 2) / 2}`);
  return word as Bytes32;
}

/** Local decoder — mirrors `decodeLivenessProof`, used by the Proof Inspector. */
export function unpackLivenessProof(word: Bytes32): LivenessSignals {
  const v = BigInt(word);
  return {
    version: Number((v >> 248n) & 0xffn),
    challengeId: Number((v >> 240n) & 0xffn),
    livenessBps: Number((v >> 224n) & 0xffffn),
    similarityBps: Number((v >> 208n) & 0xffffn),
    flags: Number((v >> 200n) & 0xffn),
    sigAnchor: Number((v >> 192n) & 0xffn),
    authNonce: Number((v >> 160n) & 0xffffffffn),
    binding: slice(word as Hash, 12, 32),
  };
}

/** Field-by-field breakdown for the UI, including the raw byte slices. */
export type ProofFieldRow = {
  offset: string;
  size: number;
  field: string;
  value: string;
  note?: string;
  bytes: string;
};

export function describeProofWord(word: Bytes32): ProofFieldRow[] {
  const s = unpackLivenessProof(word);
  const bytes = word.slice(2).match(/../g) ?? [];
  const rows: Array<Omit<ProofFieldRow, "bytes">> = [
    {
      offset: "0x00",
      size: 1,
      field: "version",
      value: `${s.version}`,
      note: `must equal PROOF_VERSION (${PROOF_VERSION})`,
    },
    { offset: "0x01", size: 1, field: "challengeId", value: `${s.challengeId}` },
    {
      offset: "0x02",
      size: 2,
      field: "livenessBps",
      value: `${s.livenessBps} bps · ${(s.livenessBps / 100).toFixed(2)}%`,
    },
    {
      offset: "0x04",
      size: 2,
      field: "similarityBps",
      value: `${s.similarityBps} bps · ${(s.similarityBps / 100).toFixed(2)}%`,
    },
    {
      offset: "0x06",
      size: 1,
      field: "flags",
      value: s.flags === 0 ? "0x00 · clean" : `0x${u8(s.flags)} · attack`,
    },
    {
      offset: "0x07",
      size: 1,
      field: "sigAnchor",
      value: `0x${u8(s.sigAnchor)}`,
      note: "anchor of the 64-byte BIP-340 signature",
    },
    {
      offset: "0x08",
      size: 4,
      field: "authNonce",
      value: `${s.authNonce}`,
      note: "single-use · must equal the on-chain value",
    },
    {
      offset: "0x0C",
      size: 20,
      field: "binding",
      value: `${s.binding.slice(0, 10)}…${s.binding.slice(-8)}`,
      note: "recomputed on-chain · kills cross-user replay",
    },
  ];
  let cursor = 0;
  return rows.map((row) => {
    const slice_ = `0x${bytes.slice(cursor, cursor + row.size).join("")}`;
    cursor += row.size;
    return { ...row, bytes: slice_ };
  });
}

export { CONTRACT_DOMAIN as DOMAIN };
