// Amazon's own emails, parsed deterministically (no AI). Since 2026 its
// order/shipping/delivery emails never name the products — the subject and
// body only say "Ordered 2 items: Automotive" — so the AI extractor came back
// with nothing, or a category passed off as an item. What Amazon does still
// name, in the subject line:
//   - every order/shipment/delivery: the item count and their categories
//   - "Delivery update: "Weize Floor Mats for Tesla...""        — a product
//   - "Return request confirmed for / Advance refund issued for /
//      Dropoff confirmed for <product>..."                        — a product
// plus the order number ("113-4817318-6197835") in the body. Those product
// names get carried onto the order's matched charge by order number (see
// applyAmazonProductNames, receipt-sync.ts). Household request, 2026-10-17:
// "parse what you can from the emails, that's really our only solution."

export type AmazonSubject =
  | { type: "summary"; count: number; categories: string[]; more: boolean }
  | { type: "product"; productName: string };

export function isAmazonSender(from: string): boolean {
  return /(^|[@.<\s])amazon\.com\b/i.test(from);
}

const SUMMARY_VERBS = "Ordered|Shipped|Delivered|Out for delivery|Arriving today|Arriving tomorrow";

export function parseAmazonSubject(subject: string): AmazonSubject | null {
  const s = subject.trim();

  // "Ordered 2 items: Automotive" / "Shipped 3 items: Electronics, Home Audio Accessories, and more"
  const list = new RegExp(`^(?:${SUMMARY_VERBS}):?\\s+(\\d+)\\s+items?:\\s*(.+)$`, "i").exec(s);
  if (list) {
    const raw = list[2].trim();
    const more = /,?\s*and more\s*$/i.test(raw);
    const categories = raw
      .replace(/,?\s*and more\s*$/i, "")
      .split(/\s*,\s*/)
      .map((c) => c.trim())
      .filter(Boolean);
    return { type: "summary", count: Number(list[1]), categories, more };
  }

  // "Ordered: 1 Lawn & Garden item" / "Delivered: 1 Automotive item"
  const counted = new RegExp(`^(?:${SUMMARY_VERBS}):\\s*(\\d+)\\s+(.+?)\\s+items?$`, "i").exec(s);
  if (counted) return { type: "summary", count: Number(counted[1]), categories: [counted[2].trim()], more: false };

  const product =
    /^Delivery update:\s*"?(.+?)"?$/i.exec(s) ??
    /^(?:Return request confirmed for|Advance refund issued for|Dropoff confirmed for|Refund issued for|Your refund for)\s+(.+)$/i.exec(s);
  if (product) {
    const productName = cleanProductName(product[1]);
    return productName ? { type: "product", productName } : null;
  }
  return null;
}

// Strips the quotes and trailing ellipsis Amazon truncates titles with.
function cleanProductName(raw: string): string {
  return raw
    .trim()
    .replace(/^"|"$/g, "")
    .replace(/\s*(?:\.{2,}|…)\s*\.?$/, "")
    .replace(/\.$/, "")
    .trim();
}

export function amazonOrderNumber(text: string): string | null {
  return /\b(\d{3}-\d{7}-\d{7})\b/.exec(text)?.[1] ?? null;
}

export type AmazonLineItem = { description: string; qty: number | null; totalCents: number | null; unitPriceCents: null };

// Line items from a summary subject, for an order/shipment email the AI
// found no items in: one category → "N × Category"; several → one line per
// category (Amazon doesn't say how many of each), plus "More Items" when the
// subject was cut off with "and more".
export function amazonSummaryItems(
  summary: Extract<AmazonSubject, { type: "summary" }>,
  totalCents: number | null,
): AmazonLineItem[] {
  if (summary.categories.length === 1 && !summary.more) {
    return [{ description: summary.categories[0], qty: summary.count, totalCents, unitPriceCents: null }];
  }
  const items: AmazonLineItem[] = summary.categories.map((c) => ({
    description: c,
    qty: null,
    totalCents: null,
    unitPriceCents: null,
  }));
  if (summary.more) items.push({ description: "More Items", qty: null, totalCents: null, unitPriceCents: null });
  return items;
}

type ItemLike = { description: string; qty?: number | null; totalCents?: number | null; unitPriceCents?: number | null };

// The charge's item list once product names are known for its order: the
// named products first. When there are at least as many names as existing
// lines, the existing lines were just category placeholders for those same
// items and are dropped (a lone category line's amount carries over to a
// lone product). Otherwise the remaining lines stay after the names.
// Returns null when nothing would change.
export function mergeAmazonProductNames(existing: ItemLike[] | null, names: string[]): ItemLike[] | null {
  const current = existing ?? [];
  const known = new Set(current.map((i) => i.description.toLowerCase()));
  const fresh = [...new Set(names)].filter((n) => !known.has(n.toLowerCase()));
  if (fresh.length === 0) return null;
  const named: ItemLike[] = fresh.map((n) => ({ description: n, qty: 1, totalCents: null, unitPriceCents: null }));
  if (fresh.length === 1 && current.length === 1 && current[0].totalCents != null && (current[0].qty ?? 1) <= 1) {
    return [{ ...named[0], totalCents: current[0].totalCents }];
  }
  return fresh.length >= current.length ? named : [...named, ...current];
}
