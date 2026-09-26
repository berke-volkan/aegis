/**
 * Deployed contract address.
 *
 * Set `NEXT_PUBLIC_AEGIS_CONTRACT_ADDRESS` in `.env.local`. `npm run
 * contract:deploy` writes it for you. When it is still the zero address the UI
 * degrades into "not deployed" mode instead of throwing, so the frontend can be
 * developed before the contract exists.
 */
import { isAddress, zeroAddress, type Address } from "viem";

import { aegisCallZkAbi } from "../abi";

export { aegisCallZkAbi };

const raw = process.env.NEXT_PUBLIC_AEGIS_CONTRACT_ADDRESS;

export const AEGIS_ADDRESS: Address =
  raw && isAddress(raw) ? (raw as Address) : zeroAddress;

export const IS_DEPLOYED = AEGIS_ADDRESS !== zeroAddress;

/** Reads the contract's acceptance thresholds; falls back to the Solidity defaults. */
export const DEFAULT_THRESHOLDS = {
  minLivenessBps: 7_000,
  minSimilarityBps: 6_200,
} as const;
