"use client";

import { useEffect, useRef } from "react";

import { INSTALL_SUGGESTIONS } from "@/lib/wallets/catalog";
import { Spinner } from "./ui";
import { WalletLogo } from "./WalletLogo";

/**
 * Cüzdan seçim penceresi.
 *
 * İki durumu da karşılar:
 *   · **Cüzdan kurulu** → her cüzdan için gerçek logosuyla bir kart listesi.
 *   · **Cüzdan yok**     → kurulum yönlendirmesi; kullanıcı nereye bakacağını
 *     bilmesin diye doğrudan indirme sayfalarına giden kartlar.
 *
 * Klavye: Escape kapatır, odak pencerenin içinde tutulur, arka plan tıklaması
 * kapatır.
 */
export function WalletModal({
  open,
  onClose,
  wallets,
  isDetecting,
  onSelect,
  onRescan,
  connectingRdns,
  error,
}: {
  open: boolean;
  onClose: () => void;
  wallets: Array<{ rdns: string; name: string; icon: string | null }>;
  isDetecting: boolean;
  onSelect: (rdns: string) => void;
  onRescan: () => void;
  connectingRdns?: string | null;
  error?: string;
}) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key !== "Tab" || !panelRef.current) return;
      // Focus trap: keeps Tab inside the dialog.
      const focusable = panelRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [open, onClose]);

  useEffect(() => {
    if (open) panelRef.current?.querySelector<HTMLElement>("button, a")?.focus();
  }, [open]);

  if (!open) return null;

  const hasWallets = wallets.length > 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-void/80 p-4 pt-[12vh] backdrop-blur-sm"
      onClick={onClose}
      role="presentation"
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="wallet-modal-title"
        className="panel w-full max-w-md animate-rise p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h2 id="wallet-modal-title" className="text-sm font-semibold text-ink">
              Cüzdan seç
            </h2>
            <p className="mt-0.5 text-[11px] text-ink-dim">
              {hasWallets
                ? `${wallets.length} cüzdan algılandı`
                : isDetecting
                  ? "Yüklü cüzdanlar taranıyor…"
                  : "Yüklü bir cüzdan bulunamadı"}
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Kapat"
            className="grid size-7 shrink-0 place-items-center rounded-lg text-ink-faint transition-colors hover:bg-white/5 hover:text-ink"
          >
            ✕
          </button>
        </div>

        {error && (
          <div className="mb-3 rounded-lg border border-alert/40 bg-alert/10 p-2.5 text-[11px] text-alert">
            {error}
          </div>
        )}

        {/* ---------------- detected wallets ---------------- */}
        {isDetecting && !hasWallets && (
          <div className="flex flex-col items-center gap-3 py-8">
            <Spinner className="size-5 text-plasma" />
            <p className="text-xs text-ink-faint">EIP-6963 sağlayıcıları dinleniyor…</p>
          </div>
        )}

        {hasWallets && (
          <div className="space-y-1.5">
            {wallets.map((wallet) => (
              <button
                key={wallet.rdns}
                onClick={() => onSelect(wallet.rdns)}
                disabled={Boolean(connectingRdns)}
                className="group flex w-full items-center gap-3 rounded-xl border border-transparent p-2.5 text-left transition-colors hover:border-edge-bright hover:bg-white/4 disabled:opacity-50"
              >
                <WalletLogo rdns={wallet.rdns} name={wallet.name} icon={wallet.icon} size={36} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-ink">{wallet.name}</div>
                  <div className="truncate font-mono text-[10px] text-ink-faint">{wallet.rdns}</div>
                </div>
                {connectingRdns === wallet.rdns ? (
                  <Spinner className="size-4 text-plasma" />
                ) : (
                  <span className="text-[10px] font-medium uppercase tracking-[0.1em] text-aegis opacity-0 transition-opacity group-hover:opacity-100">
                    Bağlan
                  </span>
                )}
              </button>
            ))}

            <button
              onClick={onRescan}
              className="mt-1 w-full rounded-lg py-1.5 text-center text-[11px] text-ink-faint transition-colors hover:text-ink"
            >
              ↻ Tarama yenile
            </button>
          </div>
        )}

        {/* ---------------- nothing installed ---------------- */}
        {!isDetecting && !hasWallets && (
          <div className="space-y-3">
            <div className="rounded-xl border border-warn/35 bg-warn/5 p-3 text-[11px] leading-relaxed text-ink-dim">
              <span className="text-warn">Cüzdan bulunamadı.</span> Bu uygulama bir EIP-1193
              sağlayıcısına ihtiyaç duyar. Aşağıdan bir tarayıcı cüzdanı kurun, sayfayı
              yenileyin ve tekrar deneyin.
            </div>

            <div className="space-y-1.5">
              {INSTALL_SUGGESTIONS.map((entry) => (
                <a
                  key={entry.rdns}
                  href={entry.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="group flex items-center gap-3 rounded-xl border border-transparent p-2.5 transition-colors hover:border-edge-bright hover:bg-white/4"
                >
                  <WalletLogo rdns={entry.rdns} name={entry.name} size={36} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-ink">{entry.name}</div>
                    <div className="truncate text-[10px] text-ink-faint">{entry.blurb}</div>
                  </div>
                  <span className="text-[10px] uppercase tracking-[0.1em] text-plasma-soft opacity-0 transition-opacity group-hover:opacity-100">
                    Kur ↗
                  </span>
                </a>
              ))}
            </div>

            <div className="flex items-center justify-between gap-2 border-t border-edge pt-3">
              <span className="text-[10px] text-ink-faint">
                Kurulumdan sonra taramayı yeniden çalıştırın.
              </span>
              <button
                onClick={onRescan}
                className="rounded-lg border border-edge-bright px-2.5 py-1 text-[11px] text-ink transition-colors hover:border-plasma/60"
              >
                ↻ Yeniden tara
              </button>
            </div>
          </div>
        )}

        <p className="mt-4 border-t border-edge pt-3 text-[10px] leading-relaxed text-ink-faint">
          Aegis cüzdanınızla imza atmaz; yalnızca{" "}
          <code className="font-mono text-ink-dim">registerBaseline</code> ve{" "}
          <code className="font-mono text-ink-dim">verifyCallWithLiveness</code> işlemlerini
          imzalar.
        </p>
      </div>
    </div>
  );
}
