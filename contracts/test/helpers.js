// Test helpers: a JS mirror of `lib/zk/pack.ts` + `lib/zk/binding.ts` so the
// contract can be exercised exactly the way the browser will call it.
const { keccak256, encodeAbiParameters, toHex, slice, concat } = require("viem");

const DOMAIN = keccak256(toHex("AEGIS_CALL_ZK_V1"));

const FLAG = {
  REPLAY: 1 << 0,
  SYNTHETIC: 1 << 1,
  TEMPLATE_DRIFT: 1 << 2,
  TEMPO_SPOOF: 1 << 3,
  CHALLENGE_MISMATCH: 1 << 4,
  MIC_SPOOF: 1 << 5,
};

const hex = (n, bytes) => n.toString(16).padStart(bytes * 2, "0");

/**
 * bytes20(keccak256(abi.encode(DOMAIN, commitment, user, challengeId, authNonce)))
 *
 * NOTE the slice: Solidity's `bytes32 -> bytes20` cast keeps the LEFTMOST 20
 * bytes of the word, so the binding is the *last* 20 bytes of the digest
 * (offsets 12..31), i.e. its low 160 bits.
 */
function expectedBinding({ commitment, user, challengeId, authNonce }) {
  const digest = keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "address" },
        { type: "uint8" },
        { type: "uint32" },
      ],
      [DOMAIN, commitment, user, challengeId, authNonce],
    ),
  );
  return slice(digest, 12);
}

/** Mirrors AegisCallZK.LivenessSignals. Override any field to craft a test word. */
function packProof({
  version = 1,
  challengeId,
  livenessBps,
  similarityBps,
  flags = 0,
  sigAnchor = 0,
  authNonce,
  binding,
  /** raw overrides appended after the 12 fixed bytes (used to test dirty bits) */
  tail,
}) {
  const head =
    "0x" +
    hex(version, 1) +
    hex(challengeId, 1) +
    hex(livenessBps, 2) +
    hex(similarityBps, 2) +
    hex(flags, 1) +
    hex(sigAnchor, 1) +
    hex(authNonce, 4) +
    slice(binding, 0, 20).slice(2);
  return tail ? concat([head, tail]) : head;
}

/** Build the exact word a compliant prover would submit. */
function buildProof({
  user,
  commitment,
  challengeId,
  authNonce,
  livenessBps,
  similarityBps,
  flags = 0,
  sigAnchor = 0,
}) {
  const binding = expectedBinding({ commitment, user, challengeId, authNonce });
  return packProof({ challengeId, livenessBps, similarityBps, flags, sigAnchor, authNonce, binding });
}

module.exports = { DOMAIN, FLAG, expectedBinding, packProof, buildProof, hex };
