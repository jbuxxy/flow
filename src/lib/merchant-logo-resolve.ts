import { db } from "@/lib/db";
import { getCuratedDomain } from "@/lib/merchant-domains";

const HUNTER_LOGO_BASE = "https://logos.hunter.io";

function normalize(merchant: string): string {
  return merchant.trim().toLowerCase();
}

// A literal guess only — lowercased, punctuation/spaces stripped, ".com"
// appended. This is deliberately dumb (no NLP-style "restaurant"/"llc"
// stripping): it either matches the merchant's real domain outright (as it
// does for "Costa Vida" -> costavida.com, "Panda Express" ->
// pandaexpress.com) or it doesn't, and a wrong guess is caught by the
// verification step below before it's ever cached or shown — it never gets
// to fail open.
//
// When the merchant name IS already a domain (real incident, 2026-08-16: a
// household-entered recurring bill named "Anthropic.com" — some billing
// descriptors already come this way) that has to be used as-is, not
// slugified — stripping punctuation first would turn "anthropic.com" into
// "anthropiccom" and then guess the nonexistent "anthropiccom.com" instead
// of the real, logo-having "anthropic.com".
function guessDomain(merchant: string): string | null {
  const trimmed = merchant.trim().toLowerCase();
  const alreadyADomain = trimmed.match(/^[a-z0-9-]+\.[a-z]{2,}$/);
  if (alreadyADomain) return trimmed;

  const slug = trimmed.replace(/[^a-z0-9]/g, "");
  if (slug.length < 3 || slug.length > 40) return null;
  return `${slug}.com`;
}

async function logoExists(domain: string): Promise<boolean> {
  try {
    const res = await fetch(`${HUNTER_LOGO_BASE}/${domain}`, { method: "HEAD" });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Resolves a merchant name to a logo domain, once, ever — cached in
 * MerchantLogoDomain (global, not per-household: a merchant's domain isn't
 * a household fact). `domain: null` is itself a cached result ("we already
 * checked, there's nothing"), so a merchant with no findable logo only ever
 * costs one lookup, not one per page view forever.
 *
 * Resolution order: curated table (instant, already human-verified), then
 * a literal domain guess that must independently prove itself by actually
 * resolving to a real logo before it's trusted — see guessDomain/logoExists
 * above. No AI-assisted guessing here; the literal guess already covers the
 * exact gap this was built for (regional/local chains whose domain is just
 * their name + ".com"), without the added Gemini quota cost or the wider
 * blast radius of an LLM inventing a domain for something that turns out
 * not to be a business at all.
 */
export async function resolveMerchantLogoDomain(merchant: string): Promise<string | null> {
  const key = normalize(merchant);
  if (!key) return null;

  const cached = await db.merchantLogoDomain.findUnique({ where: { merchant: key } });
  if (cached) return cached.domain;

  let domain = getCuratedDomain(merchant);
  if (!domain) {
    const guess = guessDomain(merchant);
    if (guess && (await logoExists(guess))) domain = guess;
  }

  await db.merchantLogoDomain.upsert({
    where: { merchant: key },
    create: { merchant: key, domain },
    update: { domain },
  });

  return domain;
}
