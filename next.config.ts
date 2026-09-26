import type { NextConfig } from "next";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `@wagmi/connectors` re-exports the Base Account connector, whose Coinbase CDP
 * SDK has *optional* dependencies on the x402 / Solana packages (Node-only
 * payment paths that a browser build never executes). Webpack still walks the
 * barrel and tries to resolve them, so the scopes resolve to nothing.
 *
 * If this app ever needs x402 or Solana payments, install those packages and
 * delete `resolve.fallback` below.
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Pin the workspace root so Next does not walk up and pick up an unrelated
  // lockfile above this directory.
  outputFileTracingRoot: dirname(dirname(fileURLToPath(import.meta.url))),
  experimental: {
    // wagmi/viem ship large ESM bundles; keep them in their own chunk
    optimizePackageImports: ["wagmi", "viem", "@wagmi/connectors"],
  },
  webpack: (config) => {
    config.resolve = config.resolve ?? {};
    config.resolve.fallback = {
      ...config.resolve.fallback,
      // Nothing in a browser build may reach these Node/React-Native optional
      // dependencies, so resolve them to nothing instead of letting webpack walk
      // into code paths that are never executed.
      "@x402": false, // Coinbase CDP x402 payments
      "@solana": false, // Coinbase CDP SVM accounts
      "@react-native-async-storage/async-storage": false, // @metamask/sdk
      "pino-pretty": false, // pino dev transport
    };
    return config;
  },
};

export default nextConfig;
