import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { belongsToHousehold, hasFullAccess } from "@/lib/access-rules";

export { belongsToHousehold, canViewAccountBalance, canViewNetWorth, hasFullAccess } from "@/lib/access-rules";

// Shared server-action guard for anything owner-only — was previously
// duplicated locally in settings/accounts/actions.ts; now also used by
// debts/actions.ts (2026-08-21: debts went fully read-only for non-owner
// full-access members — they can still view /debts, including the payoff
// calendar and "paid off this week," but every mutation — create, balance/
// terms edits, hide/restore, payoff-plan reordering, even confirming a
// synced payment match — is owner-only now, since a suggestion whose only
// action is "go edit a debt" is a dead end for someone who can't). Income
// was briefly locked down the same way this same day, then reopened —
// a non-owner full-access member keeps managing income normally, since they
// can already see the underlying paycheck transactions on /transactions.
export async function requireOwner() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  if (session.user.role !== "OWNER") redirect("/");
  return session;
}

// The hasFullAccess counterpart to requireOwner — was duplicated locally as
// settings/email/actions.ts's requireFullAccessSession, and missing
// entirely from several other actions.ts files whose page redirects
// BUCKETS_ONLY members away at the page level (bills, income, transactions,
// savings) but whose server actions — independently POST-able, not gated by
// what the client UI happens to render — didn't check at all. A
// BUCKETS_ONLY member's session is real and household-scoped, so
// belongsToHousehold alone lets them through; this is the other half of
// that check.
export async function requireFullAccess() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  if (!hasFullAccess(session.user)) redirect("/");
  return session;
}

// For the fetch-or-throw call sites (generalizes the pattern that used to be
// duplicated locally as buckets/[id]/actions.ts's requireBucketInHousehold).
export async function requireOwned<T extends { householdId: string } | null>(
  finder: Promise<T>,
  householdId: string,
  notFoundMessage = "Not found",
): Promise<NonNullable<T>> {
  const record = await finder;
  if (!belongsToHousehold(record, householdId)) throw new Error(notFoundMessage);
  return record;
}
