/**
 * Cryptographic primitives shared by the whole prover.
 *
 * Everything the browser does happens locally: no audio sample, no embedding
 * and no secret ever leaves this module towards a server. The only things that
 * reach Monad are the 32-byte public-signal words defined in `./pack.ts`.
 */
import { concat, keccak256, slice, stringToHex, type Hash } from "viem";

/** A 32-byte word, e.g. a commitment or a proof word. */
export type Bytes32 = Hash;

export const ZERO32: Bytes32 = `0x${"00".repeat(32)}`;

// ---------------------------------------------------------------------------
// Domain separation
// ---------------------------------------------------------------------------

/** Binds a public key to a biometric template (sign-to-contract). */
export const DOMAIN_BIOMETRIC = stringToHex("AEGIS_BIOMETRIC_V1");
/** Binds a liveness signature to a specific live challenge. */
export const DOMAIN_LIVENESS = stringToHex("AEGIS_LIVENESS_V1");
/** Salt derivation for a fresh device secret. */
export const DOMAIN_SALT = stringToHex("AEGIS_SALT_V1");

/** Keccak-256 over a list of hex chunks. */
export function hash(...parts: readonly Hexish[]): Bytes32 {
  return keccak256(concat(parts.map((p) => toHexPart(p))));
}

type Hexish = string | Bytes32 | Uint8Array;

function toHexPart(p: Hexish): `0x${string}` {
  if (typeof p === "string") return p as `0x${string}`;
  if (p instanceof Uint8Array) {
    let out = "0x";
    for (const b of p) out += b.toString(16).padStart(2, "0");
    return out as `0x${string}`;
  }
  return p;
}

// ---------------------------------------------------------------------------
// Randomness (CSPRNG only — never Math.random for anything security relevant)
// ---------------------------------------------------------------------------

export function randomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  crypto.getRandomValues(out);
  return out;
}

/** Uniform scalar in [1, n-1] for the curve group order. */
export function randomScalar(n: bigint): bigint {
  // 32 bytes of entropy is ample for a 252-bit order; rejection-sample anyway.
  for (;;) {
    const k = bytesToBigInt(randomBytes(32));
    if (k > 0n && k < n) return k;
  }
}

// ---------------------------------------------------------------------------
// Byte / bigint / hex conversions
// ---------------------------------------------------------------------------

export function bytesToHex(b: Uint8Array): `0x${string}` {
  return toHexPart(b);
}

export function bytesToBigInt(b: Uint8Array): bigint {
  let out = 0n;
  for (const byte of b) out = (out << 8n) | BigInt(byte);
  return out;
}

export function bigIntTo32Bytes(value: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let v = value;
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function utf8(str: string): Uint8Array {
  return new TextEncoder().encode(str);
}

export const bytes32 = (b: Uint8Array): Bytes32 =>
  bytesToHex(b) as Bytes32;

export const leftBytes = (h: Bytes32, n: number): Uint8Array => hexToBytes(slice(h, 0, n));

/**
 * Canonical 16-bit PCM byte view of a float capture.
 *
 * Used as the replay-ledger key, so it has to be *stable* and *collision
 * resistant*.
 *
 * The subtle trap this avoids: `new Uint8Array(int16Array)` does **not** view
 * the underlying buffer — it treats the Int16Array as an array-like and copies
 * each value into one byte, silently discarding the high byte. The correct form
 * wraps `.buffer` explicitly.
 */
export function int16PcmBytes(samples: Float32Array): Uint8Array {
  const pcm = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i] * 32767;
    pcm[i] = v < -32768 ? -32768 : v > 32767 ? 32767 : Math.round(v);
  }
  return new Uint8Array(pcm.buffer);
}

/** keccak256 over the canonical 16-bit PCM view — the replay-ledger key. */
export function pcmDigest(samples: Float32Array): Bytes32 {
  return hash(int16PcmBytes(samples));
}

const mod = (a: bigint, m: bigint) => ((a % m) + m) % m;
export { mod };

/** Human-facing short form, e.g. 0x1234…cdef */
export function shorten(hex: string, head = 6, tail = 4): string {
  if (hex.length <= head + tail + 2) return hex;
  return `${hex.slice(0, head)}…${hex.slice(-tail)}`;
}
