/**
 * On-chain session ledger, read through wagmi.
 *
 * Everything the UI needs to know about the caller's Aegis state comes from
 * here: is a baseline registered, is a session live, what is the next
 * single-use `authNonce` the proof must embed, and what thresholds apply.
 */
"use client";

import { useReadContract, useReadContracts, useWriteContract, useWaitForTransactionReceipt } from "wagmi";
import { decodeEventLog, type Address, type Abi, type AbiEvent } from "viem";

import { AEGIS_ADDRESS, DEFAULT_THRESHOLDS, aegisCallZkAbi } from "./contract";
import { cooldownRemaining } from "./txErrors";
import { ZERO32, type Bytes32 } from "../zk/primitives";

export const SESSION_ABI = aegisCallZkAbi;

/** Shape of the contract's `Session` struct (see AegisCallZK.sol). */
export type OnChainSession = {
  registered: boolean;
  active: boolean;
  registeredAt: bigint;
  lastVerifiedAt: bigint;
  validUntil: bigint;
  lockoutUntil: bigint;
  authNonce: number;
  callCount: number;
  failedAttempts: number;
  lastBaselineChangeAt: bigint;
};

export function useAegisSession(address?: Address) {
  const enabled = Boolean(address && AEGIS_ADDRESS !== "0x");

  const session = useReadContract({
    address: AEGIS_ADDRESS,
    abi: aegisCallZkAbi,
    functionName: "getSession",
    args: address ? [address] : undefined,
    query: { enabled },
  });

  const commitment = useReadContract({
    address: AEGIS_ADDRESS,
    abi: aegisCallZkAbi,
    functionName: "baselineCommitment",
    args: address ? [address] : undefined,
    query: { enabled },
  });

  const active = useReadContract({
    address: AEGIS_ADDRESS,
    abi: aegisCallZkAbi,
    functionName: "isSessionActive",
    args: address ? [address] : undefined,
    query: { enabled },
  });

  const thresholds = useReadContract({
    address: AEGIS_ADDRESS,
    abi: aegisCallZkAbi,
    functionName: "getThresholds",
    query: { enabled },
  });

  const challengeSetRoot = useReadContract({
    address: AEGIS_ADDRESS,
    abi: aegisCallZkAbi,
    functionName: "challengeSetRoot",
    query: { enabled },
  });

  const nextChallengeSeed = useReadContract({
    address: AEGIS_ADDRESS,
    abi: aegisCallZkAbi,
    functionName: "nextChallengeSeed",
    args: address ? [address] : undefined,
    query: { enabled },
  });

  // The re-enrol cooldown is a *public constant* on the contract, so it is read
  // from the chain rather than hardcoded here. It matters to the UI: right after
  // a successful `registerBaseline` both `resetBaseline` and `registerBaseline`
  // revert with `CooldownActive`, which is the single most confusing state the
  // console can land in. Showing the real remaining time is the difference
  // between "this is broken" and "come back in 43 minutes".
  const reEnrollCooldown = useReadContract({
    address: AEGIS_ADDRESS,
    abi: aegisCallZkAbi,
    functionName: "RE_ENROLL_COOLDOWN",
    query: { enabled },
  });

  const raw = session.data as OnChainSession | undefined;

  return {
    isLoading: session.isLoading || commitment.isLoading,
    error: session.error,
    session: raw,
    registered: raw?.registered ?? false,
    isSessionActive: active.data ?? false,
    commitment: commitment.data as `0x${string}` | undefined,
    thresholds: {
      minLivenessBps: Number(thresholds.data?.[0] ?? DEFAULT_THRESHOLDS.minLivenessBps),
      minSimilarityBps: Number(thresholds.data?.[1] ?? DEFAULT_THRESHOLDS.minSimilarityBps),
    },
    challengeSetRoot: challengeSetRoot.data as Bytes32 | undefined,
    chainSeed: (nextChallengeSeed.data as Bytes32 | undefined) ?? ZERO32,
    authNonce: raw?.authNonce ?? 0,
    lockoutUntil: raw?.lockoutUntil ?? 0n,
    reEnrollCooldownSeconds: Number(reEnrollCooldown.data ?? 0),
    /** seconds until this address may register or reset again; 0 when free */
    reEnrollCooldownRemaining: (nowSeconds = Math.floor(Date.now() / 1000)) =>
      cooldownRemaining({
        lastBaselineChangeAt: raw?.lastBaselineChangeAt ?? 0n,
        cooldownSeconds: Number(reEnrollCooldown.data ?? 0),
        nowSeconds,
      }),
    refetch: () => {
      void session.refetch();
      void commitment.refetch();
      void active.refetch();
      void nextChallengeSeed.refetch();
      void reEnrollCooldown.refetch();
    },
  };
}

/** Which challenge ids the contract currently accepts. */
export function useEnabledChallenges() {
  const reads = useReadContracts({
    allowFailure: true,
    contracts: Array.from({ length: 8 }, (_, i) => ({
      address: AEGIS_ADDRESS,
      abi: aegisCallZkAbi,
      functionName: "isChallengeEnabled" as const,
      args: [i] as const,
    })),
    query: { enabled: AEGIS_ADDRESS !== "0x" },
  });

  const enabled: number[] = [];
  reads.data?.forEach((result, i) => {
    if (result.status === "success" && result.result === true) enabled.push(i);
  });
  // If the chain is unreachable, do not lock the demo out.
  return enabled.length > 0 ? enabled : Array.from({ length: 8 }, (_, i) => i);
}

// ===========================================================================
//  Transactions
// ===========================================================================

/**
 * Wraps `writeContract` + `waitForTransactionReceipt` and exposes the
 * *receipt* (not the query object) so callers can decode the Aegis events.
 */
function useAegisWrite() {
  const write = useWriteContract();
  const wait = useWaitForTransactionReceipt({ hash: write.data });

  return {
    writeContract: write.writeContract,
    hash: write.data,
    isPending: write.isPending,
    error: write.error ?? (wait.error ?? undefined),
    isSuccess: wait.isSuccess,
    isConfirming: write.isPending || (write.data ? wait.isLoading : false),
    receipt: wait.data,
    reset: write.reset,
  };
}

export type AegisWriteResult = ReturnType<typeof useAegisWrite>;

export const useRegisterBaseline = useAegisWrite;
export const useVerifyCall = useAegisWrite;
export const useResetBaseline = useAegisWrite;

// ===========================================================================
//  Event decoding — the receipt is the audit trail
// ===========================================================================

const EVENT_BY_NAME = {
  BaselineRegistered: "BaselineRegistered",
  BaselineReset: "BaselineReset",
  LivenessVerified: "LivenessVerified",
  LivenessRejected: "LivenessRejected",
  LockedOut: "LockedOut",
  SessionInvalidated: "SessionInvalidated",
} as const;

export type AegisEvent = {
  name: keyof typeof EVENT_BY_NAME;
  args: Record<string, unknown>;
};

/**
 * Decodes the Aegis events in a receipt.
 * The contract deliberately *does not revert* on a failed liveness check: it
 * emits `LivenessRejected` with the reason, so the UI learns the verdict from
 * the chain instead of from a revert string.
 */
export function decodeAegisEvents(logs: readonly unknown[] | undefined): AegisEvent[] {
  if (!logs?.length) return [];
  const out: AegisEvent[] = [];
  for (const raw of logs) {
    const log = raw as { topics: readonly string[]; data: string };
    if (!log?.topics?.[0]) continue;
    try {
      const decoded = decodeEventLog({
        abi: aegisCallZkAbi as Abi,
        data: log.data as `0x${string}`,
        topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
      });
      const name = decoded.eventName as keyof typeof EVENT_BY_NAME | undefined;
      if (name && name in EVENT_BY_NAME) {
        out.push({ name, args: (decoded.args ?? {}) as Record<string, unknown> });
      }
    } catch {
      // not one of ours (the contract call itself, or another contract)
    }
  }
  return out;
}

export function findRejection(events: readonly AegisEvent[]) {
  return events.find((e) => e.name === "LivenessRejected")?.args as
    | {
        user: Address;
        challengeId: number;
        reason: number;
        flags: number;
        similarityBps: number;
        livenessBps: number;
        failedAttempts: number;
      }
    | undefined;
}

export function findAcceptance(events: readonly AegisEvent[]) {
  return events.find((e) => e.name === "LivenessVerified")?.args as
    | {
        user: Address;
        challengeId: number;
        similarityBps: number;
        livenessBps: number;
        authNonce: number;
        validUntil: bigint;
      }
    | undefined;
}
