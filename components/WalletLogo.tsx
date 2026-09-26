"use client";

import { useState } from "react";

import { brandFor } from "@/lib/wallets/catalog";

/**
 * Wallet logosu.
 *
 * Öncelik sırası:
 *   1. EIP-6963 `info.icon` (gerçek logo, data-URI, dış istek yok)
 *   2. yükleme/hata durumunda marka rengli monogram (dış istek yok)
 *
 * `img` bir data: URI içinde SVG olsa bile tarayıcı betiği çalıştırmaz, bu
 * yüzden wallet'ın gönderdiği icon string'ini doğrudan kullanmak güvenlidir.
 */
export function WalletLogo({
  rdns,
  name,
  icon,
  size = 40,
  className = "",
}: {
  rdns?: string;
  name: string;
  icon?: string | null;
  size?: number;
  className?: string;
}) {
  const [broken, setBroken] = useState(false);
  const brand = brandFor(rdns, name);
  const showImage = Boolean(icon) && !broken;

  return (
    <span
      className={`relative grid shrink-0 place-items-center overflow-hidden rounded-xl ${className}`}
      style={{ width: size, height: size, background: showImage ? "#111725" : `${brand.color}22` }}
    >
      {showImage ? (
        // biome-ignore lint: icon comes from the wallet via EIP-6963
        <img
          src={icon as string}
          alt=""
          width={size}
          height={size}
          onError={() => setBroken(true)}
          className="size-full object-contain p-1"
        />
      ) : (
        <span
          className="font-bold leading-none"
          style={{ color: brand.color, fontSize: size * 0.45 }}
        >
          {brand.glyph}
        </span>
      )}
    </span>
  );
}
