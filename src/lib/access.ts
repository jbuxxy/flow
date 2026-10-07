import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";

// OWNER always has full access regardless of dashboardScope (that field only
// applies to invited members) — see the DashboardScope comment in schema.prisma.
export function hasFullAccess(user: { role: string; dashboardScope: string }): boolean {
  return user.role === "OWNER" || user.dashboardScope === "FULL";
}

// Non-owner full-access members can view (read-only) that accounts are
// connected, and still see credit card/loan balances — those double as Debt
// tracking (already visible to full-access members via the now-read-only
// /debts, see requireOwner below) so showing them again here leaks nothing
// new. Every other account type (CHECKING/SAVINGS, but also INVESTMENT/
// OTHER — a synced brokerage or crypto-exchange account is exactly the
// "amount in an asset account" a non-owner is never supposed to see,
// 2026-08-21 household decision) stays owner-only, same bar as net worth.
export function canViewAccountBalance(
  user: { role: string },
  accountType: string,
): boolean {
  if (user.role === "OWNER") return true;
  return accountType === "CREDIT_CARD" || accountType === "LOAN";
}

// Net worth (retirement/home/vehicle equity) stays owner-only — hidden even
// from otherwise-full-access non-owner members.
export function canViewNetWorth(user: { role: string }): boolean {
  return user.role === "OWNER";
}

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

// The other half of the ownership boilerplate repeated across every
// actions.ts: fetch a record, then check it actually belongs to the caller's
// household before doing anything with it. `belongsToHousehold` is for the
// common "fetch then silently no-op if not owned" call sites — collapses
// `!x || x.householdId !== householdId` to one call and narrows the type.
export function belongsToHousehold<T extends { householdId: string } | null | undefined>(
  record: T,
  householdId: string,
): record is NonNullable<T> {
  return record != null && record.householdId === householdId;
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
