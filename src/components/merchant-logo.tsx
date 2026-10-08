"use client";

import { useEffect, useState } from "react";
import { getMerchantLogoUrl, getCuratedDomains, curatedLogoUrl, hunterLogoUrl } from "@/lib/merchant-domains";

export { getMerchantLogoUrl };

// ---------------------------------------------------------------------------
// Guessed-domain fallback (opt-in via `allowGuess`)
// ---------------------------------------------------------------------------
// Module-level cache shared by every MerchantLogo instance for the life of
// the page — repeated rows for the same merchant (a bucket's transaction
// list, say) only ever trigger one /api/merchant-logo request each, and the
// DB behind that route caches the result forever after the very first
// lookup across the whole app, not just this page. See
// src/lib/merchant-logo-resolve.ts for how a merchant is actually resolved.
const resolvedCache = new Map<string, string | null>();
const inFlight = new Map<string, Promise<string | null>>();

async function resolveViaApi(merchant: string): Promise<string | null> {
  const cached = resolvedCache.get(merchant);
  if (cached !== undefined) return cached;
  const pending = inFlight.get(merchant);
  if (pending) return pending;

  const promise = fetch(`/api/merchant-logo?merchant=${encodeURIComponent(merchant)}`)
    .then((res) => (res.ok ? res.json() : { domain: null }))
    .then((data: { domain: string | null }) => data.domain)
    .catch(() => null)
    .finally(() => inFlight.delete(merchant));

  inFlight.set(merchant, promise);
  const domain = await promise;
  resolvedCache.set(merchant, domain);
  return domain;
}

// ---------------------------------------------------------------------------
// Shared image element
// ---------------------------------------------------------------------------

/** Renders nothing (rather than a broken-image placeholder) once its own load fails. */
function LogoImg({ src, size, className }: { src: string; size: number; className: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt=""
      aria-hidden="true"
      width={size}
      height={size}
      onError={() => setFailed(true)}
      className={`inline-block shrink-0 rounded object-contain ${className}`}
      style={{ width: size, height: size }}
    />
  );
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

interface MerchantLogoProps {
  merchant: string;
  /** Size in px — default 20 */
  size?: number;
  className?: string;
  /**
   * When true, falls back to a cached, verified-once domain guess (see
   * merchant-logo-resolve.ts) for merchants not in the curated table.
   * Leave false wherever `merchant` may be a person's name rather than a
   * business — P2P transfer payees, most notably — since a wrong guess
   * there could surface a real but unrelated company's logo, which is a
   * worse outcome than just showing nothing.
   */
  allowGuess?: boolean;
  /**
   * The transaction's raw bank text (Transaction.rawDescription), checked
   * against the curated table when `merchant` alone matches nothing — the
   * cleaned-up merchant name often drops the brand ("Supercharger" from
   * "TESLA SUPERCHARGER") or keeps only an ambiguous word ("Holiday" from
   * "HOLIDAY 72 ANYTOWN UT", which guessed holiday.com, an unrelated site).
   * Curated-only: the raw text is never guessed from.
   */
  description?: string | null;
}

/**
 * Renders a small rounded logo icon for well-known merchants using the
 * Hunter.io Logo API. Silently renders nothing when no logo is available or
 * the image fails to load — never throws or shows broken-image placeholders.
 */
export function MerchantLogo({
  merchant,
  size = 20,
  className = "",
  allowGuess = false,
  description,
}: MerchantLogoProps) {
  const curatedUrl = getMerchantLogoUrl(merchant) ?? (description ? getMerchantLogoUrl(description) : null);
  const [guessedDomain, setGuessedDomain] = useState<string | null>(null);

  useEffect(() => {
    if (curatedUrl || !allowGuess) return;
    let cancelled = false;
    resolveViaApi(merchant).then((domain) => {
      if (!cancelled) setGuessedDomain(domain);
    });
    return () => {
      cancelled = true;
    };
  }, [merchant, curatedUrl, allowGuess]);

  // A guessed domain was only ever verified against Hunter (see
  // merchant-logo-resolve.ts), so it keeps Hunter's image — Google's favicon
  // service answers an unknown domain with a generic globe, not nothing.
  const src = curatedUrl ?? (guessedDomain ? hunterLogoUrl(guessedDomain) : null);
  if (!src) return null;

  return <LogoImg src={src} size={size} className={className} />;
}

/**
 * Every curated logo a composite name matches (up to `max`), shown side by
 * side — a BNPL debt named "Nike - Klarna" or "Klarna - Nike" gets both the
 * provider's and the retailer's logo (provider first — see
 * getCuratedDomains), in either word order, instead of just the first one
 * MerchantLogo alone would resolve (household request, 2026-09-13). Callers
 * pass max={1} for anything but a BNPL plan: only a BNPL name legitimately
 * pairs two brands (household request, 2026-10-07). Curated-table-only, same allowGuess-off reasoning as every
 * caller of MerchantLogo that passes a household's own free-text label
 * rather than a real bank descriptor — no guessed fallback here.
 */
export function MerchantLogos({
  merchant,
  size = 16,
  className = "",
  max = 2,
}: {
  merchant: string;
  size?: number;
  className?: string;
  max?: number;
}) {
  const domains = getCuratedDomains(merchant, max);
  if (domains.length === 0) return null;
  return (
    <span className={`inline-flex shrink-0 items-center gap-0.5 ${className}`}>
      {domains.map((domain) => (
        <LogoImg key={domain} src={curatedLogoUrl(domain)} size={size} className="" />
      ))}
    </span>
  );
}
