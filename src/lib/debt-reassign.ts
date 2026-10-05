import { db } from "@/lib/db";
import { allBnplKeywords, resolveBnplKeyword } from "@/lib/bnpl-detect";
import type { Prisma } from "@prisma/client";

// The `where` every transaction-assignment picker scopes its debt list to —
// the Reclassify / "Move" dropdowns on /transactions and /buckets, the
// bucket detail Singles list, BillRow, and the income PatternPanel. Two
// exclusions:
//   - hiddenAt: null — a debt the household explicitly hid on /debts (see
//     Debt.hiddenAt). Self-heals back if its balance returns from $0.
//   - a paid-off ($0 or less) LOAN or BNPL plan — F150, trailer, a finished
//     Affirm plan: genuinely done, nothing more to route to it. A paid-off
//     CARD (kind: "CARD") stays — a credit card sits at $0 between statement
//     cycles all the time and gets used again, so "$0 right now" isn't
//     "done" for it. Nothing here is a data mutation: the moment a loan's
//     balance goes positive again it reappears in the pickers on its own.
export function pickableDebtWhere(): Prisma.DebtWhereInput {
  return { hiddenAt: null, OR: [{ kind: "CARD" }, { balanceCents: { gt: 0 } }] };
}

// Runs once, right when a debt gets tracked or linked to an account — catches
// transactions that were already mis-filed as ordinary bucket spend *before*
// the debt existed to recognize them (the ongoing per-sync sweep in
// simplefin-sync.ts only ever touches never-yet-categorized transactions, so
// it can't fix history on its own).
//
// Deliberately narrow, learned the hard way: a credit card/loan account's own
// transaction feed mixes real purchases (Nike, Amazon — positive amountCents,
// genuine household spend) with payments/credits that reduce the balance
// (negative amountCents) — matching on accountId alone swept up purchases as
// "debt payments" and stripped them out of their buckets. Only negative
// amounts on the linked account qualify. Same logic for BNPL: "Klarna" or
// "Affirm" alone is a generic installment-payment line; "Nike - Klarna" is
// the purchase itself and must stay untouched, so the keyword has to be the
// *entire* merchant string, not just contained somewhere in it.
export async function reassignTransactionsForDebt(debtId: string): Promise<number> {
  const debt = await db.debt.findUnique({ where: { id: debtId } });
  if (!debt) return 0;

  const bnplKeywords = await allBnplKeywords(debt.householdId);
  const matchedKeyword = resolveBnplKeyword(debt, bnplKeywords);

  const or: Prisma.TransactionWhereInput[] = [];
  if (debt.accountId) or.push({ accountId: debt.accountId, amountCents: { lt: 0 } });
  if (matchedKeyword) {
    // A bare provider keyword with no retailer text ("Klarna", not "Nike -
    // Klarna") is how that provider's recurring *installment payment* line
    // typically posts — but on its own it carries zero signal about which
    // specific plan it belongs to. Safe to auto-claim only when this
    // household has exactly one BNPL debt for that provider; with two or
    // more concurrent plans (two separate Klarna purchases), a bare
    // "Klarna" transaction is genuinely ambiguous, and this function has no
    // amount/date check to disambiguate with (unlike matchInstallmentPayments'
    // ongoing per-cycle matcher, which requires the amount to also match a
    // specific debt's expected installment within tolerance). Real
    // incident, 2026-08-22: a second Klarna plan's tracked debt was created
    // after the first, and the first's earlier sweep had already claimed
    // the second plan's very first payment (bare "Klarna", amount didn't
    // match the first plan at all) — permanently stuck, since
    // matchInstallmentPayments never revisits a transaction once debtId
    // points at the wrong debt. Left unclaimed here in the ambiguous case;
    // matchInstallmentPayments' own keyword-fallback (debtId: null only) or
    // a human via /transactions still catches it safely.
    // Checked against a sibling's own pinned bnplKeyword first, not just
    // its live (renameable) name — matchedKeyword above already prefers
    // this debt's own bnplKeyword for the exact same reason. A sibling
    // that hasn't been backfilled yet (bnplKeyword still null — see
    // backfillBnplKeywords, bnpl-detect.ts) still falls back to the live-
    // name check, same as before. Without the bnplKeyword half, renaming a
    // second Klarna plan away from anything containing "Klarna" made this
    // count 0 and let a bare "Klarna" transaction get auto-claimed by the
    // wrong plan — the exact ambiguity incident this whole check exists to
    // prevent, just reached through a rename instead of a fresh debt
    // (real finding, 2026-09-14 code review).
    const siblingCount = await db.debt.count({
      where: {
        householdId: debt.householdId,
        id: { not: debt.id },
        OR: [{ bnplKeyword: matchedKeyword }, { name: { contains: matchedKeyword, mode: "insensitive" } }],
      },
    });
    if (siblingCount === 0) or.push({ merchant: { equals: matchedKeyword, mode: "insensitive" } });
  }
  if (or.length === 0) return 0;

  const result = await db.transaction.updateMany({
    where: { householdId: debt.householdId, debtId: null, OR: or },
    data: { debtId: debt.id, isTransfer: true, bucketId: null, isIncome: false, aiSuggestedBucketId: null },
  });

  return result.count;
}
