"use client";

import { useAccount, useConnect, useDisconnect, useSwitchChain } from "wagmi";
import { useState } from "react";

import { MONAD_TESTNET_ID } from "@/lib/chain/monad";
import {
  injectedConnector,
  selectWallet,
  useAvailableWallets,
} from "@/lib/wallets/discovery";
import { Button, Pill, Spinner } from "./ui";
import { WalletLogo } from "./WalletLogo";
import { WalletModal } from "./WalletModal";
import { shorten } from "@/lib/zk/primitives";

export function WalletBar() {
  const { address, isConnected, chain, isConnecting, connector } = useAccount();
  const { connect, isPending, error } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain } = useSwitchChain();

  const [open, setOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [connectingRdns, setConnectingRdns] = useState<string | null>(null);

  const { wallets, isDetecting, rescan } = useAvailableWallets();
  const wrongChain = isConnected && chain?.id !== MONAD_TESTNET_ID;

  // The connected connector resolves its name/icon from the wallet we aimed it
  // at, so the header shows the *right* logo after a reload too.
  const connected = wallets.find((w) => w.rdns === connector?.id) ?? null;

  async function handleSelect(rdns: string) {
    const wallet = wallets.find((w) => w.rdns === rdns);
    if (!wallet) return;
    setConnectingRdns(rdns);
    try {
      selectWallet(wallet);
      connect({ connector: injectedConnector });
    } finally {
      setConnectingRdns(null);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Pill tone="aegis">
        <span className="relative flex size-1.5">
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-aegis opacity-70" />
          <span className="relative inline-flex size-1.5 rounded-full bg-aegis" />
        </span>
        Monad Testnet · {MONAD_TESTNET_ID}
      </Pill>

      {wrongChain && (
        <Button size="sm" variant="danger" onClick={() => switchChain({ chainId: MONAD_TESTNET_ID })}>
          Ağ değiştir
        </Button>
      )}

      {isConnected ? (
        <div className="relative">
          <button
            onClick={() => setMenuOpen((v) => !v)}
            className="flex h-9 items-center gap-2 rounded-xl border border-edge-bright bg-panel-2 px-2.5 font-mono text-xs text-ink transition-colors hover:border-plasma/60"
          >
            {connected ? (
              <WalletLogo rdns={connected.rdns} name={connected.name} icon={connected.icon} size={22} />
            ) : (
              <span className="size-2 rounded-full bg-aegis" />
            )}
            {address ? shorten(address, 5, 4) : "…"}
          </button>
          {menuOpen && (
            <>
              <div className="fixed inset-0 z-30" onClick={() => setMenuOpen(false)} role="presentation" />
              <div className="panel absolute right-0 z-40 mt-2 w-64 p-3 shadow-2xl">
                <div className="mb-2 flex items-center gap-2.5">
                  {connected && (
                    <WalletLogo rdns={connected.rdns} name={connected.name} icon={connected.icon} size={30} />
                  )}
                  <div className="min-w-0">
                    <div className="truncate text-xs font-medium text-ink">
                      {connected?.name ?? connector?.name ?? "Cüzdan"}
                    </div>
                    <div className="font-mono text-[10px] text-ink-faint">{connector?.id}</div>
                  </div>
                </div>
                <div className="mb-3 break-all rounded-lg bg-void/50 p-2 font-mono text-[10px] text-ink-dim">
                  {address}
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  className="w-full"
                  onClick={() => {
                    disconnect();
                    setMenuOpen(false);
                  }}
                >
                  Bağlantıyı kes
                </Button>
              </div>
            </>
          )}
        </div>
      ) : (
        <>
          <Button
            size="sm"
            variant="primary"
            loading={isPending || isConnecting}
            onClick={() => setOpen(true)}
          >
            Cüzdanı bağla
          </Button>

          {/* Inline hint so the "no wallet at all" case is visible before the
              modal is even opened. */}
          {!isDetecting && wallets.length === 0 && (
            <button
              onClick={() => setOpen(true)}
              className="text-[11px] text-warn underline decoration-dotted underline-offset-4 hover:text-ink"
            >
              Cüzdan kurulumu gerekli
            </button>
          )}
        </>
      )}

      <WalletModal
        open={open}
        onClose={() => {
          setOpen(false);
          setConnectingRdns(null);
        }}
        wallets={wallets}
        isDetecting={isDetecting}
        onSelect={handleSelect}
        onRescan={rescan}
        connectingRdns={connectingRdns}
        error={error ? shortenError(error.message) : undefined}
      />
    </div>
  );
}

function shortenError(message: string): string {
  const map: Record<string, string> = {
    UserRejectedRequestError: "Cüzdan bağlantısı kullanıcı tarafından reddedildi.",
    ChainNotConfiguredError: "Monad Testnet bu cüzdan içinde tanımlı değil.",
  };
  for (const [key, value] of Object.entries(map)) if (message.includes(key)) return value;
  return message.length > 100 ? `${message.slice(0, 100)}…` : message;
}
