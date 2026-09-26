/**
 * Biometric key binding — the "ZK" primitive of Aegis, on a real curve.
 *
 * ── Why not just hash the audio? ───────────────────────────────────────────
 * A plain `keccak256(embedding)` commitment proves nothing to a *verifier*: the
 * prover recomputes the hash from whatever audio it likes and the verifier
 * cannot tell a live human from a deepfake. Aegis instead binds the biometric
 * template into an elliptic-curve key with the sign-to-contract construction:
 *
 *      P = salt · G                            salt = 32-byte device secret
 *      t = H("AEGIS_BIOMETRIC_V1" ‖ H(template) ‖ P) mod n
 *      C = P + t · G                           <-- `zkCommitment`, 32 bytes
 *
 * Consequences, and they are the whole point:
 *
 *   • `C` looks like a plain public key on-chain. The template is never revealed.
 *   • The private key for `C` is `d = salt + t mod n`, and `t` depends on the
 *     template. Reproduce the template → you know `d`. Fail to reproduce it →
 *     you know a *different* key, so every signature you make is invalid
 *     against `C`.
 *   • Therefore a genuine BIP-340 signature against `C` is a cryptographic
 *     proof that the signer reproduced the enrolled biometric. A deepfake
 *     replay, a TTS synthesis and a different human all fail here — no
 *     threshold score can talk its way past it.
 *
 * In a production deployment `t`, the similarity check and the liveness checks
 * move inside a zk-circuit and the proof is checked by a Groth16/PLONK verifier;
 * the curve-level construction below is what that circuit constrains.
 */
import { schnorr, secp256k1 } from "@noble/curves/secp256k1";

import {
  bigIntTo32Bytes,
  bytesToBigInt,
  bytesToHex,
  DOMAIN_BIOMETRIC,
  DOMAIN_SALT,
  hash,
  hexToBytes,
  randomBytes,
  type Bytes32,
} from "./primitives";

const { ProjectivePoint } = secp256k1;

/** secp256k1 group order. */
export const CURVE_ORDER: bigint = secp256k1.CURVE.n;

/**
 * `@noble/curves` BIP-340 entry points are *typed* as accepting `0x`-prefixed
 * hex but *reject* it at runtime (`hex string expected, got non-hex character
 * "0x"`). They do accept `Uint8Array`. These aliases hand noble the bytes it
 * actually wants while keeping the compiler happy.
 */
type NobleBytes = Parameters<typeof schnorr.sign>[0];
type NobleSecret = Parameters<typeof schnorr.getPublicKey>[0];
const asMessage = (b: Uint8Array) => b as unknown as NobleBytes;
const asSecret = (b: Uint8Array) => b as unknown as NobleSecret;
const asSignature = (b: Uint8Array) => b as unknown as NobleBytes;

/**
 * A biometric-bound keypair. Only `commitment` and `templateDigest` are ever
 * published; `salt` and `witness` stay on the device.
 */
export type BiometricKey = {
  /** 32-byte device secret (the ZK witness). Never transmitted. */
  salt: Bytes32;
  /** H(audio embedding) — published, but not invertible. */
  templateDigest: Bytes32;
  /** C = P + t·G, x-only. Written on-chain as `zkCommitment`. */
  commitment: Bytes32;
  /** t, the public template shift. */
  shift: bigint;
  /** d = salt + t mod n — the key that signs liveness proofs. */
  witness: bigint;
};

/**
 * Derives the template-bound commitment.
 * @param templateDigest  keccak256 of the quantised speaker embedding
 * @param saltOverride    reuse an existing device secret (re-enrollment)
 */
export function deriveBiometricKey(
  templateDigest: Bytes32,
  saltOverride?: Bytes32,
): BiometricKey {
  const salt = saltOverride ?? hash(DOMAIN_SALT, randomBytes(32));
  const saltScalar = mod(bytesToBigInt(hexToBytes(salt)), CURVE_ORDER);
  if (saltScalar === 0n) throw new Error("degenerate salt");

  const P = ProjectivePoint.BASE.multiply(saltScalar);

  // t = H(domain ‖ templateDigest ‖ compressed P) mod n
  const shift = mod(
    bytesToBigInt(hexToBytes(hash(DOMAIN_BIOMETRIC, templateDigest, bytesToHex(P.toRawBytes(true))))),
    CURVE_ORDER,
  );

  const C = P.add(ProjectivePoint.BASE.multiply(shift));
  const commitment = bytesToHex(new Uint8Array(C.toRawBytes(true).slice(1))) as Bytes32; // strip 0x02/0x03
  const witness = mod(saltScalar + shift, CURVE_ORDER);

  // Self-check: the witness must derive the very same public key. If this ever
  // throws, the construction is broken and we must not register a commitment.
  const derived = bytesToHex(
    schnorr.getPublicKey(asSecret(bigIntTo32Bytes(witness))),
  );
  if (derived !== commitment) {
    throw new Error("sign-to-contract self-check failed: witness does not derive the commitment");
  }

  return { salt, templateDigest, commitment, shift, witness };
}

// Re-derives `t` for a *fresh* capture, i.e. what an attacker would have to
// match. Returns the public key that capture implies — if it differs from the
// registered commitment, the biometric was not reproduced.
export function keyForTemplate(
  salt: Bytes32,
  templateDigest: Bytes32,
): { commitment: Bytes32; witness: bigint } {
  const saltScalar = mod(bytesToBigInt(hexToBytes(salt)), CURVE_ORDER);
  const P = ProjectivePoint.BASE.multiply(saltScalar);
  const shift = mod(
    bytesToBigInt(hexToBytes(hash(DOMAIN_BIOMETRIC, templateDigest, bytesToHex(P.toRawBytes(true))))),
    CURVE_ORDER,
  );
  const C = P.add(ProjectivePoint.BASE.multiply(shift));
  return {
    commitment: bytesToHex(new Uint8Array(C.toRawBytes(true).slice(1))) as Bytes32,
    witness: mod(saltScalar + shift, CURVE_ORDER),
  };
}

/**
 * Rebuilds the full key from what the local vault persists.
 *
 * The vault stores `salt` and `templateDigest`, never the witness — the witness
 * is re-derived on demand so it never sits in storage. Recomputing is exactly
 * what the signing device does at proof time, and the recomputed commitment is
 * checked against the one registered on-chain, so a mismatched vault is caught
 * before any transaction is signed rather than after.
 */
export function restoreKey(params: {
  salt: Bytes32;
  templateDigest: Bytes32;
  /** the commitment from `baselineCommitment(user)`; optional local check */
  expectedCommitment?: Bytes32;
}): BiometricKey {
  const saltScalar = mod(bytesToBigInt(hexToBytes(params.salt)), CURVE_ORDER);
  if (saltScalar === 0n) throw new Error("degenerate salt in vault");
  const P = ProjectivePoint.BASE.multiply(saltScalar);
  const shift = mod(
    bytesToBigInt(
      hexToBytes(
        hash(DOMAIN_BIOMETRIC, params.templateDigest, bytesToHex(P.toRawBytes(true))),
      ),
    ),
    CURVE_ORDER,
  );
  const C = P.add(ProjectivePoint.BASE.multiply(shift));
  const commitment = bytesToHex(new Uint8Array(C.toRawBytes(true).slice(1))) as Bytes32;

  if (params.expectedCommitment && params.expectedCommitment !== commitment) {
    throw new Error(
      "vault does not match the on-chain baseline — the local template or salt is wrong; re-enroll",
    );
  }

  return {
    salt: params.salt,
    templateDigest: params.templateDigest,
    commitment,
    shift,
    witness: mod(saltScalar + shift, CURVE_ORDER),
  };
}

/**
 * Signs a liveness challenge message with the biometric key.
 * @returns the 64-byte BIP-340 signature (r ‖ s)
 */
export function signLiveness(
  message: Bytes32,
  key: BiometricKey | { commitment: Bytes32; witness: bigint },
): { signature: Uint8Array; r: Uint8Array; s: Uint8Array } {
  const signature = schnorr.sign(
    asMessage(hexToBytes(message)),
    key.witness,
    asMessage(randomBytes(32)),
  );
  return {
    signature,
    r: signature.slice(0, 32),
    s: signature.slice(32, 64),
  };
}

/**
 * Verifies a liveness signature against a *registered* commitment.
 *
 * This is the check a real ZK verifier performs inside a circuit: it can only be
 * passed by someone who re-derived the same `t`, i.e. reproduced the enrolled
 * biometric, and who signed this exact live challenge.
 */
export function verifyLivenessSignature(
  commitment: Bytes32,
  message: Bytes32,
  signature: Uint8Array,
): boolean {
  if (signature.length !== 64) return false;
  try {
    return schnorr.verify(
      asSignature(signature),
      asMessage(hexToBytes(message)),
      asMessage(hexToBytes(commitment)),
    );
  } catch {
    return false;
  }
}

/**
 * 1-byte anchor that stands in for the 64-byte signature inside the 32-byte
 * proof word: `uint8(keccak256(sigR ++ sigS)[31])`.
 */
export function signatureAnchor(signature: Uint8Array): number {
  const digest = hexToBytes(hash(signature.slice(0, 32), signature.slice(32, 64)));
  return digest[31];
}

/** Convenience: full 128-char hex signature, for the Proof Inspector. */
export const signatureHex = (signature: Uint8Array) => bytesToHex(signature);

const mod = (a: bigint, m: bigint) => ((a % m) + m) % m;
