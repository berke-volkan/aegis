/**
 * Monad Testnet chain definition.
 *
 * Monad is fully EVM-equivalent, so viem needs nothing beyond the usual
 * `defineChain` metadata. Chain ID / explorers are from
 * https://docs.monad.xyz/developer-essentials/testnet
 *
 * NOTE on the RPC: the widely-copied `https://rpc.testnet.monad.xyz` does **not**
 * resolve any more. The endpoints the docs actually list are below; the first
 * one is the default, the rest are documented fallbacks (and the fallback chain
 * in `next.config.ts` handles a public node having a bad day).
 */
import { defineChain } from "viem";

export const MONAD_TESTNET_ID = 10143;

export const MONAD_TESTNET_RPC = process.env.NEXT_PUBLIC_MONAD_RPC_URL ?? "https://testnet-rpc.monad.xyz";

/** Public endpoints from the official docs, in preference order. */
export const MONAD_TESTNET_RPC_FALLBACKS = [
  "https://testnet-rpc.monad.xyz", // QuickNode, 50 rps
  "https://rpc-testnet.monadinfra.com", // Monad Foundation, 20 rps
  "https://rpc.ankr.com/monad_testnet", // Ankr
] as const;

export const monadTestnet = defineChain({
  id: MONAD_TESTNET_ID,
  name: "Monad Testnet",
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: {
    default: { http: [MONAD_TESTNET_RPC] },
  },
  blockExplorers: {
    default: { name: "Monadscan", url: "https://testnet.monadscan.com" },
  },
  testnet: true,
});

export const explorerTx = (hash: string) =>
  `${monadTestnet.blockExplorers.default.url}/tx/${hash}`;

export const explorerAddress = (address: string) =>
  `${monadTestnet.blockExplorers.default.url}/address/${address}`;
