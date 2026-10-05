"use client";

import { useCallback, useState } from "react";
import { bucketIconComponent } from "@/lib/bucket-icons";
import { getMerchantLogoUrl } from "@/lib/merchant-domains";

interface BucketIconProps {
  bucket: { name: string; icon?: string | null };
  /** Glyph size in px (the Lucide icon). Default 20. */
  size?: number;
  /**
   * Classes for the round wrapper — pass the sizing + the default tinted
   * background/text the glyph should use (e.g. `h-10 w-10 bg-blue-50 ...`).
   * When a merchant logo loads it paints its own white chip over this.
   */
  wrapperClassName?: string;
}

/**
 * The round icon that fronts a bucket everywhere it's listed.
 *
 * Default: the resolved Lucide glyph (stored AI pick → keyword rule → Wallet,
 * see bucketIconComponent) in a tinted circle.
 *
 * Merchant-specific buckets: if the bucket *name* maps to a curated merchant
 * domain (getMerchantLogoUrl — curated table only, never the guessed-domain
 * path, so "Kids' Activities" can't luck into some real company's mark), we
 * fade that merchant's logo in over the glyph once it has actually loaded.
 * The glyph stays mounted underneath, so a missing or broken logo just
 * leaves the normal icon — never a blank circle.
 */
export function BucketIcon({ bucket, size = 20, wrapperClassName = "" }: BucketIconProps) {
  const Icon = bucketIconComponent(bucket);
  const logoUrl = getMerchantLogoUrl(bucket.name);
  const [logoLoaded, setLogoLoaded] = useState(false);

  // The SSR'd <img> can finish loading before React attaches onLoad — a warm
  // HTTP cache beats hydration — and then the event never fires. Reconcile
  // from the DOM node the moment the ref is attached.
  const reconcile = useCallback((img: HTMLImageElement | null) => {
    if (img?.complete && img.naturalWidth > 0) setLogoLoaded(true);
  }, []);

  return (
    <span
      className={`relative flex shrink-0 items-center justify-center overflow-hidden rounded-full ${wrapperClassName}`}
    >
      {/* eslint-disable-next-line react-hooks/static-components -- bucketIconComponent returns a stable lookup-table reference, not a component created during render */}
      <Icon size={size} />
      {logoUrl && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          ref={reconcile}
          src={logoUrl}
          alt=""
          aria-hidden="true"
          onLoad={() => setLogoLoaded(true)}
          className={`absolute inset-0 h-full w-full bg-white object-contain p-[15%] transition-opacity ${
            logoLoaded ? "opacity-100" : "opacity-0"
          }`}
        />
      )}
    </span>
  );
}
