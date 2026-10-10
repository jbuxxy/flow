// The pure access rules — no auth()/session lookup — split out of access.ts
// so client components and plain lib modules can share them: access.ts's
// guards import auth.ts -> password.ts -> the Node-only @node-rs/argon2,
// which must never reach the browser bundle (notification-preferences.ts
// used to keep its own hasFullAccess copy for exactly that reason).
// access.ts re-exports everything here, so server code can keep importing
// from either.

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
