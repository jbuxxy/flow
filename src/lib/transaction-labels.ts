import { db } from "@/lib/db";

const MAX_SUGGESTIONS_PER_MERCHANT = 8;

// Previously-used labels for the same merchant, most recent first — the
// predictive text for "editing a similar entry". Keyed by exact merchant
// string, same matching convention as MerchantRule/RecurringPattern. Returns
// a plain object (not a Map) so it can cross the server/client component
// boundary as-is.
export async function getLabelSuggestionsByMerchant(
  householdId: string,
  merchants: string[],
): Promise<Record<string, string[]>> {
  const uniqueMerchants = [...new Set(merchants)];
  if (uniqueMerchants.length === 0) return {};

  const rows = await db.transaction.findMany({
    where: { householdId, merchant: { in: uniqueMerchants }, label: { not: null } },
    orderBy: { occurredOn: "desc" },
    distinct: ["merchant", "label"],
    select: { merchant: true, label: true },
  });

  const byMerchant: Record<string, string[]> = {};
  for (const row of rows) {
    const existing = byMerchant[row.merchant] ?? (byMerchant[row.merchant] = []);
    if (existing.length < MAX_SUGGESTIONS_PER_MERCHANT) existing.push(row.label!);
  }
  return byMerchant;
}
