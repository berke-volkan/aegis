"use client";

import { useState } from "react";

import { describeProofWord } from "@/lib/zk/pack";
import type { LivenessTranscript } from "@/lib/zk/liveness";
import type { Bytes32 } from "@/lib/zk/primitives";
import { LIVENESS_THRESHOLDS } from "@/lib/zk/liveness";
import { Meter, Panel, Pill } from "./ui";

/**
 * Proof Inspector — the "show your work" panel.
 *
 * A ZK system is only trustworthy if a human can audit it. This renders the
 * exact 32-byte word that went on-chain, byte by byte, next to the signed
 * transcript and every liveness sub-score, so a reviewer can recompute the
 * verdict by hand.
 */
export function ProofInspector({
  proofWord,
  transcript,
  baselineCommitment,
  onChainWord,
}: {
  proofWord?: Bytes32;
  transcript?: LivenessTranscript;
  baselineCommitment?: string;
  /** what the contract itself decoded, straight from the chain */
  onChainWord?: { version: number; challengeId: number; livenessBps: number; similarityBps: number; flags: number; authNonce: number };
}) {
  const [tab, setTab] = useState<"word" | "transcript" | "acoustic">("word");

  if (!proofWord) {
    return (
      <Panel className="p-5">
        <div className="text-sm font-semibold text-ink">Proof Inspector</div>
        <p className="mt-1.5 text-xs text-ink-dim">
          Kanıt üretildiğinde 32 baytlık kanıt sözcüğü, imza transkripti ve akustik
          skorlar burada bayt bayt görüntülenecek.
        </p>
      </Panel>
    );
  }

  const rows = describeProofWord(proofWord);
  const T = LIVENESS_THRESHOLDS;

  return (
    <Panel className="overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b border-edge px-5 py-3">
        <div>
          <div className="text-sm font-semibold text-ink">Proof Inspector</div>
          <div className="font-mono text-[10px] text-ink-faint">
            32 bayt · 8 alan · Solidity ile birebir aynı düzen
          </div>
        </div>
        <div className="flex gap-1 rounded-lg bg-white/4 p-0.5">
          {(
            [
              ["word", "Kanıt"],
              ["transcript", "Transkript"],
              ["acoustic", "Akustik"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`rounded-md px-2.5 py-1 text-[11px] transition-colors ${
                tab === key ? "bg-plasma/25 text-ink" : "text-ink-dim hover:text-ink"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {tab === "word" && (
        <div className="p-5">
          <div className="mb-4">
            <div className="mb-1 text-[10px] uppercase tracking-[0.12em] text-ink-faint">
              proofWord · bytes32
            </div>
            <code className="block break-all rounded-lg border border-edge bg-void/70 p-3 font-mono text-[12px] leading-relaxed text-aegis">
              {proofWord}
            </code>
          </div>

          <div className="overflow-hidden rounded-lg border border-edge">
            <table className="w-full text-left">
              <thead>
                <tr className="bg-white/3 text-[10px] uppercase tracking-[0.1em] text-ink-faint">
                  <th className="px-3 py-1.5 font-medium">offset</th>
                  <th className="px-3 py-1.5 font-medium">alan</th>
                  <th className="px-3 py-1.5 font-medium">değer</th>
                  <th className="px-3 py-1.5 font-medium">baytlar</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.field} className="border-t border-edge/70 align-top">
                    <td className="whitespace-nowrap px-3 py-1.5 font-mono text-[11px] text-ink-faint">
                      {r.offset}
                      <span className="ml-1 text-[9px] text-ink-faint/60">({r.size}B)</span>
                    </td>
                    <td className="whitespace-nowrap px-3 py-1.5 font-mono text-[11px] text-plasma-soft">
                      {r.field}
                    </td>
                    <td className="px-3 py-1.5 font-mono text-[11px] text-ink">
                      {r.value}
                      {r.note && (
                        <div className="mt-0.5 font-sans text-[10px] text-ink-faint">{r.note}</div>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-3 py-1.5 font-mono text-[11px] text-ink-dim">
                      {r.bytes}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {onChainWord && (
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <Pill tone="plasma">decodeLivenessProof() · chain</Pill>
              <span className="font-mono text-[11px] text-ink-dim">
                v{onChainWord.version} · ch{onChainWord.challengeId} · nonce {onChainWord.authNonce} · sim{" "}
                {onChainWord.similarityBps} · live {onChainWord.livenessBps} · flags 0x
                {onChainWord.flags.toString(16)}
              </span>
            </div>
          )}

          {baselineCommitment && baselineCommitment !== "0x" + "00".repeat(32) && (
            <div className="mt-3 text-[11px] text-ink-faint">
              Kayıtlı commitment:{" "}
              <code className="font-mono text-ink-dim">{baselineCommitment}</code>
            </div>
          )}
        </div>
      )}

      {tab === "transcript" && transcript && (
        <div className="space-y-2.5 p-5">
          {transcript.transcriptLines.map(([label, value]) => (
            <div key={label} className="grid gap-1 sm:grid-cols-[190px_1fr] sm:gap-3">
              <div className="text-[11px] text-ink-faint">{label}</div>
              <code
                className={`break-all font-mono text-[11px] ${
                  label === "verdict"
                    ? transcript.accepted
                      ? "text-aegis"
                      : "text-alert"
                    : "text-ink-dim"
                }`}
              >
                {value}
              </code>
            </div>
          ))}
          <p className="mt-3 border-t border-edge pt-3 text-[11px] leading-relaxed text-ink-faint">
            İmza, <code className="text-ink-dim">signedMessage</code> alanını{" "}
            <code className="text-ink-dim">C · user · challengeId · seed · authNonce · deadline · sim · live ·
            flags · audioDigest</code> değerlerinin keccak&apos;idir. Yani skorlar ve saldırı
            bayrakları kriptografik olarak mühürlenmiştir; istemci yargıyı sonradan
            değiştiremez.
          </p>
        </div>
      )}

      {tab === "acoustic" && transcript && (
        <div className="space-y-4 p-5">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Score label="presence" value={transcript.breakdown.presence} weight={T.weights.presence} />
            <Score
              label="response latency"
              value={transcript.breakdown.responseLatency}
              weight={T.weights.responseLatency}
            />
            <Score
              label="pitch naturalness"
              value={transcript.breakdown.pitchNaturalness}
              weight={T.weights.pitchNaturalness}
            />
            <Score
              label="spectral naturalness"
              value={transcript.breakdown.spectralNaturalness}
              weight={T.weights.spectralNaturalness}
            />
            <Score
              label="articulation"
              value={transcript.breakdown.articulation}
              weight={T.weights.articulation}
            />
            <div className="rounded-lg border border-edge p-3">
              <div className="mb-1 text-[10px] uppercase tracking-[0.12em] text-ink-faint">cosine</div>
              <div
                className={`font-mono text-lg ${
                  transcript.cosine >= T.similarityFloor ? "text-aegis" : "text-alert"
                }`}
              >
                {transcript.cosine.toFixed(3)}
              </div>
            </div>
          </div>

          <div className="rounded-lg border border-edge p-3">
            <div className="mb-2 text-[10px] uppercase tracking-[0.12em] text-ink-faint">
              eşikler (liveness.ts · Liveness_THRESHOLDS)
            </div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-[11px] text-ink-dim sm:grid-cols-3">
              <span>similarityFloor {T.similarityFloor}</span>
              <span>jitter min {T.jitterHuman[0]}</span>
              <span>hnr {T.hnrRange[0]}–{T.hnrRange[1]} dB</span>
              <span>
                latency {T.responseLatencyMinMs}–{T.responseLatencyMaxMs} ms
              </span>
              <span>flatness ≤ {T.flatnessCeiling}</span>
              <span>loop ceiling {T.loopCorrelationCeiling}</span>
            </div>
          </div>

          {transcript.reasons.length > 0 && (
            <div className="rounded-lg border border-alert/30 bg-alert/5 p-3">
              <div className="mb-1.5 text-[10px] uppercase tracking-[0.12em] text-alert">
                tetiklenen kontroller
              </div>
              <ul className="space-y-1 font-mono text-[11px] text-ink-dim">
                {transcript.reasons.map((r, i) => (
                  <li key={i}>· {r}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </Panel>
  );
}

function Score({ label, value, weight }: { label: string; value: number; weight: number }) {
  return (
    <div className="rounded-lg border border-edge p-3">
      <div className="mb-1.5 text-[10px] uppercase tracking-[0.1em] text-ink-faint">{label}</div>
      <Meter
        value={value}
        tone={value >= 0.6 ? "aegis" : value >= 0.35 ? "warn" : "alert"}
      />
      <div className="mt-1 font-mono text-[10px] text-ink-faint">ağırlık {weight.toFixed(2)}</div>
    </div>
  );
}
