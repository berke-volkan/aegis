import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

/**
 * AegisCallZK — the contract this project actually needs on Monad Testnet.
 *
 * The scaffold's `Counter.ts` deploys `Counter.sol`, which is unrelated to
 * Aegis and will be of no use here; use this module instead:
 *
 *   npx hardhat ignition deploy ignition/modules/AegisCallZK.ts --network monadTestnet
 *
 * The constructor takes no arguments, so no `args` are needed. No follow-up
 * `m.call(...)` is issued either: on a fresh deployment the only sensible next
 * step is a user enrolling their baseline, which is a wallet action, not a
 * deployer action.
 *
 * Deployment history is recorded in `ignition/deployments/chain-10143/`, so a
 * re-run on the same network is a no-op instead of a duplicate contract.
 */
export default buildModule("AegisCallZKModule", (m) => {
  const aegisCallZk = m.contract("AegisCallZK");

  return { aegisCallZk };
});
