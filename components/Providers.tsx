"use client";

import { QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { WagmiProvider } from "wagmi";

import { queryClient, wagmiConfig } from "@/lib/chain/wagmiConfig";

export function Providers({ children }: { children: React.ReactNode }) {
  // A fresh client per mount keeps SSR/CSR boundaries clean.
  const [client] = useState(queryClient);
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    </WagmiProvider>
  );
}
