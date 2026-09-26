/**
 * AegisCallZK — Hardhat 2 yapılandırması (yalnızca kontrat testleri + deploy).
 *
 * ⚠️ NEDEN TypeScript?
 *
 * Hardhat 2 config dosyasını `findUp` ile bulur ve **öncelik sırası
 * `.ts` → `.cts` → `.cjs/.js`** olmak üzere **yukarı doğru** arar. Depo kökünde
 * bir `hardhat.config.ts` (Hardhat 3) varsa, `contracts/` içinden çalıştırılan
 * Hardhat 2 onu bulur ve Hardhat 3 formatındaki bir config'i doğrulamaya
 * çalışır — sessizce yanlış projeyi derler.
 *
 * Bu dosya `.ts` olmasaydı o gölgeleme olurdu. `.ts` olması sayesinde `findUp`
 * `contracts/` dizininde durur ve doğru config bulunur.
 *
 * NOT: Bu, iki Hardhat sürümünün bir arada bulunması ideal değildir. Kökteki
 * Hardhat 3 kurulumuna tekilleştirmek için README'deki "Tekilleştirme" notuna
 * bakın.
 */
import type { HardhatUserConfig } from "hardhat/config";

/**
 * Private keys are frequently pasted without the `0x` prefix (that is what most
 * faucet UIs hand out). Normalising here means the same key works either way.
 */
function normalizeKey(key: string): string {
  const trimmed = key.trim();
  return trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`;
}

const config: HardhatUserConfig = {
  paths: {
    sources: "./src",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 800 },
      // Monad's EVM is Cancun-class, but `paris` is the conservative choice:
      // no PUSH0/MCOPY/TSTORE transients required by this contract anyway.
      evmVersion: "paris",
    },
  },
  networks: {
    hardhat: {
      // Mirror Monad Testnet's chain id so contract behaviour is identical.
      chainId: 10143,
    },
    monadTestnet: {
      // Official list: https://docs.monad.xyz/developer-essentials/testnet
      // (`rpc.testnet.monad.xyz` is quoted in many guides but no longer resolves.)
      url: process.env.MONAD_TESTNET_RPC_URL || "https://testnet-rpc.monad.xyz",
      chainId: 10143,
      accounts: process.env.MONAD_TESTNET_PRIVATE_KEY
        ? [normalizeKey(process.env.MONAD_TESTNET_PRIVATE_KEY)]
        : [],
    },
  },
  mocha: {
    timeout: 120_000,
  },
};

export default config;
