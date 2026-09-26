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
  // Pin the trace root to *this* directory so Next does not walk up and pick up
  // an unrelated lockfile above the project.
  //
  // It must be the directory holding this file, not its parent. `dirname(dirname(…))`
  // points one level ABOVE the project: on Vercel (/vercel/path0/<repo>) that is
  // /vercel/path0, so the tracer looks for `.next/routes-manifest.json` outside
  // the build output and the build dies with
  //   ENOENT: … lstat '/vercel/path0/path0/.next/routes-manifest.json'
  // which reads like a corrupt cache but is a path bug. Pinning to the project
  // directory is also the documented way to stop upward lockfile discovery.
  outputFileTracingRoot: dirname(fileURLToPath(import.meta.url)),
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
