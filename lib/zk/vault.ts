/**
 * Local witness vault.
 *
 * What a real deployment stores here: a device secret wrapped by the platform
 * keystore (WebAuthn PRF, Secure Enclave, Android Keystore) and never
 * extractable. For an MVP, `localStorage` is the honest choice *provided* the
 * README says plainly that this is a demo store, not a secure enclave.
 *
 * What is stored:
 *   · `salt`        the biometric key's secret scalar (THE witness)
 *   · `commitment`  the registered public key
 *   · `templateDigest`
 *   · `embedding`   the baseline MFCC vector, for the similarity comparison
 *   · `captures`    digests of every capture ever submitted (replay ledger)
 *
 * What is NOT stored: raw audio. The baseline sample lives in memory for the
 * duration of the tab session only.
 */
import type { Bytes32 } from "./primitives";

const KEY = "aegis.vault.v1";

export type VaultRecord = {
  version: 1;
  /** lower-cased address the baseline belongs to */
  address: string;
  salt: Bytes32;
  commitment: Bytes32;
  templateDigest: Bytes32;
  embedding: number[];
  /** keccak256 digests of PCM submitted in previous sessions */
  captures: Bytes32[];
  enrolledAt: number;
};

function isBrowser(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

export function loadVault(address: string): VaultRecord | null {
  if (!isBrowser()) return null;
  try {
    const raw = window.localStorage.getItem(`${KEY}:${address.toLowerCase()}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as VaultRecord;
    if (parsed.version !== 1 || parsed.address !== address.toLowerCase()) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveVault(record: VaultRecord): void {
  if (!isBrowser()) return;
  try {
    window.localStorage.setItem(`${KEY}:${record.address}`, JSON.stringify(record));
  } catch (err) {
    console.warn("[aegis] could not persist vault", err);
  }
}

export function clearVault(address: string): void {
  if (!isBrowser()) return;
  window.localStorage.removeItem(`${KEY}:${address.toLowerCase()}`);
}

/** Records a submitted capture so a later replay of it can be recognised. */
export function rememberCapture(address: string, digest: Bytes32, maxEntries = 24): void {
  const record = loadVault(address);
  if (!record) return;
  const captures = [digest, ...record.captures.filter((d) => d !== digest)].slice(0, maxEntries);
  saveVault({ ...record, captures });
}

export const embeddingToArray = (embedding: Float32Array): number[] =>
  Array.from(embedding, (v) => Math.round(v * 1e6) / 1e6);

export const arrayToEmbedding = (values: number[]): Float32Array =>
  Float32Array.from(values);
