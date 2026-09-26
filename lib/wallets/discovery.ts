/**
 * Wallet keşfi (EIP-6963) + çoklu-cüzdan bağlantısı.
 *
 * Neden EIP-6963: `window.ethereum` tek bir global'dir ve birden çok eklenti
 * kurulu olduğunda hangisinin döneceği tarayıcıya göre değişir. EIP-6963
 * standartlaştırılmış keşif + **ikon dahil** kimlik sağlar:
 *
 *   window.addEventListener("eip6963:announceProvider", …)
 *   window.dispatchEvent(new Event("eip6963:requestProvider"))
 *
 * `info.icon` bir data-URI'dir; yani gerçek wallet logolarını uygulamanın
 * kendi varlıkları olarak taşımadan gösterebiliriz. EIP-6963'ü desteklemeyen
 * eski eklentiler için `window.ethereum.providers` dizisine düşülür.
 *
 * Bağlantı tarafında tek bir kayıtlı `injected` connector kullanılır ve
 * `target` fonksiyonu ile seçilen cüzdana yönlendirilir. Böylece:
 *   · her cüzdan için ayrı connector kaydı gerekmez,
 *   · `connector.name` / `connector.icon` seçilen cüzdanı yansıtır,
 *   · wagmi'nin cookie storage ile yaptığı otomatik yeniden bağlanma bozulmaz.
 *
 * Protokol I/O'su React'ten ayrı tutulmuştur (`createWalletProbe`), böylece
 * tarayıcısız da test edilebilir.
 */
"use client";

import { useEffect, useMemo, useState } from "react";
import { injected } from "wagmi/connectors";

/** A wallet as advertised over EIP-6963. */
export type DiscoveredWallet = {
  /** reverse-DNS id, stable across sessions (e.g. "io.metamask") */
  rdns: string;
  name: string;
  /** data: URI (EIP-6963) or null when only legacy discovery worked */
  icon: string | null;
  provider: unknown;
};

/** The slice of `Window` the probe needs — keeps it testable without a DOM. */
export type WalletWindow = {
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
  dispatchEvent(event: Event): boolean;
  ethereum?: unknown;
  localStorage?: { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void };
};

type Eip6963Detail = {
  info: { uuid: string; name: string; icon: string; rdns: string };
  provider: unknown;
};

/** How long we wait for `announceProvider` before declaring "nothing installed". */
export const DETECT_GRACE_MS = 900;

/** How long we let EIP-6963 responses pile up before rendering the list. */
export const SETTLE_DEBOUNCE_MS = 60;

const isBrowser = () => typeof window !== "undefined";

const browserWindow = (): WalletWindow | undefined =>
  isBrowser() ? (window as unknown as WalletWindow) : undefined;

// ---------------------------------------------------------------------------
//  Legacy identity inference (only for pre-EIP-6963 extensions)
// ---------------------------------------------------------------------------
const LEGACY_FLAGS: Array<[flag: string, rdns: string, name: string]> = [
  ["isMetaMask", "io.metamask", "MetaMask"],
  ["isRabby", "io.rabby", "Rabby Wallet"],
  ["isTrust", "com.trustwallet.app", "Trust Wallet"],
  ["isTrustWallet", "com.trustwallet.app", "Trust Wallet"],
  ["isBraveWallet", "com.brave.wallet", "Brave Wallet"],
  ["isCoinbaseWallet", "com.coinbase.wallet", "Coinbase Wallet"],
  ["isPhantom", "app.phantom", "Phantom"],
  ["isOkxWallet", "com.okex.wallet", "OKX Wallet"],
  ["isTokenPocket", "io.tokenpocket", "TokenPocket"],
  ["isLedger", "com.ledger.ledgerlive", "Ledger Live"],
  ["isFrame", "sh.frame", "Frame"],
  ["isZerion", "io.zerion", "Zerion"],
];

function fromLegacyProvider(provider: Record<string, unknown>, index: number): DiscoveredWallet {
  const flag = LEGACY_FLAGS.find(([f]) => provider[f] === true);
  return {
    rdns: flag?.[1] ?? `injected.${index}`,
    name: flag?.[2] ?? "Cüzdan",
    // No logo available: the UI falls back to a brand monogram.
    icon: null,
    provider,
  };
}

// ---------------------------------------------------------------------------
//  The probe: EIP-6963 announcements + legacy fallback, no React involved
// ---------------------------------------------------------------------------

/**
 * Starts discovery against `win` and pushes every update to `onChange`.
 *
 * `onChange([])` means "nothing installed" once the grace period elapses with
 * no announcements. Returns a cleanup function.
 */
export function createWalletProbe(options: {
  win: WalletWindow;
  onChange: (wallets: DiscoveredWallet[]) => void;
  graceMs?: number;
}): () => void {
  const { win, onChange, graceMs = DETECT_GRACE_MS } = options;
  const announced = new Map<string, DiscoveredWallet>();
  let settled = false;
  let quietTimer: ReturnType<typeof setTimeout> | undefined;
  let graceTimer: ReturnType<typeof setTimeout> | undefined;

  const finish = (wallets: DiscoveredWallet[]) => {
    if (settled) return;
    settled = true;
    clearTimeout(quietTimer);
    clearTimeout(graceTimer);
    onChange(wallets);
  };

  /**
   * Settle shortly after the last announcement.
   *
   * NOT on the first one: EIP-6963 wallets each answer the same
   * `requestProvider` event, so finishing early would hide every wallet except
   * whichever happened to reply first. A short debounce collects them all
   * without making the user wait out the full grace period.
   */
  const finishWhenQuiet = () => {
    clearTimeout(quietTimer);
    quietTimer = setTimeout(() => {
      if (announced.size > 0) finish([...announced.values()]);
    }, SETTLE_DEBOUNCE_MS);
  };

  const onAnnounce = (event: Event) => {
    const detail = (event as CustomEvent<Eip6963Detail>).detail;
    const info = detail?.info;
    if (!info?.rdns || !detail?.provider) return;

    // Idempotent: wallets re-announce on every request event.
    if (announced.has(info.rdns)) return;
    announced.set(info.rdns, {
      rdns: info.rdns,
      name: info.name,
      icon: info.icon ?? null,
      provider: detail.provider,
    });
    finishWhenQuiet();
  };

  win.addEventListener("eip6963:announceProvider", onAnnounce);
  win.dispatchEvent(new Event("eip6963:requestProvider"));

  // Kullanıcı yeni bir eklenti kurduktan sonra sekmeye geri döndüğünde
  // yeniden istek atıyoruz: tıklamak zorunda kalmasın.
  const onFocus = () => win.dispatchEvent(new Event("eip6963:requestProvider"));
  win.addEventListener("focus", onFocus);

  // Final backstop: nothing answered EIP-6963, so try the legacy global.
  graceTimer = setTimeout(() => {
    if (announced.size > 0) {
      finish([...announced.values()]);
      return;
    }
    const injectedProvider = win.ethereum;
    if (!injectedProvider) {
      finish([]);
      return;
    }
    const list = Array.isArray((injectedProvider as { providers?: unknown[] }).providers)
      ? ((injectedProvider as { providers: unknown[] }).providers as Record<string, unknown>[])
      : [injectedProvider as Record<string, unknown>];
    finish(list.filter(Boolean).map(fromLegacyProvider));
  }, graceMs);

  return () => {
    clearTimeout(quietTimer);
    clearTimeout(graceTimer);
    win.removeEventListener("eip6963:announceProvider", onAnnounce);
    win.removeEventListener("focus", onFocus);
  };
}

// ---------------------------------------------------------------------------
//  React bindings
// ---------------------------------------------------------------------------
export type WalletAvailability = {
  wallets: DiscoveredWallet[];
  /** true while we are still waiting for providers to announce */
  isDetecting: boolean;
  /** re-run discovery (used by the "Yeniden tara" button) */
  rescan: () => void;
};

export function useAvailableWallets(): WalletAvailability {
  const [wallets, setWallets] = useState<DiscoveredWallet[]>([]);
  const [isDetecting, setIsDetecting] = useState(true);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    const win = browserWindow();
    if (!win) {
      setIsDetecting(false);
      return;
    }
    setIsDetecting(true);
    setWallets([]);
    const stop = createWalletProbe({
      win,
      onChange: (found) => {
        setWallets(found);
        setIsDetecting(false);
      },
    });
    return stop;
  }, [nonce]);

  // Let the connector re-aim at the persisted wallet once it is discoverable.
  useEffect(() => {
    rememberWallets(wallets);
  }, [wallets]);

  return useMemo(
    () => ({
      wallets,
      isDetecting,
      rescan: () => setNonce((n) => n + 1),
    }),
    [wallets, isDetecting],
  );
}

// ---------------------------------------------------------------------------
//  Connector: one registered `injected` connector, aimed at the chosen wallet
// ---------------------------------------------------------------------------

/**
 * wagmi'nin `injected` connector'ı için hedef cüzdan tanımı.
 *
 * Tipi elle yazmıyoruz: wagmi'nin kendi `target` tipinden türetiyoruz ki
 * `WalletProvider` şekli iki kopyada farklılaşmasın.
 */
type InjectedParams = NonNullable<Parameters<typeof injected>[0]>;
type TargetFn = Extract<NonNullable<InjectedParams["target"]>, () => unknown>;
type Target = NonNullable<ReturnType<TargetFn>>;

const SELECTED_KEY = "aegis.wallet.selected";

let selected: Target | undefined;

/** Wallets reported by the current page, so a re-resolve can find the provider. */
const registry = new Map<string, DiscoveredWallet>();

const toTarget = (wallet: DiscoveredWallet): Target => ({
  id: wallet.rdns,
  name: wallet.name,
  // EIP-6963 guarantees an EIP-1193 provider; the cast only re-states that.
  provider: wallet.provider as Target["provider"],
  ...(wallet.icon ? { icon: wallet.icon } : {}),
});

const readPersisted = (): string | null => {
  try {
    return browserWindow()?.localStorage?.getItem(SELECTED_KEY) ?? null;
  } catch {
    return null;
  }
};

/**
 * Resolves the target, re-attaching the provider object after a reload.
 *
 * A provider *object* cannot be persisted, only its rdns. So the choice is
 * stored and the provider is looked up again from the discovery registry.
 * Returns `undefined` while still unknown, which makes wagmi fall back to
 * `window.ethereum` — the behaviour it would have had without this module.
 */
function resolveSelected(): Target | undefined {
  if (selected) return selected;
  const rdns = readPersisted();
  if (!rdns) return undefined;
  const wallet = registry.get(rdns);
  if (!wallet) return undefined;
  selected = toTarget(wallet);
  return selected;
}

/** Called by the discovery hook so the connector can re-resolve the provider. */
export function rememberWallets(wallets: DiscoveredWallet[]) {
  for (const wallet of wallets) registry.set(wallet.rdns, wallet);
  // The stored choice may have just become resolvable.
  if (!selected) resolveSelected();
}

/** Points the shared injected connector at a specific wallet. */
export function selectWallet(wallet: DiscoveredWallet | undefined) {
  if (!wallet) {
    selected = undefined;
    browserWindow()?.localStorage?.removeItem(SELECTED_KEY);
    return;
  }
  selected = toTarget(wallet);
  try {
    browserWindow()?.localStorage?.setItem(SELECTED_KEY, wallet.rdns);
  } catch {
    /* private mode: the choice just will not survive a reload */
  }
}

/** The rdns of the wallet the user picked, if known. */
export const getSelectedWalletRdns = (): string | null => selected?.id ?? readPersisted();

export const injectedConnector = /*#__PURE__*/ injected({
  shimDisconnect: true,
  // Evaluated lazily so `connector.id` / `.name` / `.icon` reflect the wallet the
  // user actually chose, while wagmi keeps re-connecting this one connector.
  target: () => resolveSelected(),
});
