import hardhatToolboxViemPlugin from "@nomicfoundation/hardhat-toolbox-viem";
import { defineConfig } from "hardhat/config";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));

/**
 * Minimal `.env` loader.
 *
 * Hardhat 3 ships **no** dotenv support (Hardhat 2 loaded `.env` implicitly), so
 * `process.env.MONAD_TESTNET_PRIVATE_KEY` is always `undefined` unless you export
 * it in the shell. With `accounts: []` the deployer is unset and Ignition fails
 * deep in the JSON-RPC layer with the unhelpful
 * `ProviderError: Invalid params` on `eth_getTransactionCount`.
 *
 * Twelve lines beats adding a dependency for one variable — and it fails loudly
 * instead of silently deploying with an empty account list.
 */
function loadEnvFile(path: string): void {
  if (!existsSync(path)) return;
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    process.env[key] ??= value;
  }
}

// Both locations, so it does not matter which one you edit.
loadEnvFile(resolve(root, ".env"));
loadEnvFile(resolve(root, "contracts/.env"));

const rawKey = process.env.MONAD_TESTNET_PRIVATE_KEY?.trim();

/** Faucet UIs hand out keys without the `0x` prefix; accept both. */
function normalizeKey(key: string): string {
  return key.startsWith("0x") ? key : `0x${key}`;
}

const accounts = rawKey ? [normalizeKey(rawKey)] : [];

export default defineConfig({
  plugins: [hardhatToolboxViemPlugin],

  solidity: {
    profiles: {
      default: {
        version: "0.8.24", // Counter.sol (^0.8.24) and AegisCallZK.sol (0.8.24)
      },
      production: {
        version: "0.8.24",
        settings: {
          optimizer: {
            enabled: true,
            runs: 200,
          },
          // Conservative EVM target: nothing here needs PUSH0/MCOPY/transients.
          evmVersion: "paris",
        },
      },
    },
  },

  networks: {
    monadTestnet: {
      type: "http",
      // Official list: https://docs.monad.xyz/developer-essentials/testnet
      // `rpc.testnet.monad.xyz` is quoted in many guides but no longer resolves.
      url: process.env.MONAD_TESTNET_RPC_URL || "https://testnet-rpc.monad.xyz",
      chainId: 10143,
      accounts,
    },
  },
});
