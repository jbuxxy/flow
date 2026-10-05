import { db } from "@/lib/db";
import { nameSimilarity } from "@/lib/fuzzy-match";
import { daysAgo } from "@/lib/period";

// No natural "cycle" to anchor a redisplay to (unlike a debt's billing
// cycle or a bill's due date) — a flat snooze window instead, same idea as
// getActiveDebtsNeedingSetup's fallback for a debt with no DebtPayment yet.
const UNTRACKED_LIABILITY_SNOOZE_DAYS = 30;

export type UntrackedLiabilityTransaction = { id: string; merchant: string; amountCents: number; occurredOn: Date };

export type UntrackedLiabilityAccount = {
  id: string;
  name: string;
  orgName: string | null;
  accountType: "CREDIT_CARD" | "LOAN";
  balanceCents: number;
  // Deduced from a tracked bill covering this same loan (see
  // findMinPaymentFromBills) — a starting guess for the "Min $/mo" field,
  // never applied on its own. LOAN only; see that function for why.
  knownMinPaymentCents?: number;
  recentTransactions: UntrackedLiabilityTransaction[];
};

function orgAcronym(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0])
    .join("");
}

// A LOAN account's minimum payment is, in practice, usually just visible
// already — as the household's own tracked bill for the exact same lender,
// since /bills has been tracking the recurring debit off the checking
// account this whole time even though nothing ever linked it to the loan
// account. Candidate bills aren't filtered by category — BillCategory is
// fully household-managed free text now, not a fixed enum, so there's no
// reliable "housing/loan" label to filter on — the acronym/name-overlap
// matching below is conservative enough on its own. Deliberately
// conservative either way, since presenting a wrong number as a confident
// default is worse than presenting none: two independent signals, either
// sufficient on its own.
//   1. Acronym match — a servicer's checking-account statement line is very
//      often just the initials of its full legal name ("SHL" for "Summit
//      Home Loans, Inc" is the textbook case), checked first
//      since it's effectively unambiguous when it hits.
//   2. Word-overlap similarity (nameSimilarity) between the bill and the
//      account's name/org, at a bar well above the 0.34 used for the
//      softer "suggest a link" case elsewhere (debts/page.tsx) — a bad
//      guess here would pre-fill a real number into the payoff calculator,
//      not just suggest a click.
// Assumes the tracked bill amount already *is* the minimum payment, with
// nothing extra going to principal — a safe assumption for a value nobody
// otherwise has, and the household can always overwrite it if wrong.
function findMinPaymentFromBills(
  account: { name: string; orgName: string | null },
  bills: { name: string; merchant: string | null; amountCents: number }[],
): number | undefined {
  const acronym = account.orgName ? orgAcronym(account.orgName) : "";
  if (acronym.length >= 3) {
    const acronymMatch = bills.find((bill) => {
      const billFirstWord = (bill.merchant ?? bill.name).toLowerCase().trim().split(/\s+/)[0] ?? "";
      return billFirstWord === acronym;
    });
    if (acronymMatch) return acronymMatch.amountCents;
  }

  let best: { amountCents: number; score: number } | null = null;
  for (const bill of bills) {
    const score = Math.max(
      nameSimilarity(bill.name, account.name),
      account.orgName ? nameSimilarity(bill.name, account.orgName) : 0,
      bill.merchant ? nameSimilarity(bill.merchant, account.name) : 0,
      bill.merchant && account.orgName ? nameSimilarity(bill.merchant, account.orgName) : 0,
    );
    if (score >= 0.5 && (!best || score > best.score)) best = { amountCents: bill.amountCents, score };
  }
  return best?.amountCents;
}

// A synced credit card or loan account is real, known-balance data — very
// different from the BNPL banner's guesswork, which only has a merchant
// name and no account at all. This is the gap between "we synced it" and
// "there's a Debt row for it": SimpleFIN gives us the account and balance
// automatically, but nothing ever creates the Debt record, so the payoff
// calculator never sees it unless the household manually adds one.
export async function getUntrackedLiabilityAccounts(householdId: string): Promise<UntrackedLiabilityAccount[]> {
  const [accounts, candidateBills] = await Promise.all([
    db.account.findMany({
      where: {
        householdId,
        accountType: { in: ["CREDIT_CARD", "LOAN"] },
        // Excludes a retired/superseded account row — e.g. linkDebtAccount
        // hides the old Account once it re-points a Debt onto a new one
        // (SimpleFIN re-issuing simpleFinAccountId for the same real card).
        // Without this, that orphaned, invisible-in-Settings duplicate still
        // matches "no debt attached" even though the real debt is tracked
        // under its replacement account.
        hiddenAt: null,
        debts: { none: {} },
      },
      orderBy: { name: "asc" },
      select: {
        id: true,
        name: true,
        orgName: true,
        accountType: true,
        balanceCents: true,
        transactions: {
          orderBy: { occurredOn: "desc" },
          take: 15,
          select: { id: true, merchant: true, amountCents: true, occurredOn: true },
        },
      },
    }),
    db.recurringBill.findMany({
      where: { householdId, active: true, cadence: "MONTHLY" },
      select: { name: true, merchant: true, amountCents: true },
    }),
  ]);

  return accounts.map((a) => ({
    id: a.id,
    name: a.name,
    orgName: a.orgName,
    accountType: a.accountType as "CREDIT_CARD" | "LOAN",
    balanceCents: a.balanceCents,
    knownMinPaymentCents:
      a.accountType === "LOAN" ? findMinPaymentFromBills({ name: a.name, orgName: a.orgName }, candidateBills) : undefined,
    recentTransactions: a.transactions,
  }));
}

// Dashboard-card counterpart to getUntrackedLiabilityAccounts above —
// filtered through a per-account dismissal. Not permanent: comes back
// after UNTRACKED_LIABILITY_SNOOZE_DAYS if the account is still untracked
// (it drops out of the underlying query entirely, dismissal or not, the
// moment a household actually tracks it as a Debt).
export async function getActiveUntrackedLiabilityAccounts(householdId: string): Promise<UntrackedLiabilityAccount[]> {
  const accounts = await getUntrackedLiabilityAccounts(householdId);
  if (accounts.length === 0) return [];

  const dismissals = await db.suggestionDismissal.findMany({
    where: { householdId, kind: "UNTRACKED_LIABILITY", key: { in: accounts.map((a) => a.id) } },
    select: { key: true, createdAt: true },
  });
  const dismissedAtByKey = new Map(dismissals.map((d) => [d.key, d.createdAt]));
  const snoozeCutoff = daysAgo(UNTRACKED_LIABILITY_SNOOZE_DAYS);

  return accounts.filter((a) => {
    const dismissedAt = dismissedAtByKey.get(a.id);
    return !dismissedAt || dismissedAt < snoozeCutoff;
  });
}

export async function dismissUntrackedLiability(householdId: string, accountId: string): Promise<void> {
  await db.suggestionDismissal.upsert({
    where: { householdId_kind_key: { householdId, kind: "UNTRACKED_LIABILITY", key: accountId } },
    create: { householdId, kind: "UNTRACKED_LIABILITY", key: accountId },
    update: { createdAt: new Date() },
  });
}
