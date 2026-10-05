"use client";

import { useState } from "react";
import { Bitcoin } from "lucide-react";

// The real brand mark for a CRYPTO asset's coin, by ticker. CoinCap's static
// icon CDN is keyed by lowercase symbol, needs no API key, and isn't rate
// limited (unlike CoinGecko's, which 429s this box's shared IP). Falls back
// to the generic Bitcoin glyph — the app's prior crypto icon — when there's
// no symbol, the ticker isn't in the set (404 → onError), or the image
// otherwise fails to load. Plain <img> with an onError swap, same approach
// as MerchantLogo.
export function CryptoIcon({
  symbol,
  size = 14,
  className = "",
}: {
  symbol?: string | null;
  size?: number;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const slug = symbol?.trim().toLowerCase().replace(/[^a-z0-9]/g, "") ?? "";

  if (!slug || failed) return <Bitcoin size={size} aria-hidden="true" className={className} />;

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={`https://assets.coincap.io/assets/icons/${slug}@2x.png`}
      alt=""
      aria-hidden="true"
      width={size}
      height={size}
      onError={() => setFailed(true)}
      className={`inline-block shrink-0 rounded-full object-contain ${className}`}
      style={{ width: size, height: size }}
    />
  );
}
