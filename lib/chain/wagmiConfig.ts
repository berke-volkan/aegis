import { QueryClient } from "@tanstack/react-query";
import { cookieStorage, createConfig, createStorage, http } from "wagmi";

import { monadTestnet } from "./monad";
import { injectedConnector } from "../wallets/discovery";

/**
 * wagmi/viem setup.
 *
 * `ssr: true` + cookie storage keeps the connected account stable across a
 * server render, which is what stops wagmi/React hydration mismatches.
 *
 * Only ONE connector is registered, on purpose. The wallet is chosen at runtime
 * from what EIP-6963 discovery finds, and `injectedConnector.target` is aimed at
 * it (see `lib/wallets/discovery.ts`). Consequences:
 *   · no heavy connector bundles — the dedicated `coinbaseWallet` / `baseAccount`
 *     / `walletConnect` connectors drag in Coinbase's CDP SDK and ~10 further
 *     transitive deps, none of which a browser MVP needs,
 *   · `connector.name` / `connector.icon` reflect the wallet the user picked,
 *   · wagmi's cookie-storage reconnection keeps working across reloads.
 */
export const wagmiConfig = createConfig({
  chains: [monadTestnet],
  connectors: [injectedConnector],
  transports: {
    [monadTestnet.id]: http(monadTestnet.rpcUrls.default.http[0], {
      batch: { wait: 32 },
      retryCount: 3,
    }),
  },
  ssr: true,
  storage: createStorage({ storage: cookieStorage }),
});

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 4_000,
      retry: 2,
      refetchOnWindowFocus: false,
    },
  },
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
