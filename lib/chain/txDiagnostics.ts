/**
 * Write-failure diagnosis.
 *
 * ── The problem ────────────────────────────────────────────────────────────
 * When a wallet is about to send a transaction it simulates it first. If the
 * simulation reverts, the user gets an error *from the wallet's RPC endpoint* —
 * not from us, and not from a node we control. Many public endpoints answer a
 * revert with JSON-RPC `code: -32000` and **no `data` field**, discarding the
 * revert payload. viem cannot decode what is not there and reports:
 *
 *   "Execution reverted for an unknown reason."
 *
 * which is a dead end: the contract has fifteen custom errors, each with an
 * actionable meaning, and none of them reach the screen.
 *
 * Verified against the live deployment: called through the documented
 * `https://testnet-rpc.monad.xyz` endpoint, every revert path returns a
 * properly encoded selector (`AlreadyRegistered` → `0x45ed80e9`,
 * `CooldownActive` → `0xc1ab61a1` + remaining seconds, …) and a never-enrolled
 * address registers successfully. The contract is fine; the wallet's endpoint
 * is not telling us why.
 *
 * ── The fix ────────────────────────────────────────────────────────────────
 * Re-run the exact same call as a read-only `eth_call` against an endpoint we
 * control, and decode the revert from *that* answer. The caller's address is
 * used as `from`, so the simulation sees their real state — the same thing the
 * wallet did, minus the lossy hop. The pure parts (`decodeRevertData`,
 * `classifyWriteFailure`) are separated from the network call so they can be
 * tested.
 */
import { decodeErrorResult, encodeFunctionData, toFunctionSelector, type Abi, type AbiFunction, type Address } from "viem";

/** Error name for a raw 4-byte revert selector, straight from the ABI. */
export function selectorName(data: string, abi: Abi): string | undefined {
  if (typeof data !== "string" || data.length < 10) return undefined;
  const selector = data.slice(0, 10).toLowerCase();
  for (const item of abi) {
    if (item.type !== "error") continue;
    const sig = `${item.name}(${item.inputs.map((i) => i.type).join(",")})`;
    try {
      if (toFunctionSelector(sig).toLowerCase() === selector) return item.name;
    } catch {
      // an ABI entry viem cannot hash — skip it rather than crash
    }
  }
  return undefined;
}

/**
 * Decodes a raw revert payload into an error name.
 *
 * Tries `decodeErrorResult` first (which yields the arguments too, so
 * `CooldownActive(1812)` can be rendered) and falls back to matching the
 * selector by hand, which survives an ABI viem cannot fully parse.
 */
export function decodeRevertData(data: string | undefined, abi: Abi): string | undefined {
  if (!data || data.length < 10) return undefined;
  try {
    const result = decodeErrorResult({ abi, data: data as `0x${string}` });
    return result.errorName;
  } catch {
    return selectorName(data, abi);
  }
}

export type SimulationResult = {
  /** the RPC answered at all */
  reachable: boolean;
  /** the call would succeed */
  ok: boolean;
  /** raw revert payload, when it reverted */
  data?: string;
  /** decoded error name, when we could resolve it */
  errorName?: string;
  /** the node's own message, for the case where there is no data */
  nodeMessage?: string;
  /** JSON-RPC error code — `-32000` with no data is the lossy-node tell */
  code?: number;
};

const FALLBACK_RPCS = [
  "https://testnet-rpc.monad.xyz",
  "https://rpc-testnet.monadinfra.com",
  "https://rpc.ankr.com/monad_testnet",
] as const;

/**
 * Runs the call as a read-only `eth_call`, trying each endpoint in turn.
 *
 * Deliberately uses `fetch` rather than a viem client: the whole point is to see
 * the *raw* JSON-RPC payload, including a missing `data` field, which viem would
 * have already converted into an opaque `UnknownContractError`.
 */
export async function simulateCall(params: {
  to: Address;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
  from?: Address;
  blockTag?: "latest" | "pending";
  rpcUrls?: readonly string[];
  /** per-endpoint timeout */
  timeoutMs?: number;
}): Promise<SimulationResult> {
  const item = params.abi.find(
    (a): a is AbiFunction => a.type === "function" && a.name === params.functionName,
  );
  if (!item) return { reachable: false, ok: false, nodeMessage: "ABI'de bu fonksiyon yok" };

  const data = encodeFunctionData({
    abi: params.abi,
    functionName: item.name,
    args: (params.args ?? []) as never,
  });

  for (const url of params.rpcUrls ?? FALLBACK_RPCS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), params.timeoutMs ?? 8_000);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_call",
          params: [{ from: params.from, to: params.to, data }, params.blockTag ?? "latest"],
        }),
        signal: controller.signal,
      });
      const json = (await res.json()) as {
        result?: string;
        error?: { code?: number; message?: string; data?: unknown };
      };
      if (json.error) {
        const raw = json.error.data;
        return {
          reachable: true,
          ok: false,
          // some nodes return data as an object: { data: "0x…" }
          data: typeof raw === "string" ? raw : undefined,
          errorName:
            typeof raw === "string" ? decodeRevertData(raw, params.abi) : undefined,
          nodeMessage: json.error.message,
          code: json.error.code,
        };
      }
      return { reachable: true, ok: true };
    } catch {
      // endpoint down or timed out — try the next one
    } finally {
      clearTimeout(timer);
    }
  }
  return { reachable: false, ok: false, nodeMessage: "Monad RPC'lerine ulaşılamadı" };
}

export type WriteFailure = {
  /** what the wallet reported, rendered through the error table */
  walletMessage: string;
  /** true when the reason came from our own simulation rather than the wallet */
  authoritative: boolean;
};

/**
 * Produces the single message the UI shows for a failed write.
 *
 * The wallet's own message is used when it decoded something; otherwise the
 * simulation is trusted, because we know that endpoint returns the payload. If
 * the simulation *succeeds* while the wallet still refuses, the contract is
 * happy and the problem is on the sending side (wrong network, no gas, or a
 * broken endpoint) — which is a different message and a different fix.
 */
export function classifyWriteFailure(params: {
  walletMessage: string;
  simulation: SimulationResult;
  renderError: (name: string, data?: string) => string;
  functionName: string;
}): WriteFailure {
  const { walletMessage, simulation, renderError, functionName } = params;

  if (simulation.reachable && !simulation.ok && simulation.errorName) {
    return {
      walletMessage: renderError(simulation.errorName, simulation.data),
      authoritative: true,
    };
  }

  if (simulation.reachable && simulation.ok) {
    return {
      walletMessage:
        `Kontrat bu çağrıyı kabul ediyor, yani sorun kontratta değil. ` +
        `Cüzdanın gönderimi reddetti — ağ Monad Testnet (10143) değil, ` +
        `hesapta MON yok, ya da cüzdanın RPC ucu bozuk. ` +
        `Ağ ve bakiyeyi kontrol et.`,
      authoritative: true,
    };
  }

  if (simulation.reachable && !simulation.ok && !simulation.errorName) {
    const code = simulation.code !== undefined ? ` (JSON-RPC kodu ${simulation.code})` : "";
    return {
      walletMessage:
        `Revert verisi alınamadı${code}: ${simulation.nodeMessage ?? "bilinmeyen"} — ` +
        `düğüm hata verisini taşımıyor. Cüzdanın RPC ucunu değiştirip tekrar deneyin.`,
      authoritative: true,
    };
  }

  return { walletMessage, authoritative: false };
}
