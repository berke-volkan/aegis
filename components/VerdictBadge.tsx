"use client";

import { ATTACK_FLAG_LABELS } from "@/lib/zk/pack";
import { Panel, Pill } from "./ui";

export type Verdict = {
  ok: boolean;
  title: string;
  headline: string;
  detail: string;
  similarityBps?: number;
  livenessBps?: number;
  flagNames?: string[];
  reasons?: string[];
  /** on-chain confirmation */
  onChain?: "confirmed" | "rejected-onchain" | "pending" | "reverted" | "local-only";
  txHash?: string;
  explorerUrl?: string;
  thresholds?: { minLivenessBps: number; minSimilarityBps: number };
  biometricKeyMatched?: boolean;
  signatureValid?: boolean;
};

/**
 * STEP 2d — the verdict card.
 *
 * Two states, both of them loud and unambiguous:
 *   ✅ "ZK-Verified Human: Baseline & Liveness Matched"
 *   🚨 "Deepfake / Replay Attack Detected!"
 */
export function VerdictBadge({ verdict }: { verdict: Verdict }) {
  const ok = verdict.ok;

  return (
    <div
      className={`animate-rise relative overflow-hidden rounded-2xl border p-6 sm:p-8 ${
        ok
          ? "border-aegis/40 bg-gradient-to-br from-aegis/12 via-panel to-panel shadow-[0_0_70px_-25px] shadow-aegis/70"
          : "animate-flash border-alert/50 bg-gradient-to-br from-alert/14 via-panel to-panel shadow-[0_0_70px_-25px] shadow-alert/70"
      }`}
    >
      {/* decorative scanline */}
      <div
        className={`pointer-events-none absolute inset-0 opacity-[0.06] ${
          ok
            ? "bg-[linear-gradient(180deg,transparent,white_50%,transparent)]"
            : "bg-[repeating-linear-gradient(45deg,transparent,transparent_6px,white_6px,white_7px)]"
        }`}
        aria-hidden
      />

      <div className="relative flex flex-col items-center text-center">
        <div
          className={`text-5xl sm:text-6xl ${ok ? "" : "animate-pulse"}`}
          role="img"
          aria-label={ok ? "doğrulandı" : "saldırı tespit edildi"}
        >
          {ok ? "🟢" : "🚨"}
        </div>

        <h2
          className={`mt-3 text-center text-lg font-bold tracking-tight sm:text-xl ${
            ok ? "text-aegis text-glow-aegis" : "text-alert"
          }`}
        >
          {verdict.headline}
        </h2>
        <p className="mt-1.5 max-w-md text-sm text-ink-dim">{verdict.detail}</p>

        {/* scores */}
        {(verdict.similarityBps !== undefined || verdict.livenessBps !== undefined) && (
          <div className="mt-5 grid w-full max-w-sm grid-cols-2 gap-3">
            <ScoreTile
              label="Similarity"
              value={verdict.similarityBps}
              min={verdict.thresholds?.minSimilarityBps}
            />
            <ScoreTile label="Liveness" value={verdict.livenessBps} min={verdict.thresholds?.minLivenessBps} />
          </div>
        )}

        {/* crypto layer status */}
        {(verdict.signatureValid !== undefined || verdict.biometricKeyMatched !== undefined) && (
          <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
            {verdict.signatureValid !== undefined && (
              <Pill tone={verdict.signatureValid ? "aegis" : "alert"}>
                BIP-340 signature {verdict.signatureValid ? "valid ✓" : "INVALID ✗"}
              </Pill>
            )}
            {verdict.biometricKeyMatched !== undefined && (
              <Pill tone={verdict.biometricKeyMatched ? "aegis" : "warn"}>
                {verdict.biometricKeyMatched
                  ? "biyometrik anahtar birebir eşleşti ✓"
                  : "anahtar kayması (beklenen) · skor bazlı"}
              </Pill>
            )}
          </div>
        )}

        {/* attack reasons */}
        {!ok && (verdict.flagNames?.length || verdict.reasons?.length) ? (
          <Panel className="mt-5 w-full max-w-lg p-4 text-left">
            <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-alert">
              Tespit edilen saldırı sinyalleri
            </div>
            <ul className="space-y-1.5">
              {verdict.flagNames?.map((f) => (
                <li key={f} className="flex items-start gap-2 text-[12px] text-ink">
                  <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-alert" />
                  <span>
                    <code className="font-mono text-[11px] text-alert">{f}</code>
                    <span className="text-ink-dim">
                      {" — "}
                      {Object.entries(ATTACK_FLAG_LABELS)
                        .map(([bit, label]) => ({ bit: Number(bit), label }))
                        .find((x) => x.bit === flagBit(f))
                        ?.label ?? ""}
                    </span>
                  </span>
                </li>
              ))}
              {verdict.reasons?.map((r, i) => (
                <li key={i} className="flex items-start gap-2 text-[12px] text-ink-dim">
                  <span className="mt-1.5 size-1 shrink-0 rounded-full bg-ink-faint" />
                  <span className="font-mono text-[11px]">{r}</span>
                </li>
              ))}
            </ul>
          </Panel>
        ) : null}

        {/* on-chain status */}
        {verdict.onChain && (
          <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
            {verdict.onChain === "confirmed" && <Pill tone="aegis">Monad'da onaylandı · session açık</Pill>}
            {verdict.onChain === "rejected-onchain" && (
              <Pill tone="alert">Monad'a kaydedildi · LivenessRejected</Pill>
            )}
            {verdict.onChain === "pending" && <Pill tone="plasma">Monad'a gönderiliyor…</Pill>}
            {verdict.onChain === "reverted" && <Pill tone="alert">İşlem revert edildi</Pill>}
            {verdict.onChain === "local-only" && <Pill tone="warn">Yalnızca yerel doğrulama</Pill>}
            {verdict.txHash && verdict.explorerUrl && (
              <a
                href={verdict.explorerUrl}
                target="_blank"
                rel="noreferrer"
                className="font-mono text-[11px] text-plasma-soft underline decoration-dotted underline-offset-4 hover:text-ink"
              >
                {shortenTx(verdict.txHash)} ↗
              </a>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function ScoreTile({ label, value, min }: { label: string; value?: number; min?: number }) {
  const has = value !== undefined;
  const pass = has && (min === undefined || value >= min);
  return (
    <div
      className={`rounded-xl border p-3 ${
        has ? (pass ? "border-aegis/30 bg-aegis/5" : "border-alert/30 bg-alert/5") : "border-edge"
      }`}
    >
      <div className="text-[10px] uppercase tracking-[0.12em] text-ink-faint">{label}</div>
      <div
        className={`mt-1 font-mono text-xl font-semibold ${
          !has ? "text-ink-faint" : pass ? "text-aegis" : "text-alert"
        }`}
      >
        {has ? `${(value / 100).toFixed(2)}%` : "—"}
      </div>
      {min !== undefined && (
        <div className="mt-0.5 text-[10px] text-ink-faint">eşik {(min / 100).toFixed(0)}%</div>
      )}
    </div>
  );
}

function shortenTx(hash: string): string {
  return `${hash.slice(0, 10)}…${hash.slice(-8)}`;
}

/** name → bit, so the UI can print the human label for each named flag. */
const NAMES = {
  REPLAY: 1 << 0,
  SYNTHETIC: 1 << 1,
  TEMPLATE_DRIFT: 1 << 2,
  TEMPO_SPOOF: 1 << 3,
  CHALLENGE_MISMATCH: 1 << 4,
  MIC_SPOOF: 1 << 5,
} as const;

function flagBit(name: string): number {
  return (NAMES as Record<string, number>)[name] ?? -1;
}
