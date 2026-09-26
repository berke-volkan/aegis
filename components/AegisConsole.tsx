"use client";

import Image from "next/image";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAccount } from "wagmi";
import type { Address } from "viem";

import { MicUnavailableError, startRecording, type RecorderHandle } from "@/lib/audio/recorder";
import {
  analyseVoiceprint,
} from "@/lib/audio/features";
import { AEGIS_ADDRESS, IS_DEPLOYED, aegisCallZkAbi } from "@/lib/chain/contract";
import {
  decodeAegisEvents,
  findAcceptance,
  findRejection,
  useAegisSession,
  useEnabledChallenges,
  useRegisterBaseline,
  useResetBaseline,
  useVerifyCall,
} from "@/lib/chain/useAegis";
import { explorerTx, MONAD_TESTNET_ID } from "@/lib/chain/monad";
import { step1Blockers, step1Hint, step1State } from "@/lib/chain/step1";
import { describeTxError, formatDuration, renderContractError } from "@/lib/chain/txErrors";
import { classifyWriteFailure, simulateCall } from "@/lib/chain/txDiagnostics";
import { restoreKey } from "@/lib/zk/biometricKey";
import { createBaselineProof, BASELINE_PHRASES, BASELINE_TARGET_MS } from "@/lib/zk/baseline";
import { ENROLL_MIN_LIVENESS_BPS } from "@/lib/zk/enrollmentLiveness";
import { issueChallenge, type LivenessChallenge } from "@/lib/zk/challenges";
import { proveLiveness, scoreLiveness, type LivenessTranscript } from "@/lib/zk/liveness";
import { pcmDigest, type Bytes32 } from "@/lib/zk/primitives";
import { SPOOF_LABELS, normalise, synthesiseSpoof, type SpoofKind } from "@/lib/zk/spoof";
import { useAvailableWallets } from "@/lib/wallets/discovery";
import {
  arrayToEmbedding,
  clearVault,
  embeddingToArray,
  loadVault,
  rememberCapture,
  saveVault,
  type VaultRecord,
} from "@/lib/zk/vault";
import { ProofInspector } from "./ProofInspector";
import { INSTALL_SUGGESTIONS } from "@/lib/wallets/catalog";
import { WalletLogo } from "./WalletLogo";
import { ChallengeCard, Stepper, StatRow, rejectionLabel, type Step } from "./StepViews";
import { VerdictBadge, type Verdict } from "./VerdictBadge";
import { VoiceOrb } from "./VoiceOrb";
import { Button, Meter, Panel, Pill, SectionTitle } from "./ui";

export function AegisConsole() {
  const { address, isConnected, chain } = useAccount();
  const wrongChain = isConnected && chain?.id !== MONAD_TESTNET_ID;

  const onchain = useAegisSession(address);
  const enabledChallenges = useEnabledChallenges();
  const register = useRegisterBaseline();
  const reset = useResetBaseline();
  const verify = useVerifyCall();
  const { wallets, isDetecting: isDetectingWallets } = useAvailableWallets();
  const noWallet = !isConnected && !isDetectingWallets && wallets.length === 0;

  // ---- local witness state -------------------------------------------
  const [vault, setVault] = useState<VaultRecord | null>(null);
  const [baselineEmbedding, setBaselineEmbedding] = useState<Float32Array | null>(null);

  // ---- step 1 ----------------------------------------------------------
  const [baselineStep, setBaselineStep] = useState<Step>("idle");
  const [levels, setLevels] = useState<number[]>([]);
  // Canlı seviye ölçümü (tam ölçek payı olarak) — reddedilen kayıtların
  // teşhisi için kullanıcıya gösteriliyor.
  const [peakLevel, setPeakLevel] = useState(0);
  const [rmsLevel, setRmsLevel] = useState(0);
  const [baselineResult, setBaselineResult] = useState<ReturnType<typeof createBaselineProof> | null>(null);
  const recorderRef = useRef<RecorderHandle | null>(null);

  // ---- step 2 ----------------------------------------------------------
  const [callStep, setCallStep] = useState<Step>("idle");
  const [challenge, setChallenge] = useState<LivenessChallenge | null>(null);
  const [callLevels, setCallLevels] = useState<number[]>([]);
  const [transcript, setTranscript] = useState<LivenessTranscript | null>(null);
  const [proofWord, setProofWord] = useState<Bytes32 | null>(null);
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [spoof, setSpoof] = useState<SpoofKind>("none");
  const [error, setError] = useState<string | null>(null);
  /**
   * Decoded write-failure detail, kept apart from `error` because it is
   * produced asynchronously by our own RPC simulation and carries the wallet's
   * original wording alongside ours.
   */
  const [txError, setTxError] = useState<{ message: string; note: string | null; pending: boolean } | null>(null);
  const [onchainWord, setOnchainWord] = useState<Parameters<typeof ProofInspector>[0]["onChainWord"]>();
  const callRecorderRef = useRef<RecorderHandle | null>(null);

  // ---- hydrate the local vault whenever the account changes -----------
  useEffect(() => {
    if (!address) {
      setVault(null);
      setBaselineEmbedding(null);
      return;
    }
    const record = loadVault(address);
    setVault(record);
    // Only the embedding is needed from the enrolled baseline — similarity is
    // the sole thing it contributes to scoring.
    setBaselineEmbedding(record ? arrayToEmbedding(record.embedding) : null);
  }, [address]);

  const hasLocalBaseline = Boolean(vault);
  const isEnrolledOnChain = onchain.registered;

  // ---- STEP 1 state machine ---------------------------------------------
  // `hasLocalBaseline && isEnrolledOnChain` tek başına hem yeterli hem de
  // yeterince dürüst değil: vault, `registerBaseline` işlemi onaylandıktan
  // SONRA yazılıyor, yani "yerel witness var mı?" cevabı aynı zamanda "zincire
  // kaydedildi mi?" cevabı. Commitment'i yazma paneli de `hasLocalBaseline`
  // koşuluna bağlıydı → ilk kayıtta hiç görünmüyor, kullanıcı sonsuza kadar
  // kilitleniyordu. İki yarı ayrı ayrı takip ediliyor; bkz. lib/chain/step1.ts.
  const step1Inputs = {
    hasAddress: Boolean(address),
    baselineCaptured: Boolean(baselineResult?.ok),
    hasLocalBaseline,
    isEnrolledOnChain,
  };
  const s1 = step1State(step1Inputs);
  const step1Done = s1 === "done";
  const needsOnChainWrite = s1 === "awaiting-registration";
  const orphanOnChain = s1 === "orphan";

  // ---- live cooldown clock ----------------------------------------------
  // The remaining wait is chain state that changes with wall-clock time, so it
  // needs its own tick; a stale "43 minutes" left on screen for ten minutes is
  // worse than no countdown at all.
  const [nowSeconds, setNowSeconds] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => setNowSeconds(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, []);
  const cooldownLeft = onchain.reEnrollCooldownRemaining(nowSeconds);

  // ---- cleanup recorders on unmount -----------------------------------
  useEffect(
    () => () => {
      recorderRef.current?.dispose();
      callRecorderRef.current?.dispose();
    },
    [],
  );

  const commitCapture = useCallback(
    (digest: Bytes32) => {
      if (!address) return;
      rememberCapture(address, digest);
      setVault(loadVault(address));
    },
    [address],
  );

  // =====================================================================
  //  STEP 1 — record the baseline
  // =====================================================================
  async function recordBaseline() {
    setError(null);
    setBaselineStep("recording");
    setLevels([]);
    setPeakLevel(0);
    setRmsLevel(0);
    try {
      const handle = await startRecording({
        maxMs: BASELINE_TARGET_MS + 2_000,
        onLevel: (level, history) => {
          setLevels([...history]);
          // Track the running peak and a slow RMS so the meter shows something
          // meaningful rather than a value that flickers to zero between words.
          setPeakLevel((p) => Math.max(p, level));
          setRmsLevel((r) => r * 0.9 + level * 0.1);
        },
      });
      recorderRef.current = handle;

      // capture for the target duration, then stop
      await new Promise((r) => setTimeout(r, BASELINE_TARGET_MS));
      const samples = await handle.stop();
      const capturedMs = (samples.length / 16_000) * 1000;
      recorderRef.current = null;
      setBaselineStep("proving");

      const result = createBaselineProof(samples, 16_000);
      setBaselineResult(result);

      if (!result.ok) {
        // Her mesaj ölçülen değeri içerir. "Yeterince yüksek sesle konuşun"
        // eyleme dönüşmez; "tepe %0,8, gereken >%1" dönüşür.
        setError(
          [
            `Kayıt kullanılamaz (${(capturedMs / 1000).toFixed(1)} sn ses alındı).`,
            ...result.problems,
            "Tarayıcının mikrofon izinlerini ve mikrofon kazancını kontrol edin, sonra tekrar deneyin.",
          ].join(" "),
        );
        setBaselineStep("idle");
        return;
      }

      // Keep the raw sample in memory only (never in localStorage) so the
      // demo's "replay" attack can re-submit a bit-identical buffer.
      (window as unknown as { __aegisBaselineSamples?: Float32Array }).__aegisBaselineSamples = samples;
      setBaselineEmbedding(result.embedding);
      setBaselineStep("done");
    } catch (err) {
      setBaselineStep("idle");
      setError(
        err instanceof MicUnavailableError ? err.message : `Mikrofon hatası: ${(err as Error).message}`,
      );
    }
  }

  async function submitBaseline() {
    if (!address || !baselineResult?.ok) return;
    setError(null);
    try {
      await register.writeContract({
        address: AEGIS_ADDRESS,
        abi: aegisCallZkAbi,
        functionName: "registerBaseline",
        args: [address, baselineResult.commitment],
        chainId: MONAD_TESTNET_ID,
      });
    } catch (err) {
      await reportWriteFailure(err, register, "registerBaseline", [address, baselineResult.commitment]);
    }
  }

  /**
   * Turns a failed write into a message that names the actual cause.
   *
   * Two layers. `describeTxError` first digs the revert payload back out of
   * viem's error chain and decodes it locally — viem drops `data` while building
   * its message and reports "unknown reason" for every one of the contract's
   * errors, but the payload is still three levels down.
   *
   * Only if that comes up empty do we spend a network round trip: the same call
   * re-run as `eth_call` against endpoints we control, with the caller's
   * address as `from`, so the simulation sees their real state. That also
   * answers the distinct question of whether the contract *would* have accepted
   * the call — if it would, the fault is on the sending side.
   */
  async function reportWriteFailure(
    err: unknown,
    write: { error?: unknown },
    functionName: string,
    args: readonly unknown[],
  ) {
    const source = write.error ?? err;
    const walletMessage = describeTxError(source, functionName);
    setTxError({ message: walletMessage, note: null, pending: false });

    // Locally decoded a real contract error — no reason to ask the network.
    if (!/unknown reason|unknown custom error/.test(walletMessage)) return;
    if (/reddedildi/.test(walletMessage)) return;

    setTxError({ message: walletMessage, note: null, pending: true });
    try {
      const simulation = await simulateCall({
        to: AEGIS_ADDRESS as Address,
        abi: aegisCallZkAbi,
        functionName,
        args,
        from: address as Address,
      });
      const verdict = classifyWriteFailure({
        walletMessage,
        simulation,
        functionName,
        renderError: renderContractError,
      });
      setTxError({ message: verdict.walletMessage, note: walletMessage, pending: false });
    } catch {
      setTxError({ message: walletMessage, note: null, pending: false });
    }
  }

  // The wallet can report failure through the hook as well as by throwing, and
  // which one happens depends on whether it fails at estimateGas or at send.
  // Both have to be diagnosed, and the args have to be reconstructed here
  // because the hook error carries no parameters.
  useEffect(() => {
    if (register.error) {
      void reportWriteFailure(register.error, register, "registerBaseline", [
        address,
        baselineResult?.commitment ?? ("0x" + "00".repeat(32) as Bytes32),
      ]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [register.error]);

  useEffect(() => {
    if (reset.error) void reportWriteFailure(reset.error, reset, "resetBaseline", [address]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reset.error]);

  useEffect(() => {
    if (verify.error) {
      void reportWriteFailure(verify.error, verify, "verifyCallWithLiveness", [
        address,
        proofWord ?? ("0x" + "00".repeat(32) as Bytes32),
        challenge?.id ?? 0,
      ]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [verify.error]);

  useEffect(() => {
    if (register.isSuccess) {
      persistVault();
      onchain.refetch();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [register.isSuccess]);

  function persistVault() {
    if (!address || !baselineResult?.ok) return;
    const record: VaultRecord = {
      version: 1,
      address: address.toLowerCase(),
      salt: baselineResult.key.salt,
      commitment: baselineResult.commitment,
      templateDigest: baselineResult.templateDigest,
      embedding: embeddingToArray(baselineResult.embedding),
      captures: [],
      enrolledAt: Date.now(),
    };
    saveVault(record);
    commitCapture(baselineResult.audioDigest);
    setVault(loadVault(address));
  }

  /**
   * Drops the on-chain baseline so a fresh one can be enrolled.
   *
   * Needed for the "registered on chain but the local witness is gone" case:
   * `registerBaseline` reverts with `AlreadyRegistered`, so without a reset that
   * address can never re-enrol.
   */
  async function submitReset() {
    if (!address) return;
    setError(null);
    try {
      await reset.writeContract({
        address: AEGIS_ADDRESS,
        abi: aegisCallZkAbi,
        functionName: "resetBaseline",
        args: [address],
        chainId: MONAD_TESTNET_ID,
      });
    } catch (err) {
      await reportWriteFailure(err, reset, "resetBaseline", [address]);
    }
  }

  useEffect(() => {
    if (reset.isSuccess) {
      setBaselineResult(null);
      setBaselineEmbedding(null);
      setVault(null);
      onchain.refetch();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reset.isSuccess]);

  /** Throws away the captured proof so the record UI comes back. */
  function discardCapture() {
    setBaselineResult(null);
    setBaselineEmbedding(null);
    setBaselineStep("idle");
    setLevels([]);
    setPeakLevel(0);
    setRmsLevel(0);
  }

  // =====================================================================
  //  STEP 2a — issue a live challenge
  // =====================================================================
  async function startCall() {
    setError(null);
    setTranscript(null);
    setProofWord(null);
    setVerdict(null);
    setCallLevels([]);
    setCallStep("recording");

    const c = issueChallenge({
      chainSeed: onchain.chainSeed,
      user: address ?? "0x0",
      enabledIds: enabledChallenges,
    });
    setChallenge(c);
  }

  // =====================================================================
  //  STEP 2b/c — capture, score, prove
  // =====================================================================
  async function recordAndProve() {
    if (!challenge || !address || !vault || !baselineEmbedding) return;
    setError(null);
    setCallStep("recording");
    setCallLevels([]);

    try {
      const captureStartedAt = Date.now();
      const handle = await startRecording({
        maxMs: 6_000,
        onLevel: (_lvl, history) => setCallLevels([...history]),
      });
      callRecorderRef.current = handle;
      await new Promise((r) => setTimeout(r, 4_200));
      let samples = await handle.stop();
      callRecorderRef.current = null;

      // --- attack simulation harness (the detector is untouched) --------
      if (spoof === "replay") {
        const stored = (window as unknown as { __aegisBaselineSamples?: Float32Array })
          .__aegisBaselineSamples;
        if (stored) samples = new Float32Array(stored);
      } else if (spoof === "synthetic" || spoof === "impostor") {
        samples = normalise(
          synthesiseSpoof({ kind: spoof, baselineF0: 120, seconds: 4.2 }),
        );
      }

      setCallStep("proving");
      await new Promise((r) => setTimeout(r, 350)); // let the "analysing" state paint

      // ---- 1. analyse the capture ------------------------------------
      const capture = analyseVoiceprint(samples, 16_000);
      const audioDigest = pcmDigest(samples);

      // ---- 2. score it against the baseline -------------------------
      // `captureStartedAt` lets the scorer measure read-and-react latency from
      // the moment the challenge appeared, not from the start of the capture.
      const scored = scoreLiveness({
        capture,
        baselineEmbedding,
        challenge,
        audioDigest,
        priorDigests: (vault.captures ?? []).map((d) => d as Bytes32),
        captureStartedAt: captureStartedAt,
      });

      // ---- 3. build + sign the 32-byte proof word --------------------
      // The signing key is re-derived from the vault's witness material and
      // checked against the on-chain commitment, so a tampered local vault
      // fails here rather than producing an unusable proof.
      const registeredCommitment = (onchain.commitment ?? vault.commitment) as Bytes32;
      const key = restoreKey({
        salt: vault.salt as Bytes32,
        templateDigest: vault.templateDigest as Bytes32,
        expectedCommitment: registeredCommitment,
      });

      const transcriptResult = proveLiveness({
        scored,
        key,
        registeredCommitment,
        user: address as Address,
        challenge,
        authNonce: onchain.authNonce,
        thresholds: onchain.thresholds,
      });

      setTranscript(transcriptResult);
      setProofWord(transcriptResult.proofWord);
      commitCapture(audioDigest);

      // ---- 4. local verdict (shown immediately) ---------------------
      setVerdict({
        ok: transcriptResult.accepted,
        headline: transcriptResult.accepted
          ? "ZK-Verified Human: Baseline & Liveness Matched"
          : "🚨 Deepfake / Replay Attack Detected!",
        title: transcriptResult.accepted ? "Doğrulandı" : "Saldırı",
        detail: transcriptResult.accepted
          ? "Ses, kayıtlı biyometrik temelle eşleşti ve canlılık kontrollerini geçti. Kanıt Monad'a gönderiliyor."
          : "Ses canlı bir insanla eşleşmedi. Tespit edilen sinyaller Monad'a audit izi olarak kaydedilecek.",
        similarityBps: transcriptResult.similarityBps,
        livenessBps: transcriptResult.livenessBps,
        flagNames: transcriptResult.flagNames,
        reasons: transcriptResult.reasons,
        biometricKeyMatched: transcriptResult.biometricKeyMatched,
        signatureValid: transcriptResult.signatureValid,
        thresholds: onchain.thresholds,
        onChain: "pending",
      });

      // ---- 5. submit on-chain ----------------------------------------
      setCallStep("proving");
      await verify.writeContract({
        address: AEGIS_ADDRESS,
        abi: aegisCallZkAbi,
        functionName: "verifyCallWithLiveness",
        args: [address, transcriptResult.proofWord, challenge.id],
        chainId: MONAD_TESTNET_ID,
      });
      setCallStep("done");
    } catch (err) {
      setCallStep("idle");
      setError(`Liveness yakalama hatası: ${(err as Error).message}`);
    }
  }

  // ---- read the verdict back out of the receipt ------------------------
  useEffect(() => {
    if (!verify.receipt?.logs || !transcript) return;
    const events = decodeAegisEvents(verify.receipt.logs as never);
    const accepted = findAcceptance(events);
    const rejected = findRejection(events);
    const hash = verify.receipt.transactionHash;

    if (accepted) {
      setOnchainWord({
        version: 1,
        challengeId: Number(accepted.challengeId),
        livenessBps: Number(accepted.livenessBps),
        similarityBps: Number(accepted.similarityBps),
        flags: 0,
        authNonce: Number(accepted.authNonce),
      });
      setVerdict((v) =>
        v
          ? {
              ...v,
              ok: true,
              onChain: "confirmed",
              txHash: hash,
              explorerUrl: explorerTx(hash),
              detail:
                "Ses kayıtlı biyometrik temelle eşleşti, canlılık kontrollerini geçti ve oturum Monad'da doğrulandı.",
            }
          : v,
      );
    } else if (rejected) {
      setOnchainWord({
        version: 1,
        challengeId: Number(rejected.challengeId),
        livenessBps: Number(rejected.livenessBps),
        similarityBps: Number(rejected.similarityBps),
        flags: Number(rejected.flags),
        authNonce: transcript.authNonce,
      });
      setVerdict((v) =>
        v
          ? {
              ...v,
              ok: false,
              onChain: "rejected-onchain",
              txHash: hash,
              explorerUrl: explorerTx(hash),
              detail: `Kontrat bu kanıtı reddetti (sebep: ${rejectionLabel(Number(rejected.reason))}). Oturum açılmadı, deneme audit izine yazıldı.`,
            }
          : v,
      );
    }
    onchain.refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [verify.receipt?.transactionHash]);

  const sessionTone = useMemo(() => {
    if (!isEnrolledOnChain) return "neutral" as const;
    return onchain.isSessionActive ? ("aegis" as const) : ("warn" as const);
  }, [isEnrolledOnChain, onchain.isSessionActive]);

  // =====================================================================
  //  Render
  // =====================================================================
  return (
    <div className="mx-auto w-full max-w-6xl px-4 pb-24 sm:px-6">
      {/* ---------- header ---------- */}
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <div className="grid size-9 place-items-center rounded-xl border border-aegis/40 bg-aegis/10 text-lg">
            🛡️
          </div>
          <div>
            <h1 className="text-base font-bold tracking-tight text-ink">Aegis</h1>
            <p className="font-mono text-[10px] text-ink-faint">
              ZK · Canlı Arama Doğrulama · Monad Testnet
            </p>
          </div>
        </div>
        <Stepper step1={step1Done} step2={Boolean(verdict?.ok)} />
      </div>

      {!IS_DEPLOYED && (
        <Panel className="mb-5 border-warn/40 p-4">
          <div className="text-sm font-semibold text-warn">Kontrat adresi tanımlı değil</div>
          <p className="mt-1 text-xs text-ink-dim">
            <code className="font-mono text-ink">NEXT_PUBLIC_AEGIS_CONTRACT_ADDRESS</code> boş. Kontratı
            dağıtın:{" "}
            <code className="font-mono text-plasma-soft">npm run contract:deploy</code> — ya da yerel
            demo için <code className="font-mono text-plasma-soft">npm run contract:deploy:local</code>.
            Arayüz yine de çalışır; yalnızca zincir yazıları devre dışı kalır.
          </p>
        </Panel>
      )}

      {wrongChain && (
        <Panel className="mb-5 border-alert/40 p-4 text-sm text-alert">
          Lütfen cüzdanı Monad Testnet&apos;a ({MONAD_TESTNET_ID}) bağlayın.
        </Panel>
      )}

      {/* No wallet at all: point the user at an install before anything else. */}
      {noWallet && (
        <Panel className="mb-5 border-warn/40 bg-warn/5 p-4">
          <div className="flex items-start gap-3">
            <span className="grid size-8 shrink-0 place-items-center rounded-lg border border-warn/40 bg-warn/10 text-base">
              🦊
            </span>
            <div>
              <div className="text-sm font-semibold text-warn">Tarayıcı cüzdanı gerekli</div>
              <p className="mt-1 text-xs leading-relaxed text-ink-dim">
                Aegis&apos;in çalışması için bir EIP-1193 sağlayıcısı gerekiyor. Sağ üstteki{" "}
                <span className="text-ink">Cüzdanı bağla</span> düğmesi kurulum yönlendirmesi verir
                ya da kurulu cüzdandan birini seçmenizi sağlar.
              </p>
              <div className="mt-2.5 flex flex-wrap gap-1.5">
                {INSTALL_SUGGESTIONS.map((entry) => (
                  <a
                    key={entry.rdns}
                    href={entry.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="flex items-center gap-1.5 rounded-lg border border-edge-bright px-2 py-1 text-[11px] text-ink-dim transition-colors hover:border-plasma/60 hover:text-ink"
                  >
                    <WalletLogo rdns={entry.rdns} name={entry.name} size={16} />
                    {entry.name} ↗
                  </a>
                ))}
              </div>
            </div>
          </div>
        </Panel>
      )}

      {!isConnected && hasLocalBaseline && !noWallet && (
        <Panel className="mb-5 border-plasma/35 bg-plasma/5 p-3.5 text-xs text-ink-dim">
          <span className="text-plasma-soft">Yerel baseline hazır.</span> Devam etmek için cüzdanı
          bağlayın — kayıt işlemi cüzdanınızın imzasıyla gönderilir.
        </Panel>
      )}

      {error && (
        <Panel className="mb-5 border-alert/40 bg-alert/5 p-4 text-sm text-alert">
          <div className="leading-relaxed">{error}</div>
        </Panel>
      )}

      {txError && (
        <Panel className="mb-5 border-alert/40 bg-alert/5 p-4 text-sm text-alert">
          {txError.pending ? (
            <span className="text-alert/80">
              İşlem takıldı — nedenini kendi RPC ucumuzla doğruluyorum…
            </span>
          ) : (
            <div className="space-y-2">
              <div className="leading-relaxed">{txError.message}</div>
              {txError.note && txError.note !== txError.message && (
                <p className="border-t border-alert/20 pt-2 font-mono text-[11px] text-alert/70">
                  cüzdanın dediği: {txError.note}
                </p>
              )}
            </div>
          )}
        </Panel>
      )}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
        {/* ================= main column ================= */}
        <div className="space-y-5">
          {/* ---------- STEP 1 ---------- */}
          <Panel className={step1Done ? "" : "ring-1 ring-plasma/25"}>
            <div className="space-y-5 p-5">
              <SectionTitle
                step="1"
                title="İlk Kayıt · Biyometrik Baseline"
                subtitle={
                  hasLocalBaseline
                    ? "Yerel tanık (witness) cihazda. Baseline commitment Monad'a yazıldı."
                    : "Mikrofondan kısa bir konuşma örneği alınır, tarayıcıda ZK-baseline kanıtı üretilir ve commitment Monad'a yazılır."
                }
                right={
                  hasLocalBaseline ? (
                    <Pill tone="aegis">Yerel witness hazır</Pill>
                  ) : (
                    <Pill tone="plasma">gerekli</Pill>
                  )
                }
              />

              {hasLocalBaseline && isEnrolledOnChain && (
                <div className="rounded-xl border border-aegis/25 bg-aegis/5 p-3 text-xs text-ink-dim">
                  <span className="text-aegis">✓ Baseline kayıtlı.</span> commitment{" "}
                  <code className="font-mono text-[11px]">{onchain.commitment}</code> · salt cihazda
                  saklanıyor, hiçbir zaman ağa çıkmıyor.
                  {vault && (
                    <button
                      onClick={() => {
                        if (!address) return;
                        clearVault(address);
                        setVault(null);
                        setBaselineEmbedding(null);
                        setBaselineResult(null);
                      }}
                      className="ml-2 text-[11px] text-alert underline underline-offset-2"
                    >
                      yerel veriyi sil
                    </button>
                  )}
                </div>
              )}

              {orphanOnChain && (
                <div className="space-y-3 rounded-xl border border-warn/30 bg-warn/5 p-4">
                  <p className="text-xs leading-relaxed text-ink-dim">
                    Bu adreste <span className="text-warn">zincire kayıtlı bir baseline var</span>,
                    ama bu tarayıcıda saklanan yerel witness kaybolmuş. Liveness kanıtı
                    imzası bu witness&apos;ten türediği için doğrulama yapılamaz — commitment
                    tek başına yeterli değildir.
                  </p>

                  {cooldownLeft > 0 ? (
                    <div className="space-y-2 rounded-lg border border-warn/40 bg-void/40 p-3">
                      <p className="text-xs leading-relaxed text-warn">
                        Bekleme süresi dolmadı: <strong>{formatDuration(cooldownLeft)}</strong> kaldı.
                        Bu süre, baseline&apos;ın <em>zincire yazıldığı</em> andan itibaren başlar ve
                        hem <code className="font-mono">registerBaseline</code> hem{" "}
                        <code className="font-mono">resetBaseline</code> için geçerlidir.
                      </p>
                      <p className="text-[11px] leading-relaxed text-ink-faint">
                        Beklemek istemiyorsan en hızlı yol: cüzdanınızda{" "}
                        <span className="text-ink-dim">başka bir hesaba geçin</span>. Hiç kayıt
                        yapılmamış bir adresin bekleme süresi hiç başlamaz, hemen
                        baseline kaydedip 2. adıma geçebilirsiniz.
                      </p>
                    </div>
                  ) : (
                    <p className="text-xs leading-relaxed text-ink-faint">
                      Devam etmek için zincire kayıtlı baseline&apos;ı silip yeniden kaydedin.
                      <code className="mx-1 font-mono text-plasma-soft">resetBaseline(user)</code>{" "}
                      bunu yapar.
                    </p>
                  )}

                  <Button
                    variant="danger"
                    loading={reset.isConfirming}
                    disabled={!address || cooldownLeft > 0}
                    onClick={submitReset}
                  >
                    {reset.isConfirming
                      ? "Monad'a gönderiliyor…"
                      : cooldownLeft > 0
                        ? `resetBaseline · ${formatDuration(cooldownLeft)} sonra`
                        : "resetBaseline · kaydı sil"}
                  </Button>
                  {reset.error && !txError && (
                    <p className="text-[11px] text-ink-faint">Ayrıntı yukarıda gösteriliyor.</p>
                  )}
                </div>
              )}

              {needsOnChainWrite && (
                <div className="space-y-3 rounded-xl border border-plasma/30 bg-plasma/5 p-4">
                  <p className="text-xs leading-relaxed text-ink-dim">
                    <span className="text-aegis">✓ Konuşma doğrulandı.</span> Baseline commitment&apos;i
                    üretildi. 2. adıma geçmek için commitment&apos;i Monad kontratına yazın —{" "}
                    <code className="font-mono text-plasma-soft">registerBaseline(user, C)</code>
                  </p>
                  <code className="block break-all rounded-lg border border-edge bg-void/60 p-2.5 font-mono text-[11px] text-aegis">
                    {baselineResult?.commitment}
                  </code>
                  <Button
                    variant="success"
                    loading={register.isConfirming}
                    disabled={!address}
                    onClick={submitBaseline}
                  >
                    {register.isConfirming ? "Monad'a gönderiliyor…" : "registerBaseline · C'yi yaz"}
                  </Button>
                  {register.isConfirming && (
                    <p className="text-[11px] text-ink-faint">
                      İşlem gönderildi. Monad Testnet onayı bekleniyor — onaylanınca 2. adım
                      otomatik açılır. Not: kayıt tamamlandığında bir saatlik yeniden kayıt
                      bekleme süresi başlar.
                    </p>
                  )}
                  {register.error && !txError && (
                    <p className="text-[11px] text-ink-faint">
                      Ayrıntı yukarıda gösteriliyor.
                    </p>
                  )}
                </div>
              )}

              {/* record UI */}
              {s1 === "empty" && (
                <div className="flex flex-col items-center gap-4 py-2">
                  <VoiceOrb history={levels} active={baselineStep === "recording"} size={164} />

                  {/* Live input meter — the whole point is that a rejected capture
                      must be diagnosable. "Speak louder" is not actionable; the
                      measured peak/RMS as a share of full scale is. */}
                  <div className="w-full max-w-sm">
                    <div className="mb-1 flex items-center justify-between font-mono text-[10px]">
                      <span className="text-ink-faint">canlı giriş seviyesi</span>
                      <span
                        className={
                          peakLevel >= 0.01
                            ? "text-aegis"
                            : peakLevel > 0
                              ? "text-warn"
                              : "text-ink-faint"
                        }
                      >
                        tepe {(peakLevel * 100).toFixed(1)}% · ortalama{" "}
                        {(rmsLevel * 100).toFixed(2)}%
                      </span>
                    </div>
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/6">
                      <div
                        className={`h-full rounded-full transition-[width] duration-100 ${
                          peakLevel >= 0.01 ? "bg-aegis" : "bg-warn"
                        }`}
                        style={{ width: `${Math.min(100, Math.max(2, rmsLevel * 1200))}%` }}
                      />
                    </div>
                    <div className="mt-1 flex justify-between font-mono text-[9px] text-ink-faint">
                      <span>0 %</span>
                      <span>eşik 0.3 % (ortalama)</span>
                      <span>100 %</span>
                    </div>
                  </div>

                  <div className="text-center">
                    <div className="text-sm font-medium text-ink">
                      {baselineStep === "recording"
                        ? "Kaydediliyor… lütfen konuşun"
                        : baselineStep === "proving"
                          ? "Ses özelliği çıkarılıyor…"
                          : `${(BASELINE_TARGET_MS / 1000).toFixed(1)} saniyelik örnek gerekli`}
                    </div>
                    <p className="mt-1 text-xs text-ink-dim">
                      Önerilen cümle:{" "}
                      <span className="text-ink">
                        “{BASELINE_PHRASES[Math.floor(Math.random() * BASELINE_PHRASES.length)]}”
                      </span>
                    </p>
                    <p className="mt-2 text-[11px] text-ink-faint">
                      Ham ses cihazdan çıkmaz; yalnızca commitment ve template digest işlenir.
                    </p>
                  </div>
                  <Button
                    size="lg"
                    variant="primary"
                    loading={baselineStep === "recording" || baselineStep === "proving"}
                    onClick={recordBaseline}
                  >
                    🎙️ Biyometrik Baseline Kaydet
                  </Button>
                </div>
              )}

              {needsOnChainWrite && (
                <div className="flex justify-end">
                  <button
                    onClick={discardCapture}
                    className="text-[11px] text-ink-faint underline underline-offset-2 hover:text-ink-dim"
                  >
                    sesi sil, baştan kaydet
                  </button>
                </div>
              )}

              {baselineResult && (
                <EnrollmentReport result={baselineResult} />
              )}

              {baselineResult?.ok && (
                <div className="rounded-xl border border-edge bg-void/40 p-4">
                  <div className="mb-2 text-[10px] uppercase tracking-[0.12em] text-ink-faint">
                    baseline transkripti
                  </div>
                  <div className="space-y-1">
                    {baselineResult.transcript.map(([k, v]) => (
                      <div key={k} className="grid gap-0.5 sm:grid-cols-[150px_1fr] sm:gap-2">
                        <span className="text-[10px] text-ink-faint">{k}</span>
                        <code className="break-all font-mono text-[11px] text-ink-dim">{v}</code>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </Panel>

          {/* ---------- STEP 2 ---------- */}
          <Panel className={step1Done && !verdict ? "ring-1 ring-plasma/25" : ""}>
            <div className="space-y-5 p-5">
              <SectionTitle
                step="2"
                title="Güvenli Arama · Random Liveness Check"
                subtitle="Zincirden taze entropi ile bir challenge üretilir, kullanıcı sesiyle yanıtlar, kanıt Monad'a gönderilir."
                right={
                  !step1Done ? (
                    <Pill tone="neutral">Adım 1 bekleniyor</Pill>
                  ) : onchain.isSessionActive ? (
                    <Pill tone="aegis">oturum açık</Pill>
                  ) : null
                }
              />

              {!step1Done ? (
                <div className="space-y-2 rounded-xl border border-dashed border-edge py-8 text-center">
                  <p className="px-4 text-xs text-ink-faint">{step1Hint(s1)}</p>
                  <p className="font-mono text-[10px] text-ink-faint/60">
                    {step1Blockers(step1Inputs).join(" · ")}
                  </p>
                </div>
              ) : (
                <>
                  {/* attack simulation harness */}
                  <div className="rounded-xl border border-edge/70 bg-void/30 p-3">
                    <div className="mb-2 flex flex-wrap items-center gap-2">
                      <span className="text-[10px] uppercase tracking-[0.12em] text-ink-faint">
                        saldırı simülasyonu
                      </span>
                      <Pill tone="warn">test harness</Pill>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {(Object.keys(SPOOF_LABELS) as SpoofKind[]).map((kind) => (
                        <button
                          key={kind}
                          disabled={callStep === "recording" || callStep === "proving"}
                          onClick={() => setSpoof(kind)}
                          className={`rounded-lg border px-2.5 py-1.5 text-[11px] transition-colors disabled:opacity-40 ${
                            spoof === kind
                              ? kind === "none"
                                ? "border-aegis/50 bg-aegis/10 text-aegis"
                                : "border-alert/50 bg-alert/10 text-alert"
                              : "border-edge text-ink-dim hover:border-edge-bright hover:text-ink"
                          }`}
                        >
                          {SPOOF_LABELS[kind].label}
                        </button>
                      ))}
                    </div>
                    <p className="mt-2 text-[10px] leading-relaxed text-ink-faint">
                      {SPOOF_LABELS[spoof].blurb}. Saldırgan sesi tarayıcıda sentezlenir ve
                      <span className="text-ink-dim"> tespit motoru hiçbir şekilde değiştirilmeden </span>
                      aynı pipeline&apos;dan geçer.
                    </p>
                  </div>

                  {!challenge ? (
                    <div className="flex flex-col items-center gap-3 py-4">
                      <Button size="lg" variant="success" onClick={startCall} disabled={!IS_DEPLOYED}>
                        📞 Start Secure Call
                      </Button>
                      {!IS_DEPLOYED && (
                        <p className="text-[11px] text-ink-faint">
                          Kontrat adresi olmadan challenge üretilemez.
                        </p>
                      )}
                    </div>
                  ) : (
                    <ChallengeCard
                      challenge={challenge}
                      step={callStep}
                      levels={callLevels}
                      onRecord={recordAndProve}
                      onCancel={() => {
                        setChallenge(null);
                        setCallStep("idle");
                        setTranscript(null);
                        setProofWord(null);
                        setVerdict(null);
                        setCallLevels([]);
                      }}
                    />
                  )}

                  {verdict && (
                    <div className="pt-1">
                      <VerdictBadge verdict={verdict} />
                    </div>
                  )}

                  {verify.error && (
                    <p className="text-xs text-alert">İşlem hatası: {verify.error.message}</p>
                  )}
                </>
              )}
            </div>
          </Panel>

          {/* ---------- proof inspector ---------- */}
          <ProofInspector
            proofWord={proofWord ?? undefined}
            transcript={transcript ?? undefined}
            baselineCommitment={onchain.commitment}
            onChainWord={onchainWord}
          />
        </div>

        {/* ================= side column ================= */}
        <aside className="space-y-5">
          <Panel className="p-5">
            <SectionTitle title="Zincir üstü oturum" subtitle="AegisCallZK · Monad Testnet" />
            <div className="mt-4 space-y-2.5">
              <StatRow
                label="kontrat"
                value={IS_DEPLOYED ? `${AEGIS_ADDRESS.slice(0, 8)}…${AEGIS_ADDRESS.slice(-6)}` : "—"}
              />
              <StatRow label="registered" value={String(onchain.registered)} tone={onchain.registered ? "aegis" : undefined} />
              <StatRow
                label="session"
                value={onchain.isSessionActive ? "aktif" : isEnrolledOnChain ? "kapalı" : "—"}
                tone={onchain.isSessionActive ? "aegis" : undefined}
              />
              <StatRow label="authNonce" value={String(onchain.authNonce)} hint="kanıttaki tek kullanımlık sayaç" />
              <StatRow label="callCount" value={String(onchain.session?.callCount ?? 0)} />
              <StatRow
                label="failedAttempts"
                value={String(onchain.session?.failedAttempts ?? 0)}
                tone={(onchain.session?.failedAttempts ?? 0) > 0 ? "alert" : undefined}
              />
              <StatRow
                label="lockoutUntil"
                value={onchain.lockoutUntil > 0n ? new Date(Number(onchain.lockoutUntil) * 1000).toLocaleTimeString("tr") : "—"}
                tone={onchain.lockoutUntil > 0n ? "alert" : undefined}
              />
              <StatRow label="eşik sim/live" value={`${onchain.thresholds.minSimilarityBps} / ${onchain.thresholds.minLivenessBps} bps`} />
            </div>

            <div className="mt-4 space-y-2">
              <Meter
                label="similarity"
                value={transcript?.similarityBps ?? 0}
                max={10_000}
                tone={
                  !transcript
                    ? "plasma"
                    : transcript.similarityBps >= onchain.thresholds.minSimilarityBps
                      ? "aegis"
                      : "alert"
                }
              />
              <Meter
                label="liveness"
                value={transcript?.livenessBps ?? 0}
                max={10_000}
                tone={
                  !transcript
                    ? "plasma"
                    : transcript.livenessBps >= onchain.thresholds.minLivenessBps
                      ? "aegis"
                      : "alert"
                }
              />
            </div>
          </Panel>

          <Panel className="p-5">
            <SectionTitle title="Nasıl çalışıyor" />
            <ol className="mt-3 space-y-3">
              {[
                ["Biyometrik anahtar bağlama", "C = P + t·G (sign-to-contract). Template digest'i t'ye gömülür; ses aynı değilse anahtar tutmaz."],
                ["Liveness kanıtı", "MFCC embedding + akustik kontroller → similarity/liveness bps + saldırı bayrakları."],
                ["Kriptografik mühür", "Skorlar ve bayraklar, canlı challenge'a bağlı bir mesajın içinde BIP-340 ile imzalanır."],
                ["Zincir", "32 baytlık kanıt sözcüğü + taze authNonce → verifyCallWithLiveness."],
              ].map(([title, body], i) => (
                <li key={title} className="flex gap-3">
                  <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-md border border-plasma/40 bg-plasma/10 font-mono text-[10px] text-plasma-soft">
                    {i + 1}
                  </span>
                  <div>
                    <div className="text-[12px] font-medium text-ink">{title}</div>
                    <div className="text-[11px] leading-relaxed text-ink-faint">{body}</div>
                  </div>
                </li>
              ))}
            </ol>
          </Panel>

          <ArchitectureDiagrams />
        </aside>
      </div>
    </div>
  );
}

/**
 * Mimari diyagramlar.
 *
 * Kapalı başlar: 360 px'lik bir yan sütunda açık duran iki geniş şema, konsolün
 * asıl işini (3 adımlı akış) eziyor. `details`/`summary` ile açılıyor, yani
 * demosu sırasında "mimariyi göster" dendiğinde bir tıkla hazır.
 *
 * Görseller beyaz zeminli oldukları için ters çevrilmiyor — kullanıcının
 * çizdiği hâliyle, `next/image` ile optimize edilerek sunuluyor.
 */
function ArchitectureDiagrams() {
  return (
    <Panel className="p-5">
      <SectionTitle title="Mimari diyagramlar" />
      <div className="mt-3 space-y-2">
        {(
          [
            [
              "/diagrams/01-client-enrolment.png",
              "Tarayıcı tarafı — biyometrik yakalama, MFCC embedding, sign-to-contract anahtar bağlama ve taze challenge üretimi.",
              1537,
              656,
            ],
            [
              "/diagrams/02-onchain-verification.png",
              "Zincir tarafı — 20 baytlık bağlama doğrulaması, nullifier kontrolü, lockout guard ve sub-second finality.",
              1492,
              677,
            ],
          ] as const
        ).map(([src, alt, w, h]) => (
          <details key={src} className="group rounded-lg border border-edge bg-void/40">
            <summary className="cursor-pointer list-none px-3 py-2 text-[11px] font-medium text-ink-dim transition-colors hover:text-ink">
              <span className="mr-1.5 inline-block transition-transform group-open:rotate-90">▸</span>
              {src.includes("01-") ? "1 · İstemci / enrolment" : "2 · Zincir doğrulama"}
            </summary>
            <div className="border-t border-edge p-2">
              <Image
                src={src}
                alt={alt}
                width={w}
                height={h}
                className="w-full rounded-md"
                // 2.34:1 and 2.2:1 — the intrinsic ratio is preserved automatically,
                // so no CLS shift; these are just hints for the browser.
                sizes="(max-width: 1024px) 100vw, 336px"
              />
            </div>
          </details>
        ))}
      </div>
      <p className="mt-3 text-[10px] leading-relaxed text-ink-faint">
        Tam açıklama ve <strong>diyagram ile kodun uyuşmadığı iki kutu</strong> için{" "}
        <code className="font-mono text-plasma-soft">README.md</code> → “Mimari akış”.
      </p>
    </Panel>
  );
}

/**
 * Adım 1 sonucu paneli: ham ölçümler + **enrolment liveness** skoru.
 *
 * Liveness geçse de geçmese de gösterilir. "Daha yüksek sesle konuşun" bir
 * cevap değil, tahmindir; ekranda ölçülen sayılar olmalıdır.
 *
 * `naturalness` bilgi amaçlıdır ve kapı değildir: insan ile vocoder arasındaki
 * fark bu boru hattında çok incedir. Yanlış reddi kabul etmektense uyarı
 * vermek yeğdir — bu yüzden hücre "uyarı" rengiyle ayrılıyor.
 */
function EnrollmentReport({ result }: { result: NonNullable<ReturnType<typeof createBaselineProof>> }) {
  const L = result.liveness;
  const d = L.detail;
  const ok = result.ok;

  return (
    <div
      className={`mt-5 rounded-xl border p-4 ${
        ok ? "border-aegis/30 bg-aegis/5" : "border-warn/30 bg-warn/5"
      }`}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <span
          className={`text-[10px] uppercase tracking-[0.12em] ${ok ? "text-aegis" : "text-warn"}`}
        >
          {ok ? "canlı konuşma doğrulandı" : "bu kayıt kullanılamaz"}
        </span>
        <span className="font-mono text-[10px] text-ink-faint">
          {(result.durationMs / 1000).toFixed(1)} sn · {result.preview.totalFrames} kare
        </span>
      </div>

      <div className="mb-3 grid grid-cols-3 gap-2">
        <ScoreCell
          label="liveness"
          value={L.livenessBps}
          pass={L.livenessBps >= ENROLL_MIN_LIVENESS_BPS}
        />
        <ScoreCell label="presence" value={L.presenceBps} pass={L.presenceBps >= 5000} />
        <ScoreCell label="naturalness" value={L.naturalnessBps} tone="info" />
      </div>

      <div className="grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-[11px] text-ink-dim sm:grid-cols-4">
        <span>tepe: %{(result.preview.rawPeak * 100).toFixed(2)}</span>
        <span>ort.: %{(result.preview.rawRms * 100).toFixed(2)}</span>
        <span>F0: {d.f0Mean} Hz</span>
        <span>titreme: %{d.f0JitterPct}</span>
        <span>HNR: {d.hnrDb} dB</span>
        <span>hece: {d.syllableBursts}</span>
        <span>döngü: {d.loopScore}</span>
        <span>
          sesli: {result.preview.speechFrames}/{result.preview.totalFrames}
        </span>
      </div>

      {L.advisories.length > 0 && (
        <ul className="mt-2 space-y-1 text-[11px] leading-relaxed text-plasma">
          {L.advisories.map((a) => (
            <li key={a}>⚠ {a}</li>
          ))}
        </ul>
      )}

      {L.flagNames.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {L.flagNames.map((f) => (
            <span
              key={f}
              className="rounded border border-alert/40 bg-alert/10 px-1.5 py-0.5 font-mono text-[10px] text-alert"
            >
              {f}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function ScoreCell({
  label,
  value,
  pass,
  tone = "pass",
}: {
  label: string;
  value: number;
  pass?: boolean;
  /** "info" = bilgi amaçlı, kapı değil */
  tone?: "pass" | "info";
}) {
  const border =
    tone === "info" ? "border-edge bg-void/40" : pass ? "border-aegis/30 bg-aegis/5" : "border-warn/30 bg-warn/5";
  const text = tone === "info" ? "text-ink-dim" : pass ? "text-aegis" : "text-warn";
  return (
    <div className={`rounded-lg border p-2 ${border}`}>
      <div className="text-[9px] uppercase tracking-[0.1em] text-ink-faint">{label}</div>
      <div className={`font-mono text-base font-semibold ${text}`}>{(value / 100).toFixed(1)}%</div>
    </div>
  );
}
