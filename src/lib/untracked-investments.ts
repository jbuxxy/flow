import { db } from "@/lib/db";
import type { AssetType } from "@prisma/client";

export type UntrackedInvestmentAccount = {
  id: string;
  name: string;
  orgName: string | null;
  balanceCents: number;
  guessedAssetType: AssetType;
};

// Same gap as debts: SimpleFIN syncs the account and balance automatically,
// but nothing ever creates the Asset row that net worth actually reads from.
export async function getUntrackedInvestmentAccounts(householdId: string): Promise<UntrackedInvestmentAccount[]> {
  const accounts = await db.account.findMany({
    where: { householdId, accountType: "INVESTMENT", assets: { none: {} } },
    orderBy: { name: "asc" },
    select: { id: true, name: true, displayName: true, orgName: true, balanceCents: true },
  });

  return accounts.map((a) => ({
    id: a.id,
    name: a.displayName ?? a.name,
    orgName: a.orgName,
    balanceCents: a.balanceCents,
    // The household's own renamed guess signal, not the raw synced name
    // (see guessAssetType) — a household who renamed "Fidelity ...401k..."
    // to something without that keyword still gets a fallback INVESTMENT
    // guess, but one who renamed a vague name *to* "My 401k" gets picked up.
    guessedAssetType: guessAssetType(a.displayName ?? a.name),
  }));
}

function guessAssetType(name: string): AssetType {
  const lower = name.toLowerCase();
  if (lower.includes("401k") || lower.includes("401(k)")) return "RETIREMENT_401K";
  if (lower.includes(" ira") || lower.startsWith("ira")) return "RETIREMENT_IRA";
  if (lower.includes("pension")) return "RETIREMENT_PENSION";
  return "INVESTMENT";
}
