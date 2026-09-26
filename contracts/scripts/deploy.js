/**
 * Deploys AegisCallZK.
 *
 *   local :  npx hardhat run scripts/deploy.js --network hardhat
 *   testnet: npx hardhat run scripts/deploy.js --network monadTestnet
 *
 * Set MONAD_TESTNET_PRIVATE_KEY in `contracts/.env` (never in the Next app).
 */
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const { createPublicClient, createWalletClient, custom, http, defineChain, getAddress } = require("viem");

const ROOT = path.resolve(__dirname, "../..");

/**
 * Official endpoint list: https://docs.monad.xyz/developer-essentials/testnet
 * NOTE: `https://rpc.testnet.monad.xyz` is still quoted in a lot of third-party
 * guides but no longer resolves — do not use it.
 */
const monadTestnet = defineChain({
  id: 10143,
  name: "Monad Testnet",
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: {
    default: { http: [process.env.MONAD_TESTNET_RPC_URL || "https://testnet-rpc.monad.xyz"] },
  },
  blockExplorers: { default: { name: "Monadscan", url: "https://testnet.monadscan.com" } },
  testnet: true,
});

/** Hardhat's first deterministic dev account — public, well-known, throwaway. */
const HARDHAT_ACCOUNT_0_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

async function main() {
  const isTestnet = hre.network.name === "monadTestnet";

  const chain = isTestnet ? monadTestnet : undefined;
  const transport = isTestnet ? http(monadTestnet.rpcUrls.default.http[0]) : custom(hre.network.provider);

  const { privateKeyToAccount } = require("viem/accounts");

  let account;
  if (isTestnet) {
    const raw = process.env.MONAD_TESTNET_PRIVATE_KEY;
    if (!raw) {
      throw new Error(
        "MONAD_TESTNET_PRIVATE_KEY is missing.\n" +
          "  · Hardhat 2 loads contracts/.env automatically — check the line is NOT commented out.\n" +
          "  · The private key must belong to the account you funded from https://faucet.monad.xyz\n" +
          "  · See contracts/.env.example",
      );
    }
    const key = raw.trim().startsWith("0x") ? raw.trim() : `0x${raw.trim()}`;
    account = privateKeyToAccount(key);
  } else {
    // In-process `hardhat` network. viem needs a *signing* account, not just an
    // address, so use Hardhat's well-known first dev key and assert it really is
    // account #0 of this network.
    account = privateKeyToAccount(HARDHAT_ACCOUNT_0_KEY);
    const [first] = await hre.network.provider.send("eth_accounts", []);
    if (getAddress(first.toLowerCase()) !== account.address) {
      throw new Error(
        `local deploy mismatch: hardhat's first account is ${first}, ` +
          `but the dev key resolves to ${account.address}`,
      );
    }
  }

  const walletClient = createWalletClient({ account, chain, transport });
  const publicClient = createPublicClient({ chain, transport });

  console.log("──────────────────────────────────────────────");
  console.log("  Aegis · AegisCallZK deployment");
  console.log("──────────────────────────────────────────────");
  console.log("  network  :", hre.network.name, isTestnet ? `(chainId ${monadTestnet.id})` : "");
  console.log("  deployer :", account.address);
  const balance = await publicClient.getBalance({ address: account.address });
  const mon = Number(balance) / 1e18;
  console.log("  balance  :", mon.toFixed(4), chain?.nativeCurrency.symbol ?? "ETH");

  // A testnet account with no funds fails deep inside the JSON-RPC layer with
  // an unhelpful "Invalid params", so catch it here with an actionable message.
  if (isTestnet && balance === 0n) {
    throw new Error(
      `deployer ${account.address} has 0 MON — fund it first:\n` +
        "  https://faucet.monad.xyz  (paste the address above)\n" +
        "  Monad testnet was reset from genesis on 2025-12-16, so old balances are gone.",
    );
  }

  const { abi, bytecode } = await hre.artifacts.readArtifact("AegisCallZK");

  const hash = await walletClient.deployContract({
    abi,
    bytecode,
    account,
    chain,
    args: [],
  });

  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error("deployment reverted");

  const address = getAddress(receipt.contractAddress);
  const [owner, livenessBps, similarityBps, root] = await Promise.all([
    publicClient.readContract({ abi, address, functionName: "owner" }),
    publicClient.readContract({ abi, address, functionName: "minLivenessBps" }),
    publicClient.readContract({ abi, address, functionName: "minSimilarityBps" }),
    publicClient.readContract({ abi, address, functionName: "challengeSetRoot" }),
  ]);

  console.log("──────────────────────────────────────────────");
  console.log("  contract :", address);
  console.log("  owner    :", owner);
  console.log("  thresholds: liveness", livenessBps, "/ similarity", similarityBps, "(bps)");
  console.log("  challengeSetRoot:", root);
  console.log("  gas used :", receipt.gasUsed.toString());
  if (chain) {
    console.log("  explorer :", `${chain.blockExplorers.default.url}/address/${address}`);
  } else {
    console.log("  explorer : (yerel ağ — yok)");
  }
  console.log("──────────────────────────────────────────────");

  // Persist the address for the Next.js app (public value, safe to commit).
  const envPath = path.join(ROOT, ".env.local");
  const line = `NEXT_PUBLIC_AEGIS_CONTRACT_ADDRESS=${address}`;
  const current = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
  const next = current.includes("NEXT_PUBLIC_AEGIS_CONTRACT_ADDRESS")
    ? current.replace(/^NEXT_PUBLIC_AEGIS_CONTRACT_ADDRESS=.*$/m, line)
    : `${current.trim()}\n${line}\n`;
  fs.writeFileSync(envPath, next, "utf8");
  console.log(`  wrote ${path.relative(ROOT, envPath)}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
