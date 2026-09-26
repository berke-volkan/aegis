/**
 * Cüzdan kataloğu: yükleme yönlendirmesi + marka renkleri.
 *
 * Bilinçli bir ayrım var:
 *   · **Yüklü** wallet'ların logoları EIP-6963 `info.icon` data-URI'lerinden
 *     gelir — yani gerçek, güncel, uygulama varlığı taşımadan.
 *   · **Yükleme önerileri** (henüz kurulu değilse gösterilenler) dış istek
 *     yapmamak için monogram + marka rengi kullanır. Böylece uygulama offline
 *     çalışır, üçüncü taraf CDN'e istek atmaz ve marka görselleri bayatlamaz.
 */

export type WalletCatalogEntry = {
  rdns: string;
  name: string;
  /** where to get it */
  url: string;
  /** brand accent, used for the monogram tile */
  color: string;
  /** short blurb for the install screen */
  blurb: string;
};

export const WALLET_CATALOG: WalletCatalogEntry[] = [
  {
    rdns: "io.metamask",
    name: "MetaMask",
    url: "https://metamask.io/download/",
    color: "#F6851B",
    blurb: "En yaygın cüzdan; EIP-6963 destekler.",
  },
  {
    rdns: "io.rabby",
    name: "Rabby Wallet",
    url: "https://rabby.io/",
    color: "#8697FF",
    blurb: "Çoklu hesap ve detaylı işlem simülasyonu.",
  },
  {
    rdns: "com.trustwallet.app",
    name: "Trust Wallet",
    url: "https://trustwallet.com/download",
    color: "#3375BB",
    blurb: "Mobilde de yaygın; tarayıcı eklentisi mevcut.",
  },
  {
    rdns: "com.brave.wallet",
    name: "Brave Wallet",
    url: "https://brave.com/wallet/",
    color: "#FB542B",
    blurb: "Brave tarayıcısına gömülü.",
  },
  {
    rdns: "com.coinbase.wallet",
    name: "Coinbase Wallet",
    url: "https://www.coinbase.com/wallet/downloads",
    color: "#0052FF",
    blurb: "Smart Wallet desteğiyle.",
  },
  {
    rdns: "app.phantom",
    name: "Phantom",
    url: "https://phantom.app/download",
    color: "#AB9FF2",
    blurb: "EVM dışında Solana da destekler.",
  },
];

/** Suggestions shown when nothing is installed; keeps the list short. */
export const INSTALL_SUGGESTIONS = WALLET_CATALOG.slice(0, 4);

export type Brand = { color: string; glyph: string };

const GLYPHS: Record<string, string> = {
  metamask: "M",
  rabby: "R",
  "trust wallet": "T",
  "brave wallet": "B",
  "coinbase wallet": "C",
  phantom: "P",
  "okx wallet": "O",
  ledger: "L",
  frame: "F",
  zerion: "Z",
  tokenpocket: "T",
};

/** Brand colour + monogram for a wallet, by rdns first then by display name. */
export function brandFor(rdns?: string, name?: string): Brand {
  const byRdns = WALLET_CATALOG.find((w) => w.rdns === rdns);
  if (byRdns) return { color: byRdns.color, glyph: GLYPHS[byRdns.name.toLowerCase()] ?? "W" };

  const key = (name ?? "").toLowerCase();
  if (GLYPHS[key]) return { color: "#4ade9b", glyph: GLYPHS[key] };

  // Unknown wallet: derive a stable hue from its rdns so the tile is at least
  // recognisably the same wallet every time.
  const seed = [...(rdns ?? name ?? "wallet")].reduce((a, c) => a + c.charCodeAt(0), 0);
  return { color: `hsl(${seed % 360} 55% 55%)`, glyph: (name?.[0] ?? "W").toUpperCase() };
}
