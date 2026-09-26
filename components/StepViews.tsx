"use client";

import { useEffect, useState } from "react";

import { isChallengeExpired, type LivenessChallenge } from "@/lib/zk/challenges";
import { Button, Pill, Spinner } from "./ui";
import { VoiceOrb } from "./VoiceOrb";

/** The capture pipeline's states, shared with the console's orchestration. */
export type Step = "idle" | "recording" | "proving" | "done";

/**
 * STEP 2a–c — the live liveness challenge.
 *
 * Renders the dynamic code the user has to read and say, counts the challenge
 * down, and hosts the mic. The code is drawn from 32 bytes of CSPRNG entropy
 * mixed with the on-chain `nextChallengeSeed`, so it cannot have existed when a
 * prerecorded answer was made.
 */
export function ChallengeCard({
  challenge,
  step,
  levels,
  onRecord,
  onCancel,
}: {
  challenge: LivenessChallenge;
  step: Step;
  levels: number[];
  onRecord: () => void;
  onCancel: () => void;
}) {
  const [remaining, setRemaining] = useState(() =>
    Math.max(0, Math.round((challenge.expiresAt - Date.now()) / 1000)),
  );

  useEffect(() => {
    const tick = () =>
      setRemaining(Math.max(0, Math.round((challenge.expiresAt - Date.now()) / 1000)));
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [challenge.expiresAt]);

  const expired = isChallengeExpired(challenge);
  const spoken = challenge.request.split("— «")[1]?.replace("»", "") ?? challenge.request;

  return (
    <div className="rounded-xl border border-plasma/30 bg-plasma/5 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Pill tone="plasma">
          challenge #{challenge.id} · {challenge.template.title}
        </Pill>
        <span className={`font-mono text-[10px] ${expired ? "text-alert" : "text-ink-faint"}`}>
          seed {challenge.seed.slice(0, 14)}… · {remaining}s
        </span>
      </div>

      <p className="mt-3 text-sm text-ink">{challenge.template.instruction}</p>

      {/* the dynamic code — one tile per digit so it is unambiguous when spoken */}
      <div className="my-5 flex justify-center gap-2.5">
        {challenge.code.split("").map((d, i) => (
          <span
            key={i}
            className="grid size-12 place-items-center rounded-xl border border-plasma/40 bg-void/70 font-mono text-2xl font-bold text-ink shadow-[0_0_30px_-10px] shadow-plasma/70 sm:size-14 sm:text-3xl"
            style={{ animation: `rise 0.4s ${i * 70}ms both` }}
          >
            {d}
          </span>
        ))}
      </div>

      <div className="rounded-lg border border-edge bg-void/50 p-3 text-center text-xs text-ink-dim">
        Söylemeniz istenen: <span className="font-medium text-ink">«{spoken}»</span>
      </div>

      <div className="mt-4 flex flex-col items-center gap-3">
        <VoiceOrb history={levels} active={step === "recording"} size={132} />
        {step === "recording" ? (
          <div className="flex items-center gap-2 text-sm text-ink">
            <Spinner className="size-4 text-plasma" />
            Dinleniyor… yanıtınızı söyleyin
          </div>
        ) : step === "proving" ? (
          <div className="flex items-center gap-2 text-sm text-ink">
            <Spinner className="size-4 text-aegis" />
            MFCC çıkarılıyor, liveness puanlanıyor ve kanıt imzalanıyor…
          </div>
        ) : (
          <div className="flex flex-wrap justify-center gap-2">
            <Button size="lg" variant="success" onClick={onRecord} disabled={expired}>
              🎙️ Şimdi yanıtla
            </Button>
            <Button size="lg" variant="ghost" onClick={onCancel}>
              İptal
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

/** Compact three-stage progress indicator for the header. */
export function Stepper({ step1, step2 }: { step1: boolean; step2: boolean }) {
  const items = [
    { label: "Baseline", done: step1 },
    { label: "Liveness", done: step2 },
    { label: "Onay", done: step2 },
  ];
  const current = step1 ? 1 : 0;

  return (
    <div className="flex items-center gap-1.5">
      {items.map((item, i) => (
        <div key={item.label} className="flex items-center gap-1.5">
          <div
            className={`flex items-center gap-1.5 rounded-lg border px-2 py-1 text-[10px] transition-colors ${
              item.done
                ? "border-aegis/40 bg-aegis/10 text-aegis"
                : i === current
                  ? "border-plasma/40 bg-plasma/10 text-plasma-soft"
                  : "border-edge text-ink-faint"
            }`}
          >
            <span className="font-mono">{i + 1}</span>
            <span className="hidden sm:inline">{item.label}</span>
          </div>
          {i < items.length - 1 && <div className="h-px w-3 bg-edge" />}
        </div>
      ))}
    </div>
  );
}

/** A single `label: value` line for the on-chain session panel. */
export function StatRow({
  label,
  value,
  tone,
  hint,
}: {
  label: string;
  value: string;
  tone?: "aegis" | "alert";
  hint?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-edge/50 pb-1.5 last:border-0">
      <span className="text-[11px] text-ink-faint" title={hint}>
        {label}
      </span>
      <span
        className={`truncate font-mono text-[12px] ${
          tone === "aegis" ? "text-aegis" : tone === "alert" ? "text-alert" : "text-ink-dim"
        }`}
      >
        {value}
      </span>
    </div>
  );
}

/** Mirrors `enum RejectionReason` in AegisCallZK.sol. */
export function rejectionLabel(reason: number): string {
  return (
    ["none", "liveness eşiği altında", "similarity eşiği altında", "saldırı bayrakları", "kilitli"] as const
  )[reason] ?? "bilinmiyor";
}
